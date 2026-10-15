/** Geometry wire codec shared by client and server.
 *
 *  - Brushes travel as gzip+base64 triangle soups inside JSON (small, rare).
 *  - Chunks travel as binary (see encodeChunkMesh), content-addressed by an FNV-1a hash
 *    so clients can cache by version.
 */
import { gzipSync, gunzipSync } from 'three/examples/jsm/libs/fflate.module.js';

function b64encode(input) { return btoa(encodeURIComponent(input)); }
function b64decode(input) { return decodeURIComponent(atob(input)); }

/** @param {Float32Array} positions non-indexed xyz triples */
export function encodeSoup(positions) {
    let compressed = gzipSync(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
    let s = '';
    for(let i = 0; i < compressed.length; i += 8192) s += String.fromCharCode.apply(null, compressed.subarray(i, i + 8192));
    return b64encode(s).normalize("NFC");
}

/** @returns {Float32Array} non-indexed xyz triples */
export function decodeSoup(base64String) {
    let binary = b64decode(base64String.normalize("NFC"));
    let compressed = new Uint8Array(binary.length);
    for(let b = 0; b < binary.length; b++) compressed[b] = binary.charCodeAt(b);
    return new Float32Array(gunzipSync(compressed).buffer);
}

/** Convex hull point sets (body-local xyz triples per hull) as one gzip+base64 string: [nHulls, n1, xyz*n1, n2, xyz*n2, ...] as f32. */
export function encodeHulls(hulls) {
    let total = 1;
    for(let h of hulls) total += 1 + h.length;
    let f = new Float32Array(total), o = 0;
    f[o++] = hulls.length;
    for(let h of hulls) { f[o++] = h.length / 3; f.set(h, o); o += h.length; }
    return encodeSoup(f);
}

/** @returns {Float32Array[]} one xyz-triple array per hull */
export function decodeHulls(base64String) {
    let f = decodeSoup(base64String), out = [], o = 0;
    let n = f[o++];
    for(let i = 0; i < n && o < f.length; i++) { let count = f[o++] * 3; out.push(f.slice(o, o + count)); o += count; }
    return out;
}

const CHUNK_MAGIC = 0x32435057; // "WPC2": version 2 header; version 1 files start with the vertex count

/**
 * Chunk mesh bytes (gzip). Version 2: [u32 "WPC2"][u32 nv][u32 ni][f32 xyz*nv][f32 uv*nv][u32 idx*ni][u8 material/tri].
 * @param {Float32Array} positions @param {Uint32Array} indices @param {Uint8Array} [materials] one id per triangle
 * @param {Float32Array} [uvs] two floats per vertex (zeros if absent)
 */
export function encodeChunkMesh(positions, indices, materials = null, uvs = null) {
    let nv = positions.length / 3, ni = indices.length, numTris = ni / 3;
    let raw = new Uint8Array(12 + nv * 12 + nv * 8 + ni * 4 + numTris);
    let dv = new DataView(raw.buffer);
    dv.setUint32(0, CHUNK_MAGIC, true);
    dv.setUint32(4, nv, true);
    dv.setUint32(8, ni, true);
    raw.set(new Uint8Array(positions.buffer, positions.byteOffset, nv * 12), 12);
    if(uvs) raw.set(new Uint8Array(uvs.buffer, uvs.byteOffset, nv * 8), 12 + nv * 12);
    raw.set(new Uint8Array(indices.buffer, indices.byteOffset, ni * 4), 12 + nv * 20);
    if(materials) raw.set(materials.subarray(0, numTris), 12 + nv * 20 + ni * 4);
    return gzipSync(raw);
}

/** @param {Uint8Array} bytes @returns {{positions: Float32Array, uvs: Float32Array, indices: Uint32Array, materials: Uint8Array}} */
export function decodeChunkMesh(bytes) {
    let raw = gunzipSync(bytes);
    let dv = new DataView(raw.buffer, raw.byteOffset);
    let v2 = dv.getUint32(0, true) === CHUNK_MAGIC;
    let nv = dv.getUint32(v2 ? 4 : 0, true), ni = dv.getUint32(v2 ? 8 : 4, true);
    let o = raw.byteOffset + (v2 ? 12 : 8);
    // Copy out so the typed arrays are aligned and independently owned
    let positions = new Float32Array(raw.buffer.slice(o, o + nv * 12)); o += nv * 12;
    let uvs = v2 ? new Float32Array(raw.buffer.slice(o, o + nv * 8)) : new Float32Array(nv * 2); if(v2) o += nv * 8;
    let indices = new Uint32Array(raw.buffer.slice(o, o + ni * 4)); o += ni * 4;
    let numTris = ni / 3;
    let materials = new Uint8Array(numTris);
    if(raw.byteOffset + raw.length >= o + numTris) materials.set(raw.subarray(o - raw.byteOffset, o - raw.byteOffset + numTris));
    return { positions, uvs, indices, materials };
}

/** FNV-1a 32-bit hash as 8 hex chars; used as a chunk content version. */
export function hashBytes(bytes) {
    let h = 0x811c9dc5;
    for(let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

export const EMPTY_VERSION = '0';
export const FRAME_CHUNK = 1;
export const FRAME_CHUNK_DELTA = 2;

// ---- chunk deltas -------------------------------------------------------------------------------
// A carve changes a small part of a chunk, but a boolean returns a whole new mesh. A delta rebuilds the
// new mesh (same vertex and triangle order, so later deltas chain) from the previous one: each new
// vertex is either a previous vertex (by index) or inline, each new triangle either a previous triangle
// or inline. References are stored as zigzag varint deltas from the previous reference, which are
// almost all +1 for the untouched parts and gzip to nearly nothing.

/** Hash table from (x, y, z, u, v) float bit patterns to vertex index; hits are verified exactly. */
class VertexIndex {
    constructor(p, uv) { this.p = p; this.uv = uv; this.bits = new Int32Array(p.buffer, p.byteOffset, p.length); this.uvBits = uv ? new Int32Array(uv.buffer, uv.byteOffset, uv.length) : null; this.map = new Map(); }
    hash(bits, uvBits, i) {
        let h = Math.imul(bits[i * 3], 73856093) ^ Math.imul(bits[i * 3 + 1], 19349663) ^ Math.imul(bits[i * 3 + 2], 83492791);
        if(uvBits) h ^= Math.imul(uvBits[i * 2], 48619) ^ Math.imul(uvBits[i * 2 + 1], 12582917);
        return h;
    }
    add(i) { let h = this.hash(this.bits, this.uvBits, i), e = this.map.get(h); if(e === undefined) this.map.set(h, i); else if(Array.isArray(e)) e.push(i); else this.map.set(h, [e, i]); }
    /** Index of an unclaimed vertex of this mesh equal to vertex i of (q, quv), or -1. Meshes carry a
     *  property vertex per material at seams, so equal vertices come in small groups; taking them in order
     *  pairs each new duplicate with its old counterpart. */
    find(q, quv, i, claimed) {
        let qb = new Int32Array(q.buffer, q.byteOffset, q.length), qu = quv ? new Int32Array(quv.buffer, quv.byteOffset, quv.length) : null;
        let e = this.map.get(this.hash(qb, qu, i));
        if(e === undefined) return -1;
        let same = j => !claimed[j] && this.bits[j * 3] === qb[i * 3] && this.bits[j * 3 + 1] === qb[i * 3 + 1] && this.bits[j * 3 + 2] === qb[i * 3 + 2]
            && (!this.uvBits ? (!qu || (qu[i * 2] === 0 && qu[i * 2 + 1] === 0)) : (qu ? this.uvBits[j * 2] === qu[i * 2] && this.uvBits[j * 2 + 1] === qu[i * 2 + 1] : this.uvBits[j * 2] === 0 && this.uvBits[j * 2 + 1] === 0));
        if(!Array.isArray(e)) return same(e) ? e : -1;
        for(let j of e) if(same(j)) return j;
        return -1;
    }
}

class VarintWriter {
    constructor() { this.out = []; this.f = new Float32Array(1); this.fb = new Uint8Array(this.f.buffer); }
    u(n) { n >>>= 0; while(n >= 0x80) { this.out.push((n & 0x7f) | 0x80); n >>>= 7; } this.out.push(n); }
    s(n) { this.u(n >= 0 ? n * 2 : -n * 2 - 1); } // zigzag
    f32(x) { this.f[0] = x; this.out.push(this.fb[0], this.fb[1], this.fb[2], this.fb[3]); }
    finish() { return Uint8Array.from(this.out); }
}
class VarintReader {
    constructor(u8) { this.u8 = u8; this.p = 0; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
    u() { let r = 0, sh = 0, b; do { b = this.u8[this.p++]; r += (b & 0x7f) * 2 ** sh; sh += 7; } while(b & 0x80); return r; }
    s() { let z = this.u(); return z % 2 ? -(z + 1) / 2 : z / 2; }
    f32() { let v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
}

/**
 * Delta from a previous decoded chunk mesh to a new one (both {positions, uvs, indices, materials}).
 * Returns gzip bytes that decodeChunkDelta(prev, bytes) turns back into exactly `next`. Each old vertex
 * is referenced by at most one new vertex, so old triangles map back to unambiguous new indices.
 */
export function encodeChunkDelta(prev, next) {
    let pv = prev.positions.length / 3, nv = next.positions.length / 3, pt = prev.indices.length / 3, nt = next.indices.length / 3;
    let index = new VertexIndex(prev.positions, prev.uvs);
    for(let i = 0; i < pv; i++) index.add(i);
    let oldTris = new Map();
    for(let t = pt - 1; t >= 0; t--) oldTris.set(prev.indices[t * 3] * 4294967296 + prev.indices[t * 3 + 1] * 65536 + prev.indices[t * 3 + 2], t); // ids < 65536
    let w = new VarintWriter();
    w.u(nv); w.u(nt);
    // vertices: ref = oldIndex + 1 (0 = inline), as delta from the previous ref
    let toOld = new Int32Array(nv).fill(-1), claimed = new Uint8Array(pv), last = 0;
    let fits = pv < 65536;
    for(let i = 0; i < nv; i++) {
        let j = index.find(next.positions, next.uvs, i, claimed);
        let ref = j < 0 ? 0 : j + 1;
        w.s(ref - last); last = ref;
        if(j >= 0) { toOld[i] = j; claimed[j] = 1; }
        else { w.f32(next.positions[i * 3]); w.f32(next.positions[i * 3 + 1]); w.f32(next.positions[i * 3 + 2]); w.f32(next.uvs ? next.uvs[i * 2] : 0); w.f32(next.uvs ? next.uvs[i * 2 + 1] : 0); }
    }
    // triangles: ref = oldTri + 1 (0 = inline: three new-vertex indices and a material)
    last = 0;
    for(let t = 0; t < nt; t++) {
        let a = next.indices[t * 3], b = next.indices[t * 3 + 1], c = next.indices[t * 3 + 2];
        let j = fits && toOld[a] >= 0 && toOld[b] >= 0 && toOld[c] >= 0 ? oldTris.get(toOld[a] * 4294967296 + toOld[b] * 65536 + toOld[c]) : undefined;
        if(j !== undefined && (next.materials ? next.materials[t] : 0) !== (prev.materials ? prev.materials[j] : 0)) j = undefined;
        let ref = j === undefined ? 0 : j + 1;
        w.s(ref - last); last = ref;
        if(j === undefined) { w.u(a); w.u(b); w.u(c); w.u(next.materials ? next.materials[t] : 0); }
    }
    return gzipSync(w.finish());
}

/** Apply a delta to the previous decoded mesh; returns the new {positions, uvs, indices, materials}. */
export function decodeChunkDelta(prev, bytes) {
    let r = new VarintReader(gunzipSync(bytes));
    let nv = r.u(), nt = r.u();
    let positions = new Float32Array(nv * 3), uvs = new Float32Array(nv * 2), indices = new Uint32Array(nt * 3), materials = new Uint8Array(nt);
    let newIndexOfOld = new Int32Array(prev.positions.length / 3).fill(-1);
    let last = 0;
    for(let i = 0; i < nv; i++) {
        let ref = last + r.s(); last = ref;
        if(ref) {
            let j = ref - 1; newIndexOfOld[j] = i;
            positions[i * 3] = prev.positions[j * 3]; positions[i * 3 + 1] = prev.positions[j * 3 + 1]; positions[i * 3 + 2] = prev.positions[j * 3 + 2];
            if(prev.uvs) { uvs[i * 2] = prev.uvs[j * 2]; uvs[i * 2 + 1] = prev.uvs[j * 2 + 1]; }
        } else { positions[i * 3] = r.f32(); positions[i * 3 + 1] = r.f32(); positions[i * 3 + 2] = r.f32(); uvs[i * 2] = r.f32(); uvs[i * 2 + 1] = r.f32(); }
    }
    last = 0;
    for(let t = 0; t < nt; t++) {
        let ref = last + r.s(); last = ref;
        if(ref) {
            let j = ref - 1;
            indices[t * 3] = newIndexOfOld[prev.indices[j * 3]]; indices[t * 3 + 1] = newIndexOfOld[prev.indices[j * 3 + 1]]; indices[t * 3 + 2] = newIndexOfOld[prev.indices[j * 3 + 2]];
            materials[t] = prev.materials ? prev.materials[j] : 0;
        } else { indices[t * 3] = r.u(); indices[t * 3 + 1] = r.u(); indices[t * 3 + 2] = r.u(); materials[t] = r.u(); }
    }
    return { positions, uvs, indices, materials };
}

/** Binary WebSocket frame for a delta: [u8 type=2][i32 x][i32 y][i32 z][u8 vlen][version][u8 blen][baseVersion][payload] */
export function packChunkDeltaFrame(key, version, baseVersion, bytes) {
    let [x, y, z] = key.split(',').map(Number);
    let out = new Uint8Array(15 + version.length + baseVersion.length + bytes.length);
    let dv = new DataView(out.buffer);
    out[0] = FRAME_CHUNK_DELTA;
    dv.setInt32(1, x, true); dv.setInt32(5, y, true); dv.setInt32(9, z, true);
    let o = 13;
    out[o++] = version.length; for(let i = 0; i < version.length; i++) out[o++] = version.charCodeAt(i);
    out[o++] = baseVersion.length; for(let i = 0; i < baseVersion.length; i++) out[o++] = baseVersion.charCodeAt(i);
    out.set(bytes, o);
    return out;
}

/** Binary WebSocket frame: [u8 type=1][i32 x][i32 y][i32 z][u8 versionLength][version ascii][payload] */
export function packChunkFrame(key, version, bytes) {
    let [x, y, z] = key.split(',').map(Number);
    let out = new Uint8Array(14 + version.length + (bytes ? bytes.length : 0));
    let dv = new DataView(out.buffer);
    out[0] = FRAME_CHUNK;
    dv.setInt32(1, x, true); dv.setInt32(5, y, true); dv.setInt32(9, z, true);
    out[13] = version.length;
    for(let i = 0; i < version.length; i++) out[14 + i] = version.charCodeAt(i);
    if(bytes) out.set(bytes, 14 + version.length);
    return out;
}

/** Either frame type: {key, version, bytes} for a full chunk, plus {baseVersion, delta: true} for a delta. */
export function unpackChunkFrame(buffer) {
    let u8 = new Uint8Array(buffer);
    if(u8[0] !== FRAME_CHUNK && u8[0] !== FRAME_CHUNK_DELTA) return null;
    let dv = new DataView(u8.buffer, u8.byteOffset);
    let key = `${dv.getInt32(1, true)},${dv.getInt32(5, true)},${dv.getInt32(9, true)}`;
    let o = 13, vlen = u8[o++];
    let version = String.fromCharCode(...u8.subarray(o, o + vlen)); o += vlen;
    if(u8[0] === FRAME_CHUNK) { let bytes = u8.subarray(o); return { key, version, bytes: bytes.length ? bytes : null }; }
    let blen = u8[o++];
    let baseVersion = String.fromCharCode(...u8.subarray(o, o + blen)); o += blen;
    return { key, version, baseVersion, bytes: u8.subarray(o), delta: true };
}
