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
 *  (`ops`): from its edge's two ends when they are old enough to mean something, else empty (the shader shows the
 *  probe grid's light until it has samples). */

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
    seedReach: 3,          // metres within which a new vertex looks for gathered ones to copy its light from
    seedCarved: 0.6,       // what a surface a carve just exposed keeps of the light it copies (it is deeper in, and sees less)
    knockReach: 5,         // metres around a carve's region
};

export const OP_INIT = 0, OP_KNOCK = 1, NO_RECORD = 0xffffffff; // an op's first word: type | weight << 8 | scale * 255 << 16

const Q_POS = 1e4, Q_NRM = 1e3;
const posKey = (x, y, z) => `${Math.round(x * Q_POS)},${Math.round(y * Q_POS)},${Math.round(z * Q_POS)}`;
const nrmKey = (x, y, z) => `${Math.round(x * Q_NRM)},${Math.round(y * Q_NRM)},${Math.round(z * Q_NRM)}`;
const CHUNK = 10;

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
        this.ops = [];                               // [type, id, a, b] for the GPU
        this.dirtyLo = Infinity; this.dirtyHi = -1;  // slots whose geo needs uploading
        this.full = false;
        this.born = new Uint32Array(capacity);       // batch it was created in (see GICore: a seed must be older)
        this.batch = 1;
        this.cells = new Map();                      // 1 m cell -> record ids, to find gathered neighbours
        this.cellOf = new Float64Array(capacity);
        this.seeder = null;                          // (id, x, y, z, nx, ny, nz, pa, pb) => [a, b, weight] (GICore.seed)
        this.onDrop = null;                          // (id) => void, when a record is freed (TerrainGI forgets its crystals)
    }
    static cellKey(x, y, z) { return ((Math.floor(x) + 4096) * 8192 + (Math.floor(y) + 4096)) * 8192 + (Math.floor(z) + 4096); }
    /** Old enough to copy light from: referenced, created before this batch, and sampled. */
    gathered(r) { return r >= 0 && this.refs[r] > 0 && this.born[r] < this.batch && this.cnt[r] >= 1; }
    get size() { return this.keys.size; }
    /** The record for a key, created at (p, n) if new: with no references yet (`retain` takes one, `sweep` frees the new
     *  ones nobody took) and initialised on the GPU as `seeder` decides (`pa`, `pb`: the ends of the edge a midpoint
     *  splits). -1 when the buffers are full. */
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
        this.refs[id] = 0; this.stamp[id] = 0; this.born[id] = this.batch;
        let [a, b, w, k = 1] = this.seeder ? this.seeder(id, px, py, pz, nx, ny, nz, pa, pb) : [NO_RECORD, NO_RECORD, 0];
        this.cnt[id] = w;
        this.ops.push((OP_INIT | (w << 8) | (Math.round(k * 255) << 16)) >>> 0, id, a, b);
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
    /** Keep at most `n` samples' worth (the mean stays, its weight drops). */
    knock(id, n) { if(this.cnt[id] <= n) return; this.cnt[id] = n; this.ops.push(OP_KNOCK, id, n, 0); }
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
        this.stats = { refines: 0, refineMs: 0, adapts: 0, splits: 0, seeded: 0, dark: 0 };
        this.visible = null;           // (ax, ay, az, bx, by, bz) => can a point see another (TerrainGI: the chunk BVHs)
        this.carveBox = null;          // while refining a carved chunk: the region the carve changed, a little enlarged
        this.records.seeder = (id, x, y, z, nx, ny, nz, pa, pb) => this.seed(x, y, z, nx, ny, nz, pa, pb);
    }

    /** How a new record starts. A fresh vertex used to start empty, and the shader showed the probe grid's light until
     *  rays came in: underground, a new tunnel lit up like the plaza for a second. Now it copies the light of gathered
     *  records it can see, at full weight (rays then average in): the ends of the edge it splits, else the two nearest
     *  within `seedReach` facing roughly its way and in sight (the old cavity's walls a dig extends; the ground around a
     *  crater). A surface a carve just exposed keeps `seedCarved` of what it copies: it lies deeper than the walls it
     *  copies from, and a tunnel dug dig after dig would otherwise drag the entrance's light along with it (measured on a
     *  tunnel out of the vault: 50/255 at first and 26 converged without seeds, 39 with plain copies). With nothing in sight, a vertex inside the region a carve changed starts dark at full weight (it is in
     *  rock that was solid a moment ago); anything else (a chunk arriving, a rebuild for a new cull mask) starts
     *  unknown, on the probes. */
    seed(x, y, z, nx, ny, nz, pa, pb) {
        let R = this.records, W = this.p.weightAt, c = this.carveBox;
        let carved = !!c && x >= c[0] && x <= c[3] && y >= c[1] && y <= c[4] && z >= c[2] && z <= c[5];
        let k = carved ? this.p.seedCarved : 1;
        if(R.gathered(pa) && R.gathered(pb)) { this.stats.seeded++; return [pa, pb, W, k]; }
        let near = this.nearest(x, y, z, nx, ny, nz);
        if(near.length) { this.stats.seeded++; return [near[0], near[near.length > 1 ? 1 : 0], W, k]; }
        if(carved) { this.stats.dark++; return [NO_RECORD, NO_RECORD, W]; }
        return [NO_RECORD, NO_RECORD, 0];
    }

    /** Up to two gathered records near a point that it can see, best first (distance, with a penalty for facing away). */
    nearest(x, y, z, nx, ny, nz) {
        let R = this.records, reach = this.p.seedReach, r = Math.ceil(reach), cands = [], g = R.geo;
        let cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
        for(let i = -r; i <= r; i++) for(let j = -r; j <= r; j++) for(let k = -r; k <= r; k++) {
            let list = R.cells.get(Records.cellKey(cx + i, cy + j, cz + k));
            if(!list) continue;
            for(let id of list) {
                if(!R.gathered(id)) continue;
                let o = id * 8, dx = g[o] - x, dy = g[o + 1] - y, dz = g[o + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
                if(d2 > reach * reach || d2 < 1e-8) continue;
                let facing = g[o + 4] * nx + g[o + 5] * ny + g[o + 6] * nz;
                cands.push([d2 + (facing < 0.2 ? 4 : 0), id]);
            }
        }
        if(!cands.length) return [];
        cands.sort((a, b) => a[0] - b[0]);
        let out = [], tests = 0;
        for(let [, id] of cands) {
            if(out.length >= 2 || tests >= 8) break;
            let o = id * 8;
            tests++;
            if(this.visible && !this.visible(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, g[o] + g[o + 4] * 0.05, g[o + 1] + g[o + 5] * 0.05, g[o + 2] + g[o + 6] * 0.05)) continue;
            out.push(id);
        }
        return out;
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
        this.records.batch++;
        this.carveBox = carved && old ? [carved.min.x - 0.5, carved.min.y - 0.5, carved.min.z - 0.5, carved.max.x + 0.5, carved.max.y + 0.5, carved.max.z + 0.5] : null;
        this.refine(ch);
        this.carveBox = null;
        this.chunks.set(key, ch);
        if(old) for(let r of old.recOf) if(r >= 0) this.records.release(r);
        this.records.sweep();
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
        let m = Infinity; for(let r of ch.recs) if(R.cnt[r] < m) m = R.cnt[r];
        ch.minSamples = ch.recs.length ? m : Infinity;
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
        this.records.batch++;
        let oldRecs = c.recOf;
        this.refine(c);
        for(let r of oldRecs) if(r >= 0) this.records.release(r);
        this.records.sweep();
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
