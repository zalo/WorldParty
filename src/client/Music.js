/** Undermine's score: generated live, never quite the same twice, in the key of the effects (Sfx.js: D Mixolydian).
 *  An adventure-game siege: cheerful bells over a slow modal pad, a soft pulse underneath, more drums and a melody
 *  when something is at stake.
 *
 *  Structure: 92 BPM, 4/4 (a bar is 2.6 s). Chords walk a weighted graph of the diatonic triads (D, C, G, Am, Bm,
 *  Em; D opens every 8-bar phrase; a chord lasts one bar, or two with 35 % probability). Layers, each on its own
 *  GainNode so the game state can crossfade them:
 *   - pad: four voices (root, third, fifth, octave, voiced between A2 and G4) of two detuned saws through a slowly
 *     wobbling lowpass, gliding between chords. Always on.
 *   - arp: bells (Synth.bell) on eighth notes from a rhythm template re-rolled every 4 bars, cycling the chord tones
 *     up and down in octave 5 (sometimes 6) with passing tones; density follows intensity.
 *   - drums: soft kick on 1 and 3, shaker on eighths, a snare on 2 and 4 from intensity 0.3 up, a low war-drum
 *     gallop while carrying treasure or in the last minute, a fill every eighth bar.
 *   - lead: a vibrato saw melody (random walk on the scale, a chord tone on every downbeat) while carrying treasure
 *     or when the clock is under a minute.
 *   - tick: a woodblock on every beat in the last minute.
 *  setState({ intensity 0..1, carrying, urgent, dead, over }) maps to layer targets (dead: everything to 30 % behind
 *  a 600 Hz lowpass; over: the pad and a little arp); gains follow with setTargetAtTime over about three seconds.
 *  Scheduling: a 100 ms timer schedules every event up to half a second ahead on the audio clock (scheduleUntil),
 *  so a slow frame never drops a note; the same function drives Music.renderOffline for testing. The bus sits at
 *  0.2 (-14 dB against the effects; `undermine.music` in localStorage overrides it, ?music=0 keeps it off) so a
 *  Discord call stays intelligible over it. */
import { Synth, midiHz, degreeMidi, createBus, analyse } from './Sfx.js';

const BPM = 92, BEAT = 60 / BPM, LOOKAHEAD = 0.5, TIMER_MS = 100;
const ROOTS = { D: 0, Em: 1, G: 3, Am: 4, Bm: 5, C: 6 };
const NEXT = {
    D: [['C', 3], ['G', 3], ['Am', 1.5], ['Bm', 1.5], ['Em', 1]],
    C: [['D', 5], ['G', 3], ['Am', 2]],
    G: [['D', 4.5], ['C', 2.5], ['Am', 1.5], ['Em', 1.5]],
    Am: [['D', 4], ['G', 3], ['C', 3]],
    Bm: [['G', 4], ['Am', 3], ['D', 3]],
    Em: [['D', 4], ['Am', 3], ['C', 3]],
};
const ARP_PATTERNS = [[1, 0, 1, 1, 0, 1, 1, 0], [1, 1, 0, 1, 0, 1, 0, 1], [1, 0, 1, 0, 1, 0, 1, 0], [1, 1, 1, 0, 1, 1, 0, 1], [1, 0, 0, 1, 0, 0, 1, 0]];
const ARP_SEQ = [0, 2, 4, 7, 4, 2];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (weighted) => { let total = weighted.reduce((s, w) => s + w[1], 0), r = Math.random() * total; for(let [v, w] of weighted) { r -= w; if(r <= 0) return v; } return weighted[weighted.length - 1][0]; };

export class Music {
    constructor(sfx) {
        this.sfx = sfx; this.ctx = null; this.started = false; this.timer = null;
        this.state = { intensity: 0.3, carrying: false, urgent: false, dead: false, over: false };
        this.targets = null; this.lastKey = '';
        let saved = NaN; try { saved = parseFloat(localStorage.getItem('undermine.music')); } catch(e) {}
        this.volume = Number.isFinite(saved) ? clamp(saved, 0, 1) : 0.2;
        this.notes = 0; this.bars = 0; this.beatIndex = 0; this.nextBeat = 0;
        this.chord = 'D'; this.chordBarsLeft = 0; this.chordRoot = 0; this.pattern = ARP_PATTERNS[0]; this.arpStep = 0; this.arpOct = 1; this.leadDeg = 14;
    }

