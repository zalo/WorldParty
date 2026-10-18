/** Fort War HUD: scores and clock, health, weapon cooldowns, the event feed, death and match-over overlays, hints. */
import { WEAPONS, SUPPLY, MATCH_OVER_MS } from '../game/rules.js';

const FONT = "font-family: 'Segoe UI', system-ui, sans-serif;";
const el = (tag, css, parent = document.body) => { let e = document.createElement(tag); e.style.cssText = css; parent.appendChild(e); return e; };

export class GameHud {
    constructor(game) {
        this.game = game;
        this.main = game.main;
        this.feedItems = [];
        this.flashUntil = 0;
        this.damageUntil = 0;
        this.whiteUntil = 0;
        this.killedBy = '';
        this.helpOpen = false;
        this.lastMatch = null;
        this.matchAt = 0;
        this.build();
    }

    build() {
        let root = this.root = el('div', `position:fixed;inset:0;pointer-events:none;z-index:1800;${FONT}color:#fff;`);
        // top centre: score bar
        this.score = el('div', `position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:12px;align-items:center;background:rgba(0,0,0,0.55);padding:6px 14px;border-radius:8px;font-size:20px;font-weight:bold;`, root);
        this.scoreRed = el('span', 'min-width:34px;text-align:right;', this.score);
        this.clock = el('span', 'font-size:18px;font-weight:normal;opacity:0.9;min-width:60px;text-align:center;', this.score);
        this.scoreBlue = el('span', 'min-width:34px;text-align:left;', this.score);
        this.round = el('div', `position:absolute;top:50px;left:50%;transform:translateX(-50%);font-size:12px;opacity:0.7;`, root);
        // top left: team and health (below the error/info box)
        let left = el('div', 'position:absolute;top:44px;left:10px;', root);
        this.team = el('div', 'font-size:14px;font-weight:bold;text-shadow:0 1px 2px #000;margin-bottom:4px;', left);
        let bar = el('div', 'width:200px;height:14px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.4);border-radius:4px;overflow:hidden;', left);
        this.health = el('div', 'height:100%;width:100%;background:#6c4;transition:width 0.15s;', bar);
        this.stats = el('div', 'font-size:12px;margin-top:4px;text-shadow:0 1px 2px #000;opacity:0.85;', left);
        // bottom centre, above the tool bar: weapon slots
        this.slots = el('div', 'position:absolute;bottom:58px;left:50%;transform:translateX(-50%);display:flex;gap:6px;', root);
        this.slotEls = [];
        // bottom right: carrying, loot sense, hints
        let right = el('div', 'position:absolute;right:10px;bottom:60px;text-align:right;font-size:13px;text-shadow:0 1px 2px #000;', root);
        this.carry = el('div', 'font-size:16px;font-weight:bold;color:#ffc830;', right);
        this.sense = el('div', 'color:#ffc830;opacity:0.9;', right);
        this.hint = el('div', 'max-width:320px;opacity:0.75;margin-top:6px;', right);
        // right: event feed
        this.feed = el('div', 'position:absolute;right:10px;top:70px;width:300px;font-size:13px;text-shadow:0 1px 2px #000;display:flex;flex-direction:column;gap:3px;', root);
        // centre flashes
        this.flash = el('div', 'position:absolute;top:36%;left:50%;transform:translateX(-50%);font-size:18px;font-weight:bold;text-shadow:0 1px 3px #000;opacity:0;transition:opacity 0.3s;white-space:nowrap;', root);
        this.chargeBar = el('div', 'position:absolute;top:54%;left:50%;transform:translateX(-50%);width:120px;height:6px;background:rgba(0,0,0,0.5);border-radius:3px;display:none;', root);
        this.chargeFill = el('div', 'height:100%;width:0;background:#fc3;border-radius:3px;', this.chargeBar);
        this.vignette = el('div', 'position:absolute;inset:0;box-shadow:inset 0 0 120px 40px rgba(255,0,0,0.6);opacity:0;transition:opacity 0.2s;', root);
        this.white = el('div', 'position:absolute;inset:0;background:#fff;opacity:0;', root);
        // death overlay
        this.death = el('div', 'position:absolute;inset:0;background:rgba(40,0,0,0.5);display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;', root);
        this.deathTitle = el('div', 'font-size:34px;font-weight:bold;', this.death);
        this.deathSub = el('div', 'font-size:18px;', this.death);
        this.deathSpec = el('div', 'font-size:14px;opacity:0.8;', this.death);
        this.spectating = '';
        // match overlay
        this.over = el('div', 'position:absolute;inset:0;background:rgba(0,0,0,0.6);display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;', root);
        this.overTitle = el('div', 'font-size:40px;font-weight:bold;', this.over);
        this.overSub = el('div', 'font-size:18px;', this.over);
        this.overAwards = el('div', 'font-size:16px;margin-top:10px;display:flex;flex-direction:column;gap:4px;align-items:center;', this.over);
        // help card (H)
        this.help = el('div', `position:absolute;top:80px;left:50%;transform:translateX(-50%);width:520px;max-width:92vw;background:rgba(10,10,20,0.9);border:1px solid #555;border-radius:10px;padding:14px 18px;font-size:13px;line-height:1.5;display:none;pointer-events:auto;`, root);
        this.help.innerHTML = `<div style="font-size:18px;font-weight:bold;margin-bottom:6px">Fort War</div>
            <div>Storm the enemy fort, grab a <b style="color:#ffc830">supply crate</b> (walk into it) and carry it into your own vault. Most supplies in your vault when the clock runs out wins. Carrying it home underground earns a bonus crate.</div>
            <div style="margin-top:8px"><b>1</b> Rocket launcher &nbsp; <b>2</b> Grenade (hold to charge; right click: bunker buster, one per life) &nbsp; <b>3</b> Drill (hold; aim down to burrow; <b>every dig earns a stone</b>) &nbsp; <b>4</b> Mason (place stone; right click: shape, R: turn, scroll: distance) &nbsp; <b>5</b> Grapple (hook terrain; jump to let go) &nbsp; <b>6</b> PhysGun</div>
            <div style="margin-top:8px">Every wall, floor and bridge is terrain: blast or drill through it, dig under it, or build your own. Unsupported stone falls. Falling rubble and thrown props hurt. A carried crate glows for everyone, and the carrier cannot grapple.</div>
            <div style="margin-top:8px"><b>Enter</b> chat &nbsp; <b>H</b> this card &nbsp; <b>J</b> switch team (if the teams allow it) &nbsp; <b>Q</b> tool menu</div>
            <div style="margin-top:8px;opacity:0.7">Rumour has it loot lies buried beneath the courtyards, under the gorge banks and deep below the bridge.</div>`;
        // chat input
        this.chat = el('input', 'position:absolute;bottom:110px;left:50%;transform:translateX(-50%);width:360px;padding:6px 10px;border:1px solid #666;border-radius:6px;background:rgba(0,0,0,0.7);color:#fff;font-size:14px;display:none;pointer-events:auto;', root);
        this.chat.placeholder = 'say something, Enter to send, Esc to cancel';
    }

