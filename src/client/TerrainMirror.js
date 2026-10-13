/** Client terrain mirror: one BatchedMesh holding every chunk's mesh, grown
 *  on demand instead of reserved up front, with a BVH per chunk for player
 *  collision and a version per chunk for content-addressed fetching.
 *
 *  Unmodified chunks are implicit (solid box below y=5, nothing above), the
 *  same convention as the server. */
import * as THREE from 'three/webgpu';
import { decodeChunkMesh, EMPTY_VERSION } from '../net/codec.js';

export const GRID = 10;
export const CHUNK_COUNT = GRID * GRID * GRID;
const INITIAL_VERTS = 1 << 16;
const SOLID_VERSION = 'solid';
const AIR_VERSION = 'air';

export function chunkCenter(index) {
    return new THREE.Vector3(Math.floor(index / 100) * 10 - 45, (Math.floor(index / 10) % 10) * 10 - 45, (index % 10) * 10 - 45);
}
export function isDefaultSolid(index) { return (Math.floor(index / 10) % 10) < 5; }

export class TerrainMirror {
    constructor(scene, material) {
        this.material = material;
        this.batch = new THREE.BatchedMesh(CHUNK_COUNT, INITIAL_VERTS, INITIAL_VERTS * 3, material);
        this.batch.perObjectFrustumCulled = true;
        this.batch.castShadow = true;
        this.batch.receiveShadow = true;
        scene.add(this.batch);

        this.geoIds = new Int32Array(CHUNK_COUNT).fill(-1);
        this.instIds = new Int32Array(CHUNK_COUNT).fill(-1);
        this.reservedV = new Int32Array(CHUNK_COUNT);
        this.reservedI = new Int32Array(CHUNK_COUNT);
        this.versions = new Array(CHUNK_COUNT);
        this.bboxes = [];
        this.pending = new Map(); // index -> version being fetched
        this.wastedVerts = 0;
        this.fetchChunk = null;   // async (index, version) => Uint8Array|null, set by Main

        let half = new THREE.Vector3(5, 5, 5);
        for(let i = 0; i < CHUNK_COUNT; i++) {
            let c = chunkCenter(i);
            this.bboxes.push(new THREE.Box3(c.clone().sub(half), c.clone().add(half)));
            this.setDefault(i);
        }
    }

    /** Restore a chunk to its implicit state. */
    setDefault(index) {
        if(isDefaultSolid(index)) {
            let geometry = new THREE.BoxGeometry(10, 10, 10);
            geometry.deleteAttribute('uv'); // chunk meshes carry position + normal only; all batch geometries must match
            let c = chunkCenter(index);
            geometry.translate(c.x, c.y, c.z);
            this.setGeometry(index, geometry);
            this.versions[index] = SOLID_VERSION;
        } else {
            this.setGeometry(index, null);
            this.versions[index] = AIR_VERSION;
        }
    }

    /** Apply decoded chunk bytes (or null for an explicitly empty chunk). */
    setChunk(index, bytes, version) {
        this.pending.delete(index);
        if(!bytes) { this.setGeometry(index, null); this.versions[index] = EMPTY_VERSION; return; }
        let { positions, indices } = decodeChunkMesh(bytes);
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals(); // material uses flat shading; normals only keep attributes uniform
        this.setGeometry(index, geometry);
        this.versions[index] = version;
    }

    /** Reconcile with a {index: version} map from the server; fetch what we lack. */
    applyVersions(map, full = false) {
        for(let key in map) {
            let index = +key, version = map[key];
            if(this.versions[index] === version || this.pending.get(index) === version) continue;
            if(version === EMPTY_VERSION) { this.setChunk(index, null, version); continue; }
            this.pending.set(index, version);
            Promise.resolve(this.fetchChunk?.(index, version)).then(bytes => {
                if(this.pending.get(index) !== version) return; // superseded
                if(bytes) this.setChunk(index, bytes, version);
                else this.pending.delete(index);
            }).catch(e => { this.pending.delete(index); console.warn(`chunk ${index} fetch failed: ${e.message}`); });
        }
        if(full) {
            // Chunks absent from a full update are back to their implicit state
            for(let i = 0; i < CHUNK_COUNT; i++) {
                if(map[i] === undefined && this.versions[i] !== SOLID_VERSION && this.versions[i] !== AIR_VERSION) this.setDefault(i);
            }
        }
    }

    /** Indices of chunks whose bounds intersect `box`. */
    intersecting(box) {
        let out = [];
        for(let i = 0; i < CHUNK_COUNT; i++) if(box.intersectsBox(this.bboxes[i])) out.push(i);
        return out;
    }

    /** BVH for a chunk, or null if it has no geometry. */
    bvh(index) {
        let geoId = this.geoIds[index];
        return geoId >= 0 && this.batch.boundsTrees ? this.batch.boundsTrees[geoId] : null;
    }

    // ---- batch management ---------------------------------------------------

    setGeometry(index, geometry) {
        let geoId = this.geoIds[index];
        if(!geometry) {
            if(geoId >= 0) this.release(index);
            return;
        }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        let nv = geometry.attributes.position.count, ni = geometry.index.count;
        if(geoId >= 0 && nv <= this.reservedV[index] && ni <= this.reservedI[index]) {
            this.batch.setGeometryAt(geoId, geometry);
            this.batch.computeBoundsTree(geoId);
            return;
        }
        if(geoId >= 0) this.release(index);
        let rv = Math.max(nv, Math.ceil(nv * 1.5)), ri = Math.max(ni, Math.ceil(ni * 1.5));
        this.ensureCapacity(rv, ri);
        geoId = this.batch.addGeometry(geometry, rv, ri);
        this.geoIds[index] = geoId;
        this.instIds[index] = this.batch.addInstance(geoId);
        this.batch.setMatrixAt(this.instIds[index], new THREE.Matrix4());
        this.reservedV[index] = rv;
        this.reservedI[index] = ri;
        this.batch.computeBoundsTree(geoId);
    }

    release(index) {
        let geoId = this.geoIds[index];
        this.batch.deleteGeometry(geoId); // also deletes its instance
        if(this.batch.boundsTrees) this.batch.boundsTrees[geoId] = null;
        this.wastedVerts += this.reservedV[index];
        this.geoIds[index] = -1;
        this.instIds[index] = -1;
        this.reservedV[index] = 0;
        this.reservedI[index] = 0;
        // Compact once dead ranges dominate; BVHs reference buffer ranges, so rebuild them all.
        if(this.wastedVerts > this.batch._nextVertexStart / 2 && this.wastedVerts > 4096) {
            this.batch.optimize();
            this.wastedVerts = 0;
            this.batch.disposeBoundsTree();
            this.batch.computeBoundsTree();
        }
    }

    ensureCapacity(nv, ni) {
        let b = this.batch;
        let maxV = b._maxVertexCount, maxI = b._maxIndexCount;
        let needV = b._nextVertexStart + nv, needI = b._nextIndexStart + ni;
        if(needV <= maxV && needI <= maxI) return;
        while(maxV < needV) maxV *= 2;
        while(maxI < needI) maxI *= 2;
        b.setGeometrySize(maxV, maxI);
        // The underlying buffers were replaced; rebuild every BVH against the new arrays.
        b.disposeBoundsTree();
        b.computeBoundsTree();
    }
}
