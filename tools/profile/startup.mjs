/** Cold vs warm startup: start a room from a manifest, persist, then start a second room from what the
 *  first one stored (summaries included) and compare time, manifold builds and heap. */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
let bundle = await import('./server.bundle.mjs');
let m = JSON.parse(readFileSync(process.argv[2] || 'assets/worlds/castle-exact.json', 'utf8'));
let store = new Map();
for(let key in m.chunks) { let c = m.chunks[key]; store.set('chunk:' + key, { key, version: c.version, bytes: c.bytes ? new Uint8Array(Buffer.from(c.bytes, 'base64')) : null }); }
store.set('world', m.world);
let ctx = { id: { name: 'startup' }, storage: {
    async get(k) { return store.get(k); },
    async put(k, v) { if(typeof k === 'string') store.set(k, structuredClone(v)); else for(let kk in k) store.set(kk, structuredClone(k[kk])); },
    async delete(k) { for(let kk of Array.isArray(k) ? k : [k]) store.delete(kk); },
    async list({ prefix }) { let o = new Map(); for(let [k, v] of store) if(k.startsWith(prefix)) o.set(k, v); return o; },
} };
for(let round of ['cold', 'warm']) {
    let server = new bundle.WorldParty(ctx, {});
    clearInterval(server.interval);
    let builds = 0, T = server.terrain, orig = T.meshToManifold.bind(T);
    T.meshToManifold = (...a) => { builds++; return orig(...a); };
    let t = performance.now();
    await server.onStart();
    let ms = performance.now() - t;
    for(let i = 0; i < 40 && server.cookQueue.size; i++) server.tick(); // drain queued colliders like the live loop would
    await server.persist();
    let sums = [...store.keys()].filter(k => k.startsWith('summary:')).length;
    let bytes = 0; for(let [k, v] of store) if(k.startsWith('summary:')) bytes += JSON.stringify(v).length;
    console.log(`${round}: startup ${ms.toFixed(0)} ms, ${builds} manifolds built, manifold heap ${T.heapMB().toFixed(0)} MB, ${sums} summaries stored (~${(bytes / 1024).toFixed(0)} KB as JSON), colliders ${Object.keys(server.physics.chunkActors).length}`);
    for(let key of Object.keys(server.physics.chunkActors)) server.physics._removeChunkActor(key);
}
process.exit(0);
