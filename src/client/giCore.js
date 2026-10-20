/** Vertex GI, the CPU half: the refined render meshes, the light records their vertices share, and which records get
 *  rays each frame. The rays themselves run on the GPU (src/client/TerrainGI.js: three-mesh-bvh's BVHComputeData over
 *  the chunk meshes, a compute pass that accumulates into a storage buffer of records, read by the terrain material).
 *
 *  Only indirect light is baked: the sun's direct light and shadows stay on the real-time cascades, and the glow rocks
 *  on their volume (GlowLighting.js). What is left (the sky, the sun bounced off the ground and the walls, and further
 *  bounces) changes slowly across a surface, so it is stored at vertices, not in lightmap texels: no charts, no atlas
 *  to repack when a carve cuts a new surface, no seams, and a fraction of the sample points (Twin Forts: ~30k m² of
 *  surface is ~3M texels at 10 cm, tens of thousands of vertices here).
 *
 *  Refinement. The level's triangles are huge (mean 4 m², most of the area in triangles over 4 m²), so each chunk's
 *  render mesh is subdivided: an edge is split at its midpoint when it is longer than `maxEdge`, or when a pass over
 *  the gathered light found its two ends too different (`splitEdges`, down to `minEdge`). The rule looks only at the
 *  edge itself, so every triangle sharing an edge, in this chunk or the next, splits it the same way: no T-junctions.
 *  Triangles flagged `skip` (on a chunk plane and hidden: TerrainGI decides) are not refined and get no record.
 *
 *  Records. A vertex's light lives in a record keyed by its position and normal (on a 0.1 mm / 0.001 grid), shared by
 *  every render vertex at that point with that normal, in every chunk: seams between materials and between chunks are
 *  continuous, and when a carve replaces a chunk, the vertices of the surfaces it did not touch find their records with
 *  every sample they had. A record's sum and count live on the GPU; the CPU mirrors the count it scheduled (for
 *  priorities), and reads the sums back now and then to decide adaptive splits. A new record is initialised on the GPU
 *  (`ops`) with light carried along the surface from the lit records around it (`GICore.seed`), else dark (in a carve)
 *  or empty (the shader shows the probe grid's light until it has samples). */

export const GI_DEFAULTS = {
    maxEdge: 2,            // metres: no render edge longer than this
    minEdge: 0.4,          // metres: adaptive splits stop at edges this short
    contrast: 0.45,        // relative difference of the light at an edge's ends that splits it
    stages: [64, 192],     // samples per record at which a chunk is checked for adaptive splits
    maxSamples: 256,       // the running mean becomes an exponential average past this (the light changes with the terrain)
    nearDistance: 25,      // chunks within this of the camera aim for maxSamples; further ones for fewer
    weightAt: 12,          // samples at which a vertex's light fully replaces the probe grid's (the shader)
    capacity: 1 << 18,     // records the GPU buffers hold
    knockTo: 12,           // samples a record near a carve keeps (the light there just changed; no fewer than weightAt, or the
                           // probe grid's light comes back on the walls around every dig)
    knockReach: 5,         // metres around a carve's region
    seedReach: 3,          // metres of surface over which a new vertex takes light from lit ones (a chunk arriving) ...
    seedReachCarved: 12,   // ... and around a carve (from a crater's rim to its floor is ~4 m of surface, and the lit
                           // records nearest the rim can be a few metres off where the carve retriangulated the ground)
    seedFalloff: 5,        // metres of surface over which light carried into a carve falls to 1/e (it is deeper in and sees
                           // less: a tunnel out of the vault converged at 26/255 and took 39 from plain copies of its entrance)
    carveMargin: 3,        // metres around what a carve changed in a chunk that count as carved: the part of a crater in a
                           // chunk that was solid rock arrives with no old mesh to compare, so no box of its own ...
    carveMs: 2000,         // ... for this long after it
};

/** GPU ops, 8 words each: [type | weight << 8, record, a, b], [c, d, wa | wb << 16, wc | wd << 16]. OP_INIT (a new record)
 *  and OP_SEED (one that had no light yet) set its light to wa * mean(a) + ... + wd * mean(d) (weights in units of
 *  1/WEIGHT_ONE, so up to 4) at
 *  `weight` samples, no source being dark at that weight (or empty at 0); OP_INIT also clears its crystal light and
 *  sample sequence. OP_KNOCK keeps at most `a` samples' worth. */
export const OP_INIT = 0, OP_KNOCK = 1, OP_SEED = 2, OP_WORDS = 8, NO_RECORD = 0xffffffff, WEIGHT_ONE = 16384;
const SOURCES = 4;
// samples before a record that started without light counts as lit: an empty one's mean is all samples, a dark one's
// starts as weightAt samples of black (one sample in, it would pass on near black: the old seam flaw by another route)
const NEED_EMPTY = 4, NEED_DARK = 24;
/** How much of the light from above a record's normal takes in (1 facing up, 0.65 upright, 0.3 facing down): light
 *  carried from one record to another is scaled by their ratio (crater walls just under the rim took the ground's light
 *  whole, ~30% too bright). Both ways, or a crater's floor seeded through its walls kept their darkening. */
