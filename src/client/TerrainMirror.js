/** Client terrain mirror: one Mesh per held chunk under a single Group (a
 *  few hundred draw calls at most, and no shared-buffer bookkeeping to get
 *  wrong), with a BVH per chunk for player collision and a version per
 *  chunk for content-addressed fetching.
 *
 *  Chunks are keyed "x,y,z" over a sparse world (see terrain/grid.js); the
 *  world config arrives with the first full update. The server decides what
 *  is worth holding (see server/Connectivity.js): updates carry `chunks`
 *  {key: version|null} for modified chunks to hold or drop, `rock`
 *  {key: faceMask} for the faces of untouched rock to draw, and `cull`
 *  {key: faceMask} for the boundary faces of a modified chunk that face
 *  nothing visible. Everything else costs nothing here. */
import * as THREE from 'three/webgpu';
import { decodeChunkMesh, decodeChunkMeshAsync, decodeChunkDelta, EMPTY_VERSION } from '../net/codec.js';
import { materialColor, materialTable, DEFAULT_MATERIAL } from '../terrain/materials.js';
import { CHUNK_SIZE, HALF, FACES, DEFAULT_WORLD, chunkCenter as gridCenter, chunkMin, chunksInBox, sanitizeWorld } from '../terrain/grid.js';

export { CHUNK_SIZE };
const PLANE_EPS = 1e-3;

export function chunkCenter(key) { let c = gridCenter(key); return new THREE.Vector3(c.x, c.y, c.z); }

const SMOOTH_ANGLE = Math.cos(70 * Math.PI / 180); // faces of smooth materials meeting within this blend their normals

/** Flat-triangle geometry for terrain (chunks and fragments alike): see TerrainMirror.buildGeometry. Normals are
 *  per face, except across adjacent faces of smooth materials (carved dirt, sand) within SMOOTH_ANGLE, which blend
 *  so a crater reads as a bowl rather than a cut gem. */
export function buildTerrainGeometry(positions, indices, materials, uvs, table, layers) {
    let numTris = indices.length / 3;
    // face normals, and which faces meet at each vertex position (vertices are shared by index in the chunk mesh,
    // but seams split them, so group by position)
    let faceN = new Float32Array(numTris * 3), smoothFace = new Uint8Array(numTris);
    let byPos = new Map();
    for(let t = 0; t < numTris; t++) {
        let a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
        let ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        let vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
        faceN[t * 3] = nx / l; faceN[t * 3 + 1] = ny / l; faceN[t * 3 + 2] = nz / l;
        let id = materials ? materials[t] : DEFAULT_MATERIAL, m = table[id] || table[DEFAULT_MATERIAL];
        smoothFace[t] = m.smooth && l > 1e-9 ? 1 : 0;
        if(!smoothFace[t]) continue;
        for(let k = 0; k < 3; k++) { let v = indices[t * 3 + k] * 3, key = positions[v].toFixed(4) + ',' + positions[v + 1].toFixed(4) + ',' + positions[v + 2].toFixed(4); let list = byPos.get(key); if(list) list.push(t); else byPos.set(key, [t]); }
    }
    let nrm = new Float32Array(numTris * 9);
    let pos = new Float32Array(numTris * 9);
    let col = new Float32Array(numTris * 9);
    let uv = new Float32Array(numTris * 6);
    let slot = new Float32Array(numTris * 3);
    let tile = new Float32Array(numTris * 3);
    let idx = new Uint32Array(numTris * 3);
    let color = new THREE.Color();
    for(let t = 0; t < numTris; t++) {
        let id = materials ? materials[t] : DEFAULT_MATERIAL;
        let m = table[id] || table[DEFAULT_MATERIAL];
        let layer = layers.has(id) ? layers.get(id) : -1;
        // a textured face carries its colour only as a tint; flat faces carry it as the colour itself
        color.setHex(layer >= 0 && !m.tint ? 0xffffff : m.color);
        let tiling = layer >= 0 && m.scale ? 1 / m.scale : 0;
        for(let k = 0; k < 3; k++) {
            let v = indices[t * 3 + k], o = t * 9 + k * 3, i = t * 3 + k;
            pos[o] = positions[v * 3]; pos[o + 1] = positions[v * 3 + 1]; pos[o + 2] = positions[v * 3 + 2];
            col[o] = color.r; col[o + 1] = color.g; col[o + 2] = color.b;
            let nx = faceN[t * 3], ny = faceN[t * 3 + 1], nz = faceN[t * 3 + 2];
            if(smoothFace[t]) {
                let list = byPos.get(positions[v * 3].toFixed(4) + ',' + positions[v * 3 + 1].toFixed(4) + ',' + positions[v * 3 + 2].toFixed(4));
                let sx = 0, sy = 0, sz = 0;
                for(let f of list) { let fx = faceN[f * 3], fy = faceN[f * 3 + 1], fz = faceN[f * 3 + 2]; if(fx * nx + fy * ny + fz * nz >= SMOOTH_ANGLE) { sx += fx; sy += fy; sz += fz; } }
                let l = Math.hypot(sx, sy, sz); if(l > 1e-6) { nx = sx / l; ny = sy / l; nz = sz / l; }
            }
            nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
            if(uvs) { uv[i * 2] = uvs[v * 2]; uv[i * 2 + 1] = uvs[v * 2 + 1]; }
            slot[i] = layer; tile[i] = tiling;
            idx[i] = i;
        }
    }
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('slot', new THREE.BufferAttribute(slot, 1));
    geometry.setAttribute('tile', new THREE.BufferAttribute(tile, 1));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    return geometry;
}

