/** Fort War: the server-side game systems (see src/game/rules.js for the rules and numbers).
 *
 *  Active only in a room whose world config carries `game` (a Fort War level manifest). Owns teams, health and
 *  respawns, weapons (rockets integrated here against PhysX raycasts; grenades and busters are RigidBody props with a
 *  Fuse), explosions (a sphere carve plus a radial velocity change on bodies and knockback and damage on players),
 *  the supplies (physics crates: steal, carry, deposit, drop on death, return when abandoned), rubble damage, rubble
 *  fading, the mason's build budget, the glow rocks in the ground (src/server/GlowRocks.js), and the match timer with
 *  terrain restored from the pristine import between rounds. A team scores units (UNITS): 100 per supply in its vault
 *  and 1 per crystal its players free (`onTerrainChanged`: GlowRocks credits each shattered rock to the carve's author).
 *  Player movement stays client-authoritative; the server tells a client about knockback and teleports and trusts it. */
import { Transform, RigidBody, Prop, Projectile, Fuse, Supply, Match } from '../ecs/components.js';
import { WEAPONS, SUPPLY, RUBBLE, TEAMS, MAX_HEALTH, RESPAWN_MS, REGEN_DELAY_MS, REGEN_PER_S, MATCH_OVER_MS, PLAYER_KILL_Y, VOTE,
         SELF_DAMAGE_SCALE, FRAGMENT_FADE_MS, MAX_FRAGMENTS, AWARDS, UNITS, inBox, otherTeam, masonBox } from '../game/rules.js';
import { getPropDef } from '../props/PropRegistry.js';
import { chunksInBox } from '../terrain/grid.js';
import { GlowRocks } from './GlowRocks.js';

