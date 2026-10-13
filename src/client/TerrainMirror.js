/** Client terrain mirror: one BatchedMesh holding every chunk's mesh, grown
 *  on demand instead of reserved up front, with a BVH per chunk for player
 *  collision and a version per chunk for content-addressed fetching.
 *
 *  The server decides what is worth holding (see server/Connectivity.js):
 *  updates carry `chunks` {index: version|null} for modified chunks to hold
 *  or drop, `rock` {index: faceMask} for the faces of untouched rock to draw,
 *  and `cull` {index: faceMask} for the boundary faces of a modified chunk
 *  that face nothing visible. Everything else costs nothing here. */
import * as THREE from 'three/webgpu';
import { decodeChunkMesh, EMPTY_VERSION } from '../net/codec.js';
import { materialColor, DEFAULT_MATERIAL } from '../terrain/materials.js';
import { GRID, CHUNK_COUNT, HALF, FACES, chunkCenter as gridCenter, isDefaultSolid } from '../terrain/grid.js';

export { GRID, CHUNK_COUNT, isDefaultSolid };
const INITIAL_VERTS = 1 << 16;
const PLANE_EPS = 1e-3;

export function chunkCenter(index) { let c = gridCenter(index); return new THREE.Vector3(c.x, c.y, c.z); }

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
        this.rockMask = new Int32Array(CHUNK_COUNT); // faces of untouched rock to draw
        this.cullMask = new Int32Array(CHUNK_COUNT); // boundary faces of a held modified chunk to skip
        this.versions = new Array(CHUNK_COUNT);      // version of each held modified chunk
        this.meshes = new Array(CHUNK_COUNT);        // decoded {positions, indices, materials} per held chunk
        this.bboxes = [];
        this.pending = new Map(); // index -> version being fetched
        this.wastedVerts = 0;
        this.fetchChunk = null;   // async (index, version) => Uint8Array|null, set by Main

        let half = new THREE.Vector3(HALF, HALF, HALF);
        for(let i = 0; i < CHUNK_COUNT; i++) {
            let c = chunkCenter(i);
            this.bboxes.push(new THREE.Box3(c.clone().sub(half), c.clone().add(half)));
        }
    }

    /** Apply decoded chunk bytes (or null for an explicitly empty chunk). */
    setChunk(index, bytes, version) {
        this.pending.delete(index);
        this.meshes[index] = bytes ? decodeChunkMesh(bytes) : null;
        this.versions[index] = bytes ? version : EMPTY_VERSION;
        this.rockMask[index] = 0;
        this.rebuild(index);
    }

    /** Drop a modified chunk we no longer need to hold. */
    unload(index) {
        this.pending.delete(index);
        this.meshes[index] = null;
        this.versions[index] = undefined;
        this.rebuild(index);
    }

    /** Rebuild a chunk's geometry from what we hold and the server's masks. */
    rebuild(index) {
        let geometry = null;
        if(this.rockMask[index]) geometry = this.rockFaces(index, this.rockMask[index]);
        else if(this.meshes[index]) geometry = this.culledGeometry(index, this.meshes[index], this.cullMask[index]);
        this.setGeometry(index, geometry);
    }

    /** Reconcile with an update's {chunks, rock, cull} maps; fetch what we lack. */
    applyUpdate(data, full = false) {
        let chunks = data.chunks || {}, rock = data.rock || {}, cull = data.cull || {};
        if(full) {
            for(let i = 0; i < CHUNK_COUNT; i++) {
                if(chunks[i] === undefined && (this.versions[i] !== undefined || this.pending.has(i))) this.unload(i);
                if(rock[i] === undefined && this.rockMask[i]) { this.rockMask[i] = 0; this.rebuild(i); }
            }
        }
        for(let key in cull) {
            let index = +key;
            if(this.cullMask[index] === cull[key]) continue;
            this.cullMask[index] = cull[key];
            if(this.meshes[index]) this.rebuild(index);
        }
        for(let key in rock) {
            let index = +key;
            if(this.rockMask[index] === rock[key]) continue;
            this.rockMask[index] = rock[key];
            this.rebuild(index);
        }
        for(let key in chunks) {
            let index = +key, version = chunks[key];
            if(version === null) { if(this.versions[index] !== undefined || this.pending.has(index)) this.unload(index); continue; }
            if(this.versions[index] === version || this.pending.get(index) === version) continue;
            if(version === EMPTY_VERSION) { this.setChunk(index, null, version); continue; }
            this.pending.set(index, version);
            Promise.resolve(this.fetchChunk?.(index, version)).then(bytes => {
                if(this.pending.get(index) !== version) return; // superseded or unloaded
                if(bytes) this.setChunk(index, bytes, version);
                else this.pending.delete(index);
            }).catch(e => { this.pending.delete(index); console.warn(`chunk ${index} fetch failed: ${e.message}`); });
        }
    }

    /** Quads for the exposed faces of an unmodified solid chunk. */
    rockFaces(index, mask) {
        let c = gridCenter(index);
        let center = [c.x, c.y, c.z];
        let positions = [], indices = [];
        for(let f = 0; f < 6; f++) {
            if(!(mask & (1 << f))) continue;
            let { axis, dir } = FACES[f];
            let u = (axis + 1) % 3, v = (axis + 2) % 3; // u x v = axis
            let base = positions.length / 3;
            for(let [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                let p = [0, 0, 0];
                p[axis] = center[axis] + dir * HALF;
                p[u] = center[u] + s * HALF;
                p[v] = center[v] + t * HALF;
                positions.push(p[0], p[1], p[2]);
            }
            if(dir > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            else indices.push(base + 1, base, base + 2, base + 2, base, base + 3);
        }
        return this.buildGeometry(new Float32Array(positions), new Uint32Array(indices), null);
    }

    /** A modified chunk's mesh minus the triangles lying flat on a boundary face in `hidden`. */
    culledGeometry(index, mesh, hidden) {
        let { positions, indices, materials } = mesh;
        if(!hidden) return this.buildGeometry(positions, indices, materials);
        let c = gridCenter(index);
        let center = [c.x, c.y, c.z];
        let numTris = indices.length / 3;
        let keepIdx = [], keepMat = [];
        for(let t = 0; t < numTris; t++) {
            let a = indices[t * 3], b = indices[t * 3 + 1], d = indices[t * 3 + 2];
            let onHidden = false;
            for(let f = 0; f < 6 && !onHidden; f++) {
                if(!(hidden & (1 << f))) continue;
                let { axis, dir } = FACES[f];
                let plane = center[axis] + dir * HALF;
                onHidden = Math.abs(positions[a * 3 + axis] - plane) < PLANE_EPS
                        && Math.abs(positions[b * 3 + axis] - plane) < PLANE_EPS
                        && Math.abs(positions[d * 3 + axis] - plane) < PLANE_EPS;
            }
            if(onHidden) continue;
            keepIdx.push(a, b, d);
            keepMat.push(materials ? materials[t] : DEFAULT_MATERIAL);
        }
        if(!keepIdx.length) return null;
        return this.buildGeometry(positions, new Uint32Array(keepIdx), new Uint8Array(keepMat));
    }

    /** Expand an indexed mesh to flat triangles with a per-face material color.
     *  (Per-face attributes need unshared vertices; a sequential index keeps the batch's indexed layout.) */
    buildGeometry(positions, indices, materials) {
        let numTris = indices.length / 3;
        let pos = new Float32Array(numTris * 9);
        let col = new Float32Array(numTris * 9);
        let idx = new Uint32Array(numTris * 3);
        let color = new THREE.Color();
        for(let t = 0; t < numTris; t++) {
            color.setHex(materialColor(materials ? materials[t] : DEFAULT_MATERIAL));
            for(let k = 0; k < 3; k++) {
                let v = indices[t * 3 + k], o = t * 9 + k * 3;
                pos[o] = positions[v * 3]; pos[o + 1] = positions[v * 3 + 1]; pos[o + 2] = positions[v * 3 + 2];
                col[o] = color.r; col[o + 1] = color.g; col[o + 2] = color.b;
                idx[t * 3 + k] = t * 3 + k;
            }
        }
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geometry.setIndex(new THREE.BufferAttribute(idx, 1));
        geometry.computeVertexNormals();
        return geometry;
    }

    /** Resource summary for diagnostics. */
    stats() {
        let chunks = 0, tris = 0, rock = 0, held = 0;
        for(let i = 0; i < CHUNK_COUNT; i++) {
            if(this.rockMask[i]) rock++;
            if(this.meshes[i]) held++;
            if(this.geoIds[i] >= 0) { chunks++; tris += this.batch._geometryInfo[this.geoIds[i]].indexCount / 3; }
        }
        return { chunks, tris, rock, held, pending: this.pending.size, vertexCapacity: this.batch._maxVertexCount, vertexUsed: this.batch._nextVertexStart };
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