    /** Called once the Sfx context runs (Sfx.onReady). */
    start() {
        if(this.started || !this.sfx?.ready) return;
        try {
            this.attach(this.sfx.ctx, this.sfx.master, this.sfx.reverbSend);
            this.nextBeat = this.ctx.currentTime + 0.15;
            this.timer = setInterval(() => {
                try {
                    if(this.sfx.muted) { this.nextBeat = Math.max(this.nextBeat, this.ctx.currentTime + 0.1); return; } // nothing to hear: skip ahead, no backlog
                    this.scheduleUntil(this.ctx.currentTime + LOOKAHEAD);
                } catch(e) { console.warn('music', e); }
            }, TIMER_MS);
            this.started = true;
            this.applyState(true);
        } catch(e) { console.warn('music unavailable', e); }
    }
    stop() {
        if(this.timer) clearInterval(this.timer); this.timer = null;
        if(this.padVoices) for(let v of this.padVoices) { for(let o of v.oscs) o.stop(); v.lfo.stop(); }
        if(this.bus) this.bus.disconnect();
        this.started = false;
    }
    setVolume(v) { this.volume = clamp(v, 0, 1); try { localStorage.setItem('undermine.music', String(this.volume)); } catch(e) {} if(this.bus) this.bus.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1); }

    /** Build the layer buses and the pad voices on a context (live or offline). */
    attach(ctx, dest, reverbSend) {
        this.ctx = ctx;
        this.bus = ctx.createGain(); this.bus.gain.value = this.volume;
        this.tilt = ctx.createBiquadFilter(); this.tilt.type = 'lowpass'; this.tilt.frequency.value = 18000; this.tilt.Q.value = 0.3;
        this.tilt.connect(this.bus); this.bus.connect(dest);
        if(reverbSend) { let send = ctx.createGain(); send.gain.value = 0.3; this.bus.connect(send); send.connect(reverbSend); }
        this.layers = {}; this.synths = {};
        for(let name of ['pad', 'arp', 'drums', 'lead', 'tick']) {
            let g = ctx.createGain(); g.gain.value = 0; g.connect(this.tilt);
            this.layers[name] = g; this.synths[name] = new Synth(ctx, g);
        }
        this.padVoices = [];
        for(let i = 0; i < 4; i++) {
            let lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.8;
            let g = ctx.createGain(); g.gain.value = i === 3 ? 0.05 : 0.08; lp.connect(g); g.connect(this.layers.pad);
            let oscs = [-6, 6].map(d => { let o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = d; o.frequency.value = midiHz(50); o.connect(lp); o.start(); return o; });
            let lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + i * 0.013; let lg = ctx.createGain(); lg.gain.value = 260; lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
            this.padVoices.push({ oscs, lp, g, lfo });
        }
        this.setChord('D', ctx.currentTime);
    }

    setState(s, immediate = false) { Object.assign(this.state, s); this.applyState(immediate); }
    /** Map the state to layer gains; only touches the graph when a target actually changed (the caller runs every frame). */
    applyState(immediate = false) {
        let st = this.state, I = Math.round(clamp(st.intensity, 0, 1) * 20) / 20, base = st.dead ? 0.3 : 1;
        let tg = {
            pad: base * (st.over ? 0.9 : 1),
            arp: base * (st.over ? 0.35 : 0.5 + 0.5 * I),
            drums: st.over ? 0 : base * clamp(0.3 + 0.7 * I + (st.carrying ? 0.2 : 0) + (st.urgent ? 0.3 : 0), 0, 1),
            lead: st.over || st.dead ? 0 : clamp((st.carrying ? 0.75 : 0) + (st.urgent ? 0.45 : 0), 0, 0.9),
            tick: st.over || st.dead ? 0 : st.urgent ? 0.8 : 0,
        };
        let key = `${tg.pad}|${tg.arp}|${tg.drums}|${tg.lead}|${tg.tick}|${st.dead}`;
        this.targets = tg;
        if(key === this.lastKey || !this.ctx) { this.lastKey = key; return; }
        this.lastKey = key;
        let now = this.ctx.currentTime;
        for(let [name, g] of Object.entries(this.layers)) {
            if(immediate) g.gain.value = tg[name];
            else g.gain.setTargetAtTime(tg[name], now, tg[name] > g.gain.value ? 0.8 : 1.2);
        }
        let lp = st.dead ? 600 : 18000;
        if(immediate) this.tilt.frequency.value = lp; else this.tilt.frequency.setTargetAtTime(lp, now, 0.6);
    }

    /** Schedule every beat up to time t (audio clock). */
    scheduleUntil(t) {
        let guard = 0;
        while(this.nextBeat < t && guard++ < 64) { this.beat(this.nextBeat, this.beatIndex++); this.nextBeat += BEAT; }
    }

    setChord(name, at) {
        let root = ROOTS[name];
        let tones = [degreeMidi(root, -1), degreeMidi(root + 2, -1), degreeMidi(root + 4, -1), degreeMidi(root, 0)];
        if(tones[0] > 56) tones = tones.map(m => m - 12); // keep the pad between A2 and G4
        this.chord = name; this.chordRoot = root;
        this.padVoices.forEach((v, i) => { for(let o of v.oscs) o.frequency.setTargetAtTime(midiHz(tones[i]), at, 0.25); });
    }
    newBar(bar, at) {
        this.bars++;
        if(--this.chordBarsLeft <= 0) {
            let next = bar % 8 === 0 ? 'D' : pick(NEXT[this.chord]);
            this.chordBarsLeft = Math.random() < 0.35 ? 2 : 1;
            this.setChord(next, at);
        }
        if(bar % 4 === 0) { this.pattern = ARP_PATTERNS[Math.floor(Math.random() * ARP_PATTERNS.length)]; this.arpOct = Math.random() < 0.25 ? 2 : 1; }
    }

    beat(at, i) {
        let b = i % 4, bar = Math.floor(i / 4), st = this.state, I = clamp(st.intensity, 0, 1), tg = this.targets || {};
        if(b === 0) this.newBar(bar, at);
        if(tg.drums > 0.02) {
            let vel = 0.6 + 0.4 * I, d = this.synths.drums;
            if(b === 0 || b === 2) d.kick(at, { gain: 0.5 * vel, freq: 120 });
            if((b === 1 || b === 3) && I > 0.5 && Math.random() < 0.35) d.kick(at + BEAT * 0.5, { gain: 0.3 * vel, freq: 120 });
            if((b === 1 || b === 3) && I > 0.3) this.snare(at, 0.28 * vel);
            for(let k = 0; k < 2; k++) this.hat(at + k * BEAT / 2, (k ? 0.07 : 0.11) * rnd(0.7, 1.1) * (0.5 + 0.5 * I));
            if(I > 0.7) for(let k of [1, 3]) this.hat(at + k * BEAT / 4, 0.04 * rnd(0.6, 1));
            if(st.carrying || st.urgent) { if(b === 0) this.tom(at, 0.4); if(b === 2) { this.tom(at, 0.36); this.tom(at + BEAT * 0.5, 0.26); this.tom(at + BEAT * 0.75, 0.26); } }
            if(bar % 8 === 7 && b === 3) for(let k = 0; k < 4; k++) this.snare(at + k * BEAT / 4, 0.12 + 0.07 * k);
        }
        if(tg.arp > 0.02) for(let k = 0; k < 2; k++) {
            let slot = b * 2 + k;
            if(!this.pattern[slot]) continue;
            if(slot !== 0 && Math.random() > 0.5 + 0.5 * I) continue;
            this.arpNote(at + k * BEAT / 2, slot % 4 === 0 ? 1 : rnd(0.5, 0.8));
        }
        if(tg.lead > 0.02) { this.leadNote(at, b); if(I > 0.5 && Math.random() < 0.3) this.leadNote(at + BEAT / 2, -1); }
        if(tg.tick > 0.02) this.tick(at, b === 0 ? 1 : 0.7);
    }

    arpNote(at, vel) {
        let deg = this.chordRoot + ARP_SEQ[this.arpStep++ % ARP_SEQ.length];
        if(Math.random() < 0.18) deg += Math.random() < 0.5 ? 1 : -1; // a passing tone
        let m = degreeMidi(deg, this.arpOct); if(m > 93) m -= 12;
        this.synths.arp.bell(at, midiHz(m), { dur: 0.6, gain: 0.15 * vel, bright: 0.8 });
        this.notes++;
    }
    leadNote(at, b) {
        if(b !== 0 && Math.random() < 0.22) return; // rests
        let deg = this.leadDeg + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)];
        if(b === 0) { // the downbeat lands on the nearest chord tone
            let best = deg, bestD = 99;
            for(let t of [0, 2, 4]) for(let o = 7; o <= 21; o += 7) { let c = this.chordRoot + t + o, dd = Math.abs(c - deg); if(dd < bestD) { bestD = dd; best = c; } }
            deg = best;
        }
        deg = clamp(deg, 7, 20); this.leadDeg = deg;
        this.lead(at, midiHz(degreeMidi(deg, 0)), BEAT * 0.9, 0.1 * (b === 0 ? 1 : 0.8));
        this.notes++;
    }
    lead(at, freq, dur, gain) {
        let ctx = this.ctx, out = this.layers.lead, s = this.synths.lead;
        let o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
        let vib = ctx.createOscillator(); vib.frequency.value = 5.5; let vg = ctx.createGain(); vg.gain.value = 9; vib.connect(vg); vg.connect(o.detune);
        let f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1600; f.Q.value = 1;
        let g = s.env(at, gain, 0.04, dur * 0.5, dur * 0.5, out);
        o.connect(f); f.connect(g);
        o.start(at); vib.start(at); o.stop(at + dur + 0.1); vib.stop(at + dur + 0.1);
    }
    snare(at, gain) { let d = this.synths.drums; d.noise(at, { dur: 0.14, gain, type: 'bandpass', freq: 1800, q: 0.8, attack: 0.001 }); d.tone(at, 190, { dur: 0.1, gain: gain * 0.6, freqEnd: 120 }); }
    hat(at, gain) { this.synths.drums.noise(at, { dur: 0.045, gain, type: 'highpass', freq: 6000, attack: 0.001 }); }
    tom(at, gain) { let d = this.synths.drums; d.tone(at, 95, { dur: 0.3, gain, freqEnd: 60 }); d.noise(at, { dur: 0.08, gain: gain * 0.4, type: 'lowpass', freq: 600, attack: 0.001 }); }
    tick(at, vel) { let s = this.synths.tick; s.noise(at, { dur: 0.02, gain: 0.32 * vel, type: 'bandpass', freq: 2400, q: 6, attack: 0.001 }); s.tone(at, 1050, { dur: 0.025, gain: 0.18 * vel, type: 'triangle' }); }

    /** Debug: render `seconds` of music in a given state offline and measure it (see Sfx.analyse). */
    static async renderOffline(seconds = 10, state = {}) {
        let OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if(!OAC) return null;
        let sr = 44100, ctx = new OAC(2, Math.ceil(sr * seconds), sr), bus = createBus(ctx);
        let m = new Music(null);
        m.attach(ctx, bus.master, bus.reverbSend);
        m.setState({ intensity: 0.5, ...state }, true);
        m.nextBeat = 0.05;
        m.scheduleUntil(seconds);
        let buf = await ctx.startRendering();
        return { ...analyse(buf, 'music', seconds), notes: m.notes, bars: m.bars, chord: m.chord, state: { ...m.state } };
    }
}
