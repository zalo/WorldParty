/** Memory footprint of a room after startup: JS heap, Manifold and PhysX WASM heaps, and what the
 *  connectivity cache's retained island manifolds cost. node tools/profile/build.mjs first. */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
let manifestPath = process.argv[2] || 'assets/worlds/castle-exact.json';
let bundle = await import('./server.bundle.mjs');
let m = JSON.parse(readFileSync(manifestPath, 'utf8'));
let store = new Map();
for(let key in m.chunks) { let c = m.chunks[key]; store.set('chunk:' + key, { key, version: c.version, bytes: c.bytes ? new Uint8Array(Buffer.from(c.bytes, 'base64')) : null }); }
store.set('world', m.world);
let room = { id: { name: 'profile' }, storage: { async get(k) { return store.get(k); }, async put() {}, async delete() {}, async list({ prefix }) { let o = new Map(); for(let [k, v] of store) if(k.startsWith(prefix)) o.set(k, v); return o; } } };
let mb = n => (n / 1048576).toFixed(1) + ' MB';
function report(label, server) {
    global.gc?.();
    let mu = process.memoryUsage();
    let heap = mod => { let b = mod.HEAPU8?.buffer || mod.HEAP8?.buffer || mod.wasmMemory?.buffer || mod.wasmExports?.memory?.buffer; return b ? mb(b.byteLength) : '?'; };
    console.log(`${label}: rss ${mb(mu.rss)}, js heap ${mb(mu.heapUsed)}, arraybuffers ${mb(mu.arrayBuffers)}, manifold wasm heap ${heap(server.terrain.manifold)}, physx wasm heap ${heap(server.physics.px)}`);
}
let t = performance.now();
let server = new bundle.WorldParty(room);
clearInterval(server.interval);
await server.onStart();
console.log(`startup ${(performance.now() - t).toFixed(0)} ms`);
report('after onStart', server);
let bytes = 0, tris = 0, islandTris = 0, islands = 0;
for(let key in server.terrain.chunks) { let c = server.terrain.chunks[key]; if(c.bytes) bytes += c.bytes.length; if(c.manifold) tris += c.manifold.numTri(); }
for(let s of server.connectivity.cache.values()) for(let isl of s.solid) if(isl.manifold) { islands++; islandTris += isl.manifold.numTri(); }
console.log(`chunks: ${mb(bytes)} of gzip bytes, ${tris} tris in chunk manifolds; connectivity keeps ${islands} island manifolds with ${islandTris} tris; ${Object.keys(server.physics.chunkActors).length} colliders`);
server.connectivity.clear();
report('after dropping connectivity cache', server);
for(let key of Object.keys(server.physics.chunkActors)) server.physics._removeChunkActor(key);
report('after removing chunk colliders (PhysX keeps its heap)', server);
process.exit(0);
