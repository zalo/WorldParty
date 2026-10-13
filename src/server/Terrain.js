/** Server-side terrain: a sparse map of CSG-modified chunks backed by
 *  Manifold (WASM). Unmodified chunks are implicit: solid 10m boxes below
 *  y=5, empty above. Chunks are indexed x*100 + y*10 + z over a 10x10x10 grid
 *  centred on the origin.
 *
 *  Each stored chunk carries an indexed mesh encoded with encodeChunkMesh()
 *  and a content hash used as its version. Clients fetch chunk bytes by
 *  version over HTTP and are told about new versions through the normal
 *  update stream. A stored chunk with a null manifold is an explicitly empty
 *  chunk (fully carved away). Chunks are keyed "x,y,z" (see terrain/grid.js);
 *  the world config says which unstored chunks are implicit rock.
 *
 *  Booleans here are purely local to a chunk. Which solid is grounded and
 *  which hollows are reachable is decided afterwards by Connectivity. */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ADDITION, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { M } from '../../assets/manifold-3d/manifold.js';
import manMod from '../../assets/manifold-3d/manifold.wasm';
import { decodeSoup, encodeChunkMesh, decodeChunkMesh, hashBytes, EMPTY_VERSION } from '../net/codec.js';
import { Transform, RigidBody, FragmentMesh } from '../ecs/components.js';
import { encodeSoup } from '../net/codec.js';
import { DEFAULT_MATERIAL, MAX_MATERIALS, clampMaterial, materialTable } from '../terrain/materials.js';

import { CHUNK_SIZE, DEFAULT_WORLD, chunkCenter, isRockKey, isValidKey, inBounds, coords, rockChunks, sanitizeWorld } from '../terrain/grid.js';
export { CHUNK_SIZE, chunkCenter };
const MAX_BRUSH_SCALE = 20;
/** Properties per Manifold vertex: position xyz + uv. Every manifold the server touches uses this layout. */
export const NUM_PROP = 5;

/** Split a Manifold mesh's interleaved properties into positions and uvs (zeros if it has none). */
export function splitProps(mesh) {
    let n = mesh.numProp, v = mesh.vertProperties, nv = v.length / n;
    let positions = new Float32Array(nv * 3), uvs = new Float32Array(nv * 2);
    for(let i = 0; i < nv; i++) {
        positions[i * 3] = v[i * n]; positions[i * 3 + 1] = v[i * n + 1]; positions[i * 3 + 2] = v[i * n + 2];
        if(n >= 5) { uvs[i * 2] = v[i * n + 3]; uvs[i * 2 + 1] = v[i * n + 4]; }
    }
    return { positions, uvs };
}
export function interleaveProps(positions, uvs) {
    let nv = positions.length / 3, out = new Float32Array(nv * NUM_PROP);
    for(let i = 0; i < nv; i++) {
        out[i * NUM_PROP] = positions[i * 3]; out[i * NUM_PROP + 1] = positions[i * 3 + 1]; out[i * NUM_PROP + 2] = positions[i * 3 + 2];
        if(uvs) { out[i * NUM_PROP + 3] = uvs[i * 2]; out[i * NUM_PROP + 4] = uvs[i * 2 + 1]; }
    }
    return out;
}
const MAX_BRUSH_FLOATS = 60000; // ~6.6k triangles

export class Terrain {
    constructor() {
        /** @type {Record<string, { key:string, version:string, bytes:Uint8Array|null, manifold:any|null }>} */
        this.chunks = {};
        /** @type {Set<string>} chunk keys changed since last takeDirty() */
        this.dirty = new Set();
        this.manifold = null;
        this.world = DEFAULT_WORLD;
    }

