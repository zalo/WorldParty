/** Glow rocks on the server (Fort War): the virtual field of luminous pebbles in the ground and the entities it
 *  materializes (src/game/rules.js: GLOW_ROCK, virtualRock).
 *
 *  The field is a jittered grid over the whole solid volume below the surface; a cell's hash says whether it holds a
 *  rock and where. Nothing exists until the terrain's surface passes through a rock: after every carve or build the
 *  cells overlapping the brush are measured against the new terrain, and a lazy scan measures the cells of the chunks
 *  around players that have air underground (the sewers, the vaults, the cave route, the gorge walls), a few per tick.
 *  A rock whose exposure (the fraction of its sample points in air) is between 0 and 1 becomes an embedded, static
 *  entity: CSG never touches it, it is not terrain. Only where the air it meets has a ceiling: a ray straight up from
 *  the exposed side that escapes to the sky (the gorge walls, a crater, a shaft) means no rock, so they belong to the
 *  tunnels, the vaults, the sewers and the pockets. One that nothing holds any more (`freeAt`) shatters: the entity goes
 *  and the clients get a `glowpop` (a sparkle and a tinkle where it was). They used to become sphere bodies, which
 *  filled every fresh tunnel with a carpet of pebbles: a drill bite frees the half dozen rocks inside its sphere. A rock
 *  found entirely in air that was not in solid before the carve never existed.
 *
 *  Point-in-solid is the parity of a ray against the chunk's own closed mesh (the solid clipped to the chunk cube), in
 *  a three-mesh-bvh BVH cached per chunk version; a closest-point query with the rock's radius as the limit skips the
 *  rocks nowhere near a surface (nearly all of them) before any sampling. Manifold is not involved. */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { Transform, GlowRock } from '../ecs/components.js';
import { GLOW_ROCK, virtualRock, virtualRocksIn } from '../game/rules.js';
import { chunkAt, chunksInBox, chunkMin, chunkCenter, isRockKey, CHUNK_SIZE } from '../terrain/grid.js';

