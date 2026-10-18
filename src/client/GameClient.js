/** Fort War on the client: created by Main when a room's world config carries `game`. Arms the player with the
 *  weapon tools, adds the game render systems, owns the HUD and sound, and handles the game messages (spawns,
 *  hits, explosions, events). The server owns every rule; this only shows and asks. */
import * as THREE from 'three/webgpu';
import { RocketTool, GrenadeTool, DrillTool, MasonTool, GrappleTool } from '../tools/weapons.js';
import { PhysGunTool } from '../tools/PhysGunTool.js';
import { GameHud } from './GameHud.js';
import { Sfx } from './Sfx.js';
import { ProjectileRenderSystem, SupplyRenderSystem, FuseFxSystem, ExplosionFx, teamColorOf } from './gameSystems.js';
import { PROPS } from '../props/PropRegistry.js';
import { GAME_PROPS, RESPAWN_MS } from '../game/rules.js';

export class GameClient {
    constructor(main, config) {
        this.main = main;
        this.config = config;
        this.sfx = new Sfx();
        this.fx = new ExplosionFx(main.world.scene);
        this.hud = new GameHud(this);
        this.respawnAt = 0;
        this.wasDead = false;
        this.lastTeam = null;

        this.tools = [new RocketTool(), new GrenadeTool(), new DrillTool(), new MasonTool(), new GrappleTool(), new PhysGunTool()];
        main.spawnMenu.setTools(this.tools);
        main.spawnMenu.toolLabel.style.top = '62px'; // the score bar takes the top centre
        main.spawnMenu.setProps(PROPS.filter(p => GAME_PROPS.includes(p.id)));
        this.hud.setWeapons(this.tools.slice(0, 5));

        let ecs = main.ecs;
        ecs.addSystem(new ProjectileRenderSystem(main.world.scene));
        ecs.addSystem(new SupplyRenderSystem(main.world.scene, main.world.camera, () => main.conn.id, t => this.teamColor(t)));
        ecs.addSystem(new FuseFxSystem());
        ecs.on('set', (id, name, s) => {
            if(name === 'Supply' && s.state === 'carried' && s.carriedBy === main.conn.id && !this.carryingNoted) { this.carryingNoted = true; this.sfx.pickup(); this.hud.flashText('Supply grabbed! Get it to your vault', 2000); }
            if(name === 'Supply' && s.state !== 'carried' && s.carriedBy !== main.conn.id) this.carryingNoted = false;
        });

        window.addEventListener('keydown', (e) => this.onKey(e));
        this.hud.chat.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if(e.code === 'Enter') { let text = this.hud.chat.value.trim(); if(text) main.conn.send(JSON.stringify({ type: 'chat', message: text })); this.hud.closeChat(); }
            else if(e.code === 'Escape') this.hud.closeChat();
        });
        this.hud.toggleHelp(true);
        setTimeout(() => this.hud.toggleHelp(false), 12000);
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
        else if(e.code === 'KeyJ') { let t = this.team === 'red' ? 'blue' : 'red'; this.main.conn.send(JSON.stringify({ type: 'jointeam', team: t })); }
    }

    /** Game messages from the server. */
    onMessage(data) {
        let main = this.main;
        switch(data.type) {
            case 'spawn':
            case 'respawn':
                main.player.teleport(data.position);
                main.player.frozen = false;
                this.hud.flashText(data.type === 'spawn' ? `You are on ${this.config.teams[data.team]?.name || data.team}. Press H for help` : '', 3000);
                return true;
            case 'hit':
                if(data.impulse) main.player.knock(data.impulse);
                main.player.shake = Math.max(main.player.shake, Math.min(0.6, data.damage / 60));
                this.hud.damageFlash();
                this.sfx.hurt();
                return true;
            case 'explosion': {
                let p = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
                this.fx.spawn(p, data.radius, data.kind);
                let d = p.distanceTo(main.player.position);
                this.sfx.boom(d, data.radius);
                if(d < data.radius * 4) { main.player.shake = Math.max(main.player.shake, 0.5 * (1 - d / (data.radius * 4))); this.hud.whiteFlash(0.6 * (1 - d / (data.radius * 4))); }
                return true;
            }
            case 'event': {
                let color = data.team ? this.teamColor(data.team) : data.kind === 'kill' ? '#f55' : data.kind === 'match' ? '#fc3' : '#ccc';
                this.hud.addFeed(data.text, color);
                if(data.kind === 'kill' && data.victim === main.conn.id) { this.hud.killedBy = data.text; this.sfx.death(); }
                if(data.kind === 'kill' && data.killer === main.conn.id) { this.sfx.hit(); this.hud.flashText('Kill!', 900); }
                if(data.kind === 'deposit' && data.team === this.team) this.sfx.deposit();
                if(data.kind === 'bonus') this.hud.flashText(data.text, 3000);
                if(data.kind === 'match') { this.hud.flashText(data.text, 4000); this.sfx.fanfare(); }
                return true;
            }
            case 'chat':
                if(data.sender !== 'server') this.hud.addFeed(`${this.nameOf(data.sender)}: ${data.message}`, '#8cf');
                else this.hud.addFeed(data.message, '#ccc');
                return true;
        }
        return false;
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

    update(dt) {
        let main = this.main, me = this.me;
        this.fx.update(dt);
        if(me) {
            if(me.dead && !this.wasDead) { main.player.frozen = true; this.respawnAt = performance.now() + RESPAWN_MS; this.carryingNoted = false; for(let t of this.tools) if(t.release) t.release(main); }
            if(!me.dead && this.wasDead) { main.player.frozen = false; main.player.spectate = null; this.hud.spectating = ''; this.hud.killedBy = ''; }
            if(me.dead) this.spectateTeammate();
            this.wasDead = me.dead;
            if(me.dead && performance.now() > this.respawnAt + 500 && !this.askedRespawn) { this.askedRespawn = true; main.conn.send(JSON.stringify({ type: 'respawn' })); setTimeout(() => this.askedRespawn = false, 1000); }
            if(me.team !== this.lastTeam) { this.lastTeam = me.team; main.player.playerMesh.material.color.set(this.teamColor(me.team)); }
        }
        this.hud.update();
    }
}
