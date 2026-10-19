/** Undermine's music: "Gold Rush Heist" (assets/music/gold-rush-heist.mp3, 2:27, made with Suno), looped under the
 *  game. Same interface as Music.js's generated score (start once the Sfx context runs, setState every frame,
 *  setVolume, stop), which `?music=score` brings back.
 *
 *  An <audio> element streams it into the effects' master bus, so mute (M) and the soft clipper apply; decoding the
 *  whole track into an AudioBuffer would hold ~56 MB of samples, too much for a phone. It plays low enough that a
 *  voice call stays clear over it: the bus at 0.14 (-17 dB) puts the mastered track (-15.9 LUFS) near -35 dB RMS, a
 *  little under the score at its default (-33), and a 4 dB dip around 2.5 kHz leaves room in the band speech is
 *  understood by. It fades in over a couple of seconds; while dead it drops to half behind a 600 Hz lowpass, as the
 *  score does; it pauses while the page is hidden. `undermine.music` in localStorage overrides the level. */
const TRACK = 'assets/music/gold-rush-heist.mp3'; // relative, so it stays same origin inside Discord's proxy too
const LEVEL = 0.14;
const GESTURES = ['pointerdown', 'keydown', 'touchstart'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class MusicTrack {
    constructor(sfx, url = TRACK) {
        this.sfx = sfx; this.url = url; this.started = false; this.dead = false;
        let saved = NaN; try { saved = parseFloat(localStorage.getItem('undermine.music')); } catch(e) {}
        this.volume = Number.isFinite(saved) ? clamp(saved, 0, 1) : LEVEL;
        this.onVisibility = () => { if(!this.audio) return; if(document.hidden) this.audio.pause(); else this.play(); };
    }

    /** Called once the Sfx context runs (Sfx.onReady). */
    start() {
        if(this.started || !this.sfx?.ready) return;
        try {
            let ctx = this.ctx = this.sfx.ctx;
            this.audio = new Audio(this.url);
            this.audio.loop = true;
            this.dip = ctx.createBiquadFilter(); this.dip.type = 'peaking'; this.dip.frequency.value = 2500; this.dip.Q.value = 0.7; this.dip.gain.value = -4;
            this.lowpass = ctx.createBiquadFilter(); this.lowpass.type = 'lowpass'; this.lowpass.frequency.value = 18000; this.lowpass.Q.value = 0.3;
            this.bus = ctx.createGain(); this.bus.gain.value = 0;
            ctx.createMediaElementSource(this.audio).connect(this.dip);
            this.dip.connect(this.lowpass); this.lowpass.connect(this.bus); this.bus.connect(this.sfx.master);
            document.addEventListener('visibilitychange', this.onVisibility);
            this.started = true;
            if(!document.hidden) this.play();
        } catch(e) { console.warn('music unavailable', e); }
    }
    /** Safari and iOS can refuse play() outside a gesture (Sfx starts us after its context resumes): then the next
     *  gesture tries again. */
    play() {
        this.audio.play()?.then(() => this.apply(), (e) => {
            if(e?.name !== 'NotAllowedError') return console.warn('music', e);
            let retry = () => { for(let ev of GESTURES) window.removeEventListener(ev, retry); if(this.started && !document.hidden) this.play(); };
            for(let ev of GESTURES) window.addEventListener(ev, retry, { passive: true });
        });
    }
    stop() {
        if(!this.started) return;
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.audio.pause(); this.bus.disconnect();
        this.started = false;
    }
    setVolume(v) { this.volume = clamp(v, 0, 1); try { localStorage.setItem('undermine.music', String(this.volume)); } catch(e) {} this.apply(); }
    /** The game's state (GameClient, every frame); only death changes anything here. */
    setState(s) { let dead = !!s.dead; if(dead !== this.dead) { this.dead = dead; this.apply(); } }
    apply() {
        if(!this.bus) return;
        let t = this.ctx.currentTime;
        this.bus.gain.setTargetAtTime(this.volume * (this.dead ? 0.5 : 1), t, 0.8);
        this.lowpass.frequency.setTargetAtTime(this.dead ? 600 : 18000, t, 0.6);
    }
}