/** Bounds of the vertices one mesh has and the other lacks (what a carve added or took away), or null when there is
 *  no old mesh to compare with. Listeners (the probe grid, the glow volume) redo only that much of the chunk instead
 *  of all of it: a 1.6 m drill bite marked every probe around the whole 10 m chunk dirty. Positions are hashed at a
 *  millimetre; a collision can only make the box a little smaller than the truth. */
function changedBox(prev, next) {
    if(!prev || !next) return null;
    const hash = (P, i) => (Math.round(P[i] * 1000) * 73856093) ^ (Math.round(P[i + 1] * 1000) * 19349663) ^ (Math.round(P[i + 2] * 1000) * 83492791);
    let box = new THREE.Box3(), seen = new Set();
    let a = prev.positions, b = next.positions;
    for(let i = 0; i < a.length; i += 3) seen.add(hash(a, i));
    let mine = new Set(), v = new THREE.Vector3();
    for(let i = 0; i < b.length; i += 3) { let h = hash(b, i); mine.add(h); if(!seen.has(h)) box.expandByPoint(v.set(b[i], b[i + 1], b[i + 2])); }
    for(let i = 0; i < a.length; i += 3) if(!mine.has(hash(a, i))) box.expandByPoint(v.set(a[i], a[i + 1], a[i + 2]));
    return box.isEmpty() ? null : box;
}

export class TerrainMirror {
    constructor(scene, material) {
        this.scene = scene;
        this.material = material;
        this.world = DEFAULT_WORLD;
        this.table = materialTable(this.world);
        this.layers = new Map();     // material id -> texture array layer (see TerrainTextures)
        this.rockMask = new Map();  // key -> faces of untouched rock to draw
        this.cullMask = new Map();  // key -> boundary faces of a held modified chunk to skip
        this.versions = new Map();  // key -> version of each held modified chunk
        this.meshes = new Map();    // key -> decoded {positions, indices, materials}
        this.pending = new Map();   // key -> version being fetched
        this.boxes = new Map();     // key -> Box3 (cached)
        this.fetchChunk = null;     // async (key, version) => Uint8Array|null, set by Main
        this.onChunkChanged = null; // (key, box|null) => void, after a chunk's content changed (not mere visibility); box bounds what changed
        this.onWorldChanged = null; // (world) => void, after a new world config is adopted
        this.group = new THREE.Group();
        this.group.name = 'terrain';
        this.scene.add(this.group);
        this.objects = new Map();   // key -> Mesh
    }

