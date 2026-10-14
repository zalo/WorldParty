/** Round-trip and size check of chunk deltas on a real carve: full bytes vs delta bytes, exact reconstruction. */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
let bundle = await import('./server.bundle.mjs');
let { decodeChunkMesh, encodeChunkDelta, decodeChunkDelta, encodeSoup } = await import('../../src/net/codec.js');
let { chunkCenter } = await import('../../src/terrain/grid.js');
let m = JSON.parse(readFileSync('assets/worlds/castle-exact.json', 'utf8'));
let key = process.argv[2] || '1,0,-3';
let server = new bundle.WorldParty({ id: { name: 'x' }, storage: { async get() {}, async put() {}, async delete() {}, async list() { return new Map(); } } }, {});
clearInterval(server.interval);
await server.onStart();
let T = server.terrain; T.world = m.world;
T.loadChunk(key, new Uint8Array(Buffer.from(m.chunks[key].bytes, 'base64')), m.chunks[key].version);
let cube = [], P = [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
for(let [a,b,c,d] of [[0,1,2,3],[5,4,7,6],[4,0,3,7],[1,5,6,2],[3,2,6,7],[4,5,1,0]]) cube.push(...P[a],...P[b],...P[c],...P[a],...P[c],...P[d]);
let brush = encodeSoup(new Float32Array(cube)), c = chunkCenter(key);
let same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
for(let i = 0; i < 4; i++) {
    let prevBytes = T.chunks[key].bytes, prev = decodeChunkMesh(prevBytes);
    T.applyCsg({ keys: [key], brush, operation: 1, position: { x: c.x + i * 1.5 - 2, y: c.y - 1 + i, z: c.z }, quaternion: { x: 0, y: 0.3, z: 0.1, w: 0.94 }, scale: { x: 2, y: 2, z: 2 }, material: 0 });
    let next = decodeChunkMesh(T.chunks[key].bytes);
    let t = performance.now(); let delta = encodeChunkDelta(prev, next); let tEnc = performance.now() - t;
    t = performance.now(); let back = decodeChunkDelta(prev, delta); let tDec = performance.now() - t;
    let ok = same(back.positions, next.positions) && same(back.uvs, next.uvs) && same(back.indices, next.indices) && same(back.materials, next.materials);
    console.log(`carve ${i}: full ${(T.chunks[key].bytes.length / 1024).toFixed(0)} KB, delta ${(delta.length / 1024).toFixed(1)} KB (${next.indices.length / 3} tris), encode ${tEnc.toFixed(1)} ms, decode ${tDec.toFixed(1)} ms, exact ${ok}`);
}
process.exit(0);