const skyward = (g, r) => 0.3 + 0.35 * (1 + g[r * 8 + 5]);

const Q_POS = 1e4, Q_NRM = 1e3;
const posKey = (x, y, z) => `${Math.round(x * Q_POS)},${Math.round(y * Q_POS)},${Math.round(z * Q_POS)}`;
const nrmKey = (x, y, z) => `${Math.round(x * Q_NRM)},${Math.round(y * Q_NRM)},${Math.round(z * Q_NRM)}`;
const CHUNK = 10;
const EMPTY = [];

/** A binary min-heap of (key, a, b) entries in flat arrays. */
class Heap {
    constructor() { this.k = []; this.va = []; this.vb = []; }
    get size() { return this.k.length; }
    top() { return this.k[0]; }
    a() { return this.va[0]; }
    b() { return this.vb[0]; }
    push(key, a, b = 0) {
        let K = this.k, A = this.va, B = this.vb, i = K.length;
        K.push(key); A.push(a); B.push(b);
        while(i > 0) {
            let up = (i - 1) >> 1;
            if(K[up] <= key) break;
            K[i] = K[up]; A[i] = A[up]; B[i] = B[up]; i = up;
        }
        K[i] = key; A[i] = a; B[i] = b;
    }
    pop() {
        let K = this.k, A = this.va, B = this.vb, key = K.pop(), a = A.pop(), b = B.pop(), n = K.length;
        if(!n) return;
        let i = 0;
        for(;;) {
            let l = i * 2 + 1, r = l + 1, m = i, mk = key;
            if(l < n && K[l] < mk) { m = l; mk = K[l]; }
            if(r < n && K[r] < mk) m = r;
            if(m === i) break;
            K[i] = K[m]; A[i] = A[m]; B[i] = B[m]; i = m;
        }
        K[i] = key; A[i] = a; B[i] = b;
    }
}

function hash32(x) { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0; }

/** Light records: keys, references and the per-record data the GPU needs (`geo`: position and normal, two vec4s, each
 *  with a low-discrepancy rotation in w). Slots are reused; a reused slot is re-initialised by an op. */
export class Records {
    constructor(capacity) {
        this.capacity = capacity;
        this.geo = new Float32Array(capacity * 8);
        this.cnt = new Float32Array(capacity);       // samples scheduled (a mirror of the GPU's count)
        this.refs = new Uint32Array(capacity);
        this.stamp = new Uint32Array(capacity);      // frame it was last scheduled in (one sample per frame)
        this.keyOf = new Array(capacity);
        this.keys = new Map();
        this.free = [];
        this.fresh = [];                             // created since the last sweep
        this.n = 0;
        this.ops = [];                               // for the GPU, OP_WORDS words each (see OP_INIT)
        this.dirtyLo = Infinity; this.dirtyHi = -1;  // slots whose geo needs uploading
        this.full = false;
        this.lit = new Uint8Array(capacity);         // 1: has light worth passing on (carried from lit ones, or sampled) ...
        this.need = new Uint8Array(capacity);        // ... else the samples still to come before it has (see GICore.seed)
        this.pending = [];                           // [id, a, b] of records created since GICore.seed last ran
        this.cells = new Map();                      // 1 m cell -> record ids, to find the records at a point
        this.cellOf = new Float64Array(capacity);
        this.onDrop = null;                          // (id) => void, when a record is freed (TerrainGI forgets its crystals)
    }
    static cellKey(x, y, z) { return ((Math.floor(x) + 4096) * 8192 + (Math.floor(y) + 4096)) * 8192 + (Math.floor(z) + 4096); }
    get size() { return this.keys.size; }
    /** The record for a key, created at (p, n) if new: with no references yet (`retain` takes one, `sweep` frees the new
     *  ones nobody took), waiting for GICore.seed to initialise it on the GPU (`pa`, `pb`: the ends of the edge a
     *  midpoint splits). -1 when the buffers are full. */
    find(key, px, py, pz, nx, ny, nz, pa = -1, pb = -1) {
        let id = this.keys.get(key);
        if(id !== undefined) return id;
        if(this.free.length) id = this.free.pop();
        else if(this.n < this.capacity) id = this.n++;
        else { this.full = true; return -1; }
        this.keys.set(key, id); this.keyOf[id] = key;
        let h = hash32(id * 2654435761 + 12345);
        let g = this.geo, o = id * 8;
        g[o] = px; g[o + 1] = py; g[o + 2] = pz; g[o + 3] = (h & 0xffff) / 65536;
        g[o + 4] = nx; g[o + 5] = ny; g[o + 6] = nz; g[o + 7] = (h >>> 16) / 65536;
        this.refs[id] = 0; this.stamp[id] = 0; this.cnt[id] = 0; this.lit[id] = 0; this.need[id] = NEED_EMPTY;
        this.pending.push(id, pa, pb);
        let c = Records.cellKey(px, py, pz), list = this.cells.get(c);
        if(list) list.push(id); else this.cells.set(c, [id]);
        this.cellOf[id] = c;
        if(id < this.dirtyLo) this.dirtyLo = id;
        if(id > this.dirtyHi) this.dirtyHi = id;
        this.fresh.push(id);
        return id;
    }
    retain(id) { this.refs[id]++; }
    release(id) { if(--this.refs[id] <= 0) this.drop(id); }
    drop(id) {
        this.keys.delete(this.keyOf[id]); this.keyOf[id] = undefined; this.refs[id] = 0; this.free.push(id);
        this.onDrop?.(id);
        let list = this.cells.get(this.cellOf[id]);
        if(list) { let i = list.indexOf(id); if(i >= 0) { list[i] = list[list.length - 1]; list.pop(); } if(!list.length) this.cells.delete(this.cellOf[id]); }
    }
    sweep() { for(let id of this.fresh) if(this.refs[id] === 0 && this.keyOf[id] !== undefined) this.drop(id); this.fresh = []; }
    /** Set a record's light to the weighted sum of up to four records' means (`src`, `wts` in [0, 4)) at `w` samples'
     *  worth; `full` for a new record (see OP_INIT). */
    set(id, w, src, wts, full) {
        let q = (i) => i < wts.length ? Math.max(0, Math.min(65535, Math.round(wts[i] * WEIGHT_ONE))) : 0, s = (i) => i < src.length ? src[i] : NO_RECORD;
        this.ops.push(((full ? OP_INIT : OP_SEED) | (w << 8)) >>> 0, id, s(0), s(1), s(2), s(3), (q(0) | (q(1) << 16)) >>> 0, (q(2) | (q(3) << 16)) >>> 0);
        this.cnt[id] = w;
    }
    /** Keep at most `n` samples' worth (the mean stays, its weight drops). */
    knock(id, n) { if(this.cnt[id] <= n) return; this.cnt[id] = n; this.ops.push(OP_KNOCK, id, n, 0, 0, 0, 0, 0); }
    takeOps() { let o = this.ops; this.ops = []; return o; }
    takeDirty() { let r = this.dirtyHi >= this.dirtyLo ? [this.dirtyLo, this.dirtyHi] : null; this.dirtyLo = Infinity; this.dirtyHi = -1; return r; }
}

