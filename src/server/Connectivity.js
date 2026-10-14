/** Cross-chunk connectivity of terrain, for two questions:
 *
 *  1. Which solid is grounded? Every chunk's solid is decomposed into
 *     islands, each island's contact with the six chunk faces is rasterized
 *     onto a RASTER x RASTER grid, and islands in neighbouring chunks are
 *     joined when their footprints on the shared face overlap. Anything not
 *     connected to the bottom of the world is floating and becomes a rigid
 *     fragment (merged across chunks), unless it is too big to be safe.
 *
 *  2. Which hollows matter? The same is done for air (the cube minus the
 *     solid). Air connected to the outside of the grid is the sky. An air
 *     component is active when a player or a body is in a chunk it touches.
 *     Terrain is only materialized where it faces active air: rock chunks
 *     contribute the faces that touch active air, modified chunks are loaded
 *     when they touch active air and cull the boundary faces that do not.
 *
 *  Rasterized contact is conservative in both directions: solid that shares a
 *  cell with other solid counts as attached, air that shares a cell with other
 *  air counts as connected. Both errors are in the safe direction (terrain
 *  stays put, a little extra terrain is loaded). */
import { CHUNK_SIZE, HALF, FACES, chunkCenter, isRockKey, neighbour, outsideIsSolid } from '../terrain/grid.js';

export const RASTER = 16;                       // cells per face edge (0.625 m)
const CELLS = RASTER * RASTER;
const CELL = CHUNK_SIZE / RASTER;
const PLANE_EPS = 1e-3;
export const DUST_VOLUME = 0.01;                // floating solid below this just vanishes
export const MAX_FRAGMENT_VOLUME = 1500;        // floating solid above this stays terrain (one chunk is 1000)
export const SKY = 'sky', GROUND = 'ground';

const FULL = new Uint8Array(CELLS).fill(1);
const ALL_FACES = 63;
const ROCK = { rock: true, solid: [{ masks: [FULL, FULL, FULL, FULL, FULL, FULL], touch: ALL_FACES, volume: CHUNK_SIZE ** 3 }], air: [] };
const OPEN_AIR = { implicit: true, air: [{ masks: [FULL, FULL, FULL, FULL, FULL, FULL], touch: ALL_FACES }], solid: [] }; // unstored air: always sky
const EMPTY_AIR = { air: [{ masks: [FULL, FULL, FULL, FULL, FULL, FULL], touch: ALL_FACES }], solid: [] };                // stored, carved away: a real island

const solidKey = (key, k) => `s${key}_${k}`;
const airKey = (key, k) => `a${key}_${k}`;
/** Island key for air island k of chunk `key` with summary S; implicit air is the sky itself. */
const airKeyOf = (key, k, S) => S.implicit ? SKY : airKey(key, k);

/** Do island `s` on its face f and island `t` on its face g (the same world plane) share a cell? */
function touches(s, f, t, g) {
    if(!(s.touch & (1 << f)) || !(t.touch & (1 << g))) return false;
    let a = s.masks[f], b = t.masks[g];
    if(a === FULL || b === FULL) return true;
    for(let i = 0; i < CELLS; i++) if(a[i] && b[i]) return true;
    return false;
}

/** 2D separating-axis test between a triangle and an axis-aligned cell. */
function triCellOverlap(ax, ay, bx, by, cx, cy, x0, y0, x1, y1) {
    let tx = [ax, bx, cx], ty = [ay, by, cy];
    let bx4 = [x0, x1, x1, x0], by4 = [y0, y0, y1, y1];
    let axes = [[1, 0], [0, 1], [-(by - ay), bx - ax], [-(cy - by), cx - bx], [-(ay - cy), ax - cx]];
    for(let [nx, ny] of axes) {
        let tmin = Infinity, tmax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for(let i = 0; i < 3; i++) { let p = tx[i] * nx + ty[i] * ny; if(p < tmin) tmin = p; if(p > tmax) tmax = p; }
        for(let i = 0; i < 4; i++) { let p = bx4[i] * nx + by4[i] * ny; if(p < bmin) bmin = p; if(p > bmax) bmax = p; }
        if(tmax <= bmin + 1e-6 || bmax <= tmin + 1e-6) return false;
    }
    return true;
}

