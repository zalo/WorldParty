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
 *  which hollows are reachable is decided afterwards by Connectivity.
 *
 *  Bytes are the source of truth; only a few recently used chunks keep their
 *  Manifold object alive (RESIDENT_TRIS), everything else is rebuilt on
 *  demand through manifoldOf(). */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ADDITION, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { M } from '../../assets/manifold-3d/manifold.js';
import manMod from '../../assets/manifold-3d/manifold.wasm';
import { decodeSoup, packChunkMesh, unpackChunkMesh, decodeChunkMesh, decodeChunkMeshAsync, gzipAsync, hashBytes, EMPTY_VERSION } from '../net/codec.js';
import { gzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { Transform, RigidBody, FragmentMesh } from '../ecs/components.js';
import { encodeSoup, encodeHulls } from '../net/codec.js';
import { DEFAULT_MATERIAL, MAX_MATERIALS, MAX_HARDNESS, clampMaterial, materialTable } from '../terrain/materials.js';
import { MeshBVH } from 'three-mesh-bvh';
import { shatterMesh } from './Shatter.js';

import { CHUNK_SIZE, DEFAULT_WORLD, chunkCenter, chunkMin, chunkAt, isRockKey, isValidKey, inBounds, coords, rockChunks, sanitizeWorld } from '../terrain/grid.js';
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
/** Chunk manifolds kept alive in WASM memory. A Durable Object has 128 MB in total and a dense chunk's
 *  manifold costs a few MB, so only the most recently used chunks stay resident, up to a triangle budget
 *  (about 170 bytes of Manifold heap per triangle: the whole castle, 196k triangles, is 33 MB); the rest are
 *  rebuilt from their bytes when a carve or a connectivity summary needs them. A resident chunk also keeps
 *  its decoded mesh (27 bytes per triangle), the delta base and collider source for its next carve. */
export const RESIDENT_TRIS = 150_000;
/** Budget while a whole world is being settled at once (import, or a start without stored summaries): every
 *  chunk gets touched in turn, so a large budget would only raise the heap's peak (which never comes back). */
export const COLD_RESIDENT_TRIS = 50_000;
const HULL_CELL = 1.5;             // fragments are split into cells about this big, one convex hull each ...
const MAX_FRAGMENT_HULLS = 24;     // ... up to this many (cells grow for bigger fragments)
const HULL_MIN_VOLUME = 1e-3;      // slivers of a cell too small to matter get no hull

export class Terrain {
    constructor() {
        /** Chunk records. `bytes` is the gzip (storage, HTTP, full frames); right after a carve only `raw`
         *  (the uncompressed layout the version is hashed from) exists until compress() runs. `mesh` is the
         *  decoded mesh, kept while the chunk is resident; `prev` is the replaced content for a delta frame.
         *  @type {Record<string, { key:string, version:string, bytes:Uint8Array|null, raw:Uint8Array|null, manifold:any|null, tris:number,
         *    mesh?:{positions:Float32Array, uvs:Float32Array, indices:Uint32Array, materials:Uint8Array}|null,
         *    prev?:{ version:string, mesh:object|null, bytes:Uint8Array|null, raw:Uint8Array|null }|null }>} */
        this.chunks = {};
        /** @type {Set<string>} chunk keys changed since last takeDirty() */
        this.dirty = new Set();
        /** @type {string[]} keys whose manifold is resident, least recently used first */
        this.resident = [];
        this.residentTris = 0;
        this.residentBudget = RESIDENT_TRIS;
        this.manifold = null;
        this.wasmMemory = null;
        this.world = DEFAULT_WORLD;
    }

    /** Size of Manifold's WASM heap in MB (grows with peak use, never shrinks). */
    heapMB() { return this.wasmMemory ? this.wasmMemory.buffer.byteLength / 1048576 : 0; }

    async init(storedChunks = {}, world = null) {
        this.world = sanitizeWorld(world) || DEFAULT_WORLD;
        this.manifold = await M({
            instantiateWasm: (imports, callback) => {
                const instance = new WebAssembly.Instance(manMod, imports);
                this.wasmMemory = Object.values(instance.exports).find(e => e instanceof WebAssembly.Memory); // for memory diagnostics (the heap never shrinks)
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
                this.setManifold(key, this.withMaterial(this.soupToManifold(c.data), DEFAULT_MATERIAL));
            } else {
                this.chunks[key] = this._empty(key);
            }
        }
    }

    _empty(key) { return { key, version: EMPTY_VERSION, bytes: null, raw: null, manifold: null, tris: 0, mesh: null, prev: null }; }

    /** Does the chunk hold solid (stored bytes, compressed or not)? */
    hasSolid(key) { let c = this.chunks[key]; return !!(c && (c.bytes || c.raw)); }

    /** The chunk's gzip bytes, compressing now if a carve left them pending (storage, HTTP and full frames
     *  prefer compress(), which uses the native gzip). */
    bytesOf(key) {
        let c = this.chunks[key];
        if(!c) return null;
        if(!c.bytes && c.raw) { c.bytes = gzipSync(c.raw); c.raw = null; }
        return c.bytes;
    }

    /** Compress the chunks carved since their last compress(), with the platform gzip, off the carve path. */
    async compress(keys) {
        await Promise.all([...keys].map(async key => {
            let c = this.chunks[key];
            if(!c || c.bytes || !c.raw) return;
            let raw = c.raw, z = await gzipAsync(raw);
            if(this.chunks[key] === c && c.raw === raw) { c.bytes = z; c.raw = null; } // not re-carved meanwhile
        }));
    }

    /** Run `fn` with the small residency budget (whole-world settles), then restore the normal one. */
    cold(fn) {
        this.residentBudget = COLD_RESIDENT_TRIS;
        try { return fn(); } finally { this.residentBudget = RESIDENT_TRIS; }
    }

    /** Decode the stored bytes of chunks about to be carved that are not resident, with the native gunzip, so
     *  the synchronous rebuild in manifoldOf() only has the Manifold construction left to do. */
    async prepare(keys) {
        await Promise.all([...keys].map(async key => {
            let c = this.chunks[key];
            if(!c || c.manifold || c.mesh || !c.bytes) return;
            let mesh = await decodeChunkMeshAsync(c.bytes);
            if(this.chunks[key] === c && !c.mesh) c.mesh = mesh;
        }));
    }

    _decode(c) { return c.mesh || (c.raw ? unpackChunkMesh(c.raw) : decodeChunkMesh(c.bytes)); }

    /** Install a chunk from encoded bytes (storage or import); the version is the content hash. The manifold
     *  is built lazily by manifoldOf(). */
    loadChunk(key, bytes, version = null) {
        bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this._evict(key);
        this.chunks[key] = { ...this._empty(key), version: version || hashBytes(bytes), bytes };
    }

    /** The manifold of a stored chunk (null if the chunk is empty), rebuilt from its bytes if it is not
     *  resident. Owned by the chunk record: do not delete it, and do not hold it across other chunk lookups. */
    manifoldOf(key) {
        let c = this.chunks[key];
        if(!c || !(c.bytes || c.raw)) return null;
        if(!c.manifold) {
            let mesh = this._decode(c);
            try { c.manifold = this.meshToManifold(mesh.positions, mesh.indices, mesh.materials, mesh.uvs); }
            catch(e) {
                // A chunk that cannot be rebuilt as a solid must not take the room down; it becomes empty.
                console.warn(`chunk ${key}: ${e.message}; dropped`);
                this.chunks[key] = this._empty(key);
                this.dirty.add(key);
                return null;
            }
            c.mesh = mesh; c.tris = mesh.indices.length / 3;
        }
        this._touch(key);
        return c.manifold;
    }

    /** Mark a chunk's manifold as just used and drop the least recently used ones beyond the budget. */
    _touch(key) {
        let i = this.resident.indexOf(key);
        if(i >= 0) this.resident.splice(i, 1); else this.residentTris += this.chunks[key].tris || 0;
        this.resident.push(key);
        while(this.resident.length > 1 && this.residentTris > this.residentBudget) this._evict(this.resident[0]);
    }

    /** Free a chunk's manifold and decoded mesh (its bytes remain the source of truth). */
    _evict(key) {
        let i = this.resident.indexOf(key);
        let c = this.chunks[key];
        if(i >= 0) { this.resident.splice(i, 1); this.residentTris -= c?.tris || 0; }
        if(c) { if(c.manifold) { c.manifold.delete(); c.manifold = null; } c.mesh = null; }
    }

    /** Every chunk that can carry solid: implicit rock plus everything stored. */
    relevantKeys() {
        let out = new Set(rockChunks(this.world));
        for(let key in this.chunks) out.add(key);
        return out;
    }

    /** Replace a chunk's manifold (takes ownership; null = explicitly empty). */
    setManifold(key, manifold) {
        let old = this.chunks[key];
        let prev = old && (old.bytes || old.raw) ? { version: old.version, mesh: old.mesh || null, bytes: old.bytes, raw: old.raw } : null;
        this._evict(key);
        // The content being replaced is the base for a delta frame to clients holding it (until dropPrev)
        this.chunks[key] = { ...this._empty(key), version: '', manifold, prev };
        this._refresh(key);
        this.dirty.add(key);
        if(this.chunks[key].manifold) this._touch(key);
    }

    /** A fresh copy of the implicit rock cube for a chunk (caller owns it). */
    rockManifold(key) {
        let p = chunkCenter(key);
        return this.withMaterial(this.manifold.Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(p.x, p.y, p.z), DEFAULT_MATERIAL);
    }

    /** Current manifold for a chunk, materializing the implicit default. Caller must not delete it. */
    currentManifold(key) {
        if(this.chunks[key]) return this.manifoldOf(key);
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

    /** Storage record for a chunk (compressing now if compress() has not run yet). */
    serializeChunk(key) {
        let c = this.chunks[key];
        return c ? { key: c.key, version: c.version, bytes: this.bytesOf(key) } : undefined;
    }

    clear() {
        for(let key in this.chunks) if(this.chunks[key].manifold) this.chunks[key].manifold.delete();
        this.chunks = {};
        this.resident = []; this.residentTris = 0;
        this.dirty.clear();
    }

    /** Indexed mesh for a chunk's collider, or null if the chunk is implicit/empty: the resident decoded mesh
     *  when there is one, else decoded from its bytes (and not kept: only resident chunks cache meshes). */
    chunkMesh(key) {
        let c = this.chunks[key];
        if(!c || !(c.bytes || c.raw)) return null;
        return this._decode(c);
    }

    /** Forget the replaced content kept for delta frames since these chunks were refreshed. */
    dropPrev(keys) {
        for(let key of keys) { let c = this.chunks[key]; if(c) c.prev = null; }
    }

    /** Decoded mesh of the chunk's current content (cached while resident), or null. */
    currentMesh(key) {
        let c = this.chunks[key];
        if(!c || !(c.bytes || c.raw)) return null;
        if(!c.mesh) c.mesh = this._decode(c);
        return c.mesh;
    }

    /** The replaced content of a chunk as a decoded mesh, for a delta frame, or null if none is kept. */
    prevMesh(key) {
        let p = this.chunks[key]?.prev;
        if(!p) return null;
        return p.mesh || (p.mesh = p.raw ? unpackChunkMesh(p.raw) : decodeChunkMesh(p.bytes));
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
        // how far the brush may be simplified (m); the server's own round brushes ask for less so craters stay round
        let tolerance = typeof msg.tolerance === 'number' && msg.tolerance >= 0.005 && msg.tolerance <= 0.5 ? msg.tolerance : 0.1;
        let brush;
        try {
            brush = this.withMaterial(this.soupToManifold(msg.brush,
                new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z),
                new THREE.Quaternion(msg.quaternion.x, msg.quaternion.y, msg.quaternion.z, msg.quaternion.w),
                new THREE.Vector3(s.x, s.y, s.z), tolerance), clampMaterial(msg.material, materialTable(this.world).length));
        } catch(e) { console.warn('Rejected brush: ' + e.message); return; }

        let keys = [...new Set((msg.keys || []).filter(k => isValidKey(k) && inBounds(this.world, ...coords(k))))];
        for(let key of keys) this.applyToChunk(key, brush, op);
        brush.delete();
    }

    /** Apply a brush the server built itself (world space, materials already on its faces). Takes no ownership. */
    applyBrush(keys, brush, op) {
        keys = [...new Set(keys.filter(k => isValidKey(k) && inBounds(this.world, ...coords(k))))];
        for(let key of keys) this.applyToChunk(key, brush, op);
    }

    // ---- server carves that know what they cut ------------------------------------------------------------------

    /** What solid lies where around a carve, before it runs: the terrain's faces within a box, in a BVH (faces on a
     *  chunk plane are left out: those are the caps a clipped chunk closes itself with, not a surface). `ray` answers
     *  the first face along a ray within `far`: its distance, the material a cut behind it exposes (the face's `core`:
     *  grass is a skin over dirt, paving is laid on it) and the face's hardness (so a cobble floor resists a blast and
     *  the dirt under it does not). Built per carve; a crater's box holds a few hundred faces. */
    solidProbe(keys, min, max) {
        let table = materialTable(this.world), pos = [], mats = [], cores = [];
        for(let key of keys) {
            let mesh = this.currentMesh(key);
            if(!mesh) continue;
            let P = mesh.positions, I = mesh.indices, M = mesh.materials, cm = chunkMin(key);
            let lo = [cm.x + 1e-4, cm.y + 1e-4, cm.z + 1e-4], hi = [cm.x + CHUNK_SIZE - 1e-4, cm.y + CHUNK_SIZE - 1e-4, cm.z + CHUNK_SIZE - 1e-4];
            let bmin = [min.x, min.y, min.z], bmax = [max.x, max.y, max.z];
            for(let t = 0; t < I.length; t += 3) {
                let a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3, skip = false;
                for(let ax = 0; ax < 3 && !skip; ax++) {
                    let va = P[a + ax], vb = P[b + ax], vc = P[c + ax];
                    if(Math.max(va, vb, vc) < bmin[ax] || Math.min(va, vb, vc) > bmax[ax]) skip = true;
                    else if((va < lo[ax] && vb < lo[ax] && vc < lo[ax]) || (va > hi[ax] && vb > hi[ax] && vc > hi[ax])) skip = true;
                }
                if(skip) continue;
                pos.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
                let m = M ? M[t / 3] : DEFAULT_MATERIAL, core = table[m]?.core;
                mats.push(m); cores.push(Number.isInteger(core) && table[core] ? core : m);
            }
        }
        let hardness = (m) => Math.max(0.25, Math.min(MAX_HARDNESS, table[m]?.hardness ?? 1));
        let probe = { faces: mats.length, hardness, ray: () => null };
        if(!mats.length) return probe;
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
        let bvh = new MeshBVH(geometry, { targetLeafSize: 8 }); // indexes the soup itself, so face.a / 3 is the face
        let ray = new THREE.Ray();
        probe.ray = (o, d, far) => {
            ray.origin.set(o[0], o[1], o[2]); ray.direction.set(d[0], d[1], d[2]);
            let hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
            if(!hit) return null;
            let f = Math.floor(hit.face.a / 3);
            return { t: hit.distance, material: cores[f], hardness: hardness(mats[f]) };
        };
        return probe;
    }

    /** Pull a brush's vertices toward `origin` where they reach into hard material: along each vertex's ray from the
     *  origin, a brush that enters solid at t and would reach L keeps t + (L - t) / hardness. The brush must be
     *  star-shaped around the origin (a convex brush with the origin inside is), so moving vertices along their rays
     *  keeps it a valid solid. Takes ownership of `brush`. */
    harden(brush, origin, probe) {
        if(!probe.faces) return brush;
        let m = brush.getMesh(), n = m.numProp, v = m.vertProperties, o = [origin.x, origin.y, origin.z];
        let moved = false;
        for(let i = 0; i < v.length; i += n) {
            let d = [v[i] - o[0], v[i + 1] - o[1], v[i + 2] - o[2]], L = Math.hypot(d[0], d[1], d[2]);
            if(L < 1e-6) continue;
            d = [d[0] / L, d[1] / L, d[2] / L];
            let hit = probe.ray(o, d, L);
            if(!hit || hit.hardness <= 1) continue;
            let L2 = hit.t + (L - hit.t) / hit.hardness;
            v[i] = o[0] + d[0] * L2; v[i + 1] = o[1] + d[1] * L2; v[i + 2] = o[2] + d[2] * L2;
            moved = true;
        }
        if(!moved) return brush;
        brush.delete();
        return new this.manifold.Manifold(m);
    }

    /** Give a brush's faces the material each one cuts into, so a crater in a castle wall is stone and the same crater
     *  in a field is dirt: the core of the first terrain face on the way from `origin` (in air, inside the brush) to
     *  the face, which is where that ray entered the solid. A face with nothing on the way only cuts air (its material
     *  never shows) or rock that has no faces here (an untouched implicit rock chunk: the default material); `fallback`
     *  otherwise. Takes ownership of `brush`. */
    tagBrush(brush, origin, probe, fallback) {
        let m = brush.getMesh(), { positions } = splitProps(m), tri = m.triVerts, o = [origin.x, origin.y, origin.z];
        let materials = new Uint8Array(tri.length / 3);
        let toward = (p) => {
            let d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]], L = Math.hypot(d[0], d[1], d[2]);
            if(L < 1e-6) return null;
            return probe.ray(o, [d[0] / L, d[1] / L, d[2] / L], L);
        };
        for(let t = 0; t < materials.length; t++) {
            let a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
            let g = [(positions[a] + positions[b] + positions[c]) / 3, (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3, (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3];
            let hit = toward(g);
            // a big face may cut solid at a corner while its middle is in air
            for(let k = 0; k < 3 && !hit; k++) {
                let i = tri[t * 3 + k] * 3;
                hit = toward([positions[i] * 0.9 + g[0] * 0.1, positions[i + 1] * 0.9 + g[1] * 0.1, positions[i + 2] * 0.9 + g[2] * 0.1]);
            }
            if(hit) materials[t] = hit.material;
            else { let k = chunkAt(this.world, { x: g[0], y: g[1], z: g[2] }); materials[t] = k && !this.chunks[k] && isRockKey(this.world, k) ? DEFAULT_MATERIAL : fallback; }
        }
        brush.delete();
        return this.meshToManifold(positions, new Uint32Array(tri), materials);
    }

    /** A blast's brush (world space, tagged): the crater of Shatter.js, its reach along each direction shortened by
     *  the hardness of what it hits (a blast that meets solid at t after reaching R gets t + (R - t) / hardness
     *  along that line). Null if the diagram came out empty or not closed (never seen in 2000 tries). */
    blastBrush(center, R, probe, fallback) {
        let o = [center.x, center.y, center.z];
        let reachAt = (d) => { let hit = probe.ray(o, d, R); return hit ? hit.t + (R - hit.t) / hit.hardness : R; };
        let mesh = shatterMesh(center, reachAt);
        if(!mesh) return null;
        let brush = new this.manifold.Manifold(new this.manifold.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
        if(brush.isEmpty()) { brush.delete(); return null; }
        return this.tagBrush(brush, center, probe, fallback);
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

        // Only addition can leave the chunk's bounds; subtraction and intersection stay inside what was there,
        // so clipping them would be a second full boolean for nothing.
        if(op === ADDITION) {
            let c = chunkCenter(key);
            let cube = this.withMaterial(this.manifold.Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(c.x, c.y, c.z), DEFAULT_MATERIAL);
            let clipped = result.intersect(cube);
            cube.delete(); result.delete();
            result = clipped;
        }
        if(current && !this.chunks[key]) current.delete(); // materialized here; stored ones are deleted by setManifold
        this.setManifold(key, result);
    }

    /** Re-encode a chunk's content and version from its manifold (compressed later by compress()). */
    _refresh(key) {
        let c = this.chunks[key];
        if(!c.manifold || c.manifold.isEmpty()) {
            if(c.manifold) { c.manifold.delete(); c.manifold = null; }
            c.bytes = null; c.raw = null; c.mesh = null; c.tris = 0; c.version = EMPTY_VERSION;
            return;
        }
        let mesh = c.manifold.getMesh();
        let { positions, uvs } = splitProps(mesh);
        let indices = new Uint32Array(mesh.triVerts), materials = this.triangleMaterials(mesh);
        // No gzip here: the frame that follows is usually a delta, and the version hashes the raw layout.
        c.raw = packChunkMesh(positions, indices, materials, uvs);
        c.bytes = null;
        c.version = hashBytes(c.raw);
        c.mesh = { positions, uvs, indices, materials }; // collider cook and delta base for the next carve
        c.tris = indices.length / 3;
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
        let hulls = null;
        try { hulls = this.fragmentHulls(manifold, cx, cy, cz); } catch(e) { console.warn('fragment hulls failed: ' + e.message); }
        return {
            Transform: Transform({ position: { x: cx, y: cy, z: cz } }),
            RigidBody: RigidBody({ shape: 'trimesh', halfExtent }),
            FragmentMesh: FragmentMesh({ data: encodeSoup(soup), mats: Array.from(mats), hulls: hulls && hulls.length ? encodeHulls(hulls) : null }),
        };
    }

    /** Convex pieces approximating a fragment for PhysX: its bounding box is cut into cells of about HULL_CELL metres
     *  (at most MAX_FRAGMENT_HULLS, so big slabs get coarser cells) and each non-empty cell contributes the hull of
     *  its part. A compound of convex shapes simulates ~20x cheaper than a dynamic SDF triangle mesh and sleeps sooner,
     *  while keeping holes and overhangs at cell resolution. Points are body-local (relative to the centroid). */
    fragmentHulls(manifold, cx = 0, cy = 0, cz = 0) {
        let M = this.manifold.Manifold;
        let box = manifold.boundingBox(), min = box.min, max = box.max;
        let size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        let cell = HULL_CELL, n;
        for(;;) {
            n = size.map(sz => Math.max(1, Math.ceil(sz / cell - 1e-6)));
            if(n[0] * n[1] * n[2] <= MAX_FRAGMENT_HULLS) break;
            cell *= 1.25;
        }
        let pointsOf = m => { // hull vertices, body-local
            let h = m.hull(), mesh = h.getMesh(), np = mesh.numProp, v = mesh.vertProperties, nv = v.length / np;
            let pts = new Float32Array(nv * 3);
            for(let i = 0; i < nv; i++) { pts[i * 3] = v[i * np] - cx; pts[i * 3 + 1] = v[i * np + 1] - cy; pts[i * 3 + 2] = v[i * np + 2] - cz; }
            h.delete();
            return pts;
        };
        if(n[0] * n[1] * n[2] === 1) return [pointsOf(manifold)];
        let hulls = [];
        let step = size.map((sz, a) => sz / n[a]);
        for(let i = 0; i < n[0]; i++) for(let j = 0; j < n[1]; j++) for(let k = 0; k < n[2]; k++) {
            let cube = M.cube([step[0], step[1], step[2]], false).translate(min[0] + i * step[0], min[1] + j * step[1], min[2] + k * step[2]);
            let piece = manifold.intersect(cube);
            cube.delete();
            if(!piece.isEmpty() && piece.volume() > HULL_MIN_VOLUME) hulls.push(pointsOf(piece));
            piece.delete();
        }
        return hulls;
    }

    /** Hulls for a fragment stored before hulls existed: rebuild a manifold from its body-local soup. Returns null when
     *  the soup cannot be made manifold (the caller falls back to one hull of every vertex). */
    hullsFromSoup(base64) {
        let m;
        try { m = this.soupToManifold(base64); } catch { return null; }
        try { return m.isEmpty() ? null : this.fragmentHulls(m); } finally { m.delete(); }
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

    soupToManifold(base64, position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1), tolerance = 0.1) {
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
        let out = raw.simplify(tolerance); // returns a copy
        raw.delete();
        return out;
    }
}
