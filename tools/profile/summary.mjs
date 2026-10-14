/** Break down Connectivity.summary() for one chunk: solid decompose, air boolean, air decompose, island rasterization. */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
let bundle = await import('./server.bundle.mjs');
let { decodeChunkMesh } = await import('../../src/net/codec.js');
let { chunkCenter, CHUNK_SIZE } = await import('../../src/terrain/grid.js');
let m = JSON.parse(readFileSync(process.argv[2] || 'assets/worlds/castle-exact.json', 'utf8'));
let keys = process.argv.slice(3); if(!keys.length) keys = ['1,0,-3'];
let server = new bundle.WorldParty({ id: { name: 'x' }, storage: { async get() {}, async put() {}, async delete() {}, async list() { return new Map(); } } });
clearInterval(server.interval);
await server.onStart();
let { terrain, connectivity } = server;
terrain.world = m.world;
for(let key of keys) {
    let bytes = new Uint8Array(Buffer.from(m.chunks[key].bytes, 'base64'));
    let t = performance.now();
    try { terrain.loadChunk(key, bytes, m.chunks[key].version); } catch(e) { console.log(key, 'load threw', e.message); continue; }
    let c = terrain.chunks[key];
    console.log(`${key}: load ${(performance.now() - t).toFixed(1)} ms, manifold ${c.manifold ? 'ok' : 'DROPPED'}`);
    if(!c.manifold) continue;
    let center = chunkCenter(key);
    let M = terrain.manifold.Manifold;
    t = performance.now(); let parts = c.manifold.decompose(); let tDec = performance.now() - t;
    t = performance.now(); let islands = parts.map(p => connectivity.island(p, center, true)); let tIsl = performance.now() - t;
    t = performance.now(); let cube = terrain.withMaterial(M.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE], true).translate(center.x, center.y, center.z), 0); let tCube = performance.now() - t;
    t = performance.now(); let air = cube.subtract(c.manifold); let tAir = performance.now() - t;
    t = performance.now(); let airParts = air.decompose(); let tAirDec = performance.now() - t;
    t = performance.now(); let airIslands = airParts.map(p => connectivity.island(p, center, false)); let tAirIsl = performance.now() - t;
    t = performance.now(); let mesh = c.manifold.getMesh(); let tMesh = performance.now() - t;
    t = performance.now(); c.manifold.volume(); let tVol = performance.now() - t;
    console.log(`  solid: decompose ${tDec.toFixed(1)} ms (${parts.length} islands), rasterize ${tIsl.toFixed(1)} ms`);
    console.log(`  air: cube ${tCube.toFixed(1)} ms, subtract ${tAir.toFixed(1)} ms (${air.numTri()} tris), decompose ${tAirDec.toFixed(1)} ms (${airParts.length} islands), rasterize ${tAirIsl.toFixed(1)} ms`);
    console.log(`  getMesh ${tMesh.toFixed(1)} ms (${mesh.triVerts.length / 3} tris, ${mesh.vertProperties.length / mesh.numProp} verts), volume ${tVol.toFixed(1)} ms`);
}
process.exit(0);
