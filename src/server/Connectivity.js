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
import { CHUNK_COUNT, CHUNK_SIZE, HALF, FACES, chunkCenter, isDefaultSolid, neighbour, outsideIsSolid } from '../terrain/grid.js';

export const RASTER = 16;                       // cells per face edge (0.625 m)
const CELLS = RASTER * RASTER;
const CELL = CHUNK_SIZE / RASTER;
const PLANE_EPS = 1e-3;
export const DUST_VOLUME = 0.01;                // floating solid below this just vanishes
export const MAX_FRAGMENT_VOLUME = 1500;        // floating solid above this stays terrain (one chunk is 1000)
export const SKY = 'sky', GROUND = 'ground';

const FULL = new Uint8Array(CELLS).fill(1);
const ALL_FACES = 63;
const ROCK = { rock: true, solid: [{ manifold: null, masks: [FULL, FULL, FULL, FULL, FULL, FULL], touch: ALL_FACES, volume: CHUNK_SIZE ** 3 }], air: [] };
const AIR = { air: [{ masks: [FULL, FULL, FULL, FULL, FULL, FULL], touch: ALL_FACES }], solid: [] };

const solidKey = (index, k) => `s${index}_${k}`;
const airKey = (index, k) => `a${index}_${k}`;

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
        this.cache = new Array(CHUNK_COUNT);  // per-chunk summaries of stored chunks, keyed by version
        this.uf = new UnionFind();
        this.touch = null;                    // touch[index][face] = air island keys touching this chunk's solid across that face
    }

    get M() { return this.terrain.manifold.Manifold; }

    // ---- per-chunk summaries -------------------------------------------------

    summary(index) {
        let c = this.terrain.chunks[index];
        if(!c) return isDefaultSolid(index) ? ROCK : AIR;
        if(!c.manifold) return AIR;
        let cached = this.cache[index];
        if(cached && cached.version === c.version) return cached;
        if(cached) this.dispose(cached);
        let center = chunkCenter(index);
        let solid = c.manifold.decompose().map(m => this.island(m, center, true));
        let cube = this.M.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(center.x, center.y, center.z);
        let airManifold = cube.subtract(c.manifold);
        cube.delete();
        let air = airManifold.decompose().map(m => { let isl = this.island(m, center, false); m.delete(); return isl; });
        airManifold.delete();
        return this.cache[index] = { version: c.version, solid, air };
    }

    /** Face footprints of one island. Keeps the manifold alive when `keep` (solid islands may become fragments). */
    island(m, center, keep) {
        let mesh = m.getMesh();
        let v = mesh.vertProperties, tri = mesh.triVerts;
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
        return { manifold: keep ? m : null, masks, touch, volume: m.volume() };
    }

    dispose(summary) { for(let s of summary.solid) if(s.manifold) s.manifold.delete(); }

    invalidate(index) { if(this.cache[index]) { this.dispose(this.cache[index]); this.cache[index] = null; } }

    clear() { for(let i = 0; i < CHUNK_COUNT; i++) this.invalidate(i); this.uf = new UnionFind(); this.touch = null; }

    // ---- global solve ------------------------------------------------------

    /** Rebuild the union-find over every island and the per-face air contacts. */
    solve() {
        let uf = this.uf = new UnionFind();
        let touch = this.touch = new Array(CHUNK_COUNT);
        for(let index = 0; index < CHUNK_COUNT; index++) {
            let S = this.summary(index);
            let lists = touch[index] = [null, null, null, null, null, null];
            for(let f = 0; f < 6; f++) {
                let n = neighbour(index, f);
                if(n < 0) {
                    if(outsideIsSolid(f)) {
                        for(let k = 0; k < S.solid.length; k++) if(S.solid[k].touch & (1 << f)) uf.union(solidKey(index, k), GROUND);
                    } else {
                        for(let k = 0; k < S.air.length; k++) if(S.air[k].touch & (1 << f)) uf.union(airKey(index, k), SKY);
                        if(S.solid.some(s => s.touch & (1 << f))) lists[f] = [SKY];
                    }
                    continue;
                }
                let T = this.summary(n), g = f ^ 1;
                if(f & 1) { // each pair once, from the positive side
                    for(let i = 0; i < S.solid.length; i++) for(let j = 0; j < T.solid.length; j++)
                        if(touches(S.solid[i], f, T.solid[j], g)) uf.union(solidKey(index, i), solidKey(n, j));
                    for(let i = 0; i < S.air.length; i++) for(let j = 0; j < T.air.length; j++)
                        if(touches(S.air[i], f, T.air[j], g)) uf.union(airKey(index, i), airKey(n, j));
                }
                let keys = null;
                for(let j = 0; j < T.air.length; j++) {
                    for(let i = 0; i < S.solid.length; i++) if(touches(S.solid[i], f, T.air[j], g)) { (keys ||= []).push(airKey(n, j)); break; }
                }
                lists[f] = keys;
            }
        }
    }

    /** Solid components not connected to the ground: [{ islands:[{index,k,island}], volume }]. */
    floatingComponents() {
        let ground = this.uf.find(GROUND);
        let groups = new Map();
        for(let index = 0; index < CHUNK_COUNT; index++) {
            let S = this.summary(index);
            for(let k = 0; k < S.solid.length; k++) {
                let root = this.uf.find(solidKey(index, k));
                if(root === ground) continue;
                let g = groups.get(root);
                if(!g) groups.set(root, g = { islands: [], volume: 0 });
                g.islands.push({ index, k, island: S.solid[k] });
                g.volume += S.solid[k].volume;
            }
        }
        return [...groups.values()];
    }

    // ---- activity ------------------------------------------------------------

    /** Chunk index containing a world position, or -1 outside the grid. */
    static chunkAt(p) {
        let x = Math.floor((p.x + 50) / CHUNK_SIZE), y = Math.floor((p.y + 50) / CHUNK_SIZE), z = Math.floor((p.z + 50) / CHUNK_SIZE);
        if(x < 0 || x > 9 || y < 0 || y > 9 || z < 0 || z > 9) return -1;
        return x * 100 + y * 10 + z;
    }

    /** Roots of the air components touched by the given chunk indices (-1 = outside the grid = sky). */
    activeRoots(occupied) {
        let roots = new Set();
        for(let index of occupied) {
            if(index < 0) { roots.add(this.uf.find(SKY)); continue; }
            let S = this.summary(index);
            for(let k = 0; k < S.air.length; k++) roots.add(this.uf.find(airKey(index, k)));
        }
        return roots;
    }

    /**
     * Per-chunk materialization given the active air roots:
     *   rock:     { mask }                faces that touch active air (0 = nothing)
     *   modified: { active, cull }        load it? which boundary faces to cull
     *   air/empty: undefined
     */
    states(roots) {
        let active = key => roots.has(this.uf.find(key));
        let out = new Array(CHUNK_COUNT);
        for(let index = 0; index < CHUNK_COUNT; index++) {
            let S = this.summary(index);
            if(!S.solid.length) continue;
            let faces = 0;
            let lists = this.touch[index];
            for(let f = 0; f < 6; f++) if(lists[f] && lists[f].some(active)) faces |= 1 << f;
            if(S.rock) { if(faces) out[index] = { mask: faces }; continue; }
            let own = S.air.some((_, k) => active(airKey(index, k)));
            if(faces || own) out[index] = { active: true, cull: ~faces & ALL_FACES };
        }
        return out;
    }
}
