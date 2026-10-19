/** Client terrain mirror: a Mesh per held chunk (with its BVH, for player collision, tool raycasts and the probe
 *  grid's inside-solid test) and a version per chunk for content-addressed fetching. Those meshes are not drawn:
 *  rendering goes through merged batch meshes (see "render batching" below), because a level is hundreds of small
 *  chunks (Twin Forts: 356 meshes averaging 32 triangles) and every draw costs the same CPU however small it is
 *  (~800 draws a frame with the two shadow cascades, and six more passes of everything per probe bake).
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

/** Render batching. Chunks are grouped by region (REGION chunks per axis); a region's chunks are drawn as one or more
 *  batch meshes of at most BATCH_TRIS triangles, built by concatenating the chunks' geometries (all share one material
 *  and one attribute layout, in world space). A chunk whose geometry changes leaves its batch's draw at once (its
 *  index range is zeroed: degenerate triangles, one index buffer upload) and draws as a mesh of its own ("hot"), so a
 *  carve shows with no extra latency; once nothing in the batch has changed for SETTLE_MS the batch is rebuilt with
 *  it, as a fresh Mesh (never new geometry under a live one: see setGeometry). `?batch=0` draws one mesh per chunk. */
const REGION = [4, 2, 4];
const BATCH_TRIS = 32768;              // ~5 MB of vertex data: a castle region splits into several batches
const SETTLE_MS = 2000;
const GATHER_MS = 250;                 // a batch waits this long after a chunk settles into it, for its neighbours
const FORCE_MS = 10000;                // a batch that keeps changing is rebuilt anyway this long after it first did
const REBUILD_TRIS_PER_FRAME = 65536;  // rebuild work per update (at least one batch)
const DEFER_MS = 250;                  // longest a chunk keeps its previous drawing while its refined mesh is on its way
const BATCH_ATTRIBUTES = [['position', 3], ['color', 3], ['uv', 2], ['slot', 1], ['tile', 1], ['normal', 3], ['rec', 1]];