    async init(storedChunks = {}, world = null) {
        this.world = sanitizeWorld(world) || DEFAULT_WORLD;
        this.manifold = await M({
            instantiateWasm: (imports, callback) => {
                const instance = new WebAssembly.Instance(manMod, imports);
                callback(instance);
                return instance.exports;
            }
        });
        this.manifold.setup();
        // One Manifold original ID per material slot; booleans report which original each output triangle came from.
        this.materialBase = this.manifold.Manifold.reserveIDs(MAX_MATERIALS);
        for(let key in storedChunks) {
            let c = storedChunks[key];
            if(!isValidKey(key)) continue;
            if(c.bytes) {
                this.loadChunk(key, c.bytes, c.version);
            } else if(c.data) {
                // Legacy gzip+base64 triangle soup
                let manifold = this.withMaterial(this.soupToManifold(c.data), DEFAULT_MATERIAL);
                this.chunks[key] = { key, version: '', bytes: null, manifold };
                this._refresh(key);
                this.dirty.add(key);
            } else {
                this.chunks[key] = { key, version: EMPTY_VERSION, bytes: null, manifold: null };
            }
        }
    }

    /** Install a chunk from encoded bytes (storage or import); the version is the content hash. */
    loadChunk(key, bytes, version = null) {
        bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let mesh = decodeChunkMesh(bytes);
        let c = this.chunks[key];
        if(c && c.manifold) c.manifold.delete();
        let manifold;
        try { manifold = this.meshToManifold(mesh.positions, mesh.indices, mesh.materials, mesh.uvs); }
        catch(e) {
            // A chunk that cannot be rebuilt as a solid must not take the room down; it becomes empty.
            console.warn(`chunk ${key}: ${e.message}; dropped`);
            this.chunks[key] = { key, version: EMPTY_VERSION, bytes: null, manifold: null };
            this.dirty.add(key);
            return;
        }
        this.chunks[key] = { key, version: version || hashBytes(bytes), bytes, manifold };
    }

    /** Every chunk that can carry solid: implicit rock plus everything stored. */
    relevantKeys() {
        let out = new Set(rockChunks(this.world));
        for(let key in this.chunks) out.add(key);
        return out;
    }

    /** Replace a chunk's manifold (takes ownership; null = explicitly empty). */
    setManifold(key, manifold) {
        let c = this.chunks[key];
        if(c && c.manifold) c.manifold.delete();
        this.chunks[key] = { key, version: '', bytes: null, manifold };
        this._refresh(key);
        this.dirty.add(key);
    }

    /** A fresh copy of the implicit rock cube for a chunk (caller owns it). */
    rockManifold(key) {
        let p = chunkCenter(key);
        return this.withMaterial(this.manifold.Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(p.x, p.y, p.z), DEFAULT_MATERIAL);
    }

    /** Current manifold for a chunk, materializing the implicit default. Caller must not delete it. */
    currentManifold(key) {
        let c = this.chunks[key];
        if(c) return c.manifold;
        return isRockKey(this.world, key) ? this.rockManifold(key) : null;
    }

    /** {key: version} for every stored chunk. */
    versions() {
        let out = {};
        for(let key in this.chunks) out[key] = this.chunks[key].version;
        return out;
    }

    /** {key: version} for chunks changed since the last call. */
    takeDirty() {
        let out = {};
        for(let key of this.dirty) if(this.chunks[key]) out[key] = this.chunks[key].version;
        this.dirty.clear();
        return out;
    }

    /** Storage record for a chunk. */
    serializeChunk(key) {
        let c = this.chunks[key];
        return c ? { key: c.key, version: c.version, bytes: c.bytes } : undefined;
    }

    clear() {
        for(let key in this.chunks) if(this.chunks[key].manifold) this.chunks[key].manifold.delete();
        this.chunks = {};
        this.dirty.clear();
    }

    /** Indexed mesh for a chunk's collider, or null if the chunk is implicit/empty. */
    chunkMesh(key) {
        let c = this.chunks[key];
        return c && c.bytes ? decodeChunkMesh(c.bytes) : null;
    }

    /**
     * Apply a brush boolean to a set of chunks. `msg` is the client's `csg` payload:
     * { keys:["x,y,z", ...], brush: soup base64, operation, position, quaternion, scale }.
     * Changed chunks are added to `dirty`; grounding is Connectivity's job.
     */
    applyCsg(msg) {
        let op = parseInt(msg.operation);
        if(op !== ADDITION && op !== SUBTRACTION && op !== INTERSECTION) return;
        let s = msg.scale || { x: 1, y: 1, z: 1 };
        for(let k of ['x', 'y', 'z']) if(!Number.isFinite(s[k]) || Math.abs(s[k]) > MAX_BRUSH_SCALE) return;

        let soup = decodeSoup(msg.brush);
        if(soup.length > MAX_BRUSH_FLOATS || soup.length % 9 !== 0) return;
        let brush;
        try {
            brush = this.withMaterial(this.soupToManifold(msg.brush,
                new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z),
                new THREE.Quaternion(msg.quaternion.x, msg.quaternion.y, msg.quaternion.z, msg.quaternion.w),
                new THREE.Vector3(s.x, s.y, s.z)), clampMaterial(msg.material, materialTable(this.world).length));
        } catch(e) { console.warn('Rejected brush: ' + e.message); return; }

