/** Fort War on the client: created by Main when a room's world config carries `game`. Arms the player with the
 *  weapon tools, adds the game render systems, owns the HUD and sound, and handles the game messages (spawns,
 *  hits, explosions, events). The server owns every rule; this only shows and asks. */
import * as THREE from 'three/webgpu';
import { RocketTool, GrenadeTool, DrillTool, MasonTool, GrappleTool } from '../tools/weapons.js';
import { PhysGunTool } from '../tools/PhysGunTool.js';
import { GameHud } from './GameHud.js';
import { Sfx } from './Sfx.js';
import { Music } from './Music.js';
import { ProjectileRenderSystem, SupplyRenderSystem, FuseFxSystem, GlowRockRenderSystem, GlowSparkFx, ExplosionFx, teamColorOf } from './gameSystems.js';
import { GlowLighting } from './GlowLighting.js';
import { PROPS } from '../props/PropRegistry.js';
import { GAME_PROPS, RESPAWN_MS, VOTE, WEAPONS } from '../game/rules.js';

const _ray = new THREE.Ray(), _inv = new THREE.Matrix4(), _min = new THREE.Vector3(), _max = new THREE.Vector3();
const PREDICTED_BOOM_MS = 2000; // how long a predicted explosion waits for the server's to be matched (and not shown again)