    setWeapons(tools) {
        this.slots.innerHTML = ''; this.slotEls = [];
        tools.forEach((tool, i) => {
            let s = el('div', 'position:relative;width:44px;height:44px;border:2px solid #555;border-radius:8px;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden;', this.slots);
            let fill = el('div', 'position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(255,255,255,0.25);', s);
            let icon = el('span', 'position:relative;', s); icon.textContent = tool.icon;
            let key = el('span', 'position:absolute;top:1px;left:4px;font-size:9px;opacity:0.7;', s); key.textContent = String(i + 1);
            this.slotEls.push({ s, fill, tool });
        });
    }

    flashText(text, ms = 1500) { if(!text) return; this.flash.textContent = text; this.flash.style.opacity = '1'; this.flashUntil = performance.now() + ms; }
    damageFlash() { this.vignette.style.opacity = '1'; this.damageUntil = performance.now() + 250; }
    whiteFlash(strength) { this.white.style.opacity = String(Math.min(0.8, strength)); this.whiteUntil = performance.now() + 90; }

    addFeed(text, color = '#fff') {
        let item = el('div', `background:rgba(0,0,0,0.45);padding:3px 8px;border-radius:4px;border-left:3px solid ${color};transition:opacity 1s;`, this.feed);
        item.textContent = text;
        this.feedItems.push({ item, at: performance.now() });
        while(this.feedItems.length > 7) this.feedItems.shift().item.remove();
    }

    openChat() { this.chat.style.display = 'block'; this.chat.value = ''; this.chat.focus(); this.main.player.controls?.unlock(); }
    closeChat() { this.chat.style.display = 'none'; this.chat.blur(); }
    toggleHelp(force) { this.helpOpen = force ?? !this.helpOpen; this.help.style.display = this.helpOpen ? 'block' : 'none'; }