    /** Adopt the server's world config (bounds, implicit rock). */
    configure(world) {
        let w = sanitizeWorld(world);
        if(!w) return;
        let geometryOf = ({ gravity, ...rest }) => JSON.stringify(rest); // body gravity is the server's business
        let changed = geometryOf(w) !== geometryOf(this.world);
        this.world = w;
        this.table = materialTable(w);
        if(changed) this.onWorldChanged?.(w);
    }

    /** Texture layers became available (or changed): rebuild every held chunk's slot attribute. */
    setTextureLayers(layers) {
        this.layers = layers;
        for(let key of this.meshes.keys()) this.rebuild(key);
    }

    /** World-space bounds of a chunk. */
    bbox(key) {
        let b = this.boxes.get(key);
        if(!b) {
            let m = chunkMin(key);
            b = new THREE.Box3(new THREE.Vector3(m.x, m.y, m.z), new THREE.Vector3(m.x + CHUNK_SIZE, m.y + CHUNK_SIZE, m.z + CHUNK_SIZE));
            this.boxes.set(key, b);
        }
        return b;
    }

    /** Keys of in-bounds chunks whose bounds intersect `box`. */
    intersecting(box) { return chunksInBox(this.world, box.min, box.max); }

    /** Apply chunk bytes (or null for an explicitly empty chunk). */
    setChunk(key, bytes, version) {
        this.setChunkMesh(key, bytes ? decodeChunkMesh(bytes) : null, bytes ? version : EMPTY_VERSION);
    }

    /** Apply a delta frame against the version we hold; false if we hold something else (the next update's
     *  version map will have us fetch the chunk in full). */
    applyDelta(key, version, baseVersion, bytes) {
        let prev = this.meshes.get(key);
        if(!prev || this.versions.get(key) !== baseVersion) return false;
        let mesh = decodeChunkDelta(prev, bytes);
        // A delta that references vertices the mesh does not have would draw stretched triangles; never show one,
        // fetch the chunk in full instead (the next update names the version)
        let nv = mesh.positions.length / 3;
        for(let i = 0; i < mesh.indices.length; i++) if(mesh.indices[i] >= nv) { console.error(`chunk ${key}: delta ${baseVersion}->${version} references vertex ${mesh.indices[i]} of ${nv}; refetching`); this.unload(key); return false; }
        this.setChunkMesh(key, mesh, version);
        return true;
    }

    setChunkMesh(key, mesh, version) {
        this.pending.delete(key);
        let prev = this.meshes.get(key);
        if(mesh) this.meshes.set(key, mesh); else this.meshes.delete(key);
        this.versions.set(key, version);
        this.rockMask.delete(key);
        this.rebuild(key);
        this.onChunkChanged?.(key, changedBox(prev, mesh));
    }

    /** Drop a modified chunk we no longer need to hold. */
    unload(key) {
        this.pending.delete(key);
        this.meshes.delete(key);
        this.versions.delete(key);
        this.rebuild(key);
    }

    /** Rebuild a chunk's geometry from what we hold and the server's masks. */
    rebuild(key) {
        let geometry = null;
        let rock = this.rockMask.get(key) || 0, mesh = this.meshes.get(key);
        if(rock) geometry = this.rockFaces(key, rock);
        else if(mesh) geometry = this.culledGeometry(key, mesh, this.cullMask.get(key) || 0);
        this.setGeometry(key, geometry);
    }

