/** Undermine's sound effects, all synthesized in WebAudio: no audio files (the Discord Activity's CSP forbids
 *  loading from any other origin and the repo stays small; the music track, MusicTrack.js, is the one file and is
 *  served from the app's own origin). The context is created and resumed on the first user
 *  gesture, as browsers require; every public method is a no-op until then, or when WebAudio is missing.
 *
 *  Palette, so new sounds fit the old ones (Music.js shares it):
 *  - Key: D Mixolydian (D E F# G A B C; `SCALE`, `degreeMidi`). Good news arpeggiates the D chord upward (pickup
 *    D F# A, kill A D, vote A D); the home cadence C -> D ends the deposit fanfare and the round start; bad news
 *    borrows F natural, the parallel minor (death A F D A, round lost). The treasure light's beep walks up the
 *    scale from D5 to D6 with nearness, so it stays in tune with the music while it rises.
 *  - Impacts are three layers plus a tail: a sub (sine sweeping down to ~25 Hz), a body (lowpassed noise sweeping
 *    down) and a crack (a few ms of bandpassed noise), then sparse debris ticks. Size scales the durations and
 *    lowers the pitch; every hit gets +-8 % random pitch so two rockets never sound the same.
 *  - World sounds take a position: `listen()` (called by GameClient every frame with the camera) gives distance
 *    attenuation (full within 5 m, 1/(1 + d/18) beyond, floor 0.03), a lowpass that closes with distance (a far
 *    boom is a muffled thud) and a stereo pan from the camera's right vector.
 *  - Loops (drill motor and grind, grapple reel) are stateful: `drillLoop(true|false)` / `reel(true|false)` start
 *    a graph once and wind it down with ramps; one-shots (`drill()` = a bite per actual carve) land on top.
 *  - Voices: `Synth` holds the primitives (noise, tone, metal = FM clink, bell, brass, kick) bound to a context and
 *    an output, so the same sound functions (`SOUNDS`) play live or render into an OfflineAudioContext for the
 *    `Sfx.renderOffline(name, seconds, opts)` debug helper (peak, RMS, duration, spectral centroid, band split).
 *  - Bus: fx -> master (volume, mute; `undermine.muted` / `undermine.volume` in localStorage, M toggles mute) ->
 *    tanh soft clipper -> destination, plus a shared convolver reverb (1.6 s generated impulse) with a per-sound
 *    send. Music.js hangs its own bus off the same master.
 */

export const SCALE = [62, 64, 66, 67, 69, 71, 72]; // D Mixolydian in octave 4, as midi notes
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** Scale degree (0 = D, 7 = D an octave up, negatives allowed) to midi, `octave` octaves above the 4th. */
export const degreeMidi = (deg, octave = 0) => SCALE[((deg % 7) + 7) % 7] + 12 * (Math.floor(deg / 7) + octave);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
/** Distance attenuation for world sounds. */
export const atten = (d) => d <= 5 ? 1 : Math.max(0.03, 1 / (1 + (d - 5) / 18));
/** Lowpass cutoff by distance: high frequencies die first, so far events sound muffled. */
const muffle = (d, near = 8, full = 9000) => d > near ? full / (1 + (d - near) / 12) : 0;

/** Sound primitives bound to one context and output. Times are absolute on the context's clock. */
export class Synth {
    constructor(ctx, dest, reverbSend = null) { this.ctx = ctx; this.dest = dest; this.reverbSend = reverbSend; this._noise = null; }
    get now() { return this.ctx.currentTime; }

    /** Two seconds of white noise, shared by every noise source (each starts at a random offset). */
    noiseBuffer() {
        if(this._noise) return this._noise;
        let ctx = this.ctx, n = Math.floor(ctx.sampleRate * 2), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
        let s = 0x9e3779b9;
        for(let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = ((s >>> 0) / 2147483648) - 1; }
        return this._noise = b;
    }

    /** The output chain of one sound: [lowpass] -> [pan] -> dest, with a share into the reverb. Connect into the result. */
    bus({ pan = 0, lowpass = 0, send = 0 } = {}) {
        let ctx = this.ctx, head = this.dest;
        if(send > 0 && this.reverbSend) {
            let split = ctx.createGain(), g = ctx.createGain(); g.gain.value = send;
            split.connect(this.dest); split.connect(g); g.connect(this.reverbSend); head = split;
        }
        if(pan && ctx.createStereoPanner) { let p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(head); head = p; }
        if(lowpass > 0 && lowpass < 18000) { let f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; f.Q.value = 0.5; f.connect(head); head = f; }
        return head;
    }

    /** Gain envelope: linear attack to `peak`, hold, exponential decay to silence. Returns the GainNode (connected to `out`). */
    env(at, peak, attack, decay, hold = 0, out = this.dest) {
        let g = this.ctx.createGain(), p = g.gain;
        p.setValueAtTime(0.0001, at);
        p.linearRampToValueAtTime(Math.max(0.0002, peak), at + attack);
        if(hold > 0) p.setValueAtTime(Math.max(0.0002, peak), at + attack + hold);
        p.exponentialRampToValueAtTime(0.0001, at + attack + hold + decay);
        g.connect(out);
        return g;
    }

    /** Filtered noise burst. `freqEnd` sweeps the filter over the sound. */
    noise(at, { dur = 0.2, gain = 0.5, attack = 0.002, hold = 0, decay = dur, type = 'lowpass', freq = 1000, freqEnd = 0, q = 0.7, out = this.dest } = {}) {
        let ctx = this.ctx, end = at + attack + hold + decay;
        let src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(); src.loop = true;
        let f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
        f.frequency.setValueAtTime(freq, at);
        if(freqEnd > 0) f.frequency.exponentialRampToValueAtTime(freqEnd, end);
        let g = this.env(at, gain, attack, decay, hold, out);
        src.connect(f); f.connect(g);
        src.start(at, Math.random() * 1.5); src.stop(end + 0.03);
        return src;
    }