/** Mark every cell a triangle (given in cell units) overlaps. */
function rasterTriangle(mask, ax, ay, bx, by, cx, cy) {
    let i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(RASTER - 1, Math.ceil(Math.max(ax, bx, cx)) - 1);
    let j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(RASTER - 1, Math.ceil(Math.max(ay, by, cy)) - 1);
    for(let i = i0; i <= i1; i++) for(let j = j0; j <= j1; j++) {
        if(mask[i * RASTER + j]) continue;
        if(triCellOverlap(ax, ay, bx, by, cx, cy, i, j, i + 1, j + 1)) mask[i * RASTER + j] = 1;
    }
}

class UnionFind {
    constructor() { this.parent = new Map(); }
    find(k) {
        let p = this.parent.get(k);
        if(p === undefined) { this.parent.set(k, k); return k; }
        if(p === k) return k;
        let r = this.find(p);
        this.parent.set(k, r);
        return r;
    }
    union(a, b) { let ra = this.find(a), rb = this.find(b); if(ra !== rb) this.parent.set(ra, rb); }
}

export class Connectivity {
    /** @param {import('./Terrain.js').Terrain} terrain */
    constructor(terrain) {
        this.terrain = terrain;
        this.cache = new Map();   // key -> summary of a stored chunk, tagged with its version
        this.uf = new UnionFind();
        this.touch = new Map();   // key -> [face] -> air island keys touching this chunk's solid across that face
        this.keys = new Set();    // chunks covered by the last solve
    }

    get M() { return this.terrain.manifold.Manifold; }

    // ---- per-chunk summaries -------------------------------------------------

    summary(key) {
        let c = this.terrain.chunks[key];
        if(!c) return isRockKey(this.terrain.world, key) ? ROCK : OPEN_AIR;
        if(!c.bytes) return EMPTY_AIR;
        let cached = this.cache.get(key);
        if(cached && cached.version === c.version) return cached;
        let manifold = this.terrain.manifoldOf(key);
        if(!manifold) return EMPTY_AIR; // corrupt chunk, dropped just now
        let center = chunkCenter(key);
        // Footprints only: island manifolds are not kept (memory); settle re-decomposes the few it needs,
        // in this same order, since decompose is deterministic for a given mesh.
        let solid = manifold.decompose().map(m => { let isl = this.island(m, center); m.delete(); return isl; });
        let cube = this.terrain.withMaterial(this.M.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(center.x, center.y, center.z), 0);
        let airManifold = cube.subtract(manifold);
        cube.delete();
        let air = airManifold.decompose().map(m => { let isl = this.island(m, center); m.delete(); return isl; });
        airManifold.delete();
        let summary = { version: c.version, solid, air };
        this.cache.set(key, summary);
        return summary;
    }

    /** Face footprints of one island (the manifold is not retained). */
    island(m, center) {
        let mesh = m.getMesh();
        let np = mesh.numProp, props = mesh.vertProperties, tri = mesh.triVerts;
        // positions only (manifolds carry UVs as extra properties)
        let v = new Float32Array((props.length / np) * 3);
        for(let i = 0, n = props.length / np; i < n; i++) { v[i * 3] = props[i * np]; v[i * 3 + 1] = props[i * np + 1]; v[i * 3 + 2] = props[i * np + 2]; }
        let masks = new Array(6), touch = 0;
        let origin = [center.x - HALF, center.y - HALF, center.z - HALF];
        for(let f = 0; f < 6; f++) {
            let { axis, dir } = FACES[f];
            let plane = [center.x, center.y, center.z][axis] + dir * HALF;
            let u = (axis + 1) % 3, w = (axis + 2) % 3;
            let mask = null;
            for(let t = 0; t < tri.length; t += 3) {
                let a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
                if(Math.abs(v[a + axis] - plane) > PLANE_EPS || Math.abs(v[b + axis] - plane) > PLANE_EPS || Math.abs(v[c + axis] - plane) > PLANE_EPS) continue;
                mask ||= new Uint8Array(CELLS);
                rasterTriangle(mask,
                    (v[a + u] - origin[u]) / CELL, (v[a + w] - origin[w]) / CELL,
                    (v[b + u] - origin[u]) / CELL, (v[b + w] - origin[w]) / CELL,
                    (v[c + u] - origin[u]) / CELL, (v[c + w] - origin[w]) / CELL);
            }
            if(mask) { masks[f] = mask; touch |= 1 << f; }
        }
        return { masks, touch, volume: m.volume() };
    }

