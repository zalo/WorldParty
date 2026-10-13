/** Server-side terrain: a sparse map of CSG-modified chunks backed by
 *  Manifold (WASM). Unmodified chunks are implicit: solid 10m boxes below
 *  y=5, empty above. Chunks are indexed x*100 + y*10 + z over a 10x10x10 grid
 *  centred on the origin.
 *
 *  Each stored chunk carries an indexed mesh encoded with encodeChunkMesh()
 *  and a content hash used as its version. Clients fetch chunk bytes by
 *  version over HTTP and are told about new versions through the normal
 *  update stream. A stored chunk with a null manifold is an explicitly empty
 *  chunk (fully carved away). */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ADDITION, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { M } from '../../assets/manifold-3d/manifold.js';
import manMod from '../../assets/manifold-3d/manifold.wasm';
import { decodeSoup, encodeChunkMesh, decodeChunkMesh, hashBytes, EMPTY_VERSION } from '../net/codec.js';
import { Transform, RigidBody, FragmentMesh } from '../ecs/components.js';
import { encodeSoup } from '../net/codec.js';
import { MATERIALS, DEFAULT_MATERIAL, clampMaterial } from '../terrain/materials.js';

import { GRID, CHUNK_SIZE, SOLID_BELOW_Y, CHUNK_COUNT, chunkCoords, chunkCenter, isDefaultSolid, neighbour, exposedFaces } from '../terrain/grid.js';
export { GRID, CHUNK_SIZE, SOLID_BELOW_Y, CHUNK_COUNT, chunkCoords, chunkCenter, isDefaultSolid };
const MAX_BRUSH_SCALE = 20;
const MAX_BRUSH_FLOATS = 60000; // ~6.6k triangles

export class Terrain {
    constructor() {
        /** @type {Record<number, { index:number, version:string, bytes:Uint8Array|null, manifold:any|null }>} */
        this.chunks = {};
        /** @type {Set<number>} chunk indices changed since last takeDirty() */
        this.dirty = new Set();
        this.manifold = null;
    }

    async init(storedChunks = {}) {
        this.manifold = await M({
            instantiateWasm: (imports, callback) => {
                const instance = new WebAssembly.Instance(manMod, imports);
                callback(instance);
                return instance.exports;
            }
        });
        this.manifold.setup();
        // One Manifold original ID per material; booleans report which original each output triangle came from.
        this.materialBase = this.manifold.Manifold.reserveIDs(MATERIALS.length);
        for(let key in storedChunks) {
            let c = storedChunks[key];
            let index = c.index;
            if(c.bytes) {
                let bytes = c.bytes instanceof Uint8Array ? c.bytes : new Uint8Array(c.bytes);
                let mesh = decodeChunkMesh(bytes);
                this.chunks[index] = { index, version: c.version || hashBytes(bytes), bytes, manifold: this.meshToManifold(mesh.positions, mesh.indices, mesh.materials) };
            } else if(c.data) {
                // Legacy gzip+base64 triangle soup
                let manifold = this.withMaterial(this.soupToManifold(c.data), DEFAULT_MATERIAL);
                this.chunks[index] = { index, version: '', bytes: null, manifold };
                this._refresh(index);
                this.dirty.add(index);
            } else {
                this.chunks[index] = { index, version: EMPTY_VERSION, bytes: null, manifold: null };
            }
        }
    }

    /** True if the chunk has terrain (either implicit solid or a stored manifold). */
    hasTerrain(index) {
        let c = this.chunks[index];
        return c ? !!c.manifold : isDefaultSolid(index);
    }

    /** True if the chunk is untouched solid rock (no stored record, below the surface). */
    isUnmodifiedSolid(index) { return !this.chunks[index] && isDefaultSolid(index); }

    /** Bitmask of faces of an unmodified solid chunk that border anything other than
     *  unmodified rock; 0 means fully buried, so nothing can touch it. */
    exposure(index) { return exposedFaces(index, i => this.isUnmodifiedSolid(i)); }

    /** Indices of unmodified solid chunks that are at least partly exposed. */
    exposedDefaults() {
        let out = [];
        for(let index = 0; index < CHUNK_COUNT; index++) {
            if(this.isUnmodifiedSolid(index) && this.exposure(index)) out.push(index);
        }
        return out;
    }

