/** Vertex GI's CPU side, in a worker (giWorker.js; TerrainGI.js falls back to running it on the main thread where a
 *  worker cannot start). It owns giCore (the refined meshes, the records, the adaptive splits, the scheduling), a BVH of
 *  each chunk's coarse geometry (for the sight checks of light seeding and for placing crystals), and the crystals'
 *  bookkeeping; the main thread keeps only the GPU (buffers, passes, the packed BVH) and TerrainMirror.
 *
 *  Refinement used to run on the main thread: a readback's adaptive passes stalled it for up to 0.4 s on a desktop
 *  (36 passes re-refined 174 chunks, a neighbour once per pass), seconds on a phone. Here each pass only marks chunks,
 *  each marked chunk is refined once, and that work is time-sliced between frames (`ADAPT_MS` per frame message), so
 *  the job lists keep coming.
 *
 *  It also packs the GPU BVH (three-mesh-bvh's BVHComputeData over its chunk BVHs, each coarse corner carrying its
 *  record and albedo): that full repack cost 22-32 ms of the main thread per carve on a 4x-throttled CPU.
 *
 *  Messages in: init, chunk (coarse arrays and albedo), remove, changed (a carve's box), state (a readback of the
 *  records' light), rock / unrock (crystals), frame (camera; answered with a work package). Out: chunk (a refined
 *  render mesh), bvh (the packed BVH's buffers; the chunks in it may be sampled from then on), work (jobs, glow jobs,
 *  crystal buffer writes, whether a readback is wanted, stats). Every message out carries the record uploads (positions/normals of new
 *  records, init and knock ops) the main thread must apply before anything that references them. */
import { BufferGeometry, BufferAttribute, Ray, Vector3, Box3, DoubleSide, Mesh } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { BVHComputeData } from 'three-mesh-bvh/webgpu';
import { GICore, NO_RECORD } from './giCore.js';

const CHUNK = 10;
const ADAPT_MS = 6;          // adaptive refinement per frame message
const STATS_MS = 1000;

export class GIHost {
    constructor(post) {
        this.post = post;            // (message, transfer list) => void
        this.core = null;
        this.bvhs = new Map();       // chunk key -> MeshBVH of its coarse geometry (world space)
        this.state = null;           // the latest readback (8 floats per record)
        this.staged = [];            // chunks waiting for a readback before their adaptive pass
        this.adaptQueue = [];        // chunks to run an adaptive pass on (with this.state)
        this.redoQueue = new Set();  // chunks to refine again
        this.wantState = false;
        this.statsAt = 0;
        this.proxies = new Map();    // chunk key -> Mesh of its coarse geometry (with `surface`) for the packed BVH
        this.packer = new BVHComputeData([], { attributes: { position: 'vec4f', surface: 'vec4f' } });
        this.packDirty = false; this.packAt = 0;
        this.unpacked = new Set();   // chunks whose current geometry the packed BVH does not have yet
        this.ray = new Ray(); this.box = new Box3(); this.p = new Vector3(); this.hit = {};
    }

    handle(m) {
        switch(m.t) {
            case 'init': return this.init(m);
            case 'chunk': return this.chunk(m);
            case 'remove': this.core.removeChunk(m.key); this.bvhs.delete(m.key); if(this.proxies.delete(m.key)) this.packDirty = true; this.unpacked.delete(m.key); return;
            case 'changed': return this.changed(m.box);
            case 'state': this.state = new Float32Array(m.buf); this.adaptQueue.push(...this.staged); this.staged = []; this.wantState = false; return;
            case 'rock': return this.setRock(m.id, m.x, m.y, m.z, m.radius, m.rgb, m.power);
            case 'unrock': return this.removeRock(m.id);
            case 'frame': return this.frame(m);
        }
    }

    init(m) {
        this.core = new GICore(m.params);
        this.maxJobs = m.maxJobs; this.maxGlowJobs = m.maxGlowJobs; this.maxCrystals = m.maxCrystals; this.reach = m.reach;
        this.crystals = new Map();    // rock id -> slot
        this.slots = [];              // slot -> { id, x, y, z, radius, lx, ly, lz, rgb, power, recs: Set, cell }
        this.freeSlots = [];
        this.crystalCells = new Map();// 4 m cell -> Set of slots (by light position)
        this.recCrystals = new Map(); // record -> slots lighting it (at most 7)
        this.glowQueue = new Set();   // records whose baked crystal light needs (re)computing
        this.glowAwaitBvh = new Set();// slots to place and bake again once the packed BVH has the terrain around them
        this.crystalWrites = [];      // [slot, Float32Array(8)] for the GPU buffer
        this.core.visible = (ax, ay, az, bx, by, bz) => this.visible(ax, ay, az, bx, by, bz);
        this.core.records.onDrop = (id) => this.forgetRecord(id);
    }