const MATCH_ID = 'match';
const SPAWN_PROTECT_MS = 2500;
const KILL_GRACE_MS = 1500; // position reports still in flight from before a respawn teleport must not kill again
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;
const vec3 = (v, d = { x: 0, y: 0, z: 0 }) => v ? { x: num(v.x, d.x), y: num(v.y, d.y), z: num(v.z, d.z) } : { ...d };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const unit = (v) => { let l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtStone = (v) => `${Math.floor(v * 10 + 1e-6) / 10} m³ of stone`;

export class Game {
    constructor(server) {
        this.server = server;
        this.world = server.world;
        this.hitAt = new Map();        // player id -> last time damaged (regen delay)
        this.cooldowns = new Map();    // player id -> { weapon: readyAt }
        this.buildRegen = new Map();   // player id -> last regen time
        this.rubbleHits = new Map();   // "body|player" -> time
        this.launches = [];            // [{ id, vel }] props to give an initial velocity once their actor exists
        this.carried = new Map();      // supply id -> { underground: seconds }
        this.scoreTick = 0;
        this.lastMatchSync = 0;
        this.spawnQueue = new Set();   // players to (re)spawn on the next tick, after the update that told them about the game
        this.spawnedAt = new Map();
        this.lastActive = new Map(); // player id -> last heartbeat (votes count only players who are there)    // player id -> time of the last spawn (brief protection)
        this.rocks = new GlowRocks(server); // the glow rock field: materialized as digging (or walking up to a tunnel) exposes them
    }

    get config() { return this.server.terrain.world.game || null; }
    get active() { return !!this.config; }
    get physics() { return this.server.physics; }

    // ---- lifecycle ------------------------------------------------------------

    /** The room's world config was (re)loaded: start or stop the game accordingly. */
    onWorldChanged() {
        let w = this.world;
        if(!this.active) {
            for(let id of [...w.query('Supply')]) w.destroy(id);
            for(let id of [...w.query('Projectile')]) w.destroy(id);
            if(w.has(MATCH_ID)) w.destroy(MATCH_ID);
            this.rocks.reset();
            for(let [id, p] of w.each('Player')) if(p.team) w.set(id, 'Player', { team: null, health: MAX_HEALTH, dead: false, carrying: null });
            return;
        }
        if(!w.has(MATCH_ID)) w.create(MATCH_ID, { Match: Match({ remainingMs: this.config.matchMinutes * 60000 }) });
        if(w.query('Supply').size === 0) this.resetSupplies();
        this.rocks.adopt(); // rocks loaded from storage keep their exposure; the field fills in around them as before
        for(let id of [...w.query('Player')]) if(!w.get(id, 'Player').team) this.join(id);
    }

    /** A player connected (entity already exists): pick a team and spawn. */
    /** A level was (re)imported: start over, whatever the room held before (supplies of the old layout, an old score). */
    onImported() {
        if(!this.active) return;
        let w = this.world;
        this.resetSupplies();
        for(let [id, p] of w.each('Player')) if(p.team) { w.set(id, 'Player', { carrying: null, dead: false, health: MAX_HEALTH, respawnAt: 0, buster: WEAPONS.buster.perLife, build: WEAPONS.mason.budget, kills: 0, deaths: 0, score: 0, carries: 0, smuggles: 0, blasts: 0, crystals: 0 }); this.spawnQueue.add(id); }
        w.set(MATCH_ID, 'Match', { phase: 'live', winner: null, overAt: 0, round: 1, remainingMs: this.config.matchMinutes * 60000, scores: { red: 0, blue: 0 }, crystals: { red: 0, blue: 0 }, awards: [], vote: null });
        this.updateScores(true);
    }

    onConnect(id) { if(this.active) this.join(id); }

    /** The current round, for a dropped player kept aside by the server (onResume). */
    round() { return this.world.get(MATCH_ID, 'Match')?.round ?? null; }

    /** A dropped connection came back in time and its player was restored as it was: no spawn, same team. If a round
     *  began meanwhile it starts that round like everyone else did (fresh stats, a spawn). Its carried supply was
     *  dropped when it left (onDisconnect). */
    onResume(id, round) {
        if(!this.active) return;
        let w = this.world, p = w.get(id, 'Player');
        if(!p || !p.team) { this.join(id); return; }
        if(round !== this.round()) {
            w.set(id, 'Player', { kills: 0, deaths: 0, score: 0, carries: 0, smuggles: 0, blasts: 0, crystals: 0 });
            this.join(id, p.team);
            return;
        }
        this.cooldowns.set(id, {});
        this.lastActive.set(id, Date.now());
    }

    onDisconnect(id) {
        let p = this.world.get(id, 'Player');
        if(p && p.carrying) this.dropSupply(p.carrying, id, Date.now());
        this.hitAt.delete(id); this.cooldowns.delete(id); this.buildRegen.delete(id); this.lastActive.delete(id);
    }

    join(id, team = null) {
        let w = this.world, p = w.get(id, 'Player');
        if(!p) return;
        if(!team) { // the smaller team, red first
            let counts = { red: 0, blue: 0 };
            for(let [pid, pl] of w.each('Player')) if(pid !== id && pl.team) counts[pl.team]++;
            team = counts.blue < counts.red ? 'blue' : 'red';
        }
        let t = this.config.teams[team];
        w.set(id, 'Player', { team, color: t.color, health: MAX_HEALTH, dead: false, carrying: null, respawnAt: 0, build: WEAPONS.mason.budget, buster: WEAPONS.buster.perLife });
        this.cooldowns.set(id, {});
        this.lastActive.set(id, Date.now());
        this.spawnQueue.add(id);
    }

    spawn(id) {
        let w = this.world, p = w.get(id, 'Player'), tf = w.get(id, 'Transform');
        if(!p || !p.team) return;
        let spawns = this.config.teams[p.team].spawns;
        // the spawn point farthest from any enemy, ties broken randomly
        let enemies = [...w.each('Player', 'Transform')].filter(([pid, pl]) => pid !== id && pl.team && pl.team !== p.team && !pl.dead).map(r => r[2].position);
        let best = null, bestD = -1;
        for(let s of spawns) {
            let d = Math.min(Infinity, ...enemies.map(e => Math.hypot(e.x - s[0], e.z - s[2]))) + Math.random() * 2;
            if(d > bestD) { bestD = d; best = s; }
        }
        let pos = { x: best[0], y: best[1], z: best[2] };
        tf.position = { ...pos }; w.touch(id, 'Transform');
        this.spawnedAt.set(id, Date.now());
        this.server.send(id, { type: 'spawn', position: pos, team: p.team });
    }

    // ---- messages --------------------------------------------------------------

    /** Handle a game message; returns true when it was one. */
    async onMessage(id, data) {
        if(!this.active) return false;
        let w = this.world, p = w.get(id, 'Player'), now = Date.now();
        if(!p) return false;
        switch(data.type) {
            case 'fire':    this.fire(id, p, data, now); return true;
            case 'dig':     await this.dig(id, p, data, now); return true;
            case 'build':   await this.build(id, p, data, now); return true;
            case 'respawn': if(p.dead && now >= p.respawnAt) this.respawn(id); return true;
            case 'jointeam': this.switchTeam(id, p, String(data.team || ''), now); return true;
            case 'spawnprop': case 'spawnphyscube': return true; // no props from the menu in a match
            case 'physgun_move': return p.dead; // a dead player's hold was released (kill); a late move must not grab again
            case 'physgun_grab': { // no stealing with the physgun, and only within reach
                let btf = w.get(data.bodyId, 'Transform'), tf = w.get(id, 'Transform');
                if(!btf || !tf || p.dead) return true;
                if(w.has(data.bodyId, 'Supply') || dist(btf.position, tf.position) > WEAPONS.physgun.range) return true;
                return false;
            }
            case 'heartbeat': this.lastActive.set(id, now); return true;
            case 'vote': this.vote(id, p, String(data.action || ''), now); return true;
            case 'reset': case 'setgravity': return true; // not during a match: vote for it
        }
        return false;
    }

    /** The terrain changed (settleNow, with the replaced chunk content still around): the glow rocks a brush can have
     *  uncovered are measured, new ones appear, free ones become bodies. Returns the counts and cost, for the log. */
    onTerrainChanged(boxes, carved, changed) {
        if(!this.active) return null;
        let out = this.rocks.onTerrainChanged(boxes, carved, changed);
        if(out) for(let [id, n] of out.credits) this.creditCrystals(id, n);
        return out;
    }

    /** Where the player's eye is on the server (its Transform is the capsule centre minus half a metre). */
    eyeOf(id) { let tf = this.world.get(id, 'Transform'); return { x: tf.position.x, y: tf.position.y + 1.0, z: tf.position.z }; }

    /** Validate a shot's origin and direction against the player's known position; null if it is nowhere near. */
    /** PhysX actor pointer of a player's capsule (0 if none yet). */
    actorPtrOf(id) { return this.world.get(id, '$PxKinematic')?.actor?.ptr || this.world.get(id, '$PxBody')?.actor?.ptr || 0; }

    aim(id, data) {
        let eye = this.eyeOf(id);
        let origin = vec3(data.origin, eye), dir = unit(vec3(data.dir, { x: 0, y: 0, z: 1 }));
        if(dist(origin, eye) > 8) origin = eye; // the server's eye lags a moving (or grappling) player by the round trip
        return { origin, dir };
    }

    /** The client meters its own cooldown and fires the moment it ends; arrival jitter (and Date.now() standing
     *  still through a busy tick on Cloudflare) made every fourth shot land here "early" and vanish, so a shot
     *  within a third of the cooldown of being ready is taken and the next cooldown counts from the nominal time. */
    ready(id, weapon, now) {
        let cd = this.cooldowns.get(id) || {}, readyAt = cd[weapon] || 0, cdMs = WEAPONS[weapon].cooldownMs;
        if(readyAt - now > cdMs / 3) return false;
        cd[weapon] = Math.max(now, readyAt) + cdMs;
        this.cooldowns.set(id, cd);
        return true;
    }

    fire(id, p, data, now) {
        if(p.dead) return;
        let weapon = String(data.weapon || '');
        let def = WEAPONS[weapon];
        if(!def || !['rocket', 'grenade', 'buster'].includes(weapon)) return;
        if(weapon === 'buster' && p.buster <= 0) return;
        if(!this.ready(id, weapon, now)) return;
        let { origin, dir } = this.aim(id, data);
        let w = this.world;
        if(weapon === 'rocket') {
            // point blank: the rocket would be born inside the wall ahead and fly through it, so trace the first metre
            let pre = this.physics.raycast(origin, dir, 1.3, this.actorPtrOf(id));
            if(pre) { this.explode({ x: pre.position.x - dir.x * 0.15, y: pre.position.y - dir.y * 0.15, z: pre.position.z - dir.z * 0.15 }, 'rocket', id, now); return; }
            let start = { x: origin.x + dir.x * 1.3, y: origin.y + dir.y * 1.3, z: origin.z + dir.z * 1.3 };
            w.create({
                Transform: Transform({ position: start }),
                Projectile: Projectile({ kind: 'rocket', team: p.team, owner: id, vel: { x: dir.x * def.speed, y: dir.y * def.speed, z: dir.z * def.speed }, bornAt: now }),
            });
            return;
        }
        // grenade / buster: a physics prop with a fuse, thrown
        let power = Math.max(0, Math.min(1, num(data.power, 0.6)));
        let speed = weapon === 'grenade' ? def.minSpeed + (def.maxSpeed - def.minSpeed) * power : def.speed;
        let start = { x: origin.x + dir.x * 1.1, y: origin.y + dir.y * 1.1 - 0.2, z: origin.z + dir.z * 1.1 };
        let bid = this.server.spawnProp(weapon, start, { x: 0, y: 0, z: 0, w: 1 });
        w.add(bid, 'Fuse', Fuse({ kind: weapon, team: p.team, owner: id, at: now + def.fuseMs }));
        this.launches.push({ id: bid, vel: { x: dir.x * speed, y: dir.y * speed + 2.5, z: dir.z * speed } });
        if(weapon === 'buster') w.set(id, 'Player', { buster: p.buster - 1 });
    }

    /** Drill: carve a sphere just ahead of the eye (reaching back around the player's head), so a dig opens a
     *  hole big enough to walk or drop through, and digging down bores a shaft the player falls down. */
    async dig(id, p, data, now) {
        if(p.dead || !this.ready(id, 'drill', now)) return;
        let { origin, dir } = this.aim(id, data);
        let d = WEAPONS.drill, r = d.radius;
        // the hull of a sphere around the player, resting at the feet, and the same sphere `reach` ahead along the view:
        // separate spheres left a ridge between every two bites, a tunnel dug walking forward now has a smooth floor
        let a = { x: origin.x, y: origin.y - d.drop, z: origin.z };
        let b = { x: a.x + dir.x * d.reach, y: a.y + dir.y * d.reach, z: a.z + dir.z * d.reach };
        // stone comes from digging: a share of what the dig actually removed (re-digging a hole yields nothing, and a
        // bite into a castle wall, a third the size of one into dirt, a third the stone)
        let T = this.server.terrain;
        let keys = chunksInBox(T.world, { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, z: Math.min(a.z, b.z) - r }, { x: Math.max(a.x, b.x) + r, y: Math.max(a.y, b.y) + r, z: Math.max(a.z, b.z) + r });
        let volume = () => keys.reduce((sum, k) => sum + (T.chunks[k] && T.hasSolid(k) ? T.manifoldOf(k).volume() : 0), 0);
        let before = volume();
        await this.server.carveCapsule(a, b, r, 1, id);
        let removed = before - volume(), m = WEAPONS.mason;
        let q = this.world.get(id, 'Player');
        if(q && removed > 0.05 && q.build < m.budget) this.world.set(id, 'Player', { build: Math.min(m.budget, Math.round((q.build + removed * m.digYield) * 10) / 10) });
    }

    /** Mason: a box of the team's stone between two corners on the grid (rules.js masonBox), paid for by its volume in
     *  stone. It has to start within reach and may not swallow a player (they would be stuck inside). The solid is
     *  3 cm bigger on every side than the grid box, so it overlaps the floor or wall it is built against instead of
     *  touching it face to face: touching faces could leave it a separate piece, which is shed as a falling fragment. */
    async build(id, p, data, now) {
        let m = WEAPONS.mason, box = masonBox(data);
        if(p.dead || !box || !this.ready(id, 'mason', now)) return;
        if(box.volume > p.build + 1e-6) { this.server.send(id, { type: 'event', text: `Not enough stone: that takes ${fmtStone(box.volume)}, you have ${fmtStone(p.build)}` }); return; }
        let eye = this.eyeOf(id);
        let near = { x: clamp(eye.x, box.min[0], box.max[0]), y: clamp(eye.y, box.min[1], box.max[1]), z: clamp(eye.z, box.min[2], box.max[2]) };
        if(dist(near, eye) > m.maxDistance + 1) return;
        for(let [pid, pl, tf] of this.world.each('Player', 'Transform')) {
            if(!pl.team || pl.dead) continue;
            let f = tf.position, R = 0.45; // the capsule, feet at the position, two metres tall
            if(f.x + R > box.min[0] && f.x - R < box.max[0] && f.z + R > box.min[2] && f.z - R < box.max[2] && f.y + 2 > box.min[1] && f.y < box.max[1]) {
                this.server.send(id, { type: 'event', text: pid === id ? 'You are in the way of that box' : `${pl.name} is in the way` });
                return;
            }
        }
        this.world.set(id, 'Player', { build: Math.round((p.build - box.volume) * 10) / 10 });
        this.buildRegen.set(id, this.buildRegen.get(id) || now);
        let pad = 0.03, center = { x: (box.min[0] + box.max[0]) / 2, y: (box.min[1] + box.max[1]) / 2, z: (box.min[2] + box.max[2]) / 2 };
        await this.server.addBox(center, { x: 0, y: 0, z: 0, w: 1 }, { x: box.size[0] + 2 * pad, y: box.size[1] + 2 * pad, z: box.size[2] + 2 * pad }, this.config.teams[p.team].material);
    }

    /** Quaternion rotating +z onto `dir` (yaw and pitch only). */
    yawPitchQuat(dir) {
        let yaw = Math.atan2(dir.x, dir.z), pitch = -Math.asin(Math.max(-1, Math.min(1, dir.y)));
        let cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
        // q = yaw(Y) * pitch(X)
        return { w: cy * cp, x: cy * sp, y: sy * cp, z: -sy * sp };
    }

    switchTeam(id, p, team, now) {
        if(!TEAMS.includes(team) || team === p.team) return;
        let counts = { red: 0, blue: 0 };
        for(let [pid, pl] of this.world.each('Player')) if(pid !== id && pl.team) counts[pl.team]++;
        if(counts[team] > counts[otherTeam(team)]) { this.server.send(id, { type: 'event', text: `${this.config.teams[team].name} has enough players` }); return; }
        if(p.carrying) this.dropSupply(p.carrying, id, now);
        this.join(id, team);
        this.server.broadcast(JSON.stringify({ type: 'event', text: `${p.name} joined ${this.config.teams[team].name}` }));
    }

    // ---- damage ------------------------------------------------------------------

    damage(id, amount, by, cause, impulse, now) {
        let w = this.world, p = w.get(id, 'Player');
        if(!p || !p.team || p.dead || amount <= 0) return;
        if(now - (this.spawnedAt.get(id) || 0) < SPAWN_PROTECT_MS && by !== id) return;
        let health = Math.max(0, p.health - amount);
        w.set(id, 'Player', { health });
        this.hitAt.set(id, now);
        this.server.send(id, { type: 'hit', damage: amount, impulse, by });
        if(health <= 0) this.kill(id, by, cause, now);
    }

    kill(id, by, cause, now) {
        let w = this.world, p = w.get(id, 'Player');
        if(!p || p.dead) return;
        if(p.carrying) this.dropSupply(p.carrying, id, now);
        // let go of whatever the physgun held: the hold would otherwise follow the dead player's camera and outlive them
        for(let [bid, g] of w.each('Grabbed')) if(g.by === id) w.remove(bid, 'Grabbed');
        w.set(id, 'Player', { dead: true, health: 0, deaths: p.deaths + 1, respawnAt: now + RESPAWN_MS, carrying: null });
        let killer = by && by !== id ? w.get(by, 'Player') : null;
        if(killer) w.set(by, 'Player', { kills: killer.kills + 1 });
        let text = killer ? `${killer.name} ${cause || 'blew up'} ${p.name}` : by === id ? `${p.name} ${cause || 'blew up'} themselves` : `${p.name} ${cause || 'died'}`;
        this.server.broadcast(JSON.stringify({ type: 'event', kind: 'kill', text, victim: id, killer: killer ? by : null }));
    }

    respawn(id) {
        let w = this.world, p = w.get(id, 'Player');
        if(!p || !p.team) return;
        w.set(id, 'Player', { dead: false, health: MAX_HEALTH, respawnAt: 0, buster: WEAPONS.buster.perLife, build: Math.max(p.build, Math.floor(WEAPONS.mason.budget / 2)) });
        this.hitAt.delete(id);
        this.spawn(id);
    }

    /** A blast: carve the terrain, throw bodies, hurt and knock players. `by` is the player responsible. */
    explode(center, kind, by, now) {
        let def = WEAPONS[kind];
        let R = def.radius, reach = R * 1.6;
        this.server.carveBlast(center, R, 1, by).catch(e => console.error('carve failed: ' + e.message));
        let w = this.world;
        for(let [bid, pb, tf, rb] of w.each('$PxBody', 'Transform', 'RigidBody')) {
            if(rb.frozen) continue;
            let d = dist(tf.position, center);
            if(d > reach + (rb.halfExtent || 0)) continue;
            let f = Math.max(0.15, 1 - d / reach);
            let dir = d > 1e-3 ? { x: (tf.position.x - center.x) / d, y: (tf.position.y - center.y) / d, z: (tf.position.z - center.z) / d } : { x: 0, y: 1, z: 0 };
            let v = def.knock * 1.3 * f;
            this.physics.addVelocity(pb.actor, { x: dir.x * v, y: (dir.y + 0.5) * v, z: dir.z * v });
        }
        for(let [pid, p, tf] of w.each('Player', 'Transform')) {
            if(!p.team || p.dead) continue;
            let c = { x: tf.position.x, y: tf.position.y + 1, z: tf.position.z };
            let d = dist(c, center);
            if(d > reach + 0.8) continue;
            let f = Math.max(0, Math.min(1, 1 - (d - 0.8) / reach));
            let dir = d > 1e-3 ? { x: (c.x - center.x) / d, y: (c.y - center.y) / d, z: (c.z - center.z) / d } : { x: 0, y: 1, z: 0 };
            let k = def.knock * f;
            let impulse = { x: dir.x * k, y: Math.max(dir.y, 0.35) * k, z: dir.z * k };
            let dmg = def.damage * f * (pid === by ? SELF_DAMAGE_SCALE : 1);
            this.damage(pid, Math.round(dmg), by, kind === 'buster' ? 'busted' : kind === 'grenade' ? 'fragged' : 'rocketed', impulse, now);
        }
        this.server.broadcast(JSON.stringify({ type: 'explosion', position: center, radius: R, kind, by })); // `by`: the shooter matches it to a predicted rocket
        let shooter = by && w.get(by, 'Player'); if(shooter) w.set(by, 'Player', { blasts: shooter.blasts + 1 });
    }

    // ---- supplies ------------------------------------------------------------------

    /** Every supply back where the level put it: the vaults start empty, the treasure lies scattered over the level
     *  (`scatter`) and buried in sealed pockets (`caches`), so a round opens as a race to explore and turns into a
     *  raid on whatever the other side brought home. */
    resetSupplies() {
        let w = this.world, g = this.config;
        for(let id of [...w.query('Supply')]) w.destroy(id);
        this.carried.clear();
        let make = (team, pos, buried = false) => w.create({
            Transform: Transform({ position: pos }),
            RigidBody: RigidBody({ shape: 'box', halfExtent: SUPPLY.halfExtent, propId: 'supply' }),
            Prop: Prop({ propId: 'supply', url: null }),
            Supply: Supply({ team, state: 'home', home: pos, buried }),
        });
        for(let c of g.scatter) make(null, { x: c[0], y: c[1], z: c[2] });
        for(let c of g.caches) make(null, { x: c[0], y: c[1], z: c[2] }, true);
        for(let [id, p] of w.each('Player')) if(p.carrying) w.set(id, 'Player', { carrying: null });
        // the crates must not fall through floors whose colliders have not been cooked yet
        this.server.cookAround([...w.each('Supply', 'Transform')].map(r => r[2].position));
    }

    inVault(team, pos) { return inBox(this.config.teams[team].vault, pos); }

    pickup(sid, pid, now) {
        let w = this.world, s = w.get(sid, 'Supply'), p = w.get(pid, 'Player');
        w.remove(sid, 'RigidBody'); w.remove(sid, '$PxBody');
        w.set(sid, 'Supply', { state: 'carried', carriedBy: pid, buried: false });
        w.set(pid, 'Player', { carrying: sid });
        this.carried.set(sid, { underground: 0 });
        let owner = s.team ? this.config.teams[s.team].name + "'s" : 'a buried';
        this.server.broadcast(JSON.stringify({ type: 'event', kind: 'pickup', text: `${p.name} grabbed ${owner} supply`, team: p.team }));
    }

    /** Put a carried supply down (its carrier died, left or switched teams): it lies loose where it fell. */
    dropSupply(sid, pid, now) {
        let w = this.world;
        if(!w.has(sid, 'Supply')) return;
        let ptf = w.get(pid, 'Transform');
        let pos = ptf ? { x: ptf.position.x, y: ptf.position.y + 1.2, z: ptf.position.z } : w.get(sid, 'Supply').home;
        this.place(sid, pos);
        w.set(sid, 'Supply', { state: 'loose', carriedBy: null, droppedAt: now });
        let p = w.get(pid, 'Player'); if(p && p.carrying === sid) w.set(pid, 'Player', { carrying: null });
        this.carried.delete(sid);
    }

    /** A supply becomes a physics crate again at `pos`. */
    place(sid, pos) {
        let w = this.world;
        w.set(sid, 'Transform', { position: { ...pos }, quaternion: { x: 0, y: 0, z: 0, w: 1 } });
        if(!w.has(sid, 'RigidBody')) w.add(sid, 'RigidBody', RigidBody({ shape: 'box', halfExtent: SUPPLY.halfExtent, propId: 'supply' }));
        else { w.remove(sid, '$PxBody'); w.set(sid, 'RigidBody', { sleeping: false }); } // rebuild the actor at the new pose
    }

    /** The carrier reached their vault: the supply is theirs now. */
    deposit(sid, pid, now) {
        let w = this.world, p = w.get(pid, 'Player'), team = p.team;
        let run = this.carried.get(sid) || { underground: 0 };
        let slot = this.freeSlot(team);
        this.place(sid, slot);
        w.set(sid, 'Supply', { team, state: 'home', carriedBy: null, home: slot, droppedAt: 0 });
        w.set(pid, 'Player', { carrying: null, score: p.score + UNITS.supply, carries: p.carries + 1 });
        this.carried.delete(sid);
        let tname = this.config.teams[team].name;
        this.server.broadcast(JSON.stringify({ type: 'event', kind: 'deposit', text: `${p.name} brought a supply home to ${tname} (+${UNITS.supply})`, team }));
        if(run.underground >= SUPPLY.undergroundBonusS) {
            // Tunnel rat: smuggling it home underground earns the team a bonus crate
            let bonus = this.freeSlot(team);
            w.create({
                Transform: Transform({ position: bonus }),
                RigidBody: RigidBody({ shape: 'box', halfExtent: SUPPLY.halfExtent, propId: 'supply' }),
                Prop: Prop({ propId: 'supply', url: null }),
                Supply: Supply({ team, state: 'home', home: bonus }),
            });
            let q = w.get(pid, 'Player');
            w.set(pid, 'Player', { score: q.score + UNITS.supply, smuggles: q.smuggles + 1 });
            this.server.broadcast(JSON.stringify({ type: 'event', kind: 'bonus', text: `Tunnel rat! ${p.name} smuggled it underground: bonus crate for ${tname}`, team }));
        }
        this.updateScores(true);
    }

    /** A vault slot without a supply on it; stacks upward once all slots are taken. */
    freeSlot(team) {
        let w = this.world, slots = this.config.teams[team].slots;
        let taken = [...w.each('Supply', 'Transform')].filter(([, s]) => s.state === 'home' && s.team === team).map(r => r[2].position);
        for(let layer = 0; layer < 6; layer++) for(let s of slots) {
            let pos = { x: s[0], y: s[1] + layer * (SUPPLY.halfExtent * 2 + 0.05), z: s[2] };
            if(!taken.some(t => dist(t, pos) < 0.6)) return pos;
        }
        let s = slots[0]; return { x: s[0], y: s[1] + 6, z: s[2] };
    }

    returnHome(sid) {
        let w = this.world, s = w.get(sid, 'Supply');
        this.place(sid, s.home);
        w.set(sid, 'Supply', { state: 'home', carriedBy: null, droppedAt: 0 });
    }

    supplySystem(dt, now) {
        let w = this.world, g = this.config;
        let players = [...w.each('Player', 'Transform')].filter(([, p]) => p.team && !p.dead);
        for(let [sid, s, tf] of w.each('Supply', 'Transform')) {
            if(s.state === 'carried') {
                let carrier = w.get(s.carriedBy, 'Player'), ctf = w.get(s.carriedBy, 'Transform');
                if(!carrier || carrier.dead || carrier.carrying !== sid || !ctf) { this.dropSupply(sid, s.carriedBy, now); continue; }
                tf.position.x = ctf.position.x; tf.position.y = ctf.position.y + 2.2; tf.position.z = ctf.position.z;
                let run = this.carried.get(sid) || (this.carried.set(sid, { underground: 0 }), this.carried.get(sid));
                // underground means below the surface and outside both vaults (which are underground themselves)
                if(ctf.position.y < g.surfaceY - SUPPLY.undergroundDepth && !this.inVault('red', ctf.position) && !this.inVault('blue', ctf.position)) run.underground += dt;
                if(this.inVault(carrier.team, ctf.position)) this.deposit(sid, s.carriedBy, now);
                continue;
            }
            if(tf.position.y < PLAYER_KILL_Y + 10) { this.returnHome(sid); continue; }
            if(s.state === 'loose' && now - s.droppedAt > SUPPLY.dropReturnMs) { this.returnHome(sid); continue; }
            for(let [pid, p, ptf] of players) {
                if(p.carrying) continue;
                let dx = ptf.position.x - tf.position.x, dz = ptf.position.z - tf.position.z, dy = (ptf.position.y + 1) - tf.position.y;
                if(dx * dx + dz * dz > SUPPLY.pickupRadius ** 2 || Math.abs(dy) > 2.2) continue;
                // steal anyone else's, recover your own only when it is out of your vault
                if(s.team === p.team && this.inVault(p.team, tf.position)) continue;
                this.pickup(sid, pid, now);
                break;
            }
        }
    }

    /** Supplies each team holds (its own, not being carried: in the vault, or dropped and waiting to go back). */
    held() {
        let held = { red: 0, blue: 0 };
        for(let [, s] of this.world.each('Supply')) if(s.team && s.state !== 'carried') held[s.team]++;
        return held;
    }
    /** Each team's units: its supplies and the crystals it has banked. */
    updateScores(force = false) {
        let w = this.world, m = w.get(MATCH_ID, 'Match');
        if(!m) return;
        let held = this.held(), crystals = m.crystals || { red: 0, blue: 0 };
        let scores = { red: held.red * UNITS.supply + crystals.red * UNITS.crystal, blue: held.blue * UNITS.supply + crystals.blue * UNITS.crystal };
        if(force || scores.red !== m.scores.red || scores.blue !== m.scores.blue) w.set(MATCH_ID, 'Match', { scores });
    }
    /** Crystals a player's carve freed (GlowRocks): units for them and their team, banked at once. */
    creditCrystals(id, n) {
        let w = this.world, p = w.get(id, 'Player'), m = w.get(MATCH_ID, 'Match');
        if(!p || !p.team || !m || m.phase !== 'live' || n <= 0) return;
        w.set(id, 'Player', { crystals: (p.crystals || 0) + n, score: p.score + n * UNITS.crystal });
        let crystals = { red: 0, blue: 0, ...m.crystals }; crystals[p.team] += n;
        w.set(MATCH_ID, 'Match', { crystals });
        this.updateScores(true);
    }

    // ---- systems --------------------------------------------------------------------

    update(dt, now) {
        if(!this.active) return;
        let w = this.world;
        let players = w.query('Player').size;
        for(let id of this.spawnQueue) this.spawn(id);
        this.spawnQueue.clear();
        this.launchSystem();
        this.projectileSystem(dt, now);
        this.fuseSystem(now);
        this.supplySystem(dt, now);
        this.playerSystem(dt, now);
        this.rubbleSystem(now);
        this.fadeSystem(now);
        this.rocks.scan();
        if(++this.scoreTick % 15 === 0) this.updateScores();
        this.matchSystem(dt, now, players);
        this.voteSystem(now);
    }

    // ---- votes --------------------------------------------------------------------

    /** Players with a recent heartbeat (the client sends one while its user is at the keyboard). */
    activePlayers(now) {
        let out = [];
        for(let [id, p] of this.world.each('Player')) if(p.team && now - (this.lastActive.get(id) || 0) < VOTE.activeMs) out.push(id);
        return out;
    }

    /** A vote for an admin action: counted among the active players, passed by a majority of them (so a lone
     *  player's vote goes through at once); a different action replaces a vote nobody else has joined. */
    vote(id, p, action, now) {
        let w = this.world, m = w.get(MATCH_ID, 'Match');
        if(!m || !VOTE.actions[action] || !p.team) return;
        this.lastActive.set(id, now);
        let v = m.vote && m.vote.action === action && now < m.vote.until ? m.vote : null;
        if(!v && m.vote && now < m.vote.until && m.vote.voters.length > 1) { this.server.send(id, { type: 'event', text: `A vote to ${VOTE.actions[m.vote.action].toLowerCase()} is already running` }); return; }
        if(!v) v = { action, voters: [], until: now + VOTE.expireMs, by: p.name };
        if(v.voters.includes(id)) return;
        v.voters.push(id);
        let active = this.activePlayers(now), needed = Math.floor(active.length / 2) + 1;
        v.count = v.voters.filter(x => active.includes(x)).length; v.needed = needed;
        w.set(MATCH_ID, 'Match', { vote: v });
        this.server.broadcast(JSON.stringify({ type: 'event', kind: 'vote', text: `${p.name} voted to ${VOTE.actions[action].toLowerCase()} (${v.count}/${needed})` }));
        this.voteSystem(now);
    }

    voteSystem(now) {
        let w = this.world, m = w.get(MATCH_ID, 'Match');
        if(!m || !m.vote) return;
        let v = m.vote;
        if(now >= v.until) { w.set(MATCH_ID, 'Match', { vote: null }); this.server.broadcast(JSON.stringify({ type: 'event', text: `The vote to ${VOTE.actions[v.action].toLowerCase()} expired` })); return; }
        let active = this.activePlayers(now), needed = Math.floor(active.length / 2) + 1;
        let count = v.voters.filter(x => active.includes(x)).length;
        if(count !== v.count || needed !== v.needed) w.set(MATCH_ID, 'Match', { vote: { ...v, count, needed } });
        if(count < needed || m.phase !== 'live') return;
        w.set(MATCH_ID, 'Match', { vote: null });
        this.server.broadcast(JSON.stringify({ type: 'event', kind: 'vote', text: `Vote passed: ${VOTE.actions[v.action].toLowerCase()}` }));
        if(v.action === 'reset') this.newRound(now).catch(e => console.error('reset failed: ' + e.message));
        else if(v.action === 'end') w.set(MATCH_ID, 'Match', { remainingMs: 0 });
        else if(v.action === 'swap') {
            for(let [id, p] of w.each('Player')) if(p.team) { if(p.carrying) this.dropSupply(p.carrying, id, now); w.set(id, 'Player', { team: otherTeam(p.team), color: this.config.teams[otherTeam(p.team)].color }); this.spawnQueue.add(id); }
        }
    }

    /** Thrown props get their velocity once PhysX has an actor for them. */
    launchSystem() {
        if(!this.launches.length) return;
        let keep = [];
        for(let l of this.launches) {
            let pb = this.world.get(l.id, '$PxBody');
            if(!pb) { if(this.world.has(l.id)) keep.push(l); continue; }
            this.physics.setVelocity(pb.actor, l.vel, { x: 3, y: 1, z: 2 });
        }
        this.launches = keep;
    }

    /** Rockets: integrate, raycast the step, explode on contact or when they expire. */
    projectileSystem(dt, now) {
        let w = this.world;
        for(let [id, pr, tf] of w.each('Projectile', 'Transform')) {
            let def = WEAPONS[pr.kind] || WEAPONS.rocket;
            if(now - pr.bornAt > def.lifeMs || tf.position.y < PLAYER_KILL_Y) { w.destroy(id); continue; }
            pr.vel.y -= def.gravity * dt;
            let step = { x: pr.vel.x * dt, y: pr.vel.y * dt, z: pr.vel.z * dt };
            let len = Math.hypot(step.x, step.y, step.z);
            // the shooter's own capsule is skipped while the rocket leaves it, without hiding what is behind it
            let hit = len > 1e-4 ? this.physics.raycast(tf.position, { x: step.x / len, y: step.y / len, z: step.z / len }, len + 0.25, now - pr.bornAt < 250 ? this.actorPtrOf(pr.owner) : 0) : null;
            if(hit) {
                let hitId = this.physics.entityOfActor(w, hit.actorPtr);
                {
                    let at = { x: hit.position.x - step.x / len * 0.15, y: hit.position.y - step.y / len * 0.15, z: hit.position.z - step.z / len * 0.15 };
                    if(hitId && w.has(hitId, 'Player')) this.damage(hitId, def.direct, pr.owner, 'rocketed', { x: 0, y: 0, z: 0 }, now);
                    this.explode(at, pr.kind, pr.owner, now);
                    w.destroy(id);
                    continue;
                }
            }
            tf.position.x += step.x; tf.position.y += step.y; tf.position.z += step.z;
            w.touch(id, 'Transform'); w.touch(id, 'Projectile');
        }
    }

    fuseSystem(now) {
        let w = this.world;
        for(let [id, fuse, tf] of w.each('Fuse', 'Transform')) {
            if(now < fuse.at) continue;
            let at = { ...tf.position };
            w.destroy(id);
            this.explode(at, fuse.kind, fuse.owner, now);
        }
    }

    /** Health regeneration, respawn timers, build budget, the kill plane. */
    playerSystem(dt, now) {
        let w = this.world;
        for(let [id, p, tf] of w.each('Player', 'Transform')) {
            if(!p.team) continue;
            if(p.dead) { if(now >= p.respawnAt) this.respawn(id); continue; }
            if(tf.position.y < PLAYER_KILL_Y && now - (this.spawnedAt.get(id) || 0) > KILL_GRACE_MS) { this.kill(id, null, 'fell out of the world', now); continue; }
            if(p.health < MAX_HEALTH && now - (this.hitAt.get(id) || 0) > REGEN_DELAY_MS) {
                let h = Math.min(MAX_HEALTH, p.health + REGEN_PER_S * dt);
                if(Math.floor(h) !== Math.floor(p.health) || h === MAX_HEALTH) w.set(id, 'Player', { health: Math.round(h * 10) / 10 }); else p.health = h;
            }
            if(p.build < WEAPONS.mason.budget) {
                let last = this.buildRegen.get(id) || now;
                if(now - last >= WEAPONS.mason.regenMs) { w.set(id, 'Player', { build: Math.min(WEAPONS.mason.budget, p.build + 1) }); this.buildRegen.set(id, now); }
                else if(!this.buildRegen.has(id)) this.buildRegen.set(id, now);
            } else this.buildRegen.delete(id);
        }
    }

    /** Fast rubble and props hurt the players they hit. */
    rubbleSystem(now) {
        let w = this.world;
        let players = [...w.each('Player', 'Transform')].filter(([, p]) => p.team && !p.dead);
        if(!players.length) return;
        for(let [bid, pb, tf, rb] of w.each('$PxBody', 'Transform', 'RigidBody')) {
            if(rb.sleeping || rb.frozen || w.has(bid, 'Fuse')) continue;
            let v = pb.actor.getLinearVelocity();
            let speed = Math.hypot(v.get_x(), v.get_y(), v.get_z());
            if(speed < RUBBLE.minSpeed) continue;
            let r = (rb.halfExtent || 0.5) + 1.0;
            for(let [pid, , ptf] of players) {
                let c = { x: ptf.position.x, y: ptf.position.y + 1, z: ptf.position.z };
                if(Math.abs(c.x - tf.position.x) > r || Math.abs(c.y - tf.position.y) > r + 0.5 || Math.abs(c.z - tf.position.z) > r) continue;
                let key = bid + '|' + pid;
                if(now - (this.rubbleHits.get(key) || 0) < RUBBLE.pairCooldownMs) continue;
                this.rubbleHits.set(key, now);
                let dmg = Math.min(RUBBLE.maxDamage, (speed - RUBBLE.minSpeed) * RUBBLE.damagePerMps * Math.min(1.5, Math.max(0.3, rb.halfExtent || 0.5)));
                let grabbed = w.get(bid, 'Grabbed');
                this.damage(pid, Math.round(dmg), grabbed ? grabbed.by : null, w.has(bid, 'FragmentMesh') ? 'was crushed by rubble' : 'was hit by a flying prop', { x: v.get_x() * 0.3, y: Math.abs(v.get_y()) * 0.2 + 3, z: v.get_z() * 0.3 }, now);
            }
        }
        if(this.rubbleHits.size > 500) for(let [k, t] of this.rubbleHits) if(now - t > 5000) this.rubbleHits.delete(k);
    }

    /** Sleeping rubble fades after a while, and sooner when there is a lot of it. */
    fadeSystem(now) {
        let w = this.world;
        let sleeping = [];
        for(let [id, rb] of w.each('FragmentMesh', 'RigidBody')) {
            if(!rb.sleeping || w.has(id, 'Grabbed')) { w.remove(id, '$Fade'); continue; }
            let f = w.get(id, '$Fade') || w.add(id, '$Fade', { since: now });
            if(now - f.since > FRAGMENT_FADE_MS) w.destroy(id); else sleeping.push([id, f.since]);
        }
        let excess = w.query('FragmentMesh').size - MAX_FRAGMENTS;
        if(excess > 0) { sleeping.sort((a, b) => a[1] - b[1]); for(let [id] of sleeping.slice(0, excess)) w.destroy(id); }
    }

    matchSystem(dt, now, players) {
        let w = this.world, m = w.get(MATCH_ID, 'Match');
        if(!m) return;
        if(m.phase === 'live') {
            if(players > 0) m.remainingMs = Math.max(0, m.remainingMs - dt * 1000);
            let total = w.query('Supply').size, held = this.held();
            let sweep = total > 0 && (held.red === total || held.blue === total); // one side holds every supply: nothing left to fight over
            if(m.remainingMs <= 0 || sweep) {
                let winner = m.scores.red > m.scores.blue ? 'red' : m.scores.blue > m.scores.red ? 'blue' : null;
                w.set(MATCH_ID, 'Match', { phase: 'over', winner, overAt: now, remainingMs: 0, awards: this.awards() });
                let text = winner ? `${this.config.teams[winner].name} wins the round, ${m.scores.red} to ${m.scores.blue}!` : `Draw, ${m.scores.red} all`;
                this.server.broadcast(JSON.stringify({ type: 'event', kind: 'match', text }));
                return;
            }
            if(now - this.lastMatchSync > 1000) { this.lastMatchSync = now; w.touch(MATCH_ID, 'Match'); }
        } else if(m.phase === 'over' && now - m.overAt > MATCH_OVER_MS) {
            this.newRound(now).catch(e => console.error('new round failed: ' + e.message));
        }
    }

    /** Who stood out this round: the best in each category, if anyone qualifies. */
    awards() {
        let out = [];
        for(let [title, field, min] of AWARDS) {
            let best = null;
            for(let [, p] of this.world.each('Player')) if(p.team && p[field] >= min && (!best || p[field] > best[field])) best = p;
            if(best) out.push({ title, name: best.name, value: best[field] });
        }
        return out;
    }

    /** Next round: pristine terrain, supplies home, everyone respawned. */
    async newRound(now) {
        let w = this.world, m = w.get(MATCH_ID, 'Match');
        w.set(MATCH_ID, 'Match', { phase: 'resetting' });
        await this.server.restorePristine();
        this.rocks.reset(); // back in the ground with the terrain; the scan and the digging bring them out again
        this.resetSupplies();
        for(let [id, p] of w.each('Player')) if(p.team) { w.set(id, 'Player', { carrying: null, dead: false, health: MAX_HEALTH, respawnAt: 0, buster: WEAPONS.buster.perLife, build: WEAPONS.mason.budget, kills: 0, deaths: 0, score: 0, carries: 0, smuggles: 0, blasts: 0, crystals: 0 }); this.spawnQueue.add(id); }
        let round = m.round + 1;
        w.set(MATCH_ID, 'Match', { phase: 'live', winner: null, overAt: 0, round, remainingMs: this.config.matchMinutes * 60000, scores: { red: 0, blue: 0 }, crystals: { red: 0, blue: 0 }, awards: [] });
        this.updateScores(true);
        this.server.broadcast(JSON.stringify({ type: 'event', kind: 'match', text: `Round ${round}: the forts stand again` }));
    }
}
