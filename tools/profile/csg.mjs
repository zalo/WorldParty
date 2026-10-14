/** Profile a carve on an imported world, stage by stage, against the real server class (a fake Room over a Map).
 *  node tools/profile/build.mjs && node tools/profile/csg.mjs assets/worlds/castle-exact.json [chunkKey] [carves] */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

let [manifestPath = 'assets/worlds/castle-exact.json', wantKey = null, carves = '3'] = process.argv.slice(2);
let bundle = await import('./server.bundle.mjs');
let PartyServer = bundle.WorldParty;
let { encodeSoup, decodeChunkMesh } = await import('../../src/net/codec.js');
let { coords, chunkCenter } = await import('../../src/terrain/grid.js');

// ---- fake room ----------------------------------------------------------------
let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let store = new Map();
for(let key in manifest.chunks) {
    let c = manifest.chunks[key];
    store.set('chunk:' + key, { key, version: c.version, bytes: c.bytes ? new Uint8Array(Buffer.from(c.bytes, 'base64')) : null });
}
store.set('world', manifest.world);
let room = { // the Durable Object context
    id: { name: 'profile' },
    storage: {
        async get(k) { return store.get(k); },
        async put(k, v) { if(typeof k === 'string') store.set(k, v); else for(let kk in k) store.set(kk, k[kk]); },
        async delete(k) { for(let kk of Array.isArray(k) ? k : [k]) store.delete(kk); },
        async list({ prefix }) { let m = new Map(); for(let [k, v] of store) if(k.startsWith(prefix)) m.set(k, v); return m; },
    },
};

// ---- timing instrumentation ----------------------------------------------------
let times = new Map();
function wrap(obj, name, label = name) {
    let f = obj[name];
    obj[name] = function(...a) { let t = performance.now(); try { return f.apply(this, a); } finally { let d = performance.now() - t; let e = times.get(label) || { ms: 0, n: 0 }; e.ms += d; e.n++; times.set(label, e); } };
}
function report(title) {
    let rows = [...times].sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k.padEnd(34)} ${v.ms.toFixed(1).padStart(8)} ms  x${v.n}`);
    console.log(`\n== ${title}\n` + rows.join('\n'));
    times.clear();
}

let t0 = performance.now();
let server = new PartyServer(room);
clearInterval(server.interval);
let { terrain, connectivity, physics } = server;

wrap(Object.getPrototypeOf(terrain), 'applyToChunk', 'terrain.applyToChunk');
wrap(Object.getPrototypeOf(terrain), '_refresh', 'terrain._refresh (getMesh+encode)');
wrap(Object.getPrototypeOf(terrain), 'withMaterial', 'terrain.withMaterial');
wrap(Object.getPrototypeOf(terrain), 'soupToManifold', 'terrain.soupToManifold');
wrap(Object.getPrototypeOf(terrain), 'chunkMesh', 'terrain.chunkMesh (decode)');
wrap(Object.getPrototypeOf(terrain), 'meshToManifold', 'terrain.meshToManifold');
wrap(Object.getPrototypeOf(connectivity), 'summary', 'connectivity.summary');
wrap(Object.getPrototypeOf(connectivity), 'island', 'connectivity.island');
wrap(Object.getPrototypeOf(connectivity), 'solve', 'connectivity.solve');
wrap(Object.getPrototypeOf(connectivity), 'floatingComponents', 'connectivity.floatingComponents');
wrap(Object.getPrototypeOf(connectivity), 'states', 'connectivity.states');
wrap(Object.getPrototypeOf(physics), 'setChunkCollider', 'physics.setChunkCollider (cook)');
wrap(Object.getPrototypeOf(physics), 'setDefaultChunkCollider', 'physics.setDefaultChunkCollider');
wrap(Object.getPrototypeOf(server), 'settleTerrain', 'server.settleTerrain');
wrap(Object.getPrototypeOf(server), 'settleNow', 'server.settleNow (deferred)');
wrap(Object.getPrototypeOf(server), 'applyCsg', 'server.applyCsg (sync)');
wrap(Object.getPrototypeOf(server), 'refreshActivity', 'server.refreshActivity');
wrap(Object.getPrototypeOf(server), 'syncColliders', 'server.syncColliders');
wrap(Object.getPrototypeOf(server), 'queueChunkDelta', 'server.queueChunkDelta');
wrap(Object.getPrototypeOf(server), 'persist', 'server.persist');

await server.onStart();
console.log(`startup ${(performance.now() - t0).toFixed(0)} ms`);
report('startup');

// Pick the densest chunk unless one was named
let densest = null, maxTris = 0;
for(let key in terrain.chunks) {
    let c = terrain.chunks[key]; if(!c.bytes) continue;
    let n = decodeChunkMesh(c.bytes).indices.length / 3;
    if(n > maxTris) { maxTris = n; densest = key; }
}
let key = wantKey || densest;
console.log(`carving chunk ${key} (${maxTris} tris densest=${densest}), bytes ${terrain.chunks[key]?.bytes?.length}`);

// A player standing in that chunk makes it (and its neighbours) active
let center = chunkCenter(key);
server.world.create('p1', { Player: { name: 'p', color: '#fff' }, Transform: { position: { x: center.x, y: center.y, z: center.z }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } });
server.refreshActivity(true);
report('activity with player');

// Unit cube soup
let cube = [];
let faces = [[0,1,2,3],[5,4,7,6],[4,0,3,7],[1,5,6,2],[3,2,6,7],[4,5,1,0]];
let P = [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
for(let [a,b,c,d] of faces) cube.push(...P[a],...P[b],...P[c],...P[a],...P[c],...P[d]);
let brush = encodeSoup(new Float32Array(cube));

let n = parseInt(carves);
for(let i = 0; i < n; i++) {
    let pos = { x: center.x + (i - 1) * 1.5, y: center.y - 2 + i, z: center.z + (i % 2) };
    let t = performance.now();
    server.applyCsg({ keys: [key], brush, operation: 1 /* SUBTRACTION */, position: pos, quaternion: { x: 0, y: 0.2, z: 0.1, w: 0.97 }, scale: { x: 2, y: 2, z: 2 }, material: 0 });
    console.log(`carve ${i}: ${(performance.now() - t).toFixed(1)} ms until the frame is out`);
    await new Promise(r => setTimeout(r, 5)); // let the deferred settle run
    report(`carve ${i}`);
}
process.exit(0);