    /** Record uploads accumulated since the last message: new records' geo (one range) and the ops. */
    recordUpdates() {
        let R = this.core.records, d = R.takeDirty(), ops = R.takeOps(), out = {}, transfer = [];
        if(d) { out.geoLo = d[0]; out.geo = R.geo.slice(d[0] * 8, (d[1] + 1) * 8); transfer.push(out.geo.buffer); }
        if(ops.length) { out.ops = Uint32Array.from(ops); transfer.push(out.ops.buffer); }
        return [out, transfer];
    }

    send(msg, transfer = []) {
        let [up, t] = this.recordUpdates();
        Object.assign(msg, up);
        this.post(msg, transfer.concat(t));
    }

    // ---- chunks ---------------------------------------------------------------------

    chunk(m) {
        // the coarse geometry's BVH first: seeding checks sight against the terrain as it is now
        let g = new BufferGeometry(), nt = m.cls.length;
        g.setAttribute('position', new BufferAttribute(m.pos, 3));
        let bvh = nt ? new MeshBVH(g, { targetLeafSize: 8 }) : null;
        this.bvhs.set(m.key, bvh);
        let ch = this.core.setChunk(m.key, m.version, { pos: m.pos, nrm: m.nrm, uv: m.uv, cls: m.cls, skip: m.skip }, m.carved);
        this.redoQueue.delete(ch); // (a replaced chunk object is not in there anyway)
        this.assignCrystals(ch);
        this.sendChunk(ch);
        // for the packed BVH: each corner (the geometry is a flat corner list) with its record and its triangle's albedo
        if(this.proxies.delete(m.key)) this.packDirty = true;
        if(bvh) {
            let surface = new Float32Array(nt * 12);
            for(let t = 0; t < nt; t++) for(let k = 0; k < 3; k++) {
                let o = (t * 3 + k) * 4;
                surface[o] = ch.coarseRec[t * 3 + k]; surface[o + 1] = m.alb[t * 3]; surface[o + 2] = m.alb[t * 3 + 1]; surface[o + 3] = m.alb[t * 3 + 2];
            }
            g.setAttribute('surface', new BufferAttribute(surface, 4));
            g.boundsTree = bvh;
            let proxy = new Mesh(g); proxy.updateMatrixWorld();
            this.proxies.set(m.key, proxy);
            this.packDirty = true;
        }
        this.unpacked.add(m.key);
    }

    /** Repack the GPU BVH (at most once a second while chunks change) and send its buffers; the chunks in it may be
     *  sampled, and crystals waiting for it are placed and baked again. */
    pack() {
        this.packAt = performance.now(); this.packDirty = false;
        if(!this.proxies.size) return;
        let P = this.packer;
        P.objects = [...this.proxies.values()];
        try { P.update(); } catch(e) { console.warn('TerrainGI worker: BVH pack failed: ' + e.message); return; }
        let arr = (n) => n.value.array;
        let msg = { t: 'bvh', nodes: arr(P.storage.nodes), index: arr(P.storage.index), attributes: arr(P.storage.attributes), transforms: arr(P.storage.transforms) };
        // (sent, not copied: the packer makes new buffers on its next update)
        this.send(msg, [msg.nodes.buffer, msg.index.buffer, msg.attributes.buffer, msg.transforms.buffer]);
        let keys = [...this.unpacked]; this.unpacked.clear();
        this.ready(keys);
    }

    sendChunk(ch) {
        let msg = { t: 'chunk', key: ch.key, version: ch.version, positions: ch.positions.slice(), normals: ch.normals.slice(), uvs: ch.uvs.slice(), cls: ch.cls.slice(), recOf: ch.recOf.slice(), index: ch.index.slice(), coarseRec: ch.coarseRec.slice() };
        this.send(msg, [msg.positions.buffer, msg.normals.buffer, msg.uvs.buffer, msg.cls.buffer, msg.recOf.buffer, msg.index.buffer, msg.coarseRec.buffer]);
    }

