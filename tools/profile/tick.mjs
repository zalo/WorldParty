/** Where a tick's time goes with fragments awake vs asleep. node tools/profile/build.mjs && node tools/profile/tick.mjs [manifest] */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
let [manifestPath = 'assets/worlds/castle-exact.json'] = process.argv.slice(2);
let bundle = await import('./server.bundle.mjs');
let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let store = new Map();
for(let key in manifest.chunks) { let c = manifest.chunks[key]; store.set('chunk:' + key, { key, version: c.version, bytes: c.bytes ? new Uint8Array(Buffer.from(c.bytes, 'base64')) : null }); }
store.set('world', manifest.world);
let room = { id: { name: 'profile' }, storage: {
    async get(k) { return store.get(k); }, async put(k, v) { if(typeof k === 'string') store.set(k, v); else for(let kk in k) store.set(kk, k[kk]); },
    async delete(k) { for(let kk of Array.isArray(k) ? k : [k]) store.delete(kk); },
    async list({ prefix }) { let m = new Map(); for(let [k, v] of store) if(k.startsWith(prefix)) m.set(k, v); return m; } } };
let server = new bundle.WorldParty(room);
clearInterval(server.interval);
await server.onStart();
server.world.create('p1', { Player: { name: 'p', color: '#fff' }, Transform: { position: { x: 5, y: 5, z: 5 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } });
server.refreshActivity(true);
server.broadcast = () => {};
let times = {};
let wrap = (obj, name) => { let f = obj[name]; obj[name] = function(...a) { let t = performance.now(); try { return f.apply(this, a); } finally { times[name] = (times[name] || 0) + performance.now() - t; } }; };
let P = Object.getPrototypeOf(server.physics), S = Object.getPrototypeOf(server);
for(let n of ['playerSystem', 'bodySystem', 'jointSystem', 'grabSystem', 'stepSystem']) wrap(P, n);
for(let n of ['pumpCooks', 'refreshActivity', 'occupiedChunks', 'persist', 'fullUpdate']) wrap(S, n);
let scene = server.physics.scene; let sim = scene.simulate.bind(scene), fetchR = scene.fetchResults.bind(scene);
scene.simulate = dt => { let t = performance.now(); sim(dt); times.simulate = (times.simulate || 0) + performance.now() - t; };
scene.fetchResults = b => { let t = performance.now(); fetchR(b); times.fetchResults = (times.fetchResults || 0) + performance.now() - t; };
let run = (label, n) => {
    times = {}; let t0 = performance.now();
    for(let i = 0; i < n; i++) { server.tick(); server.physics.lastTime -= 33; }
    let total = performance.now() - t0;
    let awake = [...server.world.each('$PxBody')].filter(([id, pb]) => !pb.actor.isSleeping()).length;
    console.log(`\n== ${label}: ${n} ticks, ${(total / n).toFixed(1)} ms/tick, ${awake} awake bodies, cookQ ${server.cookQueue.size}`);
    for(let [k, v] of Object.entries(times).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${(v / n).toFixed(2).padStart(7)} ms/tick`);
};
run('fresh (fragments just shed, cooks queued)', 30);
run('next', 60);
run('next', 60);
for(let [id, pb] of server.world.each('$PxBody')) pb.actor.putToSleep();
run('all bodies put to sleep', 60);
for(let [id, pb] of server.world.each('$PxBody')) pb.actor.wakeUp();
run('all woken again', 60);
process.exit(0);