    /** Reconcile with an update's {world, chunks, rock, cull} maps; fetch what we lack. */
    applyUpdate(data, full = false) {
        if(data.world) this.configure(data.world);
        let chunks = data.chunks || {}, rock = data.rock || {}, cull = data.cull || {};
        if(full) {
            for(let key of [...this.versions.keys(), ...this.pending.keys()]) if(chunks[key] === undefined) this.unload(key);
            for(let key of [...this.rockMask.keys()]) if(rock[key] === undefined) { this.rockMask.delete(key); this.rebuild(key); }
        }
        for(let key in cull) {
            if((this.cullMask.get(key) || 0) === cull[key]) continue;
            this.cullMask.set(key, cull[key]);
            if(this.meshes.has(key)) this.rebuild(key);
        }
        for(let key in rock) {
            if((this.rockMask.get(key) || 0) === rock[key]) continue;
            if(rock[key]) this.rockMask.set(key, rock[key]); else this.rockMask.delete(key);
            this.rebuild(key);
        }
        for(let key in chunks) {
            let version = chunks[key];
            if(version === null) { if(this.versions.has(key) || this.pending.has(key)) this.unload(key); continue; }
            if(this.versions.get(key) === version || this.pending.get(key) === version) continue;
            if(version === EMPTY_VERSION) { this.setChunk(key, null, version); continue; }
            this.pending.set(key, version);
            Promise.resolve(this.fetchChunk?.(key, version)).then(async bytes => {
                if(this.pending.get(key) !== version) return; // superseded or unloaded
                if(!bytes) { this.pending.delete(key); return; }
                let mesh = await decodeChunkMeshAsync(bytes); // native gunzip, off the main thread
                if(this.pending.get(key) !== version) return;
                this.setChunkMesh(key, mesh, version);
            }).catch(e => { this.pending.delete(key); console.warn(`chunk ${key} fetch failed: ${e.message}`); });
        }
    }

    /** Quads for the exposed faces of an unmodified solid chunk. */
    rockFaces(key, mask) {
        let c = gridCenter(key);
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
    culledGeometry(key, mesh, hidden) {
        let { positions, indices, materials, uvs } = mesh;
        if(!hidden) return this.buildGeometry(positions, indices, materials, uvs);
        let c = gridCenter(key);
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
        return this.buildGeometry(positions, new Uint32Array(keepIdx), new Uint8Array(keepMat), uvs);
    }

    /** Expand an indexed mesh to flat triangles with per-face material colour, per-vertex UV, texture slot
     *  (-1 = flat colour) and tiling (tiles per metre for world-space triplanar textures, 0 = sample by UV).
     *  Per-face attributes need unshared vertices; a sequential index keeps the batch's indexed layout. */
    buildGeometry(positions, indices, materials, uvs = null) {
        return buildTerrainGeometry(positions, indices, materials, uvs, this.table, this.layers);
    }

    /** Resource summary for diagnostics. */
    stats() {
        let tris = 0, verts = 0;
        for(let mesh of this.objects.values()) { tris += mesh.geometry.index.count / 3; verts += mesh.geometry.attributes.position.count; }
        return { chunks: this.objects.size, tris, verts, rock: this.rockMask.size, held: this.meshes.size, pending: this.pending.size };
    }

    /** BVH for a chunk, or null if it has no geometry. */
    bvh(key) {
        let mesh = this.objects.get(key);
        return mesh ? mesh.geometry.boundsTree : null;
    }

    // ---- scene objects ------------------------------------------------------

    setGeometry(key, geometry) {
        let mesh = this.objects.get(key);
        if(!geometry) {
            if(mesh) { this.group.remove(mesh); mesh.geometry.dispose(); this.objects.delete(key); }
            return;
        }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.computeBoundsTree();
        // Always a fresh Mesh: swapping the geometry of a live mesh leaves the renderer's per-object state (buffers,
        // bundles) to catch up, and a draw with the old index buffer over new vertices is exactly a stretched sliver
        if(mesh) { this.group.remove(mesh); mesh.geometry.dispose(); this.objects.delete(key); }
        mesh = new THREE.Mesh(geometry, this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.userData.chunkKey = key;
        this.group.add(mesh);
        this.objects.set(key, mesh);
    }
}