    /** A carve changed a region: records around it re-converge, crystals whose light reaches it are placed again once
     *  the packed BVH has the new terrain. */
    changed(box) {
        this.core.knockAround(box);
        let cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
        let half = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2;
        for(let slot of this.crystalsNear(cx, cy, cz, this.reach + half)) this.glowAwaitBvh.add(slot);
    }

    /** The packed BVH now has these chunks: they may be sampled, and crystals waiting for it are placed and baked again. */
    ready(keys) {
        for(let key of keys) { let ch = this.core.chunks.get(key); if(ch) ch.ready = true; }
        for(let slot of this.glowAwaitBvh) { let c = this.slots[slot]; if(!c) continue; this.unlinkCrystal(slot); this.placeCrystal(c); this.linkCrystal(slot); }
        this.glowAwaitBvh.clear();
    }

    /** Can one point see another? (the coarse chunk BVHs here) */
    visible(ax, ay, az, bx, by, bz) {
        let dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
        if(len < 1e-4) return true;
        let ray = this.ray;
        ray.origin.set(ax, ay, az); ray.direction.set(dx / len, dy / len, dz / len);
        for(let bvh of this.bvhsIn(Math.min(ax, bx), Math.min(ay, by), Math.min(az, bz), Math.max(ax, bx), Math.max(ay, by), Math.max(az, bz))) {
            if(bvh.raycastFirst(ray, DoubleSide, 0, len)) return false;
        }
        return true;
    }

    *bvhsIn(x0, y0, z0, x1, y1, z1) {
        for(let i = Math.floor(x0 / CHUNK); i <= Math.floor(x1 / CHUNK); i++)
            for(let j = Math.floor(y0 / CHUNK); j <= Math.floor(y1 / CHUNK); j++)
                for(let k = Math.floor(z0 / CHUNK); k <= Math.floor(z1 / CHUNK); k++) { let b = this.bvhs.get(`${i},${j},${k}`); if(b) yield b; }
    }

    // ---- per frame ---------------------------------------------------------------------

    frame(m) {
        let t0 = performance.now(), core = this.core;
        if(this.packDirty && t0 - this.packAt > 1000) this.pack();
        // adaptive refinement, a slice at a time: passes mark chunks, each marked chunk is refined once
        if(this.state) {
            while(performance.now() - t0 < ADAPT_MS && (this.redoQueue.size || this.adaptQueue.length)) {
                if(this.redoQueue.size) {
                    let ch = this.redoQueue.values().next().value; this.redoQueue.delete(ch);
                    if(core.chunks.get(ch.key) !== ch) continue;
                    core.redo(ch);
                    this.assignCrystals(ch);
                    this.sendChunk(ch);
                } else {
                    let ch = this.adaptQueue.shift();
                    if(core.chunks.get(ch.key) !== ch) continue;
                    for(let c of core.adapt(ch, this.state)) this.redoQueue.add(c);
                }
            }
        }
        let cam = { x: m.cam[0], y: m.cam[1], z: m.cam[2] };
        let jobs = new Uint32Array(this.maxJobs), { count, staged } = core.schedule(jobs, cam);
        for(let ch of staged) this.staged.push(ch);
        if(this.staged.length && !this.wantState) this.wantState = true;
        let glow = this.takeGlowJobs();
        let msg = { t: 'work', jobs: jobs.slice(0, count), glow, crystals: this.crystalWrites, wantState: this.wantState };
        this.crystalWrites = [];
        if(t0 - this.statsAt > STATS_MS) { this.statsAt = t0; msg.stats = this.info(); }
        let transfer = [msg.jobs.buffer]; if(glow) transfer.push(glow.buffer);
        this.send(msg, transfer);
    }

    info() {
        let c = this.core, n = 0, ready = 0, minS = Infinity;
        for(let ch of c.chunks.values()) { n += ch.recs.length; if(ch.ready) ready++; if(ch.recs.length) minS = Math.min(minS, ch.minSamples); }
        return { chunks: c.chunks.size, ready, records: c.records.size, refs: n, full: c.records.full, minSamples: minS, splits: c.splitEdges.size,
            crystals: this.crystals.size, crystalRecords: this.recCrystals.size, glowQueue: this.glowQueue.size, adaptQueue: this.adaptQueue.length, redoQueue: this.redoQueue.size,
            refineMs: Math.round(c.stats.refineMs), refines: c.stats.refines, seeded: c.stats.seeded, dark: c.stats.dark };
    }