export class GICore {
    constructor(params = {}) {
        this.p = { ...GI_DEFAULTS, ...params };
        this.records = new Records(this.p.capacity);
        this.chunks = new Map();       // key -> chunk
        this.splitEdges = new Set();   // edge keys (sorted position keys) split by the adaptive passes
        this.frame = 0;
        this.stats = { refines: 0, refineMs: 0, adapts: 0, splits: 0, seeded: 0, dark: 0, seedMs: 0 };
        this.carves = [];              // recent carves: { t, box: [x0, y0, z0, x1, y1, z1] } (see `carveMargin`)
    }

    /** How new records start (the ones created since the last call; after every refinement). A fresh vertex used to
     *  start empty, and the shader showed the probe grid's light until rays came in: underground, a new tunnel lit up
     *  like the plaza for a second. It then copied the two nearest lit records in sight, which could pick a sunlit rim
     *  for one corner and a shaded wall for the next, and a crater crossing a chunk plane copied the copies on the other
     *  side, darker each time. Now light is carried along the surface: a midpoint of an edge between lit records takes
     *  their mean (an adaptive split then shows what was drawn before it); any other new record takes a blend of the
     *  `SOURCES` lit records nearest to it over the surface graph (render edges, plus records at the same point across a
     *  hard edge or a chunk seam; `neighbours`), weighted by distance so the blend changes smoothly from vertex to vertex
     *  (Franke and Little's weights, which reach 0 at the next source out), and by how its facing compares with each
     *  source's (`skyward`). Light never crosses solid: two faces of a wall are connected only around its edge,
     *  and the caps on chunk planes, which lie inside the rock, are not part of the graph. A record on surface a carve
     *  just cut takes exp(-d / `seedFalloff`) of that light, d being how far it lies over cut surface from surface that
     *  was there before (or is lit), so a crater's floor and the end of a tunnel start darker than their rims, and a
     *  copy of a copy is only as dark as its depth says; the ground a carve merely retriangulated around its hole
     *  (`oldSurface`: on the chunk's previous triangles) is not cut surface (it carries the light of the lit records
     *  around it, which can be metres off). A cut record with nothing lit within `seedReachCarved` starts dark (it was
     *  solid rock a moment ago). Elsewhere (a chunk arriving) light comes from within `seedReach`, else the record
     *  starts empty. Records from earlier calls that are still unlit (never sampled, nothing reached
     *  them) are seeded again when a later one reaches them: the parts of one carve arrive chunk by chunk in any order,
     *  and the bowl of a crater in the chunk below the ground can come before the rim that connects it to the light.
     *  Only sampled or carried light is passed on (`Records.lit`), never a dark start. `old` is the chunk's previous
     *  coarse geometry when a carve changed it. */
    seed(old = null) {
        let R = this.records, P = R.pending;
        R.pending = [];
        if(!P.length) return;
        let now = performance.now();
        this.carves = this.carves.filter(c => now - c.t < this.p.carveMs);
        this.spread(P, old);
        this.stats.seedMs += performance.now() - now;
    }