    /** An oscillator with an envelope; `freqEnd` glides the pitch over the sound; `lowpass` tames bright waveforms. */
    tone(at, freq, { dur = 0.2, gain = 0.3, attack = 0.003, hold = 0, decay = dur, type = 'sine', freqEnd = 0, detune = 0, lowpass = 0, out = this.dest } = {}) {
        let ctx = this.ctx, end = at + attack + hold + decay;
        let o = ctx.createOscillator(); o.type = type; o.detune.value = detune;
        o.frequency.setValueAtTime(Math.max(1, freq), at);
        if(freqEnd > 0) o.frequency.exponentialRampToValueAtTime(freqEnd, end);
        let g = this.env(at, gain, attack, decay, hold, out), n = o;
        if(lowpass > 0) { let f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; o.connect(f); n = f; }
        n.connect(g);
        o.start(at); o.stop(end + 0.03);
        return o;
    }

    /** FM metal: a carrier with an inharmonic modulator whose index decays fast. Clinks, pings, clanks. */
    metal(at, freq, { dur = 0.15, gain = 0.3, ratio = 2.76, index = 3, out = this.dest } = {}) {
        let ctx = this.ctx, c = ctx.createOscillator(), m = ctx.createOscillator(), mg = ctx.createGain();
        c.frequency.value = freq; m.frequency.value = freq * ratio;
        mg.gain.setValueAtTime(freq * index, at); mg.gain.exponentialRampToValueAtTime(freq * 0.05, at + dur);
        m.connect(mg); mg.connect(c.frequency);
        let g = this.env(at, gain, 0.001, dur, 0, out);
        c.connect(g);
        c.start(at); m.start(at); c.stop(at + dur + 0.03); m.stop(at + dur + 0.03);
    }

    /** Bell / pluck for jingles and the arpeggio: fundamental, octave, a slightly sharp twelfth, a short bright partial. */
    bell(at, freq, { dur = 0.5, gain = 0.3, bright = 1, out = this.dest } = {}) {
        this.tone(at, freq, { dur, gain, attack: 0.002, out });
        this.tone(at, freq * 2, { dur: dur * 0.6, gain: gain * 0.35, attack: 0.002, out });
        this.tone(at, freq * 3.01, { dur: dur * 0.3, gain: gain * 0.15 * bright, attack: 0.002, out });
        this.tone(at, freq * 5.4, { dur: 0.08, gain: gain * 0.12 * bright, attack: 0.001, out });
    }

    /** Brass-ish stinger voice: three detuned saws through a lowpass that opens with the attack. */
    brass(at, freq, { dur = 0.4, gain = 0.2, attack = 0.03, out = this.dest } = {}) {
        let ctx = this.ctx, f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 1;
        f.frequency.setValueAtTime(freq * 2, at); f.frequency.linearRampToValueAtTime(freq * 6, at + attack + 0.05); f.frequency.exponentialRampToValueAtTime(freq * 2, at + attack + dur);
        let g = this.env(at, gain, attack, dur * 0.5, dur * 0.5, out);
        f.connect(g);
        for(let d of [-7, 0, 7]) { let o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = d; o.connect(f); o.start(at); o.stop(at + attack + dur + 0.05); }
    }

    /** Kick: a sine dropping an octave and a half, with a click. */
    kick(at, { gain = 0.6, freq = 130, out = this.dest } = {}) {
        this.tone(at, freq, { dur: 0.3, gain, freqEnd: 42, attack: 0.002, out });
        this.noise(at, { dur: 0.02, gain: gain * 0.5, type: 'lowpass', freq: 2500, attack: 0.001, out });
    }
}

