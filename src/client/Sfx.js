/** Tiny synthesized sound effects (no assets): explosions, shots, hits, pickups. The context starts on the first
 *  user gesture (the pointer-lock click), as browsers require. */
export class Sfx {
    constructor() {
        this.ctx = null;
        let start = () => { if(!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {} } if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); };
        for(let ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, start, { passive: true });
    }
    get ready() { return this.ctx && this.ctx.state === 'running'; }

    /** A burst of filtered noise with a decaying envelope. */
    noise(duration, { freq = 1000, q = 0.5, gain = 0.5, type = 'lowpass', decay = duration } = {}) {
        if(!this.ready) return;
        let ctx = this.ctx, n = Math.floor(ctx.sampleRate * duration);
        let buffer = ctx.createBuffer(1, n, ctx.sampleRate), data = buffer.getChannelData(0);
        for(let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 1.5);
        let src = ctx.createBufferSource(); src.buffer = buffer;
        let filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
        let g = ctx.createGain(); g.gain.setValueAtTime(gain, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + decay);
        src.connect(filter).connect(g).connect(ctx.destination);
        src.start();
    }
    tone(freq, duration, { gain = 0.2, type = 'sine', slide = null } = {}) {
        if(!this.ready) return;
        let ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime);
        if(slide) o.frequency.exponentialRampToValueAtTime(slide, ctx.currentTime + duration);
        g.gain.setValueAtTime(gain, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + duration);
    }

    /** distance in metres scales the volume; radius the size of the blast. */
    boom(distance, radius = 3) {
        let v = Math.max(0.05, Math.min(1, 1 - distance / 90)) * Math.min(1.4, radius / 3);
        this.noise(0.9 * Math.min(1.5, radius / 3), { freq: 220, q: 0.7, gain: 0.9 * v, decay: 0.9 });
        this.tone(70, 0.6, { gain: 0.5 * v, type: 'sine', slide: 30 });
    }
    shoot() { this.noise(0.25, { freq: 900, gain: 0.5, type: 'bandpass', q: 0.8 }); this.tone(180, 0.2, { gain: 0.25, type: 'square', slide: 60 }); }
    throw() { this.noise(0.15, { freq: 1400, gain: 0.25, type: 'highpass' }); }
    hit() { this.tone(520, 0.08, { gain: 0.3, type: 'square' }); }
    hurt() { this.noise(0.3, { freq: 400, gain: 0.5 }); this.tone(120, 0.25, { gain: 0.3, type: 'sawtooth', slide: 50 }); }
    /** The treasure light's beep: higher and louder the closer (0..1). */
    beep(near) { this.tone(420 + near * 900, 0.06, { gain: 0.05 + near * 0.12, type: 'square' }); }
    pickup() { this.tone(660, 0.1, { gain: 0.25 }); setTimeout(() => this.tone(990, 0.15, { gain: 0.25 }), 90); }
    deposit() { for(let i = 0; i < 4; i++) setTimeout(() => this.tone(523 * Math.pow(1.26, i), 0.18, { gain: 0.25 }), i * 90); }
    drill() { this.noise(0.3, { freq: 350, q: 2, gain: 0.35, type: 'bandpass' }); }
    build() { this.noise(0.12, { freq: 700, gain: 0.35 }); this.tone(220, 0.1, { gain: 0.15, type: 'triangle' }); }
    hook() { this.noise(0.1, { freq: 2500, gain: 0.25, type: 'highpass' }); this.tone(900, 0.12, { gain: 0.15, slide: 300 }); }
    death() { this.tone(300, 0.8, { gain: 0.3, type: 'sawtooth', slide: 40 }); }
    fanfare() { for(let i = 0; i < 6; i++) setTimeout(() => this.tone([523, 659, 784, 1047, 784, 1047][i], 0.25, { gain: 0.25 }), i * 120); }
}