    /** Unmodified solid neighbours of a chunk (the ones a change here could expose). */
    defaultNeighbours(index) {
        let out = [];
        for(let f = 0; f < 6; f++) { let n = neighbour(index, f); if(n >= 0 && this.isUnmodifiedSolid(n)) out.push(n); }
        return out;
    }

    /** Current manifold for a chunk, materializing the implicit default. Caller must not delete it. */
    currentManifold(index) {
        let c = this.chunks[index];
        if(c) return c.manifold;
        if(!isDefaultSolid(index)) return null;
        let p = chunkCenter(index);
        return this.withMaterial(this.manifold.Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(p.x, p.y, p.z), DEFAULT_MATERIAL);
    }

    /** {index: version} for every stored chunk (full updates). */
    versions() {
        let out = {};
        for(let key in this.chunks) out[key] = this.chunks[key].version;
        return out;
    }

    /** {index: version} for chunks changed since the last call. */
    takeDirty() {
        let out = {};
        for(let index of this.dirty) if(this.chunks[index]) out[index] = this.chunks[index].version;
        this.dirty.clear();
        return out;
    }

    /** Storage record for a chunk. */
    serializeChunk(index) {
        let c = this.chunks[index];
        return c ? { index: c.index, version: c.version, bytes: c.bytes } : undefined;
    }

    clear() {
        for(let key in this.chunks) if(this.chunks[key].manifold) this.chunks[key].manifold.delete();
        this.chunks = {};
        this.dirty.clear();
    }

    /** Indexed mesh for a chunk's collider, or null if the chunk is implicit/empty. */
    chunkMesh(index) {
        let c = this.chunks[index];
        return c && c.bytes ? decodeChunkMesh(c.bytes) : null;
    }

    /**
     * Apply a brush boolean to a set of chunks. `msg` is the client's `csg` payload:
     * { indices:[...], brush: soup base64, operation, position, quaternion, scale }.
     * Returns component bags for floating fragments (to become entities).
     */
    applyCsg(msg) {
        let op = parseInt(msg.operation);
        if(op !== ADDITION && op !== SUBTRACTION && op !== INTERSECTION) return [];
        let s = msg.scale || { x: 1, y: 1, z: 1 };
        for(let k of ['x', 'y', 'z']) if(!Number.isFinite(s[k]) || Math.abs(s[k]) > MAX_BRUSH_SCALE) return [];

        let soup = decodeSoup(msg.brush);
        if(soup.length > MAX_BRUSH_FLOATS || soup.length % 9 !== 0) return [];
        let brush;
        try {
            brush = this.withMaterial(this.soupToManifold(msg.brush,
                new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z),
                new THREE.Quaternion(msg.quaternion.x, msg.quaternion.y, msg.quaternion.z, msg.quaternion.w),
                new THREE.Vector3(s.x, s.y, s.z)), clampMaterial(msg.material));
        } catch(e) { console.warn('Rejected brush: ' + e.message); return []; }