/** The sounds. Each takes the synth and options (`at` defaults to now); loops return a stop(time) function. */
export const SOUNDS = {
    /** Rocket r2.4, grenade r3.2, buster r5.6: size scales the layers; distance attenuates and muffles. */
    explosion(s, { at = s.now, radius = 3, distance = 0, pan = 0, kind = 'rocket' } = {}) {
        let size = clamp(radius / 3, 0.6, 2.2), a = atten(distance), r = rnd(0.92, 1.08);
        let v = a * clamp(0.6 + size * 0.35, 0.7, 1.0); // bigger blasts get longer and deeper, not much louder (headroom)
        let out = s.bus({ pan, lowpass: muffle(distance), send: 0.3 * clamp(size, 0.8, 1.6) });
        s.tone(at, 64 * r / Math.sqrt(size), { dur: 0.45 * size, gain: 0.7 * v, freqEnd: 24, attack: 0.004, out });                   // sub thump
        s.noise(at, { dur: 0.75 * size, gain: 0.6 * v, type: 'lowpass', freq: 480 * r, freqEnd: 60, q: 0.9, attack: 0.004, out });     // body
        s.noise(at, { dur: 0.05, gain: 0.45 * v * a, type: 'bandpass', freq: 2400 * r, q: 0.7, attack: 0.001, out });                   // crack
        let ticks = 4 + Math.round(size * 5);
        for(let i = 0; i < ticks; i++) {                                                                                                // debris
            let dt = 0.08 + Math.pow(Math.random(), 1.6) * 0.9 * size, k = clamp(1 - dt / (1.1 * size), 0.1, 1);
            s.noise(at + dt, { dur: rnd(0.02, 0.05), gain: 0.2 * v * k, type: 'bandpass', freq: rnd(500, 3200), q: 2.5, attack: 0.001, out });
        }
        if(size > 1.15) {                                                                                                               // rumble for the big ones
            s.noise(at + 0.08, { dur: 1.5 * size, gain: 0.25 * v, type: 'lowpass', freq: 170, q: 1, attack: 0.06, out });
            s.tone(at + 0.02, 40 * r, { dur: 1.3 * size, gain: 0.2 * v, freqEnd: 22, attack: 0.03, out });
        }
        if(kind === 'buster') s.tone(at + 0.05, 48 * r, { dur: 1.8, gain: 0.14 * v, type: 'triangle', freqEnd: 30, attack: 0.1, out });
    },
    /** Rocket launch: ignition thump (only in your own hands), a whoosh that recedes and drops in pitch, the motor falling away. */
    rocket(s, { at = s.now, distance = 0, pan = 0 } = {}) {
        let a = atten(distance), r = rnd(0.9, 1.1);
        let out = s.bus({ pan, lowpass: muffle(distance, 10, 6000), send: 0.2 });
        if(distance < 3) { s.noise(at, { dur: 0.05, gain: 0.45, type: 'lowpass', freq: 1200, attack: 0.001, out }); s.tone(at, 150 * r, { dur: 0.16, gain: 0.4, freqEnd: 50, out }); }
        s.noise(at, { gain: 0.42 * a, type: 'bandpass', freq: 600 * r, freqEnd: 150, q: 1.1, attack: 0.05, hold: 0.08, decay: 0.95, out });
        s.noise(at + 0.01, { dur: 0.45, gain: 0.18 * a, type: 'highpass', freq: 2200, attack: 0.02, out });
        s.tone(at + 0.02, 360 * r, { dur: 0.75, gain: 0.08 * a, type: 'sawtooth', freqEnd: 80, lowpass: 1400, attack: 0.02, out });
    },
    /** Grenade: an arm swish scaled by the charge and the pin's ping. Buster: a heavy heave and a clank. */
    throw(s, { at = s.now, power = 0.6, kind = 'grenade' } = {}) {
        let out = s.bus({ send: 0.1 }), r = rnd(0.95, 1.05);
        if(kind === 'buster') {
            s.noise(at, { dur: 0.3, gain: 0.4, type: 'bandpass', freq: 400, freqEnd: 900, q: 1, attack: 0.04, out });
            s.metal(at, 420 * r, { dur: 0.3, gain: 0.25, ratio: 1.41, index: 2.5, out });
            s.tone(at, 110, { dur: 0.2, gain: 0.3, freqEnd: 60, out });
        } else {
            s.noise(at, { dur: 0.14 + power * 0.1, gain: 0.16 + power * 0.2, type: 'highpass', freq: 900, freqEnd: 2600, attack: 0.02, out });
            s.metal(at, 2300 * r, { dur: 0.1, gain: 0.1, ratio: 3.1, index: 2, out });
        }
    },
    /** A grenade's hollow metal tick or a buster's thud when it lands; `impact` 0..1 from the landing speed. */
    bounce(s, { at = s.now, kind = 'grenade', impact = 1, distance = 0, pan = 0 } = {}) {
        let a = atten(distance) * clamp(impact, 0.2, 1), r = rnd(0.9, 1.1), out = s.bus({ pan, lowpass: muffle(distance), send: 0.2 });
        if(kind === 'buster') {
            s.tone(at, 120 * r, { dur: 0.16, gain: 0.45 * a, freqEnd: 55, out });
            s.noise(at, { dur: 0.1, gain: 0.35 * a, type: 'lowpass', freq: 500, attack: 0.001, out });
            s.metal(at, 380 * r, { dur: 0.25, gain: 0.15 * a, ratio: 1.41, index: 1.5, out });
        } else {
            s.metal(at, 780 * r, { dur: 0.1, gain: 0.3 * a, ratio: 2.76, index: 2, out });
            s.noise(at, { dur: 0.018, gain: 0.25 * a, type: 'bandpass', freq: 3000, q: 1, attack: 0.001, out });
        }
    },
    /** One fuse tick; GameClient calls it on every blink of FuseFxSystem, `progress` 0..1 of the fuse so the pitch climbs. */
    fuse(s, { at = s.now, kind = 'grenade', progress = 0, distance = 0, pan = 0 } = {}) {
        let a = atten(distance), out = s.bus({ pan, lowpass: muffle(distance, 12) });
        if(kind === 'buster') {
            s.tone(at, 520 + progress * 480, { dur: 0.05, gain: 0.25 * a, type: 'triangle', attack: 0.002, out });
            s.noise(at, { dur: 0.012, gain: 0.18 * a, type: 'bandpass', freq: 2500, q: 2, attack: 0.001, out });
            if(progress > 0.7) s.tone(at, 70, { dur: 0.08, gain: 0.18 * a, out });
        } else s.tone(at, 1400 + progress * 1300, { dur: 0.03, gain: 0.14 * a, type: 'square', attack: 0.001, lowpass: 5000, out });
    },
    /** The drill motor and grind while the button is held: detuned saws under a wobbling lowpass, noise chopped by the teeth, a hiss. */
    drillLoop(s, { at = s.now } = {}) {
        let ctx = s.ctx, out = s.bus({ send: 0.08 }), r = rnd(0.95, 1.05);
        let master = ctx.createGain(); master.gain.setValueAtTime(0.0001, at); master.gain.exponentialRampToValueAtTime(1, at + 0.12); master.connect(out);
        let stops = [], nodes = [];
        let lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650; lp.Q.value = 2;
        let mg = ctx.createGain(); mg.gain.value = 0.18; lp.connect(mg); mg.connect(master);
        let oscs = [['sawtooth', 92, 0], ['sawtooth', 92, 9], ['square', 46, 0]].map(([type, f, d]) => { let o = ctx.createOscillator(); o.type = type; o.frequency.value = f * r; o.detune.value = d; o.connect(lp); o.start(at); stops.push(o); return o; });
        let wob = ctx.createOscillator(); wob.frequency.value = 0.7; let wg = ctx.createGain(); wg.gain.value = 180; wob.connect(wg); wg.connect(lp.frequency); wob.start(at); stops.push(wob);
        let strain = ctx.createOscillator(); strain.frequency.value = 2.7; let sg = ctx.createGain(); sg.gain.value = 25; strain.connect(sg); for(let o of oscs) sg.connect(o.detune); strain.start(at); stops.push(strain);
        // grind: bandpassed noise chopped at 14 Hz
        let n1 = ctx.createBufferSource(); n1.buffer = s.noiseBuffer(); n1.loop = true;
        let bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100 * r; bp.Q.value = 1.5;
        let chop = ctx.createGain(); chop.gain.value = 0.5; let lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 14; let lg = ctx.createGain(); lg.gain.value = 0.45; lfo.connect(lg); lg.connect(chop.gain);
        let gg = ctx.createGain(); gg.gain.value = 0.2; n1.connect(bp); bp.connect(chop); chop.connect(gg); gg.connect(master); n1.start(at, Math.random()); lfo.start(at); stops.push(n1, lfo);
        // rattle: a shimmering hiss
        let n2 = ctx.createBufferSource(); n2.buffer = s.noiseBuffer(); n2.loop = true;
        let hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
        let sh = ctx.createGain(); sh.gain.value = 0.04; let lfo2 = ctx.createOscillator(); lfo2.frequency.value = 29; let lg2 = ctx.createGain(); lg2.gain.value = 0.025; lfo2.connect(lg2); lg2.connect(sh.gain);
        n2.connect(hp); hp.connect(sh); sh.connect(master); n2.start(at, Math.random()); lfo2.start(at); stops.push(n2, lfo2);
        nodes.push(master, lp, mg, bp, chop, gg, hp, sh);
        return (t = ctx.currentTime) => {
            let g = master.gain; if(g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else { g.cancelScheduledValues(t); g.setValueAtTime(1, t); }
            g.exponentialRampToValueAtTime(0.0001, t + 0.3);
            for(let o of oscs) { o.frequency.setValueAtTime(o.frequency.value, t); o.frequency.exponentialRampToValueAtTime(o.frequency.value * 0.55, t + 0.3); } // winding down
            for(let n of stops) n.stop(t + 0.35);
            setTimeout(() => { for(let n of nodes) n.disconnect(); }, (t - ctx.currentTime) * 1000 + 500);
        };
    },
    /** One bite of the drill (per actual carve, every 420 ms while held): a crunch, a thud, gravel. */
    bite(s, { at = s.now } = {}) {
        let r = rnd(0.9, 1.1), out = s.bus({ send: 0.12 });
        s.noise(at, { dur: 0.18, gain: 0.45, type: 'lowpass', freq: 420 * r, freqEnd: 110, q: 1, attack: 0.003, out });
        s.tone(at, 85 * r, { dur: 0.15, gain: 0.35, freqEnd: 38, out });
        for(let i = 0; i < 4; i++) s.noise(at + 0.02 + Math.random() * 0.22, { dur: rnd(0.015, 0.035), gain: 0.16, type: 'bandpass', freq: rnd(700, 2600), q: 3, attack: 0.001, out });
    },
    /** A glow rock dug out: it shatters with a glassy tinkle (high bell partials in D, a breath of sparkle noise). */
    crystal(s, { at = s.now, count = 1, distance = 0, pan = 0 } = {}) {
        let out = s.bus({ send: 0.35, pan, lowpass: distance > 12 ? 4000 : 0 }), g = clamp(0.2 / (1 + distance / 8), 0.02, 0.2);
        let notes = [86, 90, 93, 98, 102], n = Math.min(4, 1 + Math.ceil(count / 2));
        for(let i = 0; i < n; i++) s.bell(at + i * rnd(0.025, 0.05), midiHz(notes[Math.floor(Math.random() * notes.length)]), { dur: rnd(0.2, 0.35), gain: g * rnd(0.6, 1), bright: 1.4, out });
        s.noise(at, { dur: 0.08, gain: g * 0.5, type: 'highpass', freq: 5000, attack: 0.001, out });
    },
    /** Mason: a stone block set down; `size` is the cube root of its volume (wall 1.8, block 2, plank 1.3, pillar 1.6). */
    build(s, { at = s.now, size = 1.6 } = {}) {
        let r = rnd(0.93, 1.07), k = clamp(size / 1.6, 0.7, 1.4), out = s.bus({ send: 0.25 });
        s.tone(at, 110 * r / k, { dur: 0.22 * k, gain: 0.5, freqEnd: 40, attack: 0.002, out });
        s.noise(at, { dur: 0.12 * k, gain: 0.5, type: 'lowpass', freq: 600 * r, freqEnd: 150, q: 0.8, attack: 0.002, out });
        s.noise(at, { dur: 0.03, gain: 0.28, type: 'bandpass', freq: 1900 * r, q: 4, attack: 0.001, out });              // stone on stone
        s.noise(at + 0.05, { dur: 0.25 * k, gain: 0.09, type: 'highpass', freq: 1600, attack: 0.04, out });               // grit settling
    },
    /** Grapple: the launch, the rope paying out, and the hook biting 150 ms later. */
    hook(s, { at = s.now } = {}) {
        let r = rnd(0.95, 1.05), out = s.bus({ send: 0.2 });
        s.noise(at, { dur: 0.07, gain: 0.35, type: 'highpass', freq: 2500, attack: 0.002, out });
        s.tone(at, 620 * r, { dur: 0.09, gain: 0.08, type: 'square', freqEnd: 180, lowpass: 2500, out });
        s.noise(at + 0.01, { dur: 0.2, gain: 0.2, type: 'bandpass', freq: 800, freqEnd: 2600, q: 1.5, attack: 0.03, out });
        s.metal(at + 0.15, 1900 * r, { dur: 0.25, gain: 0.3, ratio: 2.76, index: 3, out });
        s.noise(at + 0.15, { dur: 0.015, gain: 0.25, type: 'bandpass', freq: 3500, q: 1, attack: 0.001, out });
    },
    /** The reel while the grapple pulls: a ratchet (noise chopped at 22 Hz) and a small motor whose pitch climbs. */
    reelLoop(s, { at = s.now } = {}) {
        let ctx = s.ctx, out = s.bus({ send: 0.1 });
        let master = ctx.createGain(); master.gain.setValueAtTime(0.0001, at); master.gain.exponentialRampToValueAtTime(1, at + 0.08); master.connect(out);
        let n = ctx.createBufferSource(); n.buffer = s.noiseBuffer(); n.loop = true;
        let bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 2;
        let chop = ctx.createGain(); chop.gain.value = 0.5; let lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 22; let lg = ctx.createGain(); lg.gain.value = 0.5; lfo.connect(lg); lg.connect(chop.gain);
        let g1 = ctx.createGain(); g1.gain.value = 0.14; n.connect(bp); bp.connect(chop); chop.connect(g1); g1.connect(master);
        let o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(170, at); o.frequency.linearRampToValueAtTime(240, at + 2.5);
        let lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; let g2 = ctx.createGain(); g2.gain.value = 0.08; o.connect(lp); lp.connect(g2); g2.connect(master);
        n.start(at, Math.random()); lfo.start(at); o.start(at);
        return (t = ctx.currentTime) => {
            let g = master.gain; if(g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else { g.cancelScheduledValues(t); g.setValueAtTime(1, t); }
            g.exponentialRampToValueAtTime(0.0001, t + 0.12);
            for(let x of [n, lfo, o]) x.stop(t + 0.15);
            setTimeout(() => { for(let x of [master, bp, chop, g1, lp, g2]) x.disconnect(); }, (t - ctx.currentTime) * 1000 + 300);
        };
    },
    unhook(s, { at = s.now } = {}) {
        s.noise(at, { dur: 0.06, gain: 0.22, type: 'highpass', freq: 1800, attack: 0.002 });
        s.tone(at, 500, { dur: 0.09, gain: 0.07, freqEnd: 1100, type: 'triangle' });
    },
    /** Taking damage: a body thud, a grunt-ish formant, ears ringing after a big one. */
    hurt(s, { at = s.now, damage = 30 } = {}) {
        let k = clamp(0.5 + damage / 70, 0.5, 1.1), r = rnd(0.9, 1.1), out = s.bus({ send: 0.1 });
        s.noise(at, { dur: 0.22, gain: 0.45 * k, type: 'lowpass', freq: 260 * r, freqEnd: 90, attack: 0.002, out });
        s.tone(at, 180 * r, { dur: 0.22, gain: 0.4 * k, freqEnd: 55, out });
        s.noise(at + 0.01, { dur: 0.14, gain: 0.18 * k, type: 'bandpass', freq: 650 * r, freqEnd: 350, q: 4, attack: 0.01, out });
        if(damage > 45) s.tone(at + 0.03, 3100, { dur: 0.6, gain: 0.04, attack: 0.05, out });
    },
    /** Death: a long sub drop and the parallel-minor fall A F D A. */
    death(s, { at = s.now } = {}) {
        let out = s.bus({ send: 0.4 });
        s.tone(at, 110, { dur: 1.3, gain: 0.45, freqEnd: 32, attack: 0.01, out });
        s.noise(at, { dur: 1.0, gain: 0.3, type: 'lowpass', freq: 400, freqEnd: 80, attack: 0.01, out });
        [69, 65, 62, 57].forEach((m, i) => s.brass(at + 0.1 + i * 0.19, midiHz(m), { dur: i === 3 ? 0.9 : 0.3, gain: 0.14, attack: 0.02, out }));
    },
    /** Respawn: a rising sweep and D A D. */
    respawn(s, { at = s.now } = {}) {
        let out = s.bus({ send: 0.35 });
        s.noise(at, { dur: 0.5, gain: 0.16, type: 'bandpass', freq: 300, freqEnd: 3200, q: 1.2, attack: 0.15, out });
        [62, 69, 74].forEach((m, i) => s.bell(at + 0.12 + i * 0.09, midiHz(m + 12), { dur: 0.5, gain: 0.14, out }));
    },
    kill(s, { at = s.now } = {}) { let out = s.bus({ send: 0.3 }); s.bell(at, midiHz(81), { dur: 0.3, gain: 0.2, out }); s.bell(at + 0.09, midiHz(86), { dur: 0.5, gain: 0.22, out }); },
    /** Pickup: D F# A up. */
    pickup(s, { at = s.now } = {}) { let out = s.bus({ send: 0.3 }); [74, 78, 81].forEach((m, i) => s.bell(at + i * 0.075, midiHz(m), { dur: i === 2 ? 0.6 : 0.25, gain: 0.2, out })); },
    /** A teammate (or an enemy, lower) grabbed a crate: a short version of the pickup, far away. */
    pickupOther(s, { at = s.now, friendly = true } = {}) {
        let out = s.bus({ send: 0.3 });
        if(friendly) [74, 81].forEach((m, i) => s.bell(at + i * 0.08, midiHz(m), { dur: 0.3, gain: 0.08, out }));
        else [57, 55].forEach((m, i) => s.tone(at + i * 0.12, midiHz(m), { dur: 0.3, gain: 0.08, type: 'triangle', out }));
    },
    /** Deposit: the team fanfare, D F# A D up, then C -> D home over a D3 root. */
    deposit(s, { at = s.now } = {}) {
        let out = s.bus({ send: 0.35 });
        s.tone(at, midiHz(50), { dur: 1.4, gain: 0.22, attack: 0.02, out });
        [62, 66, 69, 74].forEach((m, i) => s.bell(at + i * 0.1, midiHz(m + 12), { dur: 0.35, gain: 0.18, out }));
        s.bell(at + 0.5, midiHz(84), { dur: 0.3, gain: 0.16, out }); s.bell(at + 0.62, midiHz(86), { dur: 1.0, gain: 0.24, out });
        for(let [m, g] of [[62, 0.07], [66, 0.05], [69, 0.05]]) s.brass(at + 0.62, midiHz(m), { dur: 0.9, gain: g, out });
    },
    /** Tunnel rat: a quick scamper up the scale and a D chord. */
    bonus(s, { at = s.now } = {}) {
        let out = s.bus({ send: 0.35 });
        [67, 69, 71, 74, 76, 78].forEach((m, i) => s.bell(at + i * 0.06, midiHz(m + 12), { dur: 0.22, gain: 0.14, out }));
        [74, 78, 81].forEach(m => s.bell(at + 0.42, midiHz(m + 12), { dur: 0.9, gain: 0.12, out }));
    },
    /** Round start: drum, D D A D in brass, a bell chord on the landing. */
    roundStart(s, { at = s.now } = {}) {
        let out = s.bus({ send: 0.35 });
        s.kick(at, { gain: 0.45, out }); s.noise(at, { dur: 0.4, gain: 0.2, type: 'lowpass', freq: 300, attack: 0.002, out });
        for(let [m, dt, dur] of [[62, 0, 0.18], [62, 0.2, 0.18], [69, 0.4, 0.3], [74, 0.75, 0.9]]) { s.brass(at + dt, midiHz(m), { dur, gain: 0.14, out }); s.brass(at + dt, midiHz(m - 12), { dur, gain: 0.08, out }); }
        s.kick(at + 0.75, { gain: 0.4, out });
        [74, 78, 81].forEach(m => s.bell(at + 0.75, midiHz(m + 12), { dur: 1.0, gain: 0.1, out }));
    },
    /** Round over: win climbs A D F# A, loss falls A F D A over a low D, a draw hovers. */
    roundOver(s, { at = s.now, result = 'draw' } = {}) {
        let out = s.bus({ send: 0.4 });
        s.kick(at, { gain: 0.5, out });
        if(result === 'win') {
            for(let [m, dt] of [[69, 0], [74, 0.15], [78, 0.3], [81, 0.45]]) s.brass(at + dt, midiHz(m), { dur: dt === 0.45 ? 1.4 : 0.35, gain: 0.16, out });
            [74, 78, 81, 86].forEach(m => s.bell(at + 0.45, midiHz(m + 12), { dur: 1.4, gain: 0.1, out }));
        } else if(result === 'loss') {
            for(let [m, dt] of [[69, 0], [65, 0.25], [62, 0.5], [57, 0.75]]) s.brass(at + dt, midiHz(m), { dur: dt === 0.75 ? 1.6 : 0.4, gain: 0.15, out });
            s.tone(at + 0.75, midiHz(38), { dur: 1.8, gain: 0.22, attack: 0.05, out });
        } else for(let [m, dt] of [[69, 0], [67, 0.3], [69, 0.6]]) s.brass(at + dt, midiHz(m), { dur: dt === 0.6 ? 1.2 : 0.4, gain: 0.14, out });
    },
    votePass(s, { at = s.now } = {}) { let out = s.bus({ send: 0.3 }); s.bell(at, midiHz(81), { dur: 0.3, gain: 0.18, out }); s.bell(at + 0.12, midiHz(86), { dur: 0.6, gain: 0.18, out }); },
    /** UI: weapon switch, vote cast, menu. */
    click(s, { at = s.now } = {}) { s.noise(at, { dur: 0.012, gain: 0.14, type: 'highpass', freq: 2500, attack: 0.001 }); s.tone(at, 1700, { dur: 0.03, gain: 0.07, type: 'triangle' }); },
    /** The treasure light: a ping that walks up the scale (D5 .. D6) and gets louder as `near` goes 0..1. */
    beep(s, { at = s.now, near = 0 } = {}) {
        let f = midiHz(degreeMidi(Math.round(clamp(near, 0, 1) * 7), 1)), g = 0.06 + near * 0.12, out = s.bus({ send: 0.15 });
        s.tone(at, f, { dur: 0.09, gain: g, attack: 0.002, out }); s.tone(at, f * 2, { dur: 0.05, gain: g * 0.3, attack: 0.002, out });
    },
    /** Rubble: a collapse of `count` fragments, thuds scattered over half a second and a rumble. */
    rubble(s, { at = s.now, count = 1, distance = 0, pan = 0 } = {}) {
        let a = atten(distance), n = Math.min(9, 2 + count), k = clamp(count / 6, 0.3, 1), out = s.bus({ pan, lowpass: muffle(distance, 10, 7000), send: 0.3 });
        for(let i = 0; i < n; i++) {
            let dt = Math.random() * 0.55, r = rnd(0.8, 1.25);
            s.noise(at + dt, { dur: 0.09, gain: 0.26 * a, type: 'lowpass', freq: 380 * r, freqEnd: 120, q: 1, attack: 0.002, out });
            s.tone(at + dt, 75 * r, { dur: 0.1, gain: 0.2 * a, freqEnd: 40, out });
        }
        s.noise(at, { dur: 0.7, gain: 0.26 * a * k, type: 'lowpass', freq: 130, q: 1, attack: 0.05, out });
    },
    /** Landing after a fall; `speed` in m/s. */
    land(s, { at = s.now, speed = 10 } = {}) {
        let k = clamp((speed - 6) / 20, 0.15, 1), out = s.bus({ send: 0.1 });
        s.noise(at, { dur: 0.09, gain: 0.32 * k, type: 'lowpass', freq: 450, freqEnd: 150, attack: 0.002, out });
        s.tone(at, 95, { dur: 0.12, gain: 0.28 * k, freqEnd: 45, out });
    },
    step(s, { at = s.now } = {}) {
        let r = rnd(0.85, 1.15);
        s.noise(at, { dur: 0.06, gain: 0.11, type: 'lowpass', freq: 750 * r, freqEnd: 250, attack: 0.002 });
        s.tone(at, 120 * r, { dur: 0.04, gain: 0.05, freqEnd: 70 });
    },
};

/** The output bus for a context: fx -> master -> soft clipper -> destination, plus the reverb (send -> lowpass -> convolver -> master). */
export function createBus(ctx) {
    let fx = ctx.createGain(), master = ctx.createGain(), limiter = ctx.createWaveShaper();
    // unity below the knee, then a tanh shoulder that tops out at 0.89: a safety net, not a gain stage
    let curve = new Float32Array(1025), knee = 0.55;
    for(let i = 0; i < curve.length; i++) { let x = (i / 512) - 1, ax = Math.abs(x); curve[i] = Math.sign(x) * (ax < knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee))); }
    limiter.curve = curve; limiter.oversample = '2x';
    fx.connect(master); master.connect(limiter); limiter.connect(ctx.destination);
    let reverbSend = ctx.createGain(), lp = ctx.createBiquadFilter(), conv = ctx.createConvolver(), ret = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 3200; ret.gain.value = 0.35;
    let len = Math.floor(ctx.sampleRate * 1.6), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for(let c = 0; c < 2; c++) { let d = ir.getChannelData(c), s = 12345 + c * 777; for(let i = 0; i < len; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; let t = i / ctx.sampleRate; d[i] = (((s >>> 0) / 2147483648) - 1) * Math.exp(-t * 4.2) * (t < 0.02 ? t / 0.02 : 1); } }
    conv.buffer = ir;
    reverbSend.connect(lp); lp.connect(conv); conv.connect(ret); ret.connect(master);
    return { fx, master, limiter, reverbSend };
}