    // ---- crystals -----------------------------------------------------------------------

    static cell4(x, y, z) { return ((Math.floor(x / 4) + 1024) * 2048 + (Math.floor(y / 4) + 1024)) * 2048 + (Math.floor(z / 4) + 1024); }

    /** Slots of crystals whose light position is within `reach` of a point. */
    crystalsNear(x, y, z, reach) {
        let out = [], r = Math.ceil(reach / 4), cx = Math.floor(x / 4), cy = Math.floor(y / 4), cz = Math.floor(z / 4);
        for(let i = -r; i <= r; i++) for(let j = -r; j <= r; j++) for(let k = -r; k <= r; k++) {
            let set = this.crystalCells.get(((cx + i + 1024) * 2048 + (cy + j + 1024)) * 2048 + (cz + k + 1024));
            if(!set) continue;
            for(let slot of set) { let c = this.slots[slot]; if((c.lx - x) ** 2 + (c.ly - y) ** 2 + (c.lz - z) ** 2 <= reach * reach) out.push(slot); }
        }
        return out;
    }

    /** Where a crystal's light stands: a little out of the wall, along the normal of the terrain surface nearest it (a
     *  crystal pokes through that surface: it is partly exposed). A source flush with the wall would light that wall
     *  only at grazing angles; averaging the directions rays could travel put many lights inside the rock (a ray
     *  starting in solid with no surface within reach looked open). */
    placeCrystal(c) {
        let p = this.p.set(c.x, c.y, c.z), hit = this.hit, e = c.radius + 1, best = Infinity, nx = 0, ny = 0, nz = 0;
        for(let bvh of this.bvhsIn(c.x - e, c.y - e, c.z - e, c.x + e, c.y + e, c.z + e)) {
            if(!bvh.closestPointToPoint(p, hit, 0, Math.min(best, e)) || hit.distance >= best) continue;
            let g = bvh.geometry, P = g.attributes.position.array, I = g.index.array, f = hit.faceIndex * 3;
            let a = I[f] * 3, b = I[f + 1] * 3, d = I[f + 2] * 3;
            let ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
            let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, l = Math.hypot(cx, cy, cz);
            if(l < 1e-12) continue;
            best = hit.distance; nx = cx / l; ny = cy / l; nz = cz / l;
        }
        let k = best < Infinity ? c.radius + 0.35 : 0;
        c.lx = c.x + nx * k; c.ly = c.y + ny * k; c.lz = c.z + nz * k;
    }

    /** Queue a crystal's GPU buffer entry and link it with the records within its reach (each record keeps its 7
     *  closest crystals), queueing those records for the glow pass. */
    linkCrystal(slot) {
        let c = this.slots[slot], reach = this.reach;
        this.crystalWrites.push([slot, Float32Array.of(c.lx, c.ly, c.lz, reach, c.rgb[0], c.rgb[1], c.rgb[2], 0)]);
        let cell = GIHost.cell4(c.lx, c.ly, c.lz), set = this.crystalCells.get(cell);
        if(set) set.add(slot); else this.crystalCells.set(cell, new Set([slot]));
        c.cell = cell;
        let R = this.core.records, g = R.geo, r = Math.ceil(reach), cx = Math.floor(c.lx), cy = Math.floor(c.ly), cz = Math.floor(c.lz);
        for(let i = -r; i <= r; i++) for(let j = -r; j <= r; j++) for(let k = -r; k <= r; k++) {
            let list = R.cells.get(((cx + i + 4096) * 8192 + (cy + j + 4096)) * 8192 + (cz + k + 4096));
            if(!list) continue;
            for(let id of list) {
                let q = id * 8;
                if((g[q] - c.lx) ** 2 + (g[q + 1] - c.ly) ** 2 + (g[q + 2] - c.lz) ** 2 <= reach * reach) this.addCrystalTo(id, slot);
            }
        }
    }

