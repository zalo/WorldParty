/** Fort War HUD: scores and clock, health, weapon cooldowns, the event feed, death and match-over overlays, the
 *  treasure light (blinks and beeps faster, and warms from blue to red, the closer the nearest neutral supply),
 *  and the vote panel (V). The only instruction is "Find the Treasure." */
import { WEAPONS, SUPPLY, MATCH_OVER_MS, VOTE } from '../game/rules.js';

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
        this.sound = el('div', 'font-size:11px;margin-top:2px;text-shadow:0 1px 2px #000;opacity:0.55;', left); // 🔊 / 🔇, M toggles
        this.voteLine = el('div', 'font-size:13px;margin-top:8px;text-shadow:0 1px 2px #000;color:#fc3;', left);
        // bottom centre, above the tool bar: weapon slots
        this.slots = el('div', 'position:absolute;bottom:58px;left:50%;transform:translateX(-50%);display:flex;gap:6px;', root);
        this.slotEls = [];
        // bottom right: carrying, and the one instruction with the treasure light
        let right = el('div', 'position:absolute;right:10px;bottom:60px;text-align:right;font-size:13px;text-shadow:0 1px 2px #000;', root);
        this.carry = el('div', 'font-size:16px;font-weight:bold;color:#ffc830;', right);
        let task = el('div', 'display:flex;align-items:center;justify-content:flex-end;gap:10px;font-size:18px;font-weight:bold;', right);
        task.appendChild(document.createTextNode('Find the Treasure.'));
        this.light = el('div', 'width:16px;height:16px;border-radius:50%;background:#334;box-shadow:0 0 4px #000;transition:background 0.25s;', task);
        this.lightOn = 0; this.nextBeep = 0;
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
        this.help.innerHTML = `<div style="font-size:22px;font-weight:bold;margin-bottom:2px">Undermine</div><div style="font-size:16px;font-weight:bold;margin-bottom:6px">Find the Treasure.</div>
            <div>Walk into a crate to carry it. Bring it to your vault. The light beeps when treasure is near.</div>
            <div style="margin-top:8px;opacity:0.8"><b>1-6</b> or <b>scroll</b> weapons &nbsp; <b>Shift+scroll</b> mason distance &nbsp; <b>V</b> vote &nbsp; <b>J</b> switch team &nbsp; <b>M</b> mute &nbsp; <b>Enter</b> chat &nbsp; <b>H</b> this card</div>`;
        // vote panel (V)
        this.votePanel = el('div', `position:absolute;top:80px;left:50%;transform:translateX(-50%);background:rgba(10,10,20,0.9);border:1px solid #555;border-radius:10px;padding:12px 16px;font-size:14px;display:none;pointer-events:auto;flex-direction:column;gap:8px;`, root);
        let title = el('div', 'font-weight:bold;font-size:16px;', this.votePanel); title.textContent = 'Call a vote';
        for(let action in VOTE.actions) {
            let b = el('button', 'padding:8px 14px;border:1px solid #666;border-radius:6px;background:rgba(60,60,80,0.9);color:#fff;font-size:14px;cursor:pointer;text-align:left;', this.votePanel);
            b.textContent = VOTE.actions[action];
            b.addEventListener('click', () => { this.game.vote(action); this.toggleVote(false); });
        }
        let note = el('div', 'font-size:12px;opacity:0.7;', this.votePanel); note.textContent = 'A majority of the players present passes it; alone, it just happens.';
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
    toggleVote(force) { this.voteOpen = force ?? !this.voteOpen; this.votePanel.style.display = this.voteOpen ? 'flex' : 'none'; if(this.voteOpen) this.main.player.controls?.unlock(); }

    update() {
        let g = this.game, me = g.me, now = performance.now(), ecs = this.main.ecs;
        if(me) {
            let t = g.config.teams[me.team];
            this.team.textContent = t ? `${t.name} team · ${me.name}` : me.name;
            this.team.style.color = t ? t.color : '#fff';
            let h = Math.max(0, me.health) / 100;
            this.health.style.width = (h * 100).toFixed(0) + '%';
            this.health.style.background = h > 0.5 ? '#6c4' : h > 0.25 ? '#dc3' : '#d33';
            this.stats.textContent = `stone ${me.build}/${WEAPONS.mason.budget}`;
            let sound = g.sfx.muted ? '🔇 M' : '🔊 M';
            if(this.sound.textContent !== sound) this.sound.textContent = sound;
            this.carry.textContent = me.carrying ? '💰 Carrying treasure: take it to your vault!' : '';
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
            this.round.textContent = `round ${m.round}`;
            let v = m.vote;
            this.voteLine.textContent = v ? `Vote: ${VOTE.actions[v.action] || v.action} ${v.count}/${v.needed} · press V` : '';
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
        // the treasure light: nearest neutral supply (buried ones included: that is what the drill is for)
        let best = Infinity, mine = this.main.player.position;
        for(let [, s, tf] of ecs.each('Supply', 'Transform')) {
            if(s.team || s.state === 'carried') continue;
            let d = Math.hypot(tf.position.x - mine.x, tf.position.y - mine.y, tf.position.z - mine.z);
            if(d < best) best = d;
        }
        let near = best < SUPPLY.senseRange && me && !me.dead && !me.carrying ? Math.max(0, Math.min(1, 1 - best / SUPPLY.senseRange)) : 0;
        if(near > 0) {
            let period = 1800 - 1600 * near * near; // slow blue blink far away, a fast red flutter on top of it
            if(now >= this.nextBeep) { this.nextBeep = now + period; this.lightOn = now; this.game.sfx.beep(near); }
            let on = now - this.lightOn < Math.min(140, period * 0.5);
            let hue = 215 - 215 * near, l = on ? 65 : 28;
            this.light.style.background = `hsl(${hue.toFixed(0)},90%,${l}%)`;
            this.light.style.boxShadow = on ? `0 0 ${(6 + near * 14).toFixed(0)}px hsl(${hue.toFixed(0)},90%,60%)` : '0 0 4px #000';
        } else if(this.light.style.background !== 'rgb(51, 51, 68)') { this.light.style.background = '#334'; this.light.style.boxShadow = '0 0 4px #000'; this.nextBeep = 0; }
        // fades
        if(this.flashUntil && now > this.flashUntil) { this.flash.style.opacity = '0'; this.flashUntil = 0; }
        if(this.damageUntil && now > this.damageUntil) { this.vignette.style.opacity = '0'; this.damageUntil = 0; }
        if(this.whiteUntil && now > this.whiteUntil) { this.white.style.opacity = '0'; this.whiteUntil = 0; }
        for(let f of this.feedItems) if(now - f.at > 9000) f.item.style.opacity = '0';
        this.feedItems = this.feedItems.filter(f => { if(now - f.at > 10500) { f.item.remove(); return false; } return true; });
    }
}