const SIZE_OF_SHAPE = (dims) => Array.isArray(dims) && dims.length === 3 ? Math.cbrt(dims[0] * dims[1] * dims[2]) : 1.6;

export class Sfx {
    constructor() {
        this.ctx = null; this.synth = null; this.master = null; this.reverbSend = null;
        this.loops = {};
        this.readyFns = [];
        this.listener = { x: 0, y: 0, z: 0, rx: 1, ry: 0, rz: 0 };
        let store = (k) => { try { return localStorage.getItem(k); } catch(e) { return null; } };
        this.muted = store('undermine.muted') === '1';
        let vol = parseFloat(store('undermine.volume')); this.volume = Number.isFinite(vol) ? clamp(vol, 0, 1) : 1;
        let start = () => {
            try {
                if(!this.ctx) {
                    let AC = window.AudioContext || window.webkitAudioContext; if(!AC) return;
                    this.ctx = new AC();
                    let bus = createBus(this.ctx);
                    this.fx = bus.fx; this.master = bus.master; this.reverbSend = bus.reverbSend;
                    this.master.gain.value = this.muted ? 0 : this.volume;
                    this.synth = new Synth(this.ctx, this.fx, this.reverbSend);
                }
                if(this.ctx.state === 'suspended') this.ctx.resume().then(() => this.fireReady()).catch(() => {});
                else this.fireReady();
            } catch(e) { console.warn('audio unavailable', e); }
        };
        for(let ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, start, { passive: true });
    }
    get ready() { return !!this.ctx && this.ctx.state === 'running'; }
    /** Runs fn once the context is running (at once if it already is). Music starts here. */
    onReady(fn) { if(this.ready) fn(); else this.readyFns.push(fn); }
    fireReady() { if(!this.ready) return; let fns = this.readyFns; this.readyFns = []; for(let fn of fns) { try { fn(); } catch(e) { console.warn(e); } } }