        let keys = [...new Set((msg.keys || []).filter(k => isValidKey(k) && inBounds(this.world, ...coords(k))))];
        for(let key of keys) this.applyToChunk(key, brush, op);
        brush.delete();
    }

    applyToChunk(key, brush, op) {
        let current = this.currentManifold(key); // owned by chunk record, or a fresh default cube
        let result;
        if(!current) {
            if(op !== ADDITION) return;              // carving empty space changes nothing
            result = brush.add(brush);               // copy (manifold ops return new objects)
        } else if(op === ADDITION) result = current.add(brush);
        else if(op === SUBTRACTION) result = current.subtract(brush);
        else result = current.intersect(brush);

        // Clip to the chunk's bounds (the cube carries the default material and empty UVs like everything else)
        let c = chunkCenter(key);
        let cube = this.withMaterial(this.manifold.Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(c.x, c.y, c.z), DEFAULT_MATERIAL);
        let clipped = result.intersect(cube);
        cube.delete(); result.delete();
        if(current && !this.chunks[key]) current.delete(); // materialized here; stored ones are deleted by setManifold
        this.setManifold(key, clipped);
    }

    /** Re-encode a chunk's bytes and version from its manifold. */
    _refresh(key) {
        let c = this.chunks[key];
        if(!c.manifold || c.manifold.isEmpty()) {
            if(c.manifold) { c.manifold.delete(); c.manifold = null; }
            c.bytes = null; c.version = EMPTY_VERSION;
            return;
        }
        let mesh = c.manifold.getMesh();
        let { positions, uvs } = splitProps(mesh);
        c.bytes = encodeChunkMesh(positions, new Uint32Array(mesh.triVerts), this.triangleMaterials(mesh), uvs);
        c.version = hashBytes(c.bytes);
    }

    /** Components for a dynamic fragment body: Transform at the centroid, body-local mesh soup. */
    fragmentComponents(manifold) {
        let mesh = manifold.getMesh();
        let v = splitProps(mesh).positions, tri = mesh.triVerts;
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
            if(id < 0 || id >= MAX_MATERIALS) id = DEFAULT_MATERIAL;
            let start = runIndex[r] / 3, end = (r + 1 < runIndex.length ? runIndex[r + 1] : mesh.triVerts.length) / 3;
            mats.fill(id, start, end);
        }
        return mats;
    }

    /** Rebuild a manifold whose every triangle belongs to one material (one run), with NUM_PROP
     *  properties per vertex (existing UVs kept, otherwise zero). Takes ownership of `manifold`. */
    withMaterial(manifold, material) {
        let m = manifold.getMesh();
        let { positions, uvs } = splitProps(m);
        let mesh = new this.manifold.Mesh({
            numProp: NUM_PROP,
            vertProperties: interleaveProps(positions, uvs),
            triVerts: new Uint32Array(m.triVerts),
            runIndex: new Uint32Array([0, m.triVerts.length]),
            runOriginalID: new Uint32Array([this.materialBase + material]),
        });
        manifold.delete();
        return new this.manifold.Manifold(mesh);
    }

    /** Manifold from an indexed mesh plus per-triangle materials (grouped into one run per material) and per-vertex UVs. */
    meshToManifold(positions, indices, materials, uvs = null) {
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
        let mesh = new this.manifold.Mesh({ numProp: NUM_PROP, vertProperties: interleaveProps(positions, uvs), triVerts, runIndex: new Uint32Array(runIndex), runOriginalID: new Uint32Array(runIds) });
        // Property vertices are split along UV seams and material boundaries; the merge vectors that
        // make them one manifold are not stored, so rebuild them from coincident positions.
        mesh.merge();
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