    invalidate(key) { this.cache.delete(key); }

    clear() { this.cache.clear(); this.uf = new UnionFind(); this.touch = new Map(); this.keys = new Set(); }

    // ---- global solve ------------------------------------------------------

    /** Rebuild the union-find over every island and the per-face air contacts. */
    solve() {
        let uf = this.uf = new UnionFind();
        let touch = this.touch = new Map();
        let world = this.terrain.world;
        this.keys = this.terrain.relevantKeys();
        for(let key of this.keys) {
            let S = this.summary(key);
            let lists = [null, null, null, null, null, null];
            touch.set(key, lists);
            for(let f = 0; f < 6; f++) {
                let n = neighbour(world, key, f);
                if(n === null) {
                    if(outsideIsSolid(f)) {
                        for(let k = 0; k < S.solid.length; k++) if(S.solid[k].touch & (1 << f)) uf.union(solidKey(key, k), GROUND);
                    } else {
                        for(let k = 0; k < S.air.length; k++) if(S.air[k].touch & (1 << f)) uf.union(airKey(key, k), SKY);
                        if(S.solid.some(s => s.touch & (1 << f))) lists[f] = [SKY];
                    }
                    continue;
                }
                let T = this.summary(n), g = f ^ 1;
                // Pairs between two relevant chunks are joined once, from the positive side; a neighbour
                // that is not relevant (open air) is only ever seen from here.
                if((f & 1) || !this.keys.has(n)) {
                    for(let i = 0; i < S.solid.length; i++) for(let j = 0; j < T.solid.length; j++)
                        if(touches(S.solid[i], f, T.solid[j], g)) uf.union(solidKey(key, i), solidKey(n, j));
                    for(let i = 0; i < S.air.length; i++) for(let j = 0; j < T.air.length; j++)
                        if(touches(S.air[i], f, T.air[j], g)) uf.union(airKey(key, i), airKeyOf(n, j, T));
                }
                let keys = null;
                for(let j = 0; j < T.air.length; j++) {
                    for(let i = 0; i < S.solid.length; i++) if(touches(S.solid[i], f, T.air[j], g)) { (keys ||= []).push(airKeyOf(n, j, T)); break; }
                }
                lists[f] = keys;
            }
        }
    }

    /** Solid components not connected to the ground: [{ islands:[{key,k,island}], volume }]. */
    floatingComponents() {
        let ground = this.uf.find(GROUND);
        let groups = new Map();
        for(let key of this.keys) {
            let S = this.summary(key);
            for(let k = 0; k < S.solid.length; k++) {
                let root = this.uf.find(solidKey(key, k));
                if(root === ground) continue;
                let g = groups.get(root);
                if(!g) groups.set(root, g = { islands: [], volume: 0 });
                g.islands.push({ key, k, island: S.solid[k] });
                g.volume += S.solid[k].volume;
            }
        }
        return [...groups.values()];
    }

    // ---- activity ------------------------------------------------------------

    /** Roots of the air components touched by the given chunk keys (null = outside the grid = sky). */
    activeRoots(occupied) {
        let roots = new Set();
        for(let key of occupied) {
            if(key === null) { roots.add(this.uf.find(SKY)); continue; }
            let S = this.summary(key);
            for(let k = 0; k < S.air.length; k++) roots.add(this.uf.find(airKeyOf(key, k, S)));
        }
        return roots;
    }

    /**
     * Per-chunk materialization given the active air roots, as a Map:
     *   rock:     { mask }                faces that touch active air (0 = nothing)
     *   modified: { active, cull }        load it? which boundary faces to cull
     * Chunks with nothing to show are absent.
     */
    states(roots) {
        let active = key => roots.has(this.uf.find(key));
        let out = new Map();
        for(let key of this.keys) {
            let S = this.summary(key);
            if(!S.solid.length) continue;
            let faces = 0;
            let lists = this.touch.get(key);
            if(!lists) continue; // not part of the last solve
            for(let f = 0; f < 6; f++) if(lists[f] && lists[f].some(active)) faces |= 1 << f;
            if(S.rock) { if(faces) out.set(key, { mask: faces }); continue; }
            let own = S.air.some((_, k) => active(airKey(key, k)));
            if(faces || own) out.set(key, { active: true, cull: ~faces & ALL_FACES });
        }
        return out;
    }
}