function regionOf(key) {
    let [x, y, z] = key.split(',').map(Number);
    return Math.floor(x / REGION[0]) + ',' + Math.floor(y / REGION[1]) + ',' + Math.floor(z / REGION[2]);
}

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
    // the vertex GI record of each vertex (TerrainGI); -1: none, the probe grid lights it
    geometry.setAttribute('rec', new THREE.BufferAttribute(new Float32Array(numTris * 3).fill(-1), 1));
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
    constructor(scene, material, { batching = true } = {}) {
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
        this.group = new THREE.Group();   // one Mesh per chunk, with its BVH: collision and raycasts, not drawn when batching
        this.group.name = 'terrain';
        this.scene.add(this.group);
        this.objects = new Map();   // key -> Mesh
        this.render = new Map();    // key -> refined render geometry (TerrainGI), drawn instead of the collision geometry
        this.onGeometry = null;     // (key, geometry|null) => void, after a chunk's collision geometry was replaced
        this.changing = null;       // { key, box } while a chunk whose content a carve changed is being rebuilt
        this.deferDraw = false;     // see setGeometry
        this.waiting = new Map();   // key -> time until which the chunk's previous drawing stays (deferDraw)
        // render batching (see REGION); the Raycaster and the BVH users ignore `visible`, the renderer skips the subtree
        this.batching = batching;
        this.group.visible = !batching;
        this.renderGroup = new THREE.Group();
        this.renderGroup.name = 'terrain-batches';
        this.scene.add(this.renderGroup);
        this.drawn = new Map();     // key -> { batch, inMesh, hot: Mesh|null, changedAt, settled }
        this.hotKeys = new Set();   // chunks drawn on their own
        this.regions = new Map();   // region key -> [batch]
        this.dirty = new Set();     // batches waiting for a rebuild
        this.rebuilds = 0;
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
        let box = changedBox(prev, mesh);
        this.changing = box ? { key, box } : null; // what a carve changed, for onGeometry listeners during the rebuild (TerrainGI)
        this.rebuild(key);
        this.changing = null;
        this.onChunkChanged?.(key, box);
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
        let batches = 0; for(let list of this.regions.values()) for(let b of list) if(b.mesh) batches++;
        return { chunks: this.objects.size, tris, verts, rock: this.rockMask.size, held: this.meshes.size, pending: this.pending.size,
                 batches, hot: this.hotKeys.size, drawObjects: this.batching ? this.renderGroup.children.length : this.objects.size, rebuilds: this.rebuilds };
    }

    /** BVH for a chunk, or null if it has no geometry. */
    bvh(key) {
        let mesh = this.objects.get(key);
        return mesh ? mesh.geometry.boundsTree : null;
    }

    // ---- scene objects ------------------------------------------------------

    setGeometry(key, geometry) {
        let mesh = this.objects.get(key);
        // With deferDraw (TerrainGI, whose refined mesh comes back from a worker a frame or two later), a chunk that was
        // drawn refined keeps drawing that until the new one arrives (setRenderGeometry) or DEFER_MS pass: drawn as the
        // bare collision geometry meanwhile, a fresh dig showed the probe grid's light for those frames.
        let keep = this.deferDraw && geometry && this.batching && this.render.has(key) && this.drawn.has(key);
        if(!keep) this.undraw(key);
        this.render.delete(key); // refined from the old content
        if(mesh) { this.group.remove(mesh); if(!keep) mesh.geometry.dispose(); this.objects.delete(key); }
        if(!geometry) { this.waiting.delete(key); this.forget(key); this.onGeometry?.(key, null); return; }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.computeBoundsTree();
        // Always a fresh Mesh: swapping the geometry of a live mesh leaves the renderer's per-object state (buffers,
        // bundles) to catch up, and a draw with the old index buffer over new vertices is exactly a stretched sliver
        mesh = new THREE.Mesh(geometry, this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.userData.chunkKey = key;
        this.group.add(mesh);
        this.objects.set(key, mesh);
        if(keep) this.waiting.set(key, performance.now() + DEFER_MS);
        else if(this.batching) this.drawHot(key, geometry);
        this.onGeometry?.(key, geometry); // TerrainGI refines it and hands back a render geometry (setRenderGeometry)
    }

    /** What is drawn for a chunk: its refined render geometry when there is one, else the collision geometry. */
    drawGeometry(key) { return this.render.get(key) || this.objects.get(key)?.geometry || null; }

    /** A refined render geometry for a chunk (same surface, more vertices, a GI record per vertex). Drawn at once if the
     *  chunk is drawn on its own; a batch keeps drawing the old one until its rebuild, which is the same surface. */
    setRenderGeometry(key, geometry, coarse = null) {
        let mesh = this.objects.get(key);
        if(!mesh || (coarse && mesh.geometry !== coarse)) return; // refined from a geometry the chunk no longer has
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        this.render.set(key, geometry);
        if(!this.batching) return;
        if(this.waiting.delete(key)) { this.undraw(key); this.drawHot(key, mesh.geometry); return; } // the old drawing goes now
        let st = this.drawn.get(key);
        if(!st) return;
        if(st.hot) {
            this.dropHot(key, st.hot);
            let hot = new THREE.Mesh(geometry, this.material);
            hot.castShadow = true; hot.receiveShadow = true; hot.matrixAutoUpdate = false; hot.userData.chunkKey = key;
            this.renderGroup.add(hot);
            st.hot = hot;
        } else if(st.batch) this.touch(st.batch, GATHER_MS);
    }

    // ---- render batching ------------------------------------------------------

    /** Remove a chunk's own mesh; a refined geometry it drew that is no longer current frees its GPU buffers (the
     *  collision geometry and the current render geometry stay: batches and the BVHs read their arrays). */
    dropHot(key, hot) {
        this.renderGroup.remove(hot);
        let g = hot.geometry;
        if(g !== this.objects.get(key)?.geometry && g !== this.render.get(key)) g.dispose();
    }

    /** Take a chunk out of what is drawn: its own mesh, and its range of its batch (zeroed indices, until the rebuild). */
    undraw(key) {
        let st = this.drawn.get(key);
        if(!st) return;
        if(st.hot) { this.dropHot(key, st.hot); st.hot = null; }
        this.hotKeys.delete(key);
        if(st.batch && st.inMesh) {
            let b = st.batch, r = b.ranges.get(key), index = b.mesh.geometry.index;
            index.array.fill(0, r.start, r.start + r.count);
            index.needsUpdate = true;
            b.ranges.delete(key);
            st.inMesh = false;
            this.touch(b, SETTLE_MS);
        }
    }

    /** The chunk has no geometry any more: out of its batch's membership too. */
    forget(key) {
        let st = this.drawn.get(key);
        if(!st) return;
        if(st.batch) { st.batch.keys.delete(key); this.touch(st.batch, SETTLE_MS); }
        this.drawn.delete(key);
    }

    /** Draw a changed chunk on its own until it has settled. The mesh shares the collision mesh's geometry. */
    drawHot(key, geometry) {
        let st = this.drawn.get(key);
        if(!st) { st = { batch: null, inMesh: false, hot: null, changedAt: 0, settled: false }; this.drawn.set(key, st); }
        let hot = new THREE.Mesh(this.render.get(key) || geometry, this.material);
        hot.castShadow = true;
        hot.receiveShadow = true;
        hot.matrixAutoUpdate = false;
        hot.userData.chunkKey = key;
        this.renderGroup.add(hot);
        st.hot = hot;
        st.changedAt = performance.now();
        st.settled = false;
        this.hotKeys.add(key);
    }

    /** Schedule a batch's rebuild no sooner than `delay` ms from now. */
    touch(b, delay) {
        let now = performance.now();
        b.foldAt = Math.max(b.foldAt, now + delay);
        if(!this.dirty.has(b)) { this.dirty.add(b); b.dirtySince = now; }
    }

    trisOf(key) { let g = this.drawGeometry(key); return g ? g.index.count / 3 : 0; }

    batchTris(b, except = null) { let n = 0; for(let k of b.keys) if(k !== except) n += this.trisOf(k); return n; }

    /** The batch a settled chunk goes into: the one it was in while it still fits, else one of its region's with room. */
    assign(key, st) {
        let tris = this.trisOf(key);
        if(st.batch && (this.batchTris(st.batch, key) + tris <= BATCH_TRIS || st.batch.keys.size === 1)) return st.batch;
        if(st.batch) { st.batch.keys.delete(key); this.touch(st.batch, 0); }
        let region = regionOf(key), list = this.regions.get(region);
        if(!list) { list = []; this.regions.set(region, list); }
        let b = list.find(c => c.keys.size === 0 || this.batchTris(c) + tris <= BATCH_TRIS);
        if(!b) { b = { region, keys: new Set(), mesh: null, ranges: new Map(), foldAt: 0, dirtySince: 0 }; list.push(b); }
        b.keys.add(key);
        st.batch = b;
        return b;
    }

    /** Once per frame: settled chunks join their batch, and due batches are rebuilt (within a budget). */
    update() {
        if(!this.batching) return;
        let now = performance.now();
        for(let [key, until] of this.waiting) {
            if(now < until) continue;
            this.waiting.delete(key); this.undraw(key);
            let m = this.objects.get(key); if(m) this.drawHot(key, m.geometry);
        }
        for(let key of this.hotKeys) {
            let st = this.drawn.get(key);
            if(!st || st.settled || now - st.changedAt < SETTLE_MS) continue;
            st.settled = true;
            this.touch(this.assign(key, st), GATHER_MS);
        }
        let budget = REBUILD_TRIS_PER_FRAME, first = true;
        for(let b of this.dirty) {
            if(now < b.foldAt && now - b.dirtySince < FORCE_MS) continue;
            let tris = this.batchTris(b);
            if(!first && tris > budget) continue;
            this.rebuildBatch(b);
            budget -= tris; first = false;
            if(budget <= 0) break;
        }
    }

    /** Build a batch's mesh from its members' current geometry (members still changing stay on their own) and swap it
     *  in for the old one in the same frame; folded chunks stop drawing on their own. */
    rebuildBatch(b) {
        this.dirty.delete(b);
        b.foldAt = 0;
        this.rebuilds++;
        let members = [], total = 0, totalIndex = 0;
        for(let k of b.keys) {
            let st = this.drawn.get(k), g = this.drawGeometry(k);
            if(!st || !g || (st.hot && !st.settled)) continue;
            members.push(k);
            total += g.attributes.position.count;
            totalIndex += g.index.count;
        }
        let old = b.mesh;
        b.mesh = null;
        b.ranges = new Map();
        if(total > 0) {
            let geometry = new THREE.BufferGeometry(), arrays = {};
            for(let [name, size] of BATCH_ATTRIBUTES) arrays[name] = new Float32Array(total * size);
            let index = new Uint32Array(totalIndex), box = new THREE.Box3(), offset = 0, at = 0;
            for(let k of members) {
                let g = this.drawGeometry(k), n = g.attributes.position.count, src = g.index.array, m = g.index.count;
                for(let [name, size] of BATCH_ATTRIBUTES) arrays[name].set(g.attributes[name].array.subarray(0, n * size), offset * size);
                for(let i = 0; i < m; i++) index[at + i] = src[i] + offset;
                b.ranges.set(k, { start: at, count: m });
                if(!g.boundingBox) g.computeBoundingBox();
                box.union(g.boundingBox);
                offset += n; at += m;
            }
            for(let [name, size] of BATCH_ATTRIBUTES) geometry.setAttribute(name, new THREE.BufferAttribute(arrays[name], size));
            geometry.setIndex(new THREE.BufferAttribute(index, 1));
            geometry.boundingBox = box;
            geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
            let mesh = new THREE.Mesh(geometry, this.material);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.matrixAutoUpdate = false;
            mesh.userData.terrainBatch = b.region;
            this.renderGroup.add(mesh);
            b.mesh = mesh;
        }
        if(old) { this.renderGroup.remove(old); old.geometry.dispose(); }
        for(let k of b.keys) { let st = this.drawn.get(k); if(st) st.inMesh = b.ranges.has(k); }
        for(let k of members) {
            let st = this.drawn.get(k);
            if(st.hot) {
                this.renderGroup.remove(st.hot);
                st.hot.geometry.dispose(); // frees its GPU buffers; the arrays (and the collision mesh's BVH) stay
                st.hot = null;
                this.hotKeys.delete(k);
            }
        }
        if(b.keys.size === 0) {
            let list = this.regions.get(b.region), i = list ? list.indexOf(b) : -1;
            if(i >= 0) list.splice(i, 1);
            if(list && !list.length) this.regions.delete(b.region);
        }
    }
}