    addCrystalTo(id, slot) {
        let list = this.recCrystals.get(id), g = this.core.records.geo, q = id * 8;
        let d2 = (s) => { let c = this.slots[s]; return (g[q] - c.lx) ** 2 + (g[q + 1] - c.ly) ** 2 + (g[q + 2] - c.lz) ** 2; };
        if(!list) { list = []; this.recCrystals.set(id, list); }
        if(list.includes(slot)) { this.glowQueue.add(id); return; }
        if(list.length >= 7) {
            let worst = 0; for(let i = 1; i < list.length; i++) if(d2(list[i]) > d2(list[worst])) worst = i;
            if(d2(list[worst]) <= d2(slot)) return;
            this.slots[list[worst]].recs.delete(id);
            list[worst] = slot;
        } else list.push(slot);
        this.slots[slot].recs.add(id);
        this.glowQueue.add(id);
    }

    unlinkCrystal(slot) {
        let c = this.slots[slot];
        for(let id of c.recs) {
            let list = this.recCrystals.get(id);
            if(list) { let i = list.indexOf(slot); if(i >= 0) list.splice(i, 1); if(!list.length) this.recCrystals.delete(id); }
            this.glowQueue.add(id);
        }
        c.recs.clear();
        let set = this.crystalCells.get(c.cell);
        if(set) { set.delete(slot); if(!set.size) this.crystalCells.delete(c.cell); }
    }

    /** A glow rock showed up or changed: `rgb` its linear colour, `power` its exposure's share of the light. */
    setRock(id, x, y, z, radius, rgb, power) {
        let slot = this.crystals.get(id), col = [rgb[0] * power, rgb[1] * power, rgb[2] * power];
        if(slot !== undefined) {
            let c = this.slots[slot];
            if(c.x === x && c.y === y && c.z === z) {
                if(Math.abs(c.power - power) < 0.01) return;
                c.power = power; c.rgb = col;
                this.crystalWrites.push([slot, Float32Array.of(c.lx, c.ly, c.lz, this.reach, col[0], col[1], col[2], 0)]);
                for(let r of c.recs) this.glowQueue.add(r);
                return;
            }
            this.removeRock(id);
        }
        slot = this.freeSlots.length ? this.freeSlots.pop() : this.slots.length;
        if(slot >= this.maxCrystals) return;
        let c = { id, x, y, z, radius, power, rgb: col, recs: new Set(), lx: x, ly: y, lz: z, cell: 0 };
        this.slots[slot] = c;
        this.crystals.set(id, slot);
        this.placeCrystal(c);
        this.linkCrystal(slot);
        this.glowAwaitBvh.add(slot);   // the packed BVH may not have the dig that exposed it yet
        this.core.knockAround({ min: { x: c.lx, y: c.ly, z: c.lz }, max: { x: c.lx, y: c.ly, z: c.lz } }); // the bounce around it changes
    }

    removeRock(id) {
        let slot = this.crystals.get(id);
        if(slot === undefined) return;
        this.unlinkCrystal(slot);
        this.crystalWrites.push([slot, new Float32Array(8)]);
        this.glowAwaitBvh.delete(slot);
        this.slots[slot] = null; this.freeSlots.push(slot);
        this.crystals.delete(id);
    }

    /** New records near crystals (a refined or carved chunk) get theirs. */
    assignCrystals(ch) {
        if(!this.crystals.size) return;
        let g = this.core.records.geo;
        for(let id of ch.recs) {
            if(this.recCrystals.has(id)) continue;
            let q = id * 8;
            for(let slot of this.crystalsNear(g[q], g[q + 1], g[q + 2], this.reach)) this.addCrystalTo(id, slot);
        }
    }

    /** A record was freed: its slot may be reused by another vertex. */
    forgetRecord(id) {
        let list = this.recCrystals.get(id);
        if(list) { for(let slot of list) this.slots[slot]?.recs.delete(id); this.recCrystals.delete(id); }
        this.glowQueue.delete(id);
    }

    /** Up to maxGlowJobs queued records with their crystals: [record, 7 slots] each. */
    takeGlowJobs() {
        if(!this.glowQueue.size) return null;
        let a = new Uint32Array(Math.min(this.glowQueue.size, this.maxGlowJobs) * 8), n = 0;
        for(let id of this.glowQueue) {
            if(n * 8 >= a.length) break;
            this.glowQueue.delete(id);
            if(this.core.records.refs[id] === 0) continue;
            let list = this.recCrystals.get(id) || [], o = n * 8;
            a[o] = id;
            for(let i = 0; i < 7; i++) a[o + 1 + i] = i < list.length ? list[i] : NO_RECORD;
            n++;
        }
        return n ? a.slice(0, n * 8) : null;
    }
}