const BVH_CACHE = 64;                 // chunk BVHs kept (a dense chunk's is a few hundred KB)
const RAY_DIR = new THREE.Vector3(0.3251, 0.5917, 0.7378).normalize(); // never along a chunk axis, so no edge-on faces
const PHI = (1 + Math.sqrt(5)) / 2;
const dirs = list => list.map(([x, y, z]) => { let l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
const AXES = dirs([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);
const ICOSA = dirs([[0, 1, PHI], [0, -1, PHI], [0, 1, -PHI], [0, -1, -PHI], [1, PHI, 0], [-1, PHI, 0], [1, -PHI, 0], [-1, -PHI, 0], [PHI, 0, 1], [-PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, -1]]);
const DODECA = dirs([[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
    [0, 1 / PHI, PHI], [0, 1 / PHI, -PHI], [0, -1 / PHI, PHI], [0, -1 / PHI, -PHI], [1 / PHI, PHI, 0], [1 / PHI, -PHI, 0], [-1 / PHI, PHI, 0], [-1 / PHI, -PHI, 0],
    [PHI, 0, 1 / PHI], [PHI, 0, -1 / PHI], [-PHI, 0, 1 / PHI], [-PHI, 0, -1 / PHI]]);
/** Sample points of a rock as [fraction of the radius, directions]: the centre, six at half depth, twelve near the
 *  surface; twenty more on the rim decide "free" when those nineteen are all out. */
const SAMPLES = [[0, [[0, 0, 0]]], [0.5, AXES], [0.9, ICOSA]];
const SAMPLES_RIM = [[0.98, DODECA]];
const SHATTERED = -1;                 // byCell value of a rock that came out of the ground and shattered
const SKY_OFFSET = 0.03;              // the sky test starts a hair beyond the sample in air (further out could be back inside the wall: pebbles are small)

export class GlowRocks {
    constructor(server) {
        this.server = server;
        this.world = server.world;
        this.byCell = new Map();    // cell -> entity id of a materialized rock, or SHATTERED (kept after the rock is gone: no rock twice)
        this.bvhs = new Map();      // "key@version" -> { bvh, air }, least recently used first
        this.scanned = new Map();   // chunk key -> version the lazy scan has covered
        this.cursor = null;         // { key, version, rocks } chunk the lazy scan is in
        this.stats = { measured: 0, rays: 0, bvhBuilds: 0 };
        this.ray = new THREE.Ray();
        this.pt = new THREE.Vector3();
        this.hit = {};
        this.airSample = null;      // of the last measure(): [direction, fraction of the radius] of its outermost sample in air
    }

    get T() { return this.server.terrain; }
    get config() { return this.server.game.config; }
    get field() { return this.config?.glowRocks || null; }
    get active() { return !!this.field; }

    // ---- lifecycle ------------------------------------------------------------

    /** Forget everything (the game stopped, or the terrain went back to pristine): entities go, the scan starts over. */
    reset() {
        for(let id of [...this.world.query('GlowRock')]) this.world.destroy(id);
        this.byCell.clear(); this.scanned.clear(); this.bvhs.clear();
        this.cursor = null;
    }

    /** Start from the entities there are (a room starting from storage, a level just imported): the index is rebuilt,
     *  so cells whose rock went with a cleared world can grow one again, and every chunk is scanned anew. */
    adopt() {
        this.byCell.clear(); this.scanned.clear(); this.bvhs.clear(); this.cursor = null;
        for(let [id, g] of [...this.world.each('GlowRock')]) {
            if(g.free) { this.byCell.set(g.cell, SHATTERED); this.world.destroy(id); continue; } // a body from before rocks shattered
            this.byCell.set(g.cell, id);
        }
    }

    rockOf(cell) { let [i, j, k] = cell.split(',').map(Number); return virtualRock(this.field, i, j, k); }

    // ---- geometry -------------------------------------------------------------

    /** The BVH of a chunk's mesh (world space), cached by version; `prev` asks for the content a carve just replaced
     *  (kept by the terrain until settleNow drops it). Null for a chunk without solid. */
    bvhOf(key, prev = false) {
        let c = this.T.chunks[key];
        if(!c) return null;
        let usePrev = prev && !!c.prev;
        let id = key + '@' + (usePrev ? c.prev.version : c.version);
        let e = this.bvhs.get(id);
        if(e !== undefined) { this.bvhs.delete(id); this.bvhs.set(id, e); return e; }
        let mesh = usePrev ? this.T.prevMesh(key) : this.T.currentMesh(key);
        if(!mesh) return null;
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1)); // the build reorders the index: copy it
        this.stats.bvhBuilds++;
        e = { bvh: new MeshBVH(geometry, { maxLeafSize: 8 }), air: this.undergroundAir(key, mesh) };
        this.bvhs.set(id, e);
        while(this.bvhs.size > BVH_CACHE) this.bvhs.delete(this.bvhs.keys().next().value);
        return e;
    }

    /** Does the chunk's mesh have a face below the field's ceiling that is not on a chunk plane, i.e. air underground? */
    undergroundAir(key, mesh) {
        let lim = this.config.surfaceY - GLOW_ROCK.margin, min = chunkMin(key), P = mesh.positions, I = mesh.indices;
        let lo = [min.x + 1e-3, min.y + 1e-3, min.z + 1e-3], hi = [min.x + CHUNK_SIZE - 1e-3, min.y + CHUNK_SIZE - 1e-3, min.z + CHUNK_SIZE - 1e-3];
        for(let t = 0; t < I.length; t += 3) {
            let a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            if((P[a + 1] + P[b + 1] + P[c + 1]) / 3 >= lim) continue;
            let onPlane = false;
            for(let ax = 0; ax < 3 && !onPlane; ax++) {
                let va = P[a + ax], vb = P[b + ax], vc = P[c + ax];
                onPlane = (va < lo[ax] && vb < lo[ax] && vc < lo[ax]) || (va > hi[ax] && vb > hi[ax] && vc > hi[ax]);
            }
            if(!onPlane) return true;
        }
        return false;
    }

    /** Is a point inside solid terrain? Implicit chunks answer from the world config; stored ones by the parity of a ray
     *  against the chunk's closed mesh (one chunk's mesh is enough: it is clipped to the chunk cube). */
    inside(p, prev = false) {
        let w = this.T.world, key = chunkAt(w, p);
        if(!key) return p.y < w.bounds.min[1] * CHUNK_SIZE; // below the grid is solid; around and above it, sky
        if(!this.T.chunks[key]) return isRockKey(w, key);
        let e = this.bvhOf(key, prev);
        if(!e) return false;
        this.ray.origin.set(p.x, p.y, p.z); this.ray.direction.copy(RAY_DIR);
        this.stats.rays++;
        return (e.bvh.raycast(this.ray, THREE.DoubleSide).length & 1) === 1;
    }

    /** Exposure of a virtual rock against the current terrain: the fraction of its sample points in air (0: buried,
     *  1: nothing touches it). A rock within one chunk with no face of the terrain within its radius is all in or
     *  all out, settled by its centre alone. */
    measure(rock) {
        let r = rock.radius, T = this.T;
        this.stats.measured++;
        let keys = chunksInBox(T.world, { x: rock.x - r, y: rock.y - r, z: rock.z - r }, { x: rock.x + r, y: rock.y + r, z: rock.z + r });
        this.airSample = [[0, 1, 0], 0];
        if(keys.length === 1) {
            let key = keys[0];
            if(!T.chunks[key]) return isRockKey(T.world, key) ? 0 : 1;
            let e = this.bvhOf(key);
            if(!e) return 1;
            this.pt.set(rock.x, rock.y, rock.z);
            // min = max threshold: the query stops at the first face within reach (it still reports one beyond it)
            let h = e.bvh.closestPointToPoint(this.pt, this.hit, r, r);
            if(!h || h.distance > r) return this.inside(rock) ? 0 : 1;
        }
        let air = 0, n = 0, p = { x: 0, y: 0, z: 0 }, best = -1;
        let run = sets => { for(let [s, list] of sets) for(let d of list) { p.x = rock.x + d[0] * s * r; p.y = rock.y + d[1] * s * r; p.z = rock.z + d[2] * s * r; n++; if(!this.inside(p)) { air++; if(s > best) { best = s; this.airSample = [d, s]; } } } };
        run(SAMPLES);
        if(air === n) run(SAMPLES_RIM);
        return Math.round(air / n * 100) / 100; // two decimals: hundreds of these ride every resync
    }

    /** Does a ray straight up from `p` (a point in air) reach the sky? Chunk by chunk: implicit rock blocks it, a stored
     *  chunk's mesh blocks it where the ray hits a face (any face: the ray starts in air, so a hit is solid), above the
     *  grid is sky. The bridge deck counts as a ceiling for the gorge wall under it, which is fine. */
    openSky(p) {
        let w = this.T.world, x = p.x, z = p.z, y = p.y;
        for(let guard = 0; guard < 16; guard++) {
            let key = chunkAt(w, { x, y, z });
            if(!key) return true;
            let top = chunkMin(key).y + CHUNK_SIZE;
            if(!this.T.chunks[key]) { if(isRockKey(w, key)) return false; }
            else {
                let e = this.bvhOf(key);
                if(e) {
                    this.ray.origin.set(x, y, z); this.ray.direction.set(0, 1, 0);
                    this.stats.rays++;
                    if(e.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, top - y + 1e-3)) return false;
                }
            }
            y = top + 1e-3;
        }
        return true;
    }

    /** The air the last measured rock meets is under a ceiling (a tunnel), not open to the sky (a cliff, a crater). */
    underCeiling(rock) {
        let [d, s] = this.airSample, off = s * rock.radius + SKY_OFFSET;
        return !this.openSky({ x: rock.x + d[0] * off, y: rock.y + d[1] * off, z: rock.z + d[2] * off });
    }

    // ---- entities -------------------------------------------------------------

    materialize(rock, exposure) {
        let axis = AXES[rock.axis], h = rock.spin / 2, s = Math.sin(h);
        let id = this.world.create({
            Transform: Transform({ position: { x: rock.x, y: rock.y, z: rock.z }, quaternion: { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(h) } }),
            GlowRock: GlowRock({ cell: rock.cell, exposure, free: false }),
        });
        this.byCell.set(rock.cell, id);
        return id;
    }

    /** Nothing holds the rock any more: it shatters (the entity goes; the cell remembers, so it never grows back). */
    shatter(rock, id = undefined) {
        if(id !== undefined && this.world.has(id, 'GlowRock')) this.world.destroy(id);
        this.byCell.set(rock.cell, SHATTERED);
    }


    // ---- events ---------------------------------------------------------------

    /** The terrain changed: `boxes` bound the brushes that ran (world units), `carved` are the chunks they changed and
     *  `changed` every chunk that differs now (settle may have shed fragments elsewhere). Rocks overlapping a brush are
     *  measured: embedded ones update or free, new ones appear where air now meets them. Called from settleNow while the
     *  replaced chunk content is still around, which tells a rock freed in one bite from one that was never there. */
    onTerrainChanged(boxes, carved, changed) {
        if(!this.active) return null;
        let t0 = Date.now(), w = this.world, R = GLOW_ROCK.maxRadius, seen = new Set();
        let out = { made: 0, freed: 0, updated: 0, sky: 0, ms: 0 }, pops = [];
        let before = { measured: this.stats.measured, rays: this.stats.rays, bvhBuilds: this.stats.bvhBuilds };
        for(let b of boxes) {
            let min = { x: b.min.x - R, y: b.min.y - R, z: b.min.z - R }, max = { x: b.max.x + R, y: b.max.y + R, z: b.max.z + R };
            for(let rock of virtualRocksIn(this.field, this.config.surfaceY, min, max)) {
                if(seen.has(rock.cell)) continue;
                seen.add(rock.cell);
                let id = this.byCell.get(rock.cell);
                if(id !== undefined) {
                    let g = id === SHATTERED ? null : w.get(id, 'GlowRock');
                    if(!g || g.free) continue;
                    let e = this.measure(rock);
                    if(e >= GLOW_ROCK.freeAt) { this.shatter(rock, id); pops.push(rock); out.freed++; }
                    else if(Math.abs(e - g.exposure) > 0.01) { w.set(id, 'GlowRock', { exposure: e }); out.updated++; }
                    continue;
                }
                let e = this.measure(rock);
                if(e <= 0) continue;
                let free = e >= GLOW_ROCK.freeAt;
                if(free && !this.inside(rock, true)) continue; // open air before the carve too: no rock ever lay here
                if(!this.underCeiling(rock)) { out.sky++; continue; }  // a crater, a cliff, a shaft: the rocks stay underground
                if(free) { this.shatter(rock); pops.push(rock); out.freed++; continue; } // dug out in one bite
                this.materialize(rock, e);
                out.made++;
            }
        }
        // The scan's bookkeeping: a chunk a brush changed is as covered as it was (the brush region was just measured);
        // one that settle changed, or that was only part way through a scan, is scanned again.
        for(let key of changed) {
            let c = this.T.chunks[key], old = c?.prev?.version;
            if(carved.has(key) && c && old !== undefined && this.scanned.get(key) === old) this.scanned.set(key, c.version);
            else this.scanned.delete(key);
            if(this.cursor && this.cursor.key === key) this.cursor = null;
        }
        // the shattered ones sparkle on the clients: [x, y, z, colour index], a centimetre is plenty
        if(pops.length) this.server.broadcast(JSON.stringify({ type: 'glowpop', rocks: pops.slice(0, 64).map(r => [Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100, Math.round(r.z * 100) / 100, r.color]) }));
        out.ms = Date.now() - t0;
        out.measured = this.stats.measured - before.measured; out.rays = this.stats.rays - before.rays; out.bvhBuilds = this.stats.bvhBuilds - before.bvhBuilds;
        return out;
    }

    /** The lazy scan: a few virtual rocks per tick in the chunks around players with air underground, nearest first, so
     *  the level's own tunnels get their rocks as players come near. A chunk is covered once per version. */
    scan() {
        if(!this.active) return;
        let budget = GLOW_ROCK.scanPerTick;
        while(budget > 0) {
            if(!this.cursor && !this.nextChunk()) return;
            let { rocks, key, version } = this.cursor;
            if(this.T.chunks[key]?.version !== version) { this.cursor = null; continue; }
            let step = rocks.next();
            if(step.done) { this.scanned.set(key, version); this.cursor = null; continue; }
            let rock = step.value;
            if(this.byCell.has(rock.cell)) continue;
            budget--;
            let e = this.measure(rock);
            if(e > 0 && e < GLOW_ROCK.freeAt && this.underCeiling(rock)) this.materialize(rock, e);
        }
    }

    /** Point the cursor at the unscanned stored chunk nearest a player that can have rocks showing; false if none. */
    nextChunk() {
        let T = this.T, R = GLOW_ROCK.scanRange, lim = this.config.surfaceY - GLOW_ROCK.margin;
        let anchors = [...this.world.each('Player', 'Transform')].map(r => r[2].position);
        for(;;) {
            let best = null, bestD = Infinity;
            for(let p of anchors) for(let key of chunksInBox(T.world, { x: p.x - R, y: p.y - R, z: p.z - R }, { x: p.x + R, y: p.y + R, z: p.z + R })) {
                let c = T.chunks[key];
                if(!c || !T.hasSolid(key) || this.scanned.get(key) === c.version || chunkMin(key).y >= lim) continue;
                let m = chunkCenter(key), d = (p.x - m.x) ** 2 + (p.y - m.y) ** 2 + (p.z - m.z) ** 2;
                if(d < bestD) { bestD = d; best = key; }
            }
            if(!best) return false;
            let c = T.chunks[best], e = this.bvhOf(best);
            if(!e || !e.air) { this.scanned.set(best, c.version); continue; } // solid through and through below the surface
            let min = chunkMin(best), r = GLOW_ROCK.maxRadius;
            this.cursor = { key: best, version: c.version, rocks: virtualRocksIn(this.field, this.config.surfaceY,
                { x: min.x - r, y: min.y - r, z: min.z - r }, { x: min.x + CHUNK_SIZE + r, y: min.y + CHUNK_SIZE + r, z: min.z + CHUNK_SIZE + r }) };
            return true;
        }
    }
}
