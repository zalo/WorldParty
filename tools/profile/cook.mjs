/** PhysX triangle-mesh cooking time for the densest castle chunk under different preprocessing flags. */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
let bundle = await import('./server.bundle.mjs');
let { decodeChunkMesh } = await import('../../src/net/codec.js');
let m = JSON.parse(readFileSync('assets/worlds/castle-exact.json', 'utf8'));
let server = new bundle.default({ id: 'x', broadcast() {}, storage: { async get() {}, async put() {}, async delete() {}, async list() { return new Map(); } } });
clearInterval(server.interval);
await server.onStart();
let { physics } = server, px = physics.px;
let mesh = decodeChunkMesh(new Uint8Array(Buffer.from(m.chunks['1,0,-3'].bytes, 'base64')));
let E = px.PxMeshPreprocessingFlagEnum;
let variants = {
    'default': 0,
    'DISABLE_CLEAN_MESH': E.eDISABLE_CLEAN_MESH,
    'DISABLE_ACTIVE_EDGES': E.eDISABLE_ACTIVE_EDGES_PRECOMPUTE,
    'both': E.eDISABLE_CLEAN_MESH | E.eDISABLE_ACTIVE_EDGES_PRECOMPUTE,
};
for(let [name, flags] of Object.entries(variants)) {
    physics.cookingParams.set_meshPreprocessParams(new px.PxMeshPreprocessingFlags(flags));
    let best = Infinity;
    for(let i = 0; i < 5; i++) { let t = performance.now(); physics.setChunkCollider('1,0,-3', mesh); best = Math.min(best, performance.now() - t); }
    console.log(`${name.padEnd(22)} ${best.toFixed(1)} ms (best of 5), actor ${physics.chunkActors['1,0,-3'] ? 'ok' : 'MISSING'}`);
}
// Where does the time go without cooking: just the PxArray fills?
let t = performance.now();
let nv = mesh.positions.length / 3, verts = new px.PxArray_PxVec3(nv);
for(let i = 0; i < nv; i++) verts.set(i, new px.PxVec3(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]));
let idx = new px.PxArray_PxU32(mesh.indices.length); for(let i = 0; i < mesh.indices.length; i++) idx.set(i, mesh.indices[i]);
console.log(`array fill alone ${(performance.now() - t).toFixed(1)} ms (${nv} verts, ${mesh.indices.length / 3} tris)`);
console.log('PxVec3 has a cache?', typeof px.PxVec3.__cache__, 'HEAPF32?', !!px.HEAPF32, 'getPointer?', typeof px.getPointer, '_malloc?', typeof px._malloc);
process.exit(0);
