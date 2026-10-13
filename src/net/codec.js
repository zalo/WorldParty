/** Geometry wire codec shared by client and server.
 *
 *  - Brushes travel as gzip+base64 triangle soups inside JSON (small, rare).
 *  - Chunks travel as binary: gzip of [u32 numVerts][u32 numIndices][f32 xyz...][u32 idx...],
 *    content-addressed by an FNV-1a hash so clients can cache by version.
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

/** @param {Float32Array} positions @param {Uint32Array} indices @param {Uint8Array} [materials] one id per triangle @returns {Uint8Array} */
export function encodeChunkMesh(positions, indices, materials = null) {
    let numTris = indices.length / 3;
    let raw = new Uint8Array(8 + positions.byteLength + indices.byteLength + (materials ? numTris : 0));
    let dv = new DataView(raw.buffer);
    dv.setUint32(0, positions.length / 3, true);
    dv.setUint32(4, indices.length, true);
    raw.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 8);
    raw.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), 8 + positions.byteLength);
    if(materials) raw.set(materials.subarray(0, numTris), 8 + positions.byteLength + indices.byteLength);
    return gzipSync(raw);
}

/** @param {Uint8Array} bytes @returns {{positions: Float32Array, indices: Uint32Array, materials: Uint8Array}} */
export function decodeChunkMesh(bytes) {
    let raw = gunzipSync(bytes);
    let dv = new DataView(raw.buffer, raw.byteOffset);
    let nv = dv.getUint32(0, true), ni = dv.getUint32(4, true);
    let o = raw.byteOffset + 8;
    // Copy out so the typed arrays are aligned and independently owned
    let positions = new Float32Array(raw.buffer.slice(o, o + nv * 12));
    let indices = new Uint32Array(raw.buffer.slice(o + nv * 12, o + nv * 12 + ni * 4));
    let numTris = ni / 3;
    let matStart = o + nv * 12 + ni * 4;
    let materials = new Uint8Array(numTris);
    if(raw.byteOffset + raw.length >= matStart + numTris) materials.set(raw.subarray(matStart - raw.byteOffset, matStart - raw.byteOffset + numTris));
    return { positions, indices, materials };
}

/** FNV-1a 32-bit hash as 8 hex chars; used as a chunk content version. */
export function hashBytes(bytes) {
    let h = 0x811c9dc5;
    for(let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

export const EMPTY_VERSION = '0';
export const FRAME_CHUNK = 1;

/** Binary WebSocket frame: [u8 type=1][u32 index][u8 versionLength][version ascii][payload] */
export function packChunkFrame(index, version, bytes) {
    let out = new Uint8Array(6 + version.length + (bytes ? bytes.length : 0));
    let dv = new DataView(out.buffer);
    out[0] = FRAME_CHUNK;
    dv.setUint32(1, index, true);
    out[5] = version.length;
    for(let i = 0; i < version.length; i++) out[6 + i] = version.charCodeAt(i);
    if(bytes) out.set(bytes, 6 + version.length);
    return out;
}

export function unpackChunkFrame(buffer) {
    let u8 = new Uint8Array(buffer);
    if(u8[0] !== FRAME_CHUNK) return null;
    let dv = new DataView(u8.buffer, u8.byteOffset);
    let index = dv.getUint32(1, true);
    let vlen = u8[5];
    let version = String.fromCharCode(...u8.subarray(6, 6 + vlen));
    let bytes = u8.subarray(6 + vlen);
    return { index, version, bytes: bytes.length ? bytes : null };
}
