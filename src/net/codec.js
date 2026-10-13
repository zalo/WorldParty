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

export function unpackChunkFrame(buffer) {
    let u8 = new Uint8Array(buffer);
    if(u8[0] !== FRAME_CHUNK) return null;
    let dv = new DataView(u8.buffer, u8.byteOffset);
    let key = `${dv.getInt32(1, true)},${dv.getInt32(5, true)},${dv.getInt32(9, true)}`;
    let vlen = u8[13];
    let version = String.fromCharCode(...u8.subarray(14, 14 + vlen));
    let bytes = u8.subarray(14 + vlen);
    return { key, version, bytes: bytes.length ? bytes : null };
}