        let fragments = [];
        let indices = [...new Set((msg.indices || []).map(i => i | 0).filter(i => i >= 0 && i < CHUNK_COUNT))];
        for(let index of indices) fragments.push(...this.applyToChunk(index, brush, op));
        brush.delete();
        return fragments;
    }

    applyToChunk(index, brush, op) {
        let current = this.currentManifold(index); // owned by chunk record, or a fresh default cube
        let owned = !this.chunks[index];            // true if `current` was materialized here
        let result;
        if(!current) {
            if(op !== ADDITION) return [];           // carving empty space changes nothing
            result = brush.add(brush);               // copy (manifold ops return new objects)
        } else if(op === ADDITION) result = current.add(brush);
        else if(op === SUBTRACTION) result = current.subtract(brush);
        else result = current.intersect(brush);

        // Clip to the chunk's bounds
        let c = chunkCenter(index);
        let cube = this.manifold.Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(c.x, c.y, c.z);
        let clipped = result.intersect(cube);
        cube.delete(); result.delete();
        if(current && (owned || this.chunks[index])) current.delete();

        let fragments = [];
        let terrain = null;
        if(clipped.isEmpty()) {
            clipped.delete();
        } else {
            let islands = clipped.decompose();
            if(islands.length <= 1) {
                for(let i of islands) i.delete();
                terrain = clipped;
            } else {
                // Largest island is always terrain; smaller ones stay only if grounded.
                let info = islands.map((m, idx) => ({ idx, volume: m.volume() })).sort((a, b) => b.volume - a.volume);
                let keep = [islands[info[0].idx]];
                for(let j = 1; j < info.length; j++) {
                    let island = islands[info[j].idx];
                    if(info[j].volume < 0.01) { island.delete(); continue; }
                    if(this.isIslandGrounded(island, index)) keep.push(island);
                    else fragments.push(island);
                }
                terrain = keep[0];
                for(let i = 1; i < keep.length; i++) {
                    let next = terrain.add(keep[i]);
                    terrain.delete(); keep[i].delete();
                    terrain = next;
                }
                clipped.delete();
                console.log(`Decomposed chunk ${index}: ${islands.length} islands, ${keep.length} grounded, ${fragments.length} floating`);
            }
        }

        this.chunks[index] = { index, version: '', bytes: null, manifold: terrain };
        this._refresh(index);
        this.dirty.add(index);

        let out = [];
        for(let frag of fragments) { let comps = this.fragmentComponents(frag); frag.delete(); if(comps) out.push(comps); }
        return out;
    }

    /** Re-encode a chunk's bytes and version from its manifold. */
    _refresh(index) {
        let c = this.chunks[index];
        if(!c.manifold || c.manifold.isEmpty()) {
            if(c.manifold) { c.manifold.delete(); c.manifold = null; }
            c.bytes = null; c.version = EMPTY_VERSION;
            return;
        }
        let mesh = c.manifold.getMesh();
        c.bytes = encodeChunkMesh(new Float32Array(mesh.vertProperties), new Uint32Array(mesh.triVerts), this.triangleMaterials(mesh));
        c.version = hashBytes(c.bytes);
    }

    /** An island is grounded if it touches a chunk face whose neighbour has terrain. */
    isIslandGrounded(island, index) {
        let { x, y, z } = chunkCoords(index);
        let verts = island.getMesh().vertProperties;
        let n = verts.length / 3;
        let eps = 0.15;
        let faces = [
            [0, x * 10 - 50, x - 1, y, z], [0, x * 10 - 40, x + 1, y, z],
            [1, y * 10 - 50, x, y - 1, z], [1, y * 10 - 40, x, y + 1, z],
            [2, z * 10 - 50, x, y, z - 1], [2, z * 10 - 40, x, y, z + 1],
        ];
        for(let [axis, boundary, nx, ny, nz] of faces) {
            if(nx < 0 || nx >= GRID || ny < 0 || ny >= GRID || nz < 0 || nz >= GRID) continue;
            if(!this.hasTerrain(nx * 100 + ny * 10 + nz)) continue;
            for(let i = 0; i < n; i++) if(Math.abs(verts[i * 3 + axis] - boundary) < eps) return true;
        }
        return false;
    }

    /** Components for a dynamic fragment body: Transform at the centroid, body-local mesh soup. */
    fragmentComponents(manifold) {
        let mesh = manifold.getMesh();
        let v = mesh.vertProperties, tri = mesh.triVerts;
        let numVerts = v.length / 3, numTris = tri.length / 3;
        if(numVerts < 4 || numTris < 1) return null;
        let mats = this.triangleMaterials(mesh);

        let cx = 0, cy = 0, cz = 0;
        for(let i = 0; i < numVerts; i++) { cx += v[i * 3]; cy += v[i * 3 + 1]; cz += v[i * 3 + 2]; }
        cx /= numVerts; cy /= numVerts; cz /= numVerts;

        let soup = new Float32Array(numTris * 9);
        let halfExtent = 0;
        for(let t = 0; t < numTris; t++) {
            for(let k = 0; k < 3; k++) {
                let i = tri[t * 3 + k];
                let lx = v[i * 3] - cx, ly = v[i * 3 + 1] - cy, lz = v[i * 3 + 2] - cz;
                soup[t * 9 + k * 3] = lx; soup[t * 9 + k * 3 + 1] = ly; soup[t * 9 + k * 3 + 2] = lz;
                halfExtent = Math.max(halfExtent, Math.abs(lx), Math.abs(ly), Math.abs(lz));
            }
        }
        return {
            Transform: Transform({ position: { x: cx, y: cy, z: cz } }),
            RigidBody: RigidBody({ shape: 'trimesh', halfExtent }),
            FragmentMesh: FragmentMesh({ data: encodeSoup(soup), mats: Array.from(mats) }),
        };
    }

    // ---- codecs -----------------------------------------------------------

    /** Per-triangle material ids from a mesh's runs (runOriginalID - materialBase). */
    triangleMaterials(mesh) {
        let numTris = mesh.triVerts.length / 3;
        let mats = new Uint8Array(numTris);
        let runIndex = mesh.runIndex, runIds = mesh.runOriginalID;
        if(!runIndex || !runIds) return mats;
        for(let r = 0; r < runIds.length; r++) {
            let id = runIds[r] - this.materialBase;
            if(id < 0 || id >= MATERIALS.length) id = DEFAULT_MATERIAL;
            let start = runIndex[r] / 3, end = (r + 1 < runIndex.length ? runIndex[r + 1] : mesh.triVerts.length) / 3;
            mats.fill(id, start, end);
        }
        return mats;
    }

    /** Rebuild a manifold whose every triangle belongs to one material (one run). Takes ownership of `manifold`. */
    withMaterial(manifold, material) {
        let m = manifold.getMesh();
        let mesh = new this.manifold.Mesh({
            numProp: 3,
            vertProperties: new Float32Array(m.vertProperties),
            triVerts: new Uint32Array(m.triVerts),
            runIndex: new Uint32Array([0, m.triVerts.length]),
            runOriginalID: new Uint32Array([this.materialBase + material]),
        });
        manifold.delete();
        return new this.manifold.Manifold(mesh);
    }

    /** Manifold from an indexed mesh plus per-triangle materials, grouped into one run per material. */
    meshToManifold(positions, indices, materials) {
        let numTris = indices.length / 3;
        let order = Array.from({ length: numTris }, (_, i) => i);
        if(materials) order.sort((a, b) => materials[a] - materials[b] || a - b);
        let triVerts = new Uint32Array(indices.length);
        let runIndex = [], runIds = [];
        let last = -1;
        for(let k = 0; k < numTris; k++) {
            let t = order[k];
            let mat = materials ? materials[t] : DEFAULT_MATERIAL;
            if(mat !== last) { runIndex.push(k * 3); runIds.push(this.materialBase + mat); last = mat; }
            triVerts[k * 3] = indices[t * 3]; triVerts[k * 3 + 1] = indices[t * 3 + 1]; triVerts[k * 3 + 2] = indices[t * 3 + 2];
        }
        runIndex.push(indices.length);
        let mesh = new this.manifold.Mesh({ numProp: 3, vertProperties: new Float32Array(positions), triVerts, runIndex: new Uint32Array(runIndex), runOriginalID: new Uint32Array(runIds) });
        return new this.manifold.Manifold(mesh);
    }

    soupToManifold(base64, position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1)) {
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(decodeSoup(base64), 3));
        geometry = mergeVertices(geometry, 1e-4);
        let positions = geometry.attributes.position.array;
        let matrix = new THREE.Matrix4().compose(position, quaternion, scale);
        let vertProperties = new Float32Array(positions.length);
        let vertex = new THREE.Vector3();
        for(let i = 0; i < positions.length; i += 3) {
            vertex.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
            vertProperties[i] = vertex.x; vertProperties[i + 1] = vertex.y; vertProperties[i + 2] = vertex.z;
        }
        let mesh = new this.manifold.Mesh({ numProp: 3, vertProperties, triVerts: new Uint32Array(geometry.index.array) });
        let raw = new this.manifold.Manifold(mesh);
        let out = raw.simplify(0.1); // returns a copy
        raw.delete();
        return out;
    }
}
