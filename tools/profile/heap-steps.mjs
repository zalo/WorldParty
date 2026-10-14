/** Manifold heap after each startup step: init, every summary (solve), and the settle that sheds fragments. */
import { readFileSync } from 'node:fs';
let bundle = await import('./server.bundle.mjs');
let m = JSON.parse(readFileSync(process.argv[2] || 'assets/worlds/castle-exact.json', 'utf8'));
let stored = {};
for(let key in m.chunks) { let c = m.chunks[key]; stored[key] = { key, version: c.version, bytes: c.bytes ? new Uint8Array(Buffer.from(c.bytes, 'base64')) : null }; }
let ctx = { id: { name: 'steps' }, storage: { async get() {}, async put() {}, async delete() {}, async list() { return new Map(); } } };
let server = new bundle.WorldParty(ctx, {});
clearInterval(server.interval);
let T = server.terrain, line = label => console.log(`${label.padEnd(40)} manifold heap ${T.heapMB().toFixed(1)} MB (resident ${T.resident.length})`);
await T.init(stored, m.world); await server.physics.init();
line('after init');
server.connectivity.solve();
line('after solve (all summaries)');
let floating = server.connectivity.floatingComponents();
console.log(`floating components: ${floating.length}, islands: ${floating.reduce((n, c) => n + c.islands.length, 0)}, chunks touched: ${new Set(floating.flatMap(c => c.islands.map(i => i.key))).size}`);
server.settleTerrain();
line('after settle');
process.exit(0);
