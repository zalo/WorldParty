/** Replay recorded carves (JSON array of {keys, brush, operation, position, quaternion, scale, material}) against the
 *  real server class in Node, timing the sync part, the deferred settle and the next ticks of each.
 *  node tools/profile/build.mjs && node tools/profile/replay.mjs assets/worlds/castle-exact.json /tmp/carves.json */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

let [manifestPath = 'assets/worlds/castle-exact.json', carvesPath = '/tmp/carves.json'] = process.argv.slice(2);
let bundle = await import('./server.bundle.mjs');
let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let carves = JSON.parse(readFileSync(carvesPath, 'utf8'));
let store = new Map();
for(let key in manifest.chunks) {
    let c = manifest.chunks[key];
    store.set('chunk:' + key, { key, version: c.version, bytes: c.bytes ? new Uint8Array(Buffer.from(c.bytes, 'base64')) : null });
}
store.set('world', manifest.world);
let room = { id: { name: 'profile' }, storage: {
    async get(k) { return store.get(k); },
    async put(k, v) { if(typeof k === 'string') store.set(k, v); else for(let kk in k) store.set(kk, k[kk]); },
    async delete(k) { for(let kk of Array.isArray(k) ? k : [k]) store.delete(kk); },
    async list({ prefix }) { let m = new Map(); for(let [k, v] of store) if(k.startsWith(prefix)) m.set(k, v); return m; },
} };
let server = new bundle.WorldParty(room);
clearInterval(server.interval);
await server.onStart();
let { chunkCenter } = await import('../../src/terrain/grid.js');
let p = carves[0]?.player || chunkCenter(carves[0].keys[0]);
server.world.create('p1', { Player: { name: 'p', color: '#fff' }, Transform: { position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } });
server.refreshActivity(true);
// pretend every chunk is held by a client so pushChunk computes deltas
for(let key in server.terrain.chunks) if(!server.sentStates.has(key)) server.sentStates.set(key, { version: server.terrain.chunks[key].version });
server.broadcast = () => {};
let origLog = console.log; let logs = []; console.log = (...a) => logs.push(a.join(' '));
let sleep = ms => new Promise(r => setTimeout(r, ms));
for(let i = 0; i < carves.length; i++) {
    let c = carves[i];
    let frags0 = server.world.query('FragmentMesh').size;
    let t0 = performance.now();
    server.applyCsg(c);
    let sync = performance.now() - t0;
    let t1 = performance.now();
    await sleep(0); await sleep(0); // settle timer
    let settle = performance.now() - t1 - 1;
    let ticks = [];
    for(let t = 0; t < 10; t++) { let tt = performance.now(); server.tick(); ticks.push(performance.now() - tt); server.physics.lastTime -= 33; }
    let frags = server.world.query('FragmentMesh').size - frags0;
    let csgLog = logs.find(l => l.startsWith('csg:')); logs = [];
    origLog(`carve ${i} ${c.keys.join('|').padEnd(18)} sync ${sync.toFixed(0).padStart(4)} ms  settle ${settle.toFixed(0).padStart(5)} ms  frags ${String(frags).padStart(3)}  ticks ${ticks.map(x => x.toFixed(0)).join(' ')}  cookQ ${server.cookQueue.size}  heap M ${server.terrain.heapMB().toFixed(0)} P ${server.physics.heapMB().toFixed(0)}`);
    if(csgLog) origLog('   ' + csgLog);
}
process.exit(0);
