/** A performance and network report to the room every 20 s (the server logs it and keeps the last few hundred at
 *  GET /parties/main/<room>/perf), and the ping shown next to the server tick in the corner. It exists to look at a
 *  player's lag from afar: frame rate, the longest frame and frames over 50 ms, ping, reconnects, mouse jumps the
 *  controller dropped, time held still waiting for terrain, chunk deltas that did not apply, teleports from the server,
 *  and what renders (backend, GPU, client, size). No name: the server ties reports together by a connection id prefix. */
const REPORT_MS = 20000, PING_MS = 3000, HITCH_MS = 50;

export class PerfReport {
    constructor(main) {
        this.main = main;
        this.counts = { reconnects: 0, deltaMiss: 0, teleports: 0 };
        this.frames = 0; this.frameMax = 0; this.hitches = 0;
        this.pings = []; this.ping = null;
        this.lastReport = performance.now(); this.lastPing = 0;
        this.sent = { spikes: 0, locks: 0, holds: 0, holdMs: 0 }; // the controller's counters at the last report
        this.gpu = '';
        this.gpuInfo().then(g => this.gpu = g).catch(() => {});
    }
    count(name) { this.counts[name] = (this.counts[name] || 0) + 1; }
    pong(data) {
        if(typeof data.t !== 'number') return;
        this.ping = performance.now() - data.t;
        this.pings.push(this.ping);
    }
    /** Every frame, with the frame's length. */
    frame(dtMs) {
        this.frames++;
        if(dtMs > this.frameMax) this.frameMax = dtMs;
        if(dtMs > HITCH_MS) this.hitches++;
        let now = performance.now(), conn = this.main.conn;
        if(conn.readyState !== 1) return;
        if(now - this.lastPing > PING_MS) { this.lastPing = now; conn.send(JSON.stringify({ type: 'ping', t: now })); }
        if(now - this.lastReport > REPORT_MS) this.report(now);
    }
    report(now) {
        let main = this.main, st = main.player.stats || {}, r = main.world.renderer, el = r.domElement;
        let delta = (k) => (st[k] || 0) - (this.sent[k] || 0);
        let ua = navigator.userAgent;
        let client = [/Electron\/[\d.]+/.exec(ua)?.[0], /discord\/[\d.]+/i.exec(ua)?.[0], /(Edg|Chrome|Firefox|Version)\/\d+/.exec(ua)?.[0], /Windows|Mac OS X|Android|iPhone|iPad|Linux|CrOS/.exec(ua)?.[0]].filter(Boolean).join(' ');
        main.conn.send(JSON.stringify({
            type: 'perf',
            fps: this.frames / ((now - this.lastReport) / 1000), frameMax: this.frameMax, hitches: this.hitches,
            ping: this.pings.length ? this.pings.reduce((a, b) => a + b, 0) / this.pings.length : -1, pingMax: this.pings.length ? Math.max(...this.pings) : -1,
            ...this.counts,
            spikes: delta('spikes'), spikeMax: st.spikeMax || 0, locks: delta('locks'), holds: delta('holds'), holdMs: delta('holdMs'), raw: main.player.rawInput === true,
            backend: r.backend?.isWebGPUBackend ? 'webgpu' : 'webgl', gpu: this.gpu, client, size: `${el.width}x${el.height}`, dpr: window.devicePixelRatio,
            mobile: !!main.simulationParams.mobile, discord: !!main.discord,
        }));
        for(let k of Object.keys(this.sent)) this.sent[k] = st[k] || 0;
        if(st.spikeMax) st.spikeMax = 0;
        for(let k of Object.keys(this.counts)) this.counts[k] = 0;
        this.frames = 0; this.frameMax = 0; this.hitches = 0; this.pings = []; this.lastReport = now;
    }
    async gpuInfo() {
        let r = this.main.world.renderer;
        for(let i = 0; i < 100 && !r.backend; i++) await new Promise(res => setTimeout(res, 200));
        let info = r.backend?.device?.adapterInfo || (r.backend?.isWebGPUBackend ? (await navigator.gpu.requestAdapter())?.info : null);
        if(info) return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
        let gl = r.backend?.gl, ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    }
}