    update() {
        let g = this.game, me = g.me, now = performance.now(), ecs = this.main.ecs;
        if(me) {
            let t = g.config.teams[me.team];
            this.team.textContent = t ? `${t.name} team · ${me.name}` : me.name;
            this.team.style.color = t ? t.color : '#fff';
            let h = Math.max(0, me.health) / 100;
            this.health.style.width = (h * 100).toFixed(0) + '%';
            this.health.style.background = h > 0.5 ? '#6c4' : h > 0.25 ? '#dc3' : '#d33';
            this.stats.textContent = `${Math.ceil(me.health)} hp · ${me.kills} kills · stone ${me.build}/${WEAPONS.mason.budget} · buster ${me.buster}`;
            this.carry.textContent = me.carrying ? '💰 Carrying a supply: take it to your vault!' : '';
        }
        // scores and clock
        let m = ecs.get('match', 'Match');
        if(m) {
            if(m !== this.lastMatch || m.remainingMs !== this.lastRemaining) { this.lastMatch = m; this.lastRemaining = m.remainingMs; this.matchAt = now; }
            let remaining = m.phase === 'live' ? Math.max(0, m.remainingMs - (now - this.matchAt)) : 0;
            let s = Math.ceil(remaining / 1000);
            this.clock.textContent = m.phase === 'live' ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : m.phase === 'over' ? 'ROUND OVER' : 'resetting';
            this.scoreRed.textContent = m.scores.red; this.scoreRed.style.color = g.teamColor('red');
            this.scoreBlue.textContent = m.scores.blue; this.scoreBlue.style.color = g.teamColor('blue');
            this.round.textContent = `round ${m.round} · supplies in each vault`;
            let over = m.phase === 'over' || m.phase === 'resetting';
            this.over.style.display = over ? 'flex' : 'none';
            if(over) {
                let w = m.winner ? g.config.teams[m.winner] : null;
                this.overTitle.textContent = w ? `${w.name} wins the round!` : 'Draw!';
                this.overTitle.style.color = w ? w.color : '#fff';
                this.overSub.textContent = `${m.scores.red} to ${m.scores.blue}. The forts are rebuilt in ${Math.max(0, Math.ceil((MATCH_OVER_MS - (now - (this.overSince ||= now))) / 1000))} s`;
                let awards = (m.awards || []).map(a => `🏅 ${a.title}: ${a.name} (${a.value})`).join('\n');
                if(this.overAwards.textContent !== awards) { this.overAwards.textContent = awards; this.overAwards.style.whiteSpace = 'pre'; }
            } else this.overSince = 0;
        }
        // weapon cooldowns and the grenade charge
        for(let { fill, s, tool } of this.slotEls) {
            fill.style.height = (tool.cooldown ? tool.cooldown() * 100 : 0).toFixed(0) + '%';
            s.style.borderColor = tool === this.main.spawnMenu.getCurrentTool() ? '#ffcc44' : '#555';
        }
        let cur = this.main.spawnMenu.getCurrentTool();
        let charge = cur && cur.charge ? cur.charge() : null;
        this.chargeBar.style.display = charge === null ? 'none' : 'block';
        if(charge !== null) this.chargeFill.style.width = (charge * 100).toFixed(0) + '%';
        // death
        if(me && me.dead) {
            this.death.style.display = 'flex';
            this.deathTitle.textContent = this.killedBy || 'You died';
            let left = Math.max(0, Math.ceil((g.respawnAt - now) / 1000));
            this.deathSub.textContent = left > 0 ? `Respawning in ${left}...` : 'Respawning...';
            this.deathSpec.textContent = this.spectating ? `Watching ${this.spectating}` : '';
            this.death.style.background = this.spectating ? 'rgba(40,0,0,0.15)' : 'rgba(40,0,0,0.5)';
        } else this.death.style.display = 'none';
        // loot sense: nearest neutral supply
        let best = Infinity, bestDy = 0, mine = this.main.player.position;
        for(let [, s, tf] of ecs.each('Supply', 'Transform')) {
            if(s.team || s.state === 'carried') continue;
            let d = Math.hypot(tf.position.x - mine.x, tf.position.y - mine.y, tf.position.z - mine.z);
            if(d < best) { best = d; bestDy = tf.position.y - mine.y; }
        }
        this.sense.textContent = best < SUPPLY.senseRange ? `💰 buried loot ${best.toFixed(0)} m away, ${Math.abs(bestDy).toFixed(0)} m ${bestDy < 0 ? 'below' : 'above'}` : '';
        // fades
        if(this.flashUntil && now > this.flashUntil) { this.flash.style.opacity = '0'; this.flashUntil = 0; }
        if(this.damageUntil && now > this.damageUntil) { this.vignette.style.opacity = '0'; this.damageUntil = 0; }
        if(this.whiteUntil && now > this.whiteUntil) { this.white.style.opacity = '0'; this.whiteUntil = 0; }
        for(let f of this.feedItems) if(now - f.at > 9000) f.item.style.opacity = '0';
        this.feedItems = this.feedItems.filter(f => { if(now - f.at > 10500) { f.item.remove(); return false; } return true; });
        if(!this.hint.textContent && g.config.hints.length) this.rotateHint();
    }

    rotateHint() {
        let hints = this.game.config.hints;
        this.hintIndex = ((this.hintIndex ?? -1) + 1) % hints.length;
        this.hint.textContent = hints[this.hintIndex];
        clearTimeout(this.hintTimer);
        this.hintTimer = setTimeout(() => this.rotateHint(), 14000);
    }
}
