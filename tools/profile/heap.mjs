/** Manifold heap growth through a room's life: after init, after startup, after recomputing every summary
 *  (cache cleared), and after a run of carves. Peak growth that does not keep growing is working-set;
 *  growth that continues is a leak. node tools/profile/build.mjs first. */
import { readFileSync } from 'node:fs';
let bundle = await import('./server.bundle.mjs');
let m = JSON.parse(readFileSync(process.argv[2] || 'assets/worlds/castle-exact.json', 'utf8'));
let store = new Map();
for(let key in m.chunks) { let c = m.chunks[key]; store.set('chunk:' + key, { key, version: c.version, bytes: c.bytes ? new Uint8Array(Buffer.from(c.bytes, 'base64')) : null }); }
store.set('world', m.world);
let ctx = { id: { name: 'heap' }, storage: { async get(k) { return store.get(k); }, async put() {}, async delete() {}, async list({ prefix }) { let o = new Map(); for(let [k, v] of store) if(k.startsWith(prefix)) o.set(k, v); return o; } } };
let server = new bundle.WorldParty(ctx, {});
clearInterval(server.interval);
let T = server.terrain;
let origInit = T.init.bind(T);
T.init = async (...a) => { let r = await origInit(...a); return r; };
await server.onStart();
let line = label => console.log(`${label.padEnd(44)} manifold heap ${T.heapMB().toFixed(1)} MB, resident ${T.resident.length}, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
line('after startup');
for(let round = 1; round <= 2; round++) {
    server.connectivity.clear();
    server.connectivity.solve();
    line(`after recomputing every summary (round ${round})`);
}
let { encodeSoup } = await import('../../src/net/codec.js');
let cube = [], P = [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
for(let [a,b,c,d] of [[0,1,2,3],[5,4,7,6],[4,0,3,7],[1,5,6,2],[3,2,6,7],[4,5,1,0]]) cube.push(...P[a],...P[b],...P[c],...P[a],...P[c],...P[d]);
let brush = encodeSoup(new Float32Array(cube));
let keys = Object.keys(T.chunks).filter(k => T.chunks[k].bytes);
for(let i = 0; i < 40; i++) {
    let key = keys[i % keys.length];
    let { chunkCenter } = await import('../../src/terrain/grid.js');
    let c = chunkCenter(key);
    await server.applyCsg({ keys: [key], brush, operation: 1, position: { x: c.x + (i % 3) - 1, y: c.y + (i % 5) - 2, z: c.z }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 2, y: 2, z: 2 }, material: 0 });
    await new Promise(r => setTimeout(r, 2));
    if(i % 10 === 9) line(`after ${i + 1} carves across chunks`);
}
process.exit(0);
