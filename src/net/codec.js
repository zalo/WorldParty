/** Geometry wire codec shared by client and server.
 *  Triangle soups (non-indexed float32 xyz) are gzip-compressed and base64
 *  encoded so they can ride inside JSON messages and durable storage. */
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