export class GameClient {
    constructor(main, config) {
        this.main = main;
        this.config = config;
        this.sfx = new Sfx();
        this.music = new Music(this.sfx);
        if(new URLSearchParams(location.search).get('music') !== '0') this.sfx.onReady(() => this.music.start());
        this.fx = new ExplosionFx(main.world.scene);
        this.hud = new GameHud(this);
        this.respawnAt = 0;
        this.wasDead = false;
        this.lastTeam = null;
        // sound bookkeeping: rockets already heard, fuse blink phases and poses (bounce detection), rubble batches, music intensity
        this.heard = new Set(); this.fuseBlink = new Map(); this.fusePose = new Map(); this.rubbleBatch = []; this.rubbleAt = 0; this.lastRubble = 0;
        this.recentBooms = 0; this.stepTimer = 0; this.wasOnGround = true; this.lastVy = 0;

        this.tools = [new RocketTool(), new GrenadeTool(), new DrillTool(), new MasonTool(), new GrappleTool(), new PhysGunTool()];
        main.spawnMenu.setTools(this.tools);
        main.spawnMenu.toolLabel.style.top = '62px'; // the score bar takes the top centre
        main.spawnMenu.setProps(PROPS.filter(p => GAME_PROPS.includes(p.id)));
        this.hud.setWeapons(this.tools.slice(0, 5));

        let ecs = main.ecs;
        // our own rockets fly from the click (predicted); see ProjectileRenderSystem
        this.raycaster = new THREE.Raycaster();
        this.predictedBooms = []; // { position, at }: explosions shown at a predicted impact, for the server's to match
        this.rockets = new ProjectileRenderSystem(main.world.scene, {
            localId: () => main.conn.id,
            hitTest: (from, dir, length) => this.rocketHit(from, dir, length),
            onImpact: (position, kind, terrain) => { if(terrain) this.predictedBoom(position, kind); },
        });
        ecs.addSystem(this.rockets);
        ecs.addSystem(new SupplyRenderSystem(main.world.scene, main.world.camera, () => main.conn.id, t => this.teamColor(t)));
        ecs.addSystem(new FuseFxSystem());
        // The glow rocks' light: baked into the terrain's vertex GI when it runs (TerrainGI.setRock: no per-frame cost, and
        // nothing switching on and off as you move), else the glow volume around the camera (GlowLighting). Which one is
        // only known once the renderer is up (Main.giDecided), so the rocks are held here until then (bindGlow).
        // ?glow=0 turns crystal light off, ?glow=<n> sets its intensity (35 in the glow volume's units).
        this.glowSink = {
            rocks: new Map(), target: null,
            setRock(id, ...a) { this.rocks.set(id, a); this.target?.setRock(id, ...a); },
            removeRock(id) { this.rocks.delete(id); this.target?.removeRock(id); },
        };
        ecs.addSystem(new GlowRockRenderSystem(main.world.scene, () => this.config.glowRocks, this.glowSink));
        this.sparks = new GlowSparkFx(main.world.scene);
        ecs.on('set', (id, name, s) => {
            if(name === 'Supply' && s.state === 'carried' && s.carriedBy === main.conn.id && !this.carryingNoted) { this.carryingNoted = true; this.sfx.pickup(); this.hud.flashText('Supply grabbed! Get it to your vault', 2000); }
            if(name === 'Supply' && s.state !== 'carried' && s.carriedBy !== main.conn.id) this.carryingNoted = false;
            // world sounds from replicated state: another player's rocket leaving, a grenade landing, rubble shedding
            if(name === 'Projectile' && s.owner !== main.conn.id && !this.heard.has(id)) { this.heard.add(id); let tf = ecs.get(id, 'Transform'); if(tf) this.sfx.rocketFar(tf.position); }
            else if(name === 'Transform' && ecs.has(id, 'Fuse')) this.trackFuse(id, s.position);
            else if(name === 'FragmentMesh' && !this.heard.has(id)) { this.heard.add(id); let tf = ecs.get(id, 'Transform'); if(tf) { if(!this.rubbleBatch.length) this.rubbleAt = performance.now(); this.rubbleBatch.push(tf.position); } }
        });
        ecs.on('destroy', (id) => { this.heard.delete(id); this.fuseBlink.delete(id); this.fusePose.delete(id); });

        window.addEventListener('keydown', (e) => this.onKey(e));
        this.hud.chat.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if(e.code === 'Enter') {
                let text = this.hud.chat.value.trim();
                if(/^\/vote\b/i.test(text)) this.vote(text.split(/\s+/)[1] || '');
                else if(text) main.conn.send(JSON.stringify({ type: 'chat', message: text }));
                this.hud.closeChat();
            }
            else if(e.code === 'Escape') this.hud.closeChat();
        });
        this.hud.toggleHelp(true);
        setTimeout(() => this.hud.toggleHelp(false), 6000);
        // heartbeat: sent while the player is at the keyboard, so votes count only the people actually here
        this.lastInput = performance.now();
        for(let ev of ['keydown', 'pointerdown', 'pointermove', 'touchstart']) window.addEventListener(ev, () => this.lastInput = performance.now(), { passive: true });
        this.heartbeat = setInterval(() => { if(performance.now() - this.lastInput < VOTE.idleMs && main.conn.readyState === 1) main.conn.send(JSON.stringify({ type: 'heartbeat' })); }, VOTE.heartbeatMs);
    }

    /** Vote for an admin action (the panel's buttons, or `/vote reset|end|swap` in chat). */
    vote(action) {
        if(!VOTE.actions[action]) { this.hud.addFeed(`Votes: ${Object.keys(VOTE.actions).map(a => '/vote ' + a).join(', ')}`, '#ccc'); return; }
        this.main.conn.send(JSON.stringify({ type: 'vote', action }));
    }

    /** Update the world config (a new import may change the rules). */
    configure(config) { this.config = config; }

    get me() { return this.main.ecs.get(this.main.conn.id, 'Player'); }
    get dead() { return !!this.me?.dead; }
    get team() { return this.me?.team || null; }
    get teamColor() { return (t) => teamColorOf(this.config, t); }
    nameOf(id) { return this.main.ecs.get(id, 'Player')?.name || 'someone'; }

    onKey(e) {
        if(this.hud.chat.style.display === 'block') return;
        if(e.code === 'Enter') { e.preventDefault(); this.hud.openChat(); }
        else if(e.code === 'KeyH') this.hud.toggleHelp();
        else if(e.code === 'KeyV') this.hud.toggleVote();
        else if(e.code === 'Escape' && this.hud.voteOpen) this.hud.toggleVote(false);
        else if(e.code === 'KeyJ') { let t = this.team === 'red' ? 'blue' : 'red'; this.main.conn.send(JSON.stringify({ type: 'jointeam', team: t })); }
        else if(e.code === 'KeyM') { let muted = this.sfx.toggleMute(); this.hud.flashText(muted ? 'Sound off' : 'Sound on', 700); if(!muted) this.sfx.click(); }
    }

    /** A grenade or buster moved: estimate its vertical speed from the replicated poses and tick when it lands or bounces. */
    trackFuse(id, p) {
        let now = performance.now(), f = this.fusePose.get(id);
        if(!f) { this.fusePose.set(id, { y: p.y, t: now, vy: 0, lastBounce: 0 }); return; }
        let dt = (now - f.t) / 1000;
        if(dt < 0.01) return;
        let vy = (p.y - f.y) / dt;
        if(f.vy < -3 && vy > f.vy * 0.4 + 1 && now - f.lastBounce > 150) {
            f.lastBounce = now;
            this.sfx.bounce(this.main.ecs.get(id, 'Fuse')?.kind || 'grenade', Math.min(1, -f.vy / 20), p);
        }
        f.y = p.y; f.t = now; f.vy = vy;
    }

    /** Game messages from the server. */
    onMessage(data) {
        let main = this.main;
        switch(data.type) {
            case 'spawn':
            case 'respawn':
                main.player.teleport(data.position);
                main.player.frozen = false;
                this.hud.flashText(data.type === 'spawn' ? `You are on ${this.config.teams[data.team]?.name || data.team}. Find the Treasure.` : '', 3000);
                this.sfx.respawn();
                return true;
            case 'hit':
                if(data.impulse) main.player.knock(data.impulse);
                main.player.shake = Math.max(main.player.shake, Math.min(0.6, data.damage / 60));
                this.hud.damageFlash();
                this.sfx.hurt(data.damage);
                return true;
            case 'glowpop': {
                // glow rocks dug all the way out: they shatter where they were
                if(!Array.isArray(data.rocks) || !data.rocks.length) return true;
                this.sparks.spawn(data.rocks);
                let [x, y, z] = data.rocks[0];
                this.sfx.crystal(data.rocks.length, new THREE.Vector3(x, y, z));
                return true;
            }
            case 'explosion': {
                let p = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
                if(data.by === main.conn.id && data.kind === 'rocket') {
                    // one of ours: already shown if its predicted rocket hit terrain there
                    let now = performance.now(), i = this.predictedBooms.findIndex(b => now - b.at < PREDICTED_BOOM_MS && b.position.distanceTo(p) < 3);
                    if(i >= 0) { this.predictedBooms.splice(i, 1); return true; }
                    this.rockets.serverExploded();
                }
                this.boomFx(p, data.radius, data.kind);
                return true;
            }
            case 'event': {
                let color = data.team ? this.teamColor(data.team) : data.kind === 'kill' ? '#f55' : data.kind === 'match' ? '#fc3' : '#ccc';
                this.hud.addFeed(data.text, color);
                if(data.kind === 'kill' && data.victim === main.conn.id) { this.hud.killedBy = data.text; this.sfx.death(); }
                if(data.kind === 'kill' && data.killer === main.conn.id) { this.sfx.hit(); this.hud.flashText('Kill!', 900); }
                if(data.kind === 'pickup' && data.team && !data.text.startsWith(`${this.me?.name} grabbed`)) this.sfx.pickupOther(data.team === this.team);
                if(data.kind === 'deposit' && data.team === this.team) this.sfx.deposit();
                if(data.kind === 'bonus') { this.hud.flashText(data.text, 3000); if(data.team === this.team) this.sfx.bonus(); }
                if(data.kind === 'match') {
                    this.hud.flashText(data.text, 4000);
                    let m = main.ecs.get('match', 'Match'); // already updated: the server sets the phase before it broadcasts
                    if(m && m.phase !== 'live') this.sfx.roundOver(!m.winner ? 'draw' : m.winner === this.team ? 'win' : 'loss');
                    else this.sfx.fanfare();
                }
                if(data.kind === 'vote') { this.hud.flashText(data.text, 2500); if(/^Vote passed/.test(data.text)) this.sfx.votePass(); else this.sfx.click(); }
                return true;
            }
            case 'chat':
                if(data.sender !== 'server') this.hud.addFeed(`${this.nameOf(data.sender)}: ${data.message}`, '#8cf');
                else this.hud.addFeed(data.message, '#ccc');
                return true;
        }
        return false;
    }

    /** Flash, debris, sound, shake and the music's lean for an explosion at `p`. */
    boomFx(p, radius, kind) {
        let main = this.main;
        this.fx.spawn(p, radius, kind);
        let d = p.distanceTo(main.player.position);
        this.sfx.boom(d, radius, kind, p);
        this.recentBooms += d < 50 ? 1 : 0.3; // the music leans in while things blow up nearby
        if(d < radius * 4) { main.player.shake = Math.max(main.player.shake, 0.5 * (1 - d / (radius * 4))); this.hud.whiteFlash(0.6 * (1 - d / (radius * 4))); }
    }

    /** Our rocket hit terrain on this side: explode now; the server's explosion for it (a round trip later) is not
     *  shown again. The crater still comes with the server's chunk update. */
    predictedBoom(position, kind) {
        let now = performance.now();
        this.predictedBooms = this.predictedBooms.filter(b => now - b.at < PREDICTED_BOOM_MS);
        this.predictedBooms.push({ position, at: now });
        this.boomFx(position, WEAPONS[kind].radius, kind);
    }

    /** What a rocket flying from `from` along the unit `dir` hits within `length`, as near as this side can tell the
     *  server's PhysX raycast: the terrain (the chunk BVHs along the segment), bodies, and other players. */
    rocketHit(from, dir, length) {
        let main = this.main, T = main.terrain, best = null;
        _min.copy(from).min(_max.copy(from).addScaledVector(dir, length));
        _max.copy(from).max(_ray.origin.copy(from).addScaledVector(dir, length));
        for(let k of T.intersecting({ min: _min, max: _max })) {
            let mesh = T.objects.get(k), bvh = mesh?.geometry.boundsTree;
            if(!bvh) continue;
            _ray.origin.copy(from); _ray.direction.copy(dir);
            _ray.applyMatrix4(_inv.copy(mesh.matrixWorld).invert());
            let hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, best ? best.distance : length);
            if(hit && (!best || hit.distance < best.distance)) best = { distance: hit.distance, point: hit.point.applyMatrix4(mesh.matrixWorld), terrain: true };
        }
        let targets = [main.physBodiesParent];
        for(let [id, , m] of main.ecs.each('Player', '$Mesh')) if(id !== main.conn.id && m.object.visible) targets.push(m.object);
        this.raycaster.set(from, dir);
        this.raycaster.far = best ? best.distance : length;
        let hits = this.raycaster.intersectObjects(targets, true);
        if(hits.length) best = { distance: hits[0].distance, point: hits[0].point.clone(), terrain: false };
        return best;
    }

    /** While dead, watch the nearest living teammate (the camera hovers behind them). */
    spectateTeammate() {
        let main = this.main, me = this.me, best = null, bestD = Infinity;
        for(let [id, p, tf] of main.ecs.each('Player', 'Transform')) {
            if(id === main.conn.id || p.team !== me.team || p.dead) continue;
            let d = Math.hypot(tf.position.x - main.player.position.x, tf.position.z - main.player.position.z);
            if(d < bestD) { bestD = d; best = { p, tf }; }
        }
        if(!best) { main.player.spectate = null; this.hud.spectating = ''; return; }
        let m = main.ecs.get(best.p === this.me ? null : [...main.ecs.each('Player')].find(r => r[1] === best.p)?.[0], '$Mesh');
        let pos = m ? m.object.position : best.tf.position;
        main.player.spectate = { x: pos.x, y: pos.y + 1, z: pos.z };
        this.hud.spectating = best.p.name;
    }

    /** Send the glow rocks to whatever lights with them (see glowSink). */
    bindGlow() {
        let main = this.main, param = main.queryParams.get('glow');
        this.glowBound = true;
        if(param === '0') return;
        let target;
        if(main.gi) {
            target = main.gi;
            if(param) main.gi.glowGain = parseFloat(param) / 10;
        } else {
            let mobile = main.isMobile();
            this.glow = target = new GlowLighting(main.world.renderer, main.world.scene, main.terrain, { dims: mobile ? [64, 32, 64] : [80, 32, 80], ...(param ? { intensity: parseFloat(param) } : {}) });
            main.chunkListeners.push((key, region) => this.glow.chunkChanged(region));
            main.muteDuringProbeBake?.(this.glow.light);
        }
        this.glowSink.target = target;
        for(let [id, a] of this.glowSink.rocks) target.setRock(id, ...a);
    }

    update(dt) {
        let main = this.main, me = this.me;
        this.fx.update(dt);
        this.sparks.update(dt);
        if(!this.glowBound && main.giDecided) this.bindGlow();
        this.glow?.update(main.world.camera);
        if(me) {
            if(me.dead && !this.wasDead) { main.player.frozen = true; this.respawnAt = performance.now() + RESPAWN_MS; this.carryingNoted = false; for(let t of this.tools) if(t.release) t.release(main); this.sfx.drillLoop(false); this.sfx.reel(false); }
            if(!me.dead && this.wasDead) { main.player.frozen = false; main.player.spectate = null; this.hud.spectating = ''; this.hud.killedBy = ''; }
            if(me.dead) this.spectateTeammate();
            this.wasDead = me.dead;
            if(me.dead && performance.now() > this.respawnAt + 500 && !this.askedRespawn) { this.askedRespawn = true; main.conn.send(JSON.stringify({ type: 'respawn' })); setTimeout(() => this.askedRespawn = false, 1000); }
            if(me.team !== this.lastTeam) { this.lastTeam = me.team; main.player.playerMesh.material.color.set(this.teamColor(me.team)); }
        }
        this.updateAudio(dt, me);
        this.hud.update();
    }

    /** Per-frame sound: the listener, fuse ticks in step with the blinking, weapon switch clicks, landings and
     *  footsteps, batched rubble, and the music's view of the game state. */
    updateAudio(dt, me) {
        let main = this.main, ecs = main.ecs, sfx = this.sfx, now = performance.now(), pl = main.player;
        if(!sfx.ready) return;
        sfx.listen(main.world.camera);
        // fuses tick on every blink of FuseFxSystem (same phase formula, from the age it recorded)
        for(let [id, fuse] of ecs.each('Fuse')) {
            let fx = ecs.get(id, '$FuseFx'); if(!fx) continue;
            let age = (now - fx.seen) / 1000, on = Math.sin(age * (3 + age * 3) * Math.PI) > 0, was = this.fuseBlink.get(id);
            if(on && was === false) { let tf = ecs.get(id, 'Transform'); if(tf) sfx.fuseTick(fuse.kind, Math.min(1, age * 1000 / (WEAPONS[fuse.kind]?.fuseMs || 2600)), tf.position); }
            this.fuseBlink.set(id, on);
        }
        let tool = main.spawnMenu.getCurrentTool();
        if(tool !== this.lastTool) { if(this.lastTool !== undefined) sfx.click(); this.lastTool = tool; }
        // landing and footsteps (walking is client-side, so only the local player has them)
        let onGround = !!pl.playerIsOnGround, vy = pl.playerVelocity?.y ?? 0;
        if(onGround && !this.wasOnGround && this.lastVy < -7 && !pl.frozen) sfx.land(-this.lastVy);
        this.wasOnGround = onGround; this.lastVy = vy;
        let walking = onGround && !pl.frozen && !me?.dead && pl.walkMovement && pl.walkMovement.length() > 0.2;
        if(walking) { this.stepTimer += dt; if(this.stepTimer >= 0.42) { this.stepTimer = 0; sfx.step(); } } else this.stepTimer = 0.3;
        // rubble: fragments of one collapse arrive over a few ticks; one sound per batch
        if(this.rubbleBatch.length && now - this.rubbleAt > 120 && now - this.lastRubble > 300) {
            let c = { x: 0, y: 0, z: 0 }, n = this.rubbleBatch.length;
            for(let p of this.rubbleBatch) { c.x += p.x / n; c.y += p.y / n; c.z += p.z / n; }
            sfx.rubble(n, c); this.rubbleBatch.length = 0; this.lastRubble = now;
        }
        // music follows the state of play
        this.recentBooms *= Math.exp(-dt / 8);
        let nearEnemy = false, mine = pl.position;
        if(me?.team) for(let [id, p, tf] of ecs.each('Player', 'Transform')) { if(id === main.conn.id || p.team === me.team || p.dead) continue; if(Math.hypot(tf.position.x - mine.x, tf.position.z - mine.z) < 30) { nearEnemy = true; break; } }
        let m = ecs.get('match', 'Match');
        let remaining = m && m.phase === 'live' ? Math.max(0, m.remainingMs - (now - this.hud.matchAt)) : Infinity;
        this.music.setState({ intensity: 0.2 + Math.min(0.5, this.recentBooms * 0.12) + (nearEnemy ? 0.3 : 0), carrying: !!me?.carrying, urgent: remaining < 60000, dead: !!me?.dead, over: !!m && m.phase !== 'live' });
    }
}
