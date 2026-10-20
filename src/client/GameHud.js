/** Fort War HUD: scores and clock, the health bar alone in the top left, weapon slots (the selected one framed; they
 *  are also how a phone switches weapons, and the mason's shows its stone), the event feed, death and match-over
 *  overlays, the treasure finder (how far the nearest neutral supply is and how far above or below), the scoreboard
 *  (hold Tab, or tap the score bar on a phone), and the vote panel (V). The only instruction is "Find the Treasure." */
import { SUPPLY, MATCH_OVER_MS, VOTE } from '../game/rules.js';

// the HUD updates every frame: write only what changed (a same-text write still invalidates layout and paint)
const setText = (el, text) => { text = String(text); if(el.textContent !== text) el.textContent = text; };

const FONT = "font-family: 'Segoe UI', system-ui, sans-serif;";
const el = (tag, css, parent = document.body) => { let e = document.createElement(tag); e.style.cssText = css; parent.appendChild(e); return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
        this.score.style.pointerEvents = 'auto'; this.score.style.cursor = 'pointer'; // a tap shows the scoreboard (phones have no Tab)
        this.score.addEventListener('click', (e) => { e.stopPropagation(); this.toggleBoard(!this.boardOpen); });
        // scoreboard (hold Tab): a column per team, players best first
        this.board = el('div', `position:absolute;top:84px;left:50%;transform:translateX(-50%);display:none;gap:14px;flex-wrap:wrap;justify-content:center;max-width:96vw;`, root);
        this.boardOpen = false; this.boardKey = '';
        this.round = el('div', `position:absolute;top:50px;left:50%;transform:translateX(-50%);font-size:12px;opacity:0.7;`, root);
        // top left: the health bar, nothing else
        let left = el('div', 'position:absolute;top:10px;left:10px;', root);
        let bar = el('div', 'width:200px;height:14px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.4);border-radius:4px;overflow:hidden;', left);
        this.health = el('div', 'height:100%;width:100%;background:#6c4;transition:width 0.15s;', bar);
        // a vote in progress: under the score bar
        this.voteLine = el('div', 'position:absolute;top:68px;left:50%;transform:translateX(-50%);font-size:13px;text-shadow:0 1px 2px #000;color:#fc3;white-space:nowrap;', root);
        // bottom centre: weapon slots (no tool bar under them in a match)
        this.slots = el('div', 'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:6px;', root);
        this.slotEls = [];
        // bottom right: carrying, and the treasure finder (the one instruction when nothing is in range)
        let right = el('div', 'position:absolute;right:10px;bottom:16px;text-align:right;font-size:13px;text-shadow:0 1px 2px #000;', root);
        this.carry = el('div', 'font-size:16px;font-weight:bold;color:#ffc830;', right);
        this.finder = el('div', 'font-size:16px;font-weight:bold;', right);
        // right: event feed
        this.feed = el('div', 'position:absolute;right:10px;top:70px;width:300px;font-size:13px;text-shadow:0 1px 2px #000;display:flex;flex-direction:column;gap:3px;', root);
        // centre flashes
        this.flash = el('div', 'position:absolute;top:36%;left:50%;transform:translateX(-50%);font-size:18px;font-weight:bold;text-shadow:0 1px 3px #000;opacity:0;transition:opacity 0.3s;white-space:nowrap;', root);
        // under the crosshair: what the mason's box measures and costs while one is being drawn
        this.hint = el('div', 'position:absolute;top:calc(50% + 22px);left:50%;transform:translateX(-50%);font-size:13px;font-weight:bold;text-shadow:0 1px 3px #000;white-space:nowrap;', root);
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
            <div>Walk into a crate to carry it and bring it to your vault: every crate there is worth 100 to your team. Every crystal you dig or blast out of the ground is worth 1. Most at the end wins. Bottom right says how far the nearest treasure is, and how far above or below you.</div>
            <div style="margin-top:8px;opacity:0.8"><b>Tab</b> scores &nbsp; <b>1-4</b> or <b>scroll</b> tools &nbsp; <b>right click</b> grapple &nbsp; <b>F</b> mason wall/floor, physgun freeze &nbsp; <b>R</b> drop the mason's corner &nbsp; <b>V</b> vote &nbsp; <b>J</b> switch team &nbsp; <b>M</b> mute &nbsp; <b>Enter</b> chat &nbsp; <b>H</b> this card</div>`;
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
            let count = tool.kind === 'mason' ? el('span', 'position:absolute;bottom:1px;right:4px;font-size:11px;font-weight:bold;text-shadow:0 1px 2px #000;', s) : null;
            // the slots switch weapons when tapped or clicked (a phone has no number keys, and no tool button any more)
            s.style.pointerEvents = 'auto'; s.style.cursor = 'pointer';
            let pick = (e) => { e.preventDefault(); e.stopPropagation(); this.main.spawnMenu.selectTool(i); };
            s.addEventListener('touchstart', pick, { passive: false }); s.addEventListener('mousedown', pick);
            this.slotEls.push({ s, fill, tool, count });
        });
    }

    setHint(text) { setText(this.hint, text); }
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
    toggleBoard(on) { this.boardOpen = on; this.board.style.display = on ? 'flex' : 'none'; if(on) this.renderBoard(); }
    /** The scoreboard's content, rebuilt only when something on it changed (names come from players: escaped). */
    renderBoard() {
        let g = this.game, ecs = this.main.ecs, m = ecs.get('match', 'Match'), myId = this.main.conn.id;
        let players = [...ecs.each('Player')].filter(([, p]) => p.team);
        let key = JSON.stringify([m?.scores, players.map(([id, p]) => [id, p.name, p.team, p.score, p.crystals, p.carries, p.kills, p.deaths, p.dead, !!p.carrying])]);
        if(key === this.boardKey) return;
        this.boardKey = key;
        let cell = 'padding:3px 7px;text-align:right;';
        let html = '';
        for(let team of ['red', 'blue']) {
            let t = g.config.teams[team], rows = players.filter(([, p]) => p.team === team).sort((a, b) => b[1].score - a[1].score || b[1].kills - a[1].kills);
            html += `<div style="min-width:300px;background:rgba(10,10,20,0.88);border:1px solid #555;border-top:3px solid ${t.color};border-radius:10px;padding:10px 12px;">`
                + `<div style="display:flex;justify-content:space-between;font-size:18px;font-weight:bold;color:${t.color};margin-bottom:6px;"><span>${esc(t.name)}</span><span>${m?.scores?.[team] ?? 0}</span></div>`
                + `<table style="border-collapse:collapse;font-size:13px;width:100%;"><tr style="opacity:0.6;font-size:11px;"><td style="padding:3px 7px;">player</td><td style="${cell}" title="units">units</td><td style="${cell}" title="crystals">💎</td><td style="${cell}" title="crates brought home">📦</td><td style="${cell}" title="kills">K</td><td style="${cell}" title="deaths">D</td></tr>`;
            for(let [id, p] of rows) {
                let me = id === myId, style = (me ? 'background:rgba(255,255,255,0.12);font-weight:bold;' : '') + (p.dead ? 'opacity:0.45;' : '');
                html += `<tr style="${style}"><td style="padding:3px 7px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.carrying ? '💰 ' : ''}${esc(p.name)}</td><td style="${cell}">${p.score}</td><td style="${cell}">${p.crystals || 0}</td><td style="${cell}">${p.carries}</td><td style="${cell}">${p.kills}</td><td style="${cell}">${p.deaths}</td></tr>`;
            }
            if(!rows.length) html += `<tr><td colspan="6" style="padding:6px 7px;opacity:0.5;">nobody yet</td></tr>`;
            html += '</table></div>';
        }
        this.board.innerHTML = html;
    }
    toggleHelp(force) { this.helpOpen = force ?? !this.helpOpen; this.help.style.display = this.helpOpen ? 'block' : 'none'; }
    toggleVote(force) { this.voteOpen = force ?? !this.voteOpen; this.votePanel.style.display = this.voteOpen ? 'flex' : 'none'; if(this.voteOpen) this.main.player.controls?.unlock(); }

    update() {
        let g = this.game, me = g.me, now = performance.now(), ecs = this.main.ecs;
        if(me) {
            let h = Math.max(0, me.health) / 100;
            this.health.style.width = (h * 100).toFixed(0) + '%';
            this.health.style.background = h > 0.5 ? '#6c4' : h > 0.25 ? '#dc3' : '#d33';
            setText(this.carry, me.carrying ? '💰 Carrying treasure: take it to your vault! (100)' : '');
            for(let { count } of this.slotEls) if(count) setText(count, Math.floor(me.build + 1e-6));
        }
        // scores and clock
        let m = ecs.get('match', 'Match');
        if(m) {
            if(m !== this.lastMatch || m.remainingMs !== this.lastRemaining) { this.lastMatch = m; this.lastRemaining = m.remainingMs; this.matchAt = now; }
            let remaining = m.phase === 'live' ? Math.max(0, m.remainingMs - (now - this.matchAt)) : 0;
            let s = Math.ceil(remaining / 1000);
            setText(this.clock, m.phase === 'live' ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : m.phase === 'over' ? 'ROUND OVER' : 'resetting');
            setText(this.scoreRed, m.scores.red); this.scoreRed.style.color = g.teamColor('red');
            setText(this.scoreBlue, m.scores.blue); this.scoreBlue.style.color = g.teamColor('blue');
            setText(this.round, `round ${m.round}`);
            let v = m.vote;
            setText(this.voteLine, v ? `Vote: ${VOTE.actions[v.action] || v.action} ${v.count}/${v.needed} · press V` : '');
            let over = m.phase === 'over' || m.phase === 'resetting';
            this.over.style.display = over ? 'flex' : 'none';
            if(over) {
                let w = m.winner ? g.config.teams[m.winner] : null;
                this.overTitle.textContent = w ? `${w.name} wins the round!` : 'Draw!';
                this.overTitle.style.color = w ? w.color : '#fff';
                this.overSub.textContent = `${m.scores.red} to ${m.scores.blue}. The forts are rebuilt in ${Math.max(0, Math.ceil((MATCH_OVER_MS - (now - (this.overSince ||= now))) / 1000))} s`;
                // what each player brought in (Player.score: units), best first, then the awards
                let earners = [...ecs.each('Player')].filter(([, p]) => p.team && p.score > 0).sort((a, b) => b[1].score - a[1].score).slice(0, 6)
                    .map(([, p]) => `${p.name}: ${p.score}${p.crystals ? ` (${p.crystals} 💎)` : ''}`);
                let awards = [...(earners.length ? [earners.join(' · ')] : []), ...(m.awards || []).map(a => `🏅 ${a.title}: ${a.name} (${a.value})`)].join('\n');
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
        // the treasure finder: the nearest neutral supply (buried ones included: that is what the drill is for), how far
        // and how far above or below the eye, within senseRange; else the instruction (nothing while carrying or dead)
        let best = Infinity, dy = 0, mine = this.main.world.camera.position;
        for(let [, s, tf] of ecs.each('Supply', 'Transform')) {
            if(s.team || s.state === 'carried') continue;
            let d = Math.hypot(tf.position.x - mine.x, tf.position.y - mine.y, tf.position.z - mine.z);
            if(d < best) { best = d; dy = tf.position.y - mine.y; }
        }
        let finder = '';
        if(me && !me.dead && !me.carrying) {
            let level = Math.abs(dy) < 1 ? 'level with you' : `${Math.abs(dy).toFixed(0)} m ${dy < 0 ? 'below' : 'above'}`;
            finder = best < SUPPLY.senseRange ? `💰 Treasure ${best.toFixed(0)} m away, ${level}` : 'Find the Treasure.';
        }
        setText(this.finder, finder);
        if(this.boardOpen && now - (this.boardAt || 0) > 250) { this.boardAt = now; this.renderBoard(); }
        // fades
        if(this.flashUntil && now > this.flashUntil) { this.flash.style.opacity = '0'; this.flashUntil = 0; }
        if(this.damageUntil && now > this.damageUntil) { this.vignette.style.opacity = '0'; this.damageUntil = 0; }
        if(this.whiteUntil && now > this.whiteUntil) { this.white.style.opacity = '0'; this.whiteUntil = 0; }
        for(let f of this.feedItems) if(now - f.at > 9000) f.item.style.opacity = '0';
        this.feedItems = this.feedItems.filter(f => { if(now - f.at > 10500) { f.item.remove(); return false; } return true; });
    }
}
