/** Singleplayer: the room server (src/server.js, on Cloudflare a Durable Object) in a Web Worker on this machine, with
 *  one connection, the main thread's LocalSocket. The room starts from a world manifest (the Fort War level, or what
 *  ?import= names) as a room starting from storage would, and its storage is this worker's memory: a reload starts the
 *  level afresh. Unlike on Cloudflare, Date.now() advances during a tick here, so the tick and carve timings the server
 *  measures are real; its carve log line is passed on for the corner readout. Built as its own bundle (soloServer.js
 *  next to main.js, tools/build-site.mjs), its WASM fetched from assets/. */
import { WorldParty } from '../server.js';

const store = new Map(), connections = new Map();
let server = null, conn = null;

// Durable Object storage in memory, with its copy semantics (a value read or written is a structured clone)
const clone = (v) => v === undefined ? v : structuredClone(v);
const storage = {
    async get(k) {
        if(!Array.isArray(k)) return clone(store.get(k));
        let m = new Map();
        for(let x of k) if(store.has(x)) m.set(x, clone(store.get(x)));
        return m;
    },
    async put(k, v) { if(typeof k === 'string') store.set(k, clone(v)); else for(let x in k) store.set(x, clone(k[x])); },
    async delete(k) {
        if(!Array.isArray(k)) return store.delete(k);
        let n = 0;
        for(let x of k) if(store.delete(x)) n++;
        return n;
    },
    async list({ prefix = '', limit = Infinity } = {}) {
        let m = new Map();
        for(let k of [...store.keys()].filter(k => k.startsWith(prefix)).sort()) { if(m.size >= limit) break; m.set(k, clone(store.get(k))); }
        return m;
    },
};

// the server's carve timings ("csg: ... boolean+encode 5ms, settle 3ms, colliders+activity 2ms; glow rocks: ... 1ms")
const log = console.log.bind(console);
console.log = (...a) => {
    log(...a);
    let s = typeof a[0] === 'string' ? a[0] : '';
    if(!s.startsWith('csg:')) return;
    let n = (re) => { let m = re.exec(s); return m ? +m[1] : 0; };
    postMessage({ t: 'carve', boolean: n(/boolean\+encode (\d+)ms/), settle: n(/settle (\d+)ms/), colliders: n(/colliders\+activity (\d+)ms/), glow: n(/glow rocks:.* (\d+)ms$/) });
};

function bytesOf(b64) {
    let s = atob(b64), out = new Uint8Array(s.length);
    for(let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

async function start({ id, manifest, url }) {
    let t0 = performance.now();
    let level = await (await fetch(manifest)).json();
    for(let key in level.chunks) { let c = level.chunks[key]; store.set('chunk:' + key, { key, version: c.version, bytes: c.bytes ? bytesOf(c.bytes) : null }); }
    store.set('world', level.world);
    server = new WorldParty({ id: { name: 'solo' }, storage, connections }, {});
    await server.onStart();
    conn = {
        id,
        send(msg) {
            if(typeof msg === 'string') { postMessage({ t: 'msg', data: msg }); return; }
            let b = msg instanceof ArrayBuffer ? msg.slice(0) : msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
            postMessage({ t: 'msg', data: b }, [b]);
        },
    };
    connections.set(id, conn);
    postMessage({ t: 'open', ms: performance.now() - t0 });
    server.onConnect(conn, { request: { url } });
}

/** A chunk fetch (Main.fetchChunk), answered by the server's own HTTP handler. */
async function chunk({ req, key, version }) {
    let res = await server.onRequest(new Request(`http://solo/parties/main/solo/chunk/${key}?v=${version}`));
    let bytes = res.status === 200 ? await res.arrayBuffer() : null;
    postMessage({ t: 'chunk', req, status: res.status, bytes }, bytes ? [bytes] : []);
}

const fail = (e) => postMessage({ t: 'error', message: e?.stack || String(e) });
onmessage = (e) => {
    let m = e.data;
    if(m.t === 'start') start(m).catch(fail);
    else if(!server) return;
    else if(m.t === 'msg') server.onMessage(conn, m.data).catch(fail);
    else if(m.t === 'chunk') chunk(m).catch(fail);
};
