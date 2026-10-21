/** Singleplayer: Main.conn without a network. It looks like the PartySocket it replaces (send, id, readyState, 'open'
 *  and 'message' events, chunk frames as ArrayBuffers) but talks to the room server in a worker on this machine
 *  (serverWorker.js, the soloServer.js bundle next to main.js), and serves the chunk fetches that would go over HTTP
 *  (`fetchChunk`). */
export class LocalSocket extends EventTarget {
    /** `manifest`: the world manifest the room starts from (absolute URL). */
    constructor({ manifest }) {
        super();
        this.id = 'solo-' + Math.random().toString(36).slice(2, 10);
        this.readyState = 0;            // WebSocket's CONNECTING; 1 once the room is up
        this.binaryType = 'arraybuffer';
        this.queued = [];               // sent before the room was up (PartySocket queues these too)
        this.requests = new Map();      // chunk fetches waiting: request id -> resolve
        this.nextRequest = 1;
        this.carve = null;              // the server's timings of its last carve, ms: { boolean, settle, colliders, glow }
        let url = new URL('./soloServer.js' + new URL(import.meta.url).search, import.meta.url); // (the bundle's ?v= busts the cache)
        this.worker = new Worker(url, { type: 'module' });
        this.worker.onmessage = (e) => this.receive(e.data);
        this.worker.onerror = (e) => console.error('solo server: ' + (e.message || 'the worker failed to start'));
        this.manifest = manifest;
    }

    send(data) {
        if(this.readyState !== 1) { if(this.queued.length < 1000) this.queued.push(data); return; }
        this.worker.postMessage({ t: 'msg', data });
    }

    receive(m) {
        switch(m.t) {
            case 'msg': this.dispatchEvent(new MessageEvent('message', { data: m.data })); break;
            // its WASM is in (fetched and compiled before its module runs, so a message posted any earlier is lost)
            case 'loaded': this.worker.postMessage({ t: 'start', id: this.id, manifest: this.manifest, url: location.href }); break;
            case 'open':
                console.log(`solo: room up in ${(m.ms / 1000).toFixed(1)} s`);
                this.readyState = 1;
                this.dispatchEvent(new Event('open'));
                for(let d of this.queued.splice(0)) this.send(d);
                break;
            case 'chunk': { let r = this.requests.get(m.req); this.requests.delete(m.req); r?.(m); break; }
            case 'carve': this.carve = m; break;
            case 'error': console.error('solo server: ' + m.message); break;
        }
    }

    /** Chunk bytes by version, as Main.fetchChunk gets them over HTTP: null when the chunk is empty (204). */
    fetchChunk(key, version) {
        let req = this.nextRequest++;
        return new Promise((resolve, reject) => {
            this.requests.set(req, (m) => m.status === 200 ? resolve(new Uint8Array(m.bytes)) : m.status === 204 ? resolve(null) : reject(new Error('HTTP ' + m.status)));
            this.worker.postMessage({ t: 'chunk', req, key, version });
        });
    }

    close() { this.worker.terminate(); this.readyState = 3; }
}