    setMuted(m) {
        this.muted = !!m;
        try { localStorage.setItem('undermine.muted', this.muted ? '1' : '0'); } catch(e) {}
        if(this.master) { let g = this.master.gain, t = this.ctx.currentTime; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(this.muted ? 0 : this.volume, t + 0.15); }
        if(this.muted) for(let k in this.loops) this.loop(k, false);
        return this.muted;
    }
    toggleMute() { return this.setMuted(!this.muted); }
    setVolume(v) {
        this.volume = clamp(v, 0, 1);
        try { localStorage.setItem('undermine.volume', String(this.volume)); } catch(e) {}
        if(this.master && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }

    /** Where the ears are: the camera's position and right vector, for distance and pan. */
    listen(camera) {
        let l = this.listener, p = camera.position, q = camera.quaternion;
        l.x = p.x; l.y = p.y; l.z = p.z;
        // the camera's local +x in world space
        l.rx = 1 - 2 * (q.y * q.y + q.z * q.z); l.ry = 2 * (q.x * q.y + q.w * q.z); l.rz = 2 * (q.x * q.z - q.w * q.y);
    }
    /** Distance and stereo pan of a world position (pan fades toward the centre up close, so a blast at your feet is not hard left). */
    spatial(pos) {
        let l = this.listener, dx = pos.x - l.x, dy = pos.y - l.y, dz = pos.z - l.z, d = Math.hypot(dx, dy, dz);
        let pan = d > 0.5 ? (dx * l.rx + dy * l.ry + dz * l.rz) / d * clamp(d / 6, 0, 1) * 0.8 : 0;
        return { distance: d, pan };
    }

    play(name, opts = {}) {
        if(!this.ready || this.muted || !SOUNDS[name]) return;
        try { SOUNDS[name](this.synth, { at: this.ctx.currentTime, ...opts }); } catch(e) { console.warn(`sfx ${name}`, e); }
    }
    /** Start or stop a looping sound; idempotent, so it can be called every frame. */
    loop(name, on) {
        if(on) {
            if(this.loops[name] || !this.ready || this.muted || !SOUNDS[name]) return;
            try { this.loops[name] = SOUNDS[name](this.synth, { at: this.ctx.currentTime }); } catch(e) { console.warn(`sfx ${name}`, e); }
        } else if(this.loops[name]) { try { this.loops[name](this.ctx.currentTime); } catch(e) {} delete this.loops[name]; }
    }

    // ---- game-facing API ----
    /** An explosion `distance` metres away (or at `pos`, which also pans it) of blast radius `radius`. */
    boom(distance, radius = 3, kind = 'rocket', pos = null) { let sp = pos ? this.spatial(pos) : { distance, pan: 0 }; this.play('explosion', { radius, kind, ...sp }); }
    shoot() { this.play('rocket'); }
    /** Somebody else's rocket leaving its launcher at `pos`. */
    rocketFar(pos) { this.play('rocket', this.spatial(pos)); }
    throw(power = 0.6, kind = 'grenade') { this.play('throw', { power, kind }); }
    bounce(kind, impact, pos) { this.play('bounce', { kind, impact, ...this.spatial(pos) }); }
    fuseTick(kind, progress, pos) { let sp = this.spatial(pos); if(sp.distance < 40) this.play('fuse', { kind, progress, ...sp }); }
    drillLoop(on) { this.loop('drillLoop', on); }
    drill() { this.play('bite'); }
    build(dims) { this.play('build', { size: SIZE_OF_SHAPE(dims) }); }
    hook() { this.play('hook'); }
    reel(on) { this.loop('reelLoop', on); }
    unhook() { this.play('unhook'); }
    hurt(damage = 30) { this.play('hurt', { damage }); }
    death() { this.play('death'); }
    respawn() { this.play('respawn'); }
    hit() { this.play('kill'); }
    pickup() { this.play('pickup'); }
    pickupOther(friendly) { this.play('pickupOther', { friendly }); }
    deposit() { this.play('deposit'); }
    bonus() { this.play('bonus'); }
    fanfare() { this.play('roundStart'); }
    roundOver(result) { this.play('roundOver', { result }); }
    votePass() { this.play('votePass'); }
    click() { this.play('click'); }
    beep(near) { this.play('beep', { near }); }
    crystal(count, pos) { let sp = this.spatial(pos); if(sp.distance < 30) this.play('crystal', { count, ...sp }); }
    rubble(count, pos) { this.play('rubble', { count, ...this.spatial(pos) }); }
    land(speed) { this.play('land', { speed }); }
    step() { this.play('step'); }

    /** Debug: render one sound into an OfflineAudioContext and measure it. Channels 0/1 are the final output,
     *  2/3 the signal before the soft clipper (so `prePeak` tells whether the clipper had to work). */
    static async renderOffline(name, seconds = 2, opts = {}) {
        let OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if(!OAC || !SOUNDS[name]) return null;
        let sr = 44100, ctx = new OAC(4, Math.ceil(sr * seconds), sr), bus = createBus(ctx);
        bus.limiter.disconnect();
        let merger = ctx.createChannelMerger(4), s1 = ctx.createChannelSplitter(2), s2 = ctx.createChannelSplitter(2);
        bus.limiter.connect(s1); bus.master.connect(s2);
        s1.connect(merger, 0, 0); s1.connect(merger, 1, 1); s2.connect(merger, 0, 2); s2.connect(merger, 1, 3);
        merger.connect(ctx.destination);
        let synth = new Synth(ctx, bus.fx, bus.reverbSend);
        let stop = SOUNDS[name](synth, { at: 0.02, ...opts });
        if(typeof stop === 'function') stop(Math.max(0.1, seconds * 0.6));
        let buf = await ctx.startRendering();
        return analyse(buf, name, seconds);
    }
    static get sounds() { return Object.keys(SOUNDS); }
}

/** Peak, RMS, audible duration and a spectrum summary of a rendered buffer (see renderOffline). */
export function analyse(buf, name, seconds) {
    let ch = [0, 1, 2, 3].map(i => i < buf.numberOfChannels ? buf.getChannelData(i) : null), n = buf.length, sr = buf.sampleRate;
    let peak = 0, prePeak = 0, sum = 0, last = 0, mono = new Float32Array(n);
    for(let i = 0; i < n; i++) {
        let a = Math.abs(ch[0][i]), b = ch[1] ? Math.abs(ch[1][i]) : 0, v = Math.max(a, b);
        if(v > peak) peak = v; if(v > 0.002) last = i;
        if(ch[2]) { let c = Math.max(Math.abs(ch[2][i]), ch[3] ? Math.abs(ch[3][i]) : 0); if(c > prePeak) prePeak = c; }
        mono[i] = ch[1] ? (ch[0][i] + ch[1][i]) * 0.5 : ch[0][i]; sum += mono[i] * mono[i];
    }
    let active = Math.max(1, last), rms = Math.sqrt(sum / active);
    // spectrum of the loudest 4096-sample window
    let N = 4096, best = 0, bestE = -1;
    for(let i = 0; i + N <= n; i += N / 2) { let e = 0; for(let j = 0; j < N; j += 4) e += mono[i + j] * mono[i + j]; if(e > bestE) { bestE = e; best = i; } }
    let re = new Float64Array(N), im = new Float64Array(N);
    for(let j = 0; j < N; j++) re[j] = (mono[best + j] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * j / N));
    fft(re, im);
    let centroid = 0, total = 0, bands = { low: 0, mid: 0, high: 0 }, domBin = 0, domE = 0;
    for(let k = 1; k < N / 2; k++) {
        let e = re[k] * re[k] + im[k] * im[k], f = k * sr / N;
        centroid += f * e; total += e;
        if(f < 200) bands.low += e; else if(f < 2000) bands.mid += e; else bands.high += e;
        if(e > domE) { domE = e; domBin = k; }
    }
    if(total > 0) { centroid /= total; for(let b in bands) bands[b] = Math.round(bands[b] / total * 100) / 100; }
    let r = (v) => Math.round(v * 1000) / 1000;
    return { name, seconds, peak: r(peak), prePeak: r(prePeak), rms: r(rms), duration: r(last / sr), centroidHz: Math.round(centroid), dominantHz: Math.round(domBin * sr / N), bands, clipped: prePeak > 0.97 };
}

function fft(re, im) {
    let n = re.length;
    for(let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for(; j & bit; bit >>= 1) j ^= bit; j ^= bit; if(i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for(let len = 2; len <= n; len <<= 1) {
        let ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for(let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for(let j = 0; j < len / 2; j++) {
                let ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
                re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
                let t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
}