    spread(P, old) {
        let R = this.records, p = this.p, W = p.weightAt, g = R.geo;
        let carved = new Map(), isCarved = (r) => {
            let v = carved.get(r);
            if(v !== undefined) return v;
            let o = r * 8, x = g[o], y = g[o + 1], z = g[o + 2];
            v = this.carves.some(({ box: b }) => x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]);
            carved.set(r, v);
            return v;
        };
        let reachOf = (r) => isCarved(r) ? p.seedReachCarved : p.seedReach;
        let alive = (r) => r >= 0 && R.refs[r] > 0 && R.keyOf[r] !== undefined;
        // the new records; midpoints of an edge between lit records take its ends' mean
        let fresh = new Set(), done = new Set();
        for(let i = 0; i < P.length; i += 3) {
            let id = P[i], a = P[i + 1], b = P[i + 2];
            if(!alive(id)) continue; // swept
            fresh.add(id);
            if(alive(a) && alive(b) && R.lit[a] && R.lit[b]) { R.set(id, W, [a, b], [0.5, 0.5], true); done.add(id); this.stats.seeded++; }
        }
        let kept = old ? this.oldSurface(old, [...fresh].filter(isCarved)) : null;
        let cut = (r) => isCarved(r) && !(kept && kept.has(r)); // on surface a carve cut (not merely retriangulated)
        // the records to seed: the new ones and the unlit ones on the surface within reach of them; the lit ones next
        // to those are the sources
        let cache = new Map(), heap = new Heap(), targets = new Map(), sources = new Set();
        for(let id of fresh) { targets.set(id, 0); heap.push(0, id); }
        while(heap.size) {
            let d = heap.top(), r = heap.a(); heap.pop();
            if(d > targets.get(r)) continue;
            let nb = this.neighbours(r, cache);
            for(let n = 0; n < nb.length; n += 2) {
                let u = nb[n];
                if(R.lit[u]) { sources.add(u); continue; }
                let du = d + nb[n + 1], was = targets.get(u);
                if(was !== undefined ? du >= was : du > reachOf(u) || !this.neighbours(u, cache).length) continue;
                targets.set(u, du); heap.push(du, u);
            }
        }
        // the nearest sources of each target over the surface, [source, distance, ...] (a target settles at most
        // SOURCES + 1, the last only for its distance)
        let best = new Map(), most = (SOURCES + 1) * 2, depth = new Map();
        if(sources.size) {
            for(let t of targets.keys()) {
                let nb = this.neighbours(t, cache);
                for(let n = 0; n < nb.length; n += 2) if(sources.has(nb[n]) && nb[n + 1] <= reachOf(t)) heap.push(nb[n + 1], t, nb[n]);
            }
            while(heap.size) {
                let d = heap.top(), t = heap.a(), s = heap.b(); heap.pop();
                let b = best.get(t);
                if(!b) best.set(t, b = []);
                if(b.length >= most) continue;
                let seen = false;
                for(let k = 0; k < b.length; k += 2) if(b[k] === s) { seen = true; break; }
                if(seen) continue;
                b.push(s, d);
                let nb = this.neighbours(t, cache);
                for(let n = 0; n < nb.length; n += 2) {
                    let u = nb[n];
                    if(!targets.has(u)) continue;
                    let du = d + nb[n + 1], bu = best.get(u);
                    if(du <= reachOf(u) && (!bu || bu.length < most)) heap.push(du, u, s);
                }
            }
            // how deep each target on cut surface lies: its distance over cut surface to surface that was there before
            for(let t of targets.keys()) {
                if(!cut(t)) continue;
                let nb = this.neighbours(t, cache);
                for(let n = 0; n < nb.length; n += 2) { let u = nb[n]; if(sources.has(u) || (targets.has(u) && !cut(u))) heap.push(nb[n + 1], t); }
            }
            while(heap.size) {
                let d = heap.top(), t = heap.a(); heap.pop();
                if(depth.has(t)) continue;
                depth.set(t, d);
                let nb = this.neighbours(t, cache);
                for(let n = 0; n < nb.length; n += 2) { let u = nb[n]; if(targets.has(u) && cut(u) && !depth.has(u)) heap.push(d + nb[n + 1], u); }
            }
        }
        let lit = [];
        for(let t of targets.keys()) {
            if(done.has(t)) continue;
            let b = best.get(t), isNew = fresh.has(t);
            if(b && b.length) {
                let n = Math.min(b.length / 2, SOURCES), far = b.length / 2 > SOURCES ? b[SOURCES * 2 + 1] : reachOf(t);
                let src = [], wts = [], sum = 0;
                for(let k = 0; k < n; k++) {
                    let d = Math.max(b[k * 2 + 1], 1e-4), w = far > d ? ((far - d) / (far * d)) ** 2 : 0;
                    src.push(b[k * 2]); wts.push(w); sum += w;
                }
                let fade = Math.exp(-(depth.get(t) || 0) / p.seedFalloff), vt = skyward(g, t);
                for(let k = 0; k < n; k++) wts[k] = (sum > 0 ? wts[k] / sum : 1 / n) * fade * vt / skyward(g, src[k]);
                R.set(t, W, src, wts, isNew);
                lit.push(t);
                this.stats.seeded++;
            } else if(isNew) {
                if(cut(t)) { R.set(t, W, [], [], true); R.need[t] = NEED_DARK; this.stats.dark++; }
                else { R.set(t, 0, [], [], true); R.need[t] = NEED_EMPTY; }
            }
        }
        // (marked only now: a record seeded in this pass is initialised in the same GPU dispatch, so no other may read it)
        for(let t of lit) R.lit[t] = 1;
        for(let t of done) R.lit[t] = 1;
    }

    /** Which of the records `ids` lie on a triangle of the chunk's previous coarse geometry `old`, facing its way: the
     *  surface a carve retriangulated around what it cut, not new surface. */
    oldSurface(old, ids) {
        let out = new Set();
        if(!ids.length) return out;
        let g = this.records.geo, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for(let r of ids) for(let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], g[r * 8 + a]); hi[a] = Math.max(hi[a], g[r * 8 + a]); }
        let { pos, cls } = old, tris = [], E = 2e-3;
        for(let t = 0; t < cls.length; t++) {
            let o = t * 9, skip = false;
            for(let a = 0; a < 3 && !skip; a++) {
                let m = Math.min(pos[o + a], pos[o + 3 + a], pos[o + 6 + a]), M = Math.max(pos[o + a], pos[o + 3 + a], pos[o + 6 + a]);
                if(m > hi[a] + E || M < lo[a] - E) skip = true;
            }
            if(skip) continue;
            let ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
            let ux = pos[o + 3] - ax, uy = pos[o + 4] - ay, uz = pos[o + 5] - az, vx = pos[o + 6] - ax, vy = pos[o + 7] - ay, vz = pos[o + 8] - az;
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
            if(l < 1e-10) continue;
            tris.push([ax, ay, az, ux, uy, uz, vx, vy, vz, nx / l, ny / l, nz / l]);
        }
        for(let r of ids) {
            let o = r * 8, x = g[o], y = g[o + 1], z = g[o + 2];
            for(let [ax, ay, az, ux, uy, uz, vx, vy, vz, nx, ny, nz] of tris) {
                let px = x - ax, py = y - ay, pz = z - az;
                if(Math.abs(px * nx + py * ny + pz * nz) > E || g[o + 4] * nx + g[o + 5] * ny + g[o + 6] * nz < 0.5) continue;
                // barycentric coordinates in the plane
                let uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz, vv = vx * vx + vy * vy + vz * vz;
                let pu = px * ux + py * uy + pz * uz, pv = px * vx + py * vy + pz * vz, den = uu * vv - uv * uv;
                let s = (vv * pu - uv * pv) / den, t = (uu * pv - uv * pu) / den, e = 1e-4;
                if(s >= -e && t >= -e && s + t <= 1 + e) { out.add(r); break; }
            }
        }
        return out;
    }

    /** A chunk's surface graph: record -> [neighbour, edge length, ...] over its render triangles, without caps (triangles
     *  lying on one of the chunk's boundary planes: a hidden one sits between two chunks' rock, and light carried across
     *  it would pass through the solid). Built when seeding first needs it, kept until the chunk is refined again. */
    adjacency(ch) {
        if(ch.adj) return ch.adj;
        let adj = new Map(), I = ch.index, P = ch.positions, rec = ch.recOf, lo = ch.min;
        let on = (i, a, s) => Math.abs(P[i * 3 + a] - s) < 1e-4;
        let cap = (i, j, k) => {
            for(let a = 0; a < 3; a++) for(let s of [lo[a], lo[a] + CHUNK]) if(on(i, a, s) && on(j, a, s) && on(k, a, s)) return true;
            return false;
        };
        let link = (i, j) => {
            let a = rec[i], b = rec[j];
            if(a < 0 || b < 0 || a === b) return;
            let la = adj.get(a);
            if(!la) adj.set(a, la = []);
            for(let n = 0; n < la.length; n += 2) if(la[n] === b) return; // (both ways are added together)
            let l = Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
            la.push(b, l);
            let lb = adj.get(b);
            if(!lb) adj.set(b, lb = []);
            lb.push(a, l);
        };
        for(let t = 0; t < I.length; t += 3) {
            let i = I[t], j = I[t + 1], k = I[t + 2];
            if(cap(i, j, k)) continue;
            link(i, j); link(j, k); link(k, i);
        }
        return ch.adj = adj;
    }

    /** A record's neighbours along the surface, [record, distance, ...]: its render edges in every chunk it is in, and
     *  the records at the same point with another normal (across a hard edge, or the next chunk's side of a seam) at
     *  distance 0. Empty for a record on nothing but caps. */
    neighbours(r, cache) {
        let got = cache.get(r);
        if(got) return got;
        let out = this.edgesOf(r), R = this.records, g = R.geo, o = r * 8, x = g[o], y = g[o + 1], z = g[o + 2];
        if(out.length) {
            out = out.slice();
            let span = (v) => { let a = Math.floor(v - 1e-4), b = Math.floor(v + 1e-4); return a === b ? [a] : [a, b]; };
            for(let i of span(x)) for(let j of span(y)) for(let k of span(z)) {
                let list = R.cells.get(Records.cellKey(i, j, k));
                if(list) for(let id of list) {
                    let q = id * 8;
                    if(id === r || Math.abs(g[q] - x) > 1e-4 || Math.abs(g[q + 1] - y) > 1e-4 || Math.abs(g[q + 2] - z) > 1e-4) continue;
                    if(R.refs[id] > 0 && this.edgesOf(id).length) out.push(id, 0);
                }
            }
        }
        cache.set(r, out);
        return out;
    }

    /** A record's render edges in the chunks around its point (the next ones too when it lies on a boundary plane). */
    edgesOf(r) {
        let g = this.records.geo, o = r * 8, out = null, first = null;
        let span = (v) => { let a = Math.floor((v - 1e-4) / CHUNK), b = Math.floor((v + 1e-4) / CHUNK); return a === b ? [a] : [a, b]; };
        for(let i of span(g[o])) for(let j of span(g[o + 1])) for(let k of span(g[o + 2])) {
            let ch = this.chunks.get(`${i},${j},${k}`), l = ch && this.adjacency(ch).get(r);
            if(!l) continue;
            if(!first) first = l;
            else { if(!out) out = first.slice(); for(let n = 0; n < l.length; n++) out.push(l[n]); }
        }
        return out || first || EMPTY;
    }

    /** Remember where a carve was, for `seed` (see `carveMargin`). */
    noteCarve(b) {
        let e = this.p.carveMargin;
        this.carves.push({ t: performance.now(), box: [b.min.x - e, b.min.y - e, b.min.z - e, b.max.x + e, b.max.y + e, b.max.z + e] });
    }

    updateMin(ch) {
        let R = this.records, m = Infinity;
        for(let r of ch.recs) if(R.cnt[r] < m) m = R.cnt[r];
        ch.minSamples = ch.recs.length ? m : Infinity;
    }

    reset() { for(let key of [...this.chunks.keys()]) this.removeChunk(key); this.splitEdges.clear(); }

    /** A chunk's coarse geometry: flat corner arrays (positions and normals, 9 per triangle; uvs 6 per triangle or null),
     *  a material class per triangle and optionally `skip` (1: a hidden triangle on a chunk plane, left as it is). Returns the chunk with its refined mesh (positions, normals, uvs, cls, recOf,
     *  index) and `coarseRec`, the record of each coarse corner (-1 on chunk planes), for the GPU BVH's lookups.
     *  `carved` (a box {min, max}) is what a carve changed, if one did (see `seed`). */
    setChunk(key, version, coarse, carved = null) {
        let old = this.chunks.get(key);
        let [cx, cy, cz] = key.split(',').map(Number);
        let ch = { key, version, min: [cx * CHUNK, cy * CHUNK, cz * CHUNK], coarse, stage: 0, cursor: 0, minSamples: 0, ready: false };
        if(carved && old) this.noteCarve(carved);
        this.refine(ch);
        this.chunks.set(key, ch);
        if(old) for(let r of old.recOf) if(r >= 0) this.records.release(r);
        this.records.sweep();
        // (after the old records are gone: light comes only from the surface as it is now)
        this.seed(carved && old ? old.coarse : null);
        this.updateMin(ch);
        return ch;
    }

    removeChunk(key) {
        let ch = this.chunks.get(key);
        if(!ch) return;
        this.chunks.delete(key);
        for(let r of ch.recOf) if(r >= 0) this.records.release(r);
    }

    /** Records within reach of a changed region keep only a few samples. */
    knockAround(box) {
        let { knockTo: n, knockReach: e } = this.p, R = this.records;
        let lo = [box.min.x - e, box.min.y - e, box.min.z - e], hi = [box.max.x + e, box.max.y + e, box.max.z + e];
        for(let ch of this.chunks.values()) {
            if(ch.min[0] > hi[0] || ch.min[0] + CHUNK < lo[0] || ch.min[1] > hi[1] || ch.min[1] + CHUNK < lo[1] || ch.min[2] > hi[2] || ch.min[2] + CHUNK < lo[2]) continue;
            for(let r of ch.recs) {
                let x = R.geo[r * 8], y = R.geo[r * 8 + 1], z = R.geo[r * 8 + 2];
                if(x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2]) { R.knock(r, n); ch.minSamples = Math.min(ch.minSamples, n); }
            }
        }
    }

    // ---- refinement ----------------------------------------------------------------

    /** Subdivide a chunk's coarse triangles (see the file comment) into an indexed render mesh. */
    refine(ch) {
        let t0 = performance.now();
        let { pos, nrm, uv, cls, skip } = ch.coarse, n = cls.length, p = this.p, R = this.records, splits = this.splitEdges;
        let V = { pos: [], nrm: [], uv: [], cls: [], rec: [] }, index = [], local = new Map();
        let coarseRec = new Int32Array(n * 3).fill(-1);
        let recKeyOf = (c) => posKey(c[0], c[1], c[2]) + '|' + nrmKey(c[3], c[4], c[5]);
        // no record without a direction: a zero-area triangle's normal is zero, and so is the mean of two opposite ones
        // (a sheet's edge). On the GPU its rays had a NaN direction, which no BVH box rejects: each walked the whole tree,
        // 16 ms for one ray on an RTX 4090, and a pass waits for its slowest ray (gathers of 15 to 90 ms per frame)
        let hasNormal = (c) => c[3] * c[3] + c[4] * c[4] + c[5] * c[5] > 1e-8;
        // corner: [x, y, z, nx, ny, nz, u, v, rec]
        let corner = (t, k, plane) => {
            let o = t * 9 + k * 3, c = [pos[o], pos[o + 1], pos[o + 2], nrm[o], nrm[o + 1], nrm[o + 2], uv ? uv[t * 6 + k * 2] : 0, uv ? uv[t * 6 + k * 2 + 1] : 0, -1];
            if(!plane && hasNormal(c)) c[8] = R.find(recKeyOf(c), c[0], c[1], c[2], c[3], c[4], c[5]);
            return c;
        };
        let mid = (a, b) => {
            let nx = a[3] + b[3], ny = a[4] + b[4], nz = a[5] + b[5], l = Math.hypot(nx, ny, nz) || 1;
            let c = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5, nx / l, ny / l, nz / l, (a[6] + b[6]) * 0.5, (a[7] + b[7]) * 0.5, -1];
            if(hasNormal(c)) c[8] = R.find(recKeyOf(c), c[0], c[1], c[2], c[3], c[4], c[5], a[8], b[8]);
            return c;
        };
        let split = (a, b) => {
            let L = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            if(L > p.maxEdge) return true;
            if(L <= 2 * p.minEdge || !splits.size) return false;
            let ka = posKey(a[0], a[1], a[2]), kb = posKey(b[0], b[1], b[2]);
            return splits.has(ka < kb ? ka + '~' + kb : kb + '~' + ka);
        };
        let vertex = (c, k) => {
            let key = posKey(c[0], c[1], c[2]) + '|' + nrmKey(c[3], c[4], c[5]) + '|' + Math.round(c[6] * 4096) + ',' + Math.round(c[7] * 4096) + '|' + k + (c[8] < 0 ? '|p' : '');
            let i = local.get(key);
            if(i !== undefined) return i;
            i = V.cls.length; local.set(key, i);
            V.pos.push(c[0], c[1], c[2]); V.nrm.push(c[3], c[4], c[5]); V.uv.push(c[6], c[7]); V.cls.push(k); V.rec.push(c[8]);
            return i;
        };
        let emit = (a, b, c, k) => { index.push(vertex(a, k), vertex(b, k), vertex(c, k)); };
        let tri = (a, b, c, k, depth) => {
            let s0 = depth < 12 && split(a, b), s1 = depth < 12 && split(b, c), s2 = depth < 12 && split(c, a);
            if(!s0 && !s1 && !s2) { emit(a, b, c, k); return; }
            // rotate so the split edges start at the first edge: patterns (1,0,0), (1,1,0), (1,1,1)
            let cs = [a, b, c], ss = [s0, s1, s2];
            let r = s0 && s1 && s2 ? 0 : ss.findIndex((x, i) => x && !ss[(i + 2) % 3]);
            let A = cs[r], B = cs[(r + 1) % 3], C = cs[(r + 2) % 3], sBC = ss[(r + 1) % 3], sCA = ss[(r + 2) % 3];
            let d = depth + 1;
            if(sBC && sCA) {
                let ab = mid(A, B), bc = mid(B, C), ca = mid(C, A);
                tri(A, ab, ca, k, d); tri(ab, B, bc, k, d); tri(ca, bc, C, k, d); tri(ab, bc, ca, k, d);
            } else if(sBC) {
                let ab = mid(A, B), bc = mid(B, C);
                tri(ab, B, bc, k, d);
                // the quad left over is cut along its shorter diagonal (inside this triangle: no neighbour to agree with)
                let dAbc = Math.hypot(A[0] - bc[0], A[1] - bc[1], A[2] - bc[2]), dabC = Math.hypot(ab[0] - C[0], ab[1] - C[1], ab[2] - C[2]);
                if(dAbc <= dabC) { tri(A, ab, bc, k, d); tri(A, bc, C, k, d); } else { tri(A, ab, C, k, d); tri(ab, bc, C, k, d); }
            } else {
                let ab = mid(A, B);
                tri(A, ab, C, k, d); tri(ab, B, C, k, d);
            }
        };
        for(let t = 0; t < n; t++) {
            let plane = skip ? skip[t] === 1 : false;
            let a = corner(t, 0, plane), b = corner(t, 1, plane), c = corner(t, 2, plane);
            coarseRec[t * 3] = a[8]; coarseRec[t * 3 + 1] = b[8]; coarseRec[t * 3 + 2] = c[8];
            if(plane) emit(a, b, c, cls[t]);
            else tri(a, b, c, cls[t], 0);
        }
        for(let r of V.rec) if(r >= 0) R.retain(r); // one reference per render vertex
        ch.positions = new Float32Array(V.pos); ch.normals = new Float32Array(V.nrm); ch.uvs = new Float32Array(V.uv);
        ch.cls = new Uint16Array(V.cls); ch.recOf = new Int32Array(V.rec);
        ch.index = new Uint32Array(index);
        ch.coarseRec = coarseRec;
        ch.recs = Int32Array.from(new Set(V.rec.filter(r => r >= 0)));
        ch.adj = null;
        ch.cursor = 0;
        this.stats.refineMs += performance.now() - t0;
        this.stats.refines++;
    }

    /** Split the edges of a chunk whose ends disagree (see `contrast`), given the GPU's sums and counts (`state`, 8
     *  floats per record); returns the chunks to refine again (`redo`: the chunk, and neighbours sharing a split edge on
     *  a face). */
    adapt(ch, state) {
        let p = this.p, I = ch.index, P = ch.positions, rec = ch.recOf, added = 0, planes = [];
        if(this.records.full) return [];
        // state: 8 floats per record (sum rgb + count, then the crystals' baked light, which counts too: their pools are
        // where the light changes fastest)
        let lum = (r) => { let o = r * 8, c = state[o + 3]; return c > 0 ? (0.2126 * (state[o] / c + state[o + 4]) + 0.7152 * (state[o + 1] / c + state[o + 5]) + 0.0722 * (state[o + 2] / c + state[o + 6])) : -1; };
        // a floor under the difference, so noise in the near-black (a sealed pocket) does not split everything
        let floor = 0.02;
        for(let t = 0; t < I.length; t += 3) for(let e = 0; e < 3; e++) {
            let i = I[t + e], j = I[t + (e + 1) % 3], ri = rec[i], rj = rec[j];
            if(ri < 0 || rj < 0 || ri === rj) continue;
            let L = Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
            if(L <= 2 * p.minEdge) continue;
            let a = lum(ri), b = lum(rj);
            if(a < 0 || b < 0 || Math.abs(a - b) / (Math.max(a, b) + floor) < p.contrast) continue;
            let ka = posKey(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), kb = posKey(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
            let key = ka < kb ? ka + '~' + kb : kb + '~' + ka;
            if(this.splitEdges.has(key)) continue;
            this.splitEdges.add(key); added++;
            for(let a2 = 0; a2 < 3; a2++) for(let s of [ch.min[a2], ch.min[a2] + CHUNK]) {
                if(Math.abs(P[i * 3 + a2] - s) < 1e-3 && Math.abs(P[j * 3 + a2] - s) < 1e-3) planes.push([a2, s]);
            }
        }
        this.stats.adapts++; this.stats.splits += added;
        if(!added) return [];
        let again = new Set([ch]);
        for(let [axis, s] of planes) {
            let c = ch.min.slice(); c[axis] = s === ch.min[axis] ? ch.min[axis] - CHUNK : ch.min[axis] + CHUNK;
            let nb = this.chunks.get(`${Math.round(c[0] / CHUNK)},${Math.round(c[1] / CHUNK)},${Math.round(c[2] / CHUNK)}`);
            if(nb) again.add(nb);
        }
        return [...again];
    }

    /** Refine a chunk again with the split edges as they are now (after adapt): its records carry over by key. The
     *  caller collects the chunks of a whole batch of adapt passes and redoes each once (a neighbour sharing several
     *  split faces used to be refined once per pass: 36 passes refined 174 chunks). */
    redo(c) {
        let oldRecs = c.recOf;
        this.refine(c);
        for(let r of oldRecs) if(r >= 0) this.records.release(r);
        this.records.sweep();
        this.seed();
        this.updateMin(c);
    }

    // ---- scheduling ------------------------------------------------------------------

    /** How many samples per record a chunk should reach, by its distance to the camera. */
    target(ch, cam) {
        let h = CHUNK / 2, d = Math.hypot(ch.min[0] + h - cam.x, ch.min[1] + h - cam.y, ch.min[2] + h - cam.z), near = this.p.nearDistance;
        return d <= near ? this.p.maxSamples : Math.max(8, this.p.maxSamples * (near / d) ** 2);
    }

    /** Fill `jobs` (record ids, one sample each) up to its length from the chunks furthest below their targets, among the
     *  chunks the GPU BVH already has (`ready`). Returns the number of jobs and the chunks that reached an adaptive stage. */
    schedule(jobs, cam) {
        let R = this.records, cap = this.p.maxSamples, stamp = ++this.frame, n = 0, staged = [];
        let order = [];
        for(let ch of this.chunks.values()) {
            if(!ch.ready || !ch.recs.length) continue;
            let s = ch.minSamples / this.target(ch, cam);
            if(s < 1) order.push([s, ch]);
        }
        order.sort((a, b) => a[0] - b[0]);
        for(let [, ch] of order) {
            let recs = ch.recs;
            while(n < jobs.length && ch.cursor < recs.length) {
                let r = recs[ch.cursor++];
                if(R.stamp[r] === stamp) continue;
                R.stamp[r] = stamp; jobs[n++] = r;
                if(!R.lit[r]) { if(R.need[r] > 1) R.need[r]--; else R.lit[r] = 1; }
                if(R.cnt[r] < cap) R.cnt[r]++;
            }
            if(ch.cursor >= recs.length) {
                ch.cursor = 0;
                let m = Infinity; for(let r of recs) if(R.cnt[r] < m) m = R.cnt[r];
                ch.minSamples = m;
                let st = this.p.stages;
                if(ch.stage < st.length && m >= st[ch.stage]) { ch.stage++; staged.push(ch); }
            }
            if(n >= jobs.length) break;
        }
        return { count: n, staged };
    }
}
