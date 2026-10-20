/** Fort War weapons as tools (see src/game/rules.js). Each sends a message; the server does the carving, the
 *  projectiles and the damage. The grapple is the exception: player movement is client-authoritative, so it pulls
 *  the local PlayerController directly; it is not a tool but the right mouse button with any of them (Grapple). The
 *  grenade is not handed out in a match (GameClient's tool list), but still works. */
import * as THREE from 'three/webgpu';
import { BaseTool } from './BaseTool.js';
import { WEAPONS, MASON_GRID, masonCell, masonLine, masonBox } from '../game/rules.js';

const _dir = new THREE.Vector3();
/** Where the local player is looking from and toward. */
export function aim(main) {
    let c = main.world.camera;
    c.getWorldDirection(_dir).normalize();
    return { origin: { x: c.position.x, y: c.position.y, z: c.position.z }, dir: { x: _dir.x, y: _dir.y, z: _dir.z } };
}

class Weapon extends BaseTool {
    constructor(kind) {
        let def = WEAPONS[kind];
        super(def.name, def.icon);
        this.kind = kind;
        this.def = def;
        this.readyAt = 0;
    }
    /** 0 = ready, 1 = just fired (for the HUD). */
    cooldown() { return Math.max(0, Math.min(1, (this.readyAt - performance.now()) / (this.def.cooldownMs || 1))); }
    canFire(main) { return !main.game?.dead && performance.now() >= this.readyAt; }
    spend() { this.readyAt = performance.now() + (this.def.cooldownMs || 0); }
}

export class RocketTool extends Weapon {
    constructor() {
        super('rocket');
        this.mobileActions = [{ label: 'Fire', icon: '🚀', action: 'primary' }];
    }
    onPrimaryFire(main) {
        if(!this.canFire(main)) return;
        this.spend();
        let { origin, dir } = aim(main);
        main.conn.send(JSON.stringify({ type: 'fire', weapon: 'rocket', origin, dir }));
        main.game.rockets.predict(origin, dir); // flies now; the server's comes a round trip later and is matched to it
        main.game.sfx.shoot();
        main.player.knock({ x: -dir.x * 1.5, y: 0, z: -dir.z * 1.5 });
        main.player.shake = Math.max(main.player.shake, 0.15);
    }
}

/** Hold to charge, release to throw. Right click lobs the bunker buster (one per life). */
export class GrenadeTool extends Weapon {
    constructor() {
        super('grenade');
        this.charging = null; // performance.now() when the throw began charging
        this.mobileActions = [{ label: 'Throw', icon: '💣', action: 'primary' }, { label: 'Buster', icon: '☢️', action: 'secondary' }];
    }
    /** Charge fraction for the HUD, or null. */
    charge() { return this.charging === null ? null : Math.min(1, (performance.now() - this.charging) / this.def.chargeMs); }
    onPrimaryFire(main) { if(this.canFire(main)) this.charging = performance.now(); }
    onPrimaryRelease(main) {
        if(this.charging === null) return;
        let power = this.charge();
        this.charging = null;
        this.throwGrenade(main, power);
    }
    onMobilePrimary(main) { if(this.canFire(main)) this.throwGrenade(main, 0.65); }
    throwGrenade(main, power) {
        if(!this.canFire(main)) return;
        this.spend();
        let { origin, dir } = aim(main);
        main.conn.send(JSON.stringify({ type: 'fire', weapon: 'grenade', origin, dir, power }));
        main.game.sfx.throw(power, 'grenade');
    }
    onSecondaryFire(main) {
        let me = main.game?.me;
        if(!this.canFire(main) || !me || me.buster <= 0) { main.game?.hud.flashText(me && me.buster <= 0 ? 'No bunker buster left (one per life)' : ''); return; }
        this.charging = null;
        this.readyAt = performance.now() + WEAPONS.buster.cooldownMs;
        let { origin, dir } = aim(main);
        main.conn.send(JSON.stringify({ type: 'fire', weapon: 'buster', origin, dir }));
        main.game.sfx.throw(1, 'buster');
    }
    onUnequip(main) { this.charging = null; }
}

/** Drill: hold to carve from where you stand to ahead of you (Game.dig). Point it down to burrow. */
export class DrillTool extends Weapon {
    constructor() {
        super('drill');
        this.mobileActions = [{ label: 'Dig', icon: '⛏️', action: 'primary' }];
    }
    onPrimaryFire(main) { this.dig(main); }
    dig(main) {
        if(!this.canFire(main)) return;
        this.spend();
        let { origin, dir } = aim(main);
        main.conn.send(JSON.stringify({ type: 'dig', origin, dir }));
        main.game.sfx.drill();
        main.player.shake = Math.max(main.player.shake, 0.08);
    }
    update(main) {
        let held = main.primaryHeld && !main.simulationParams.mobile;
        if(held) this.dig(main);
    }
}

/** Mason: draw a box of your team's stone between two corners on the grid (rules.js masonBox). Click where the first
 *  corner goes (the cell against the surface under the crosshair), sweep to the opposite one and click again: in wall
 *  mode the box is drawn on the upright plane facing you (fixed at the first click), in floor mode on the level one,
 *  one cell (0.5 m) thick either way, so a wall, a floor, a bridge to the next ledge and a plug for a tunnel are all
 *  the same two clicks. F switches wall and floor, R lets go of the first corner. It costs its volume in stone (m³),
 *  which digging yields; the box turns red when you cannot afford it. */
const _hit = new THREE.Vector3(), _n = new THREE.Vector3(), _pt = new THREE.Vector3();
const _center = new THREE.Vector2(0, 0);
export class MasonTool extends Weapon {
    constructor() {
        super('mason');
        this.floor = false;     // F: wall or floor
        this.start = null;      // the first corner once clicked: { cell: [i, j, k], axis } (axis: 0, 1 or 2, the drawing plane's normal)
        this.box = null;        // what the preview shows: { min, max, size, volume } (masonBox), or null
        this.preview = null;
        this.mobileActions = [{ label: 'Corner', icon: '🧱', action: 'primary' }, { label: 'Wall/Floor', icon: '🔁', action: 'secondary' }, { label: 'Cancel', icon: '✖️', action: 'cancel' }];
    }
    onEquip(main) {
        if(!this.preview) {
            let g = new THREE.BoxGeometry(1, 1, 1);
            this.preview = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
            this.preview.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })));
            this.preview.renderOrder = 10;
            main.world.scene.add(this.preview);
        }
        this.preview.visible = false;
    }
    onUnequip(main) { this.start = null; this.box = null; if(this.preview) this.preview.visible = false; main.game?.hud.setHint(''); }
    toggleMode(main) {
        this.floor = !this.floor;
        if(this.start) this.start.axis = this.planeAxis(main);
        main.game?.hud.flashText(this.floor ? 'Floor: a level box' : 'Wall: an upright box facing you', 900);
    }
    onSecondaryFire(main) { this.toggleMode(main); } // the phone's Wall/Floor button (the right mouse button is the grapple)
    onKey(main, code) { if(code === 'KeyF') this.toggleMode(main); else if(code === 'KeyR') this.cancel(main); }
    onAction(main, action) { if(action === 'cancel') this.cancel(main); }
    cancel(main) { this.start = null; }
    /** The drawing plane's normal: up for a floor, else whichever horizontal axis the view runs along. */
    planeAxis(main) {
        if(this.floor) return 1;
        main.world.camera.getWorldDirection(_dir);
        return Math.abs(_dir.x) > Math.abs(_dir.z) ? 0 : 2;
    }
    /** The grid cell against the surface under the crosshair, within reach, or null. */
    aimedCell(main) {
        let c = main.world.camera;
        main.raycaster.setFromCamera(_center, c);
        main.raycaster.far = this.def.maxDistance;
        let hits = main.raycaster.intersectObjects([main.terrainBatch, main.physBodiesParent], true);
        main.raycaster.far = Infinity;
        let h = hits.find(h => h.face);
        if(!h) return null;
        _n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        _hit.copy(h.point).addScaledVector(_n, MASON_GRID / 2); // half a cell out of the surface: the cell resting on it
        return [masonCell(_hit.x), masonCell(_hit.y), masonCell(_hit.z)];
    }
    /** The opposite corner: where the view ray crosses the drawing plane through the first corner's middle. */
    sweptCell(main) {
        let { cell, axis } = this.start, c = main.world.camera;
        c.getWorldDirection(_dir);
        let plane = masonLine(cell[axis]) + MASON_GRID / 2, eye = c.position.getComponent(axis), d = _dir.getComponent(axis);
        let t = Math.abs(d) > 1e-4 ? (plane - eye) / d : -1;
        let far = this.def.maxDistance + this.def.maxSize;
        if(!(t > 0) || t > far) t = far; // aimed away from the plane or nearly along it: the furthest it may reach
        _pt.copy(c.position).addScaledVector(_dir, t);
        let out = [masonCell(_pt.x), masonCell(_pt.y), masonCell(_pt.z)];
        out[axis] = cell[axis];
        let maxCells = Math.round(this.def.maxSize / MASON_GRID) - 1;
        for(let a = 0; a < 3; a++) out[a] = Math.max(cell[a] - maxCells, Math.min(cell[a] + maxCells, out[a]));
        return out;
    }
    onPrimaryFire(main) {
        if(main.game?.dead) return;
        if(!this.start) {
            let cell = this.aimedCell(main);
            if(!cell) { main.game?.hud.flashText('Aim at the ground or a wall within reach', 900); return; }
            this.start = { cell, axis: this.planeAxis(main) };
            main.game?.sfx.click?.();
            return;
        }
        if(!this.canFire(main) || !this.box) return;
        let have = main.game?.me?.build ?? 0;
        if(this.box.volume > have + 1e-6) { main.game?.hud.flashText(`Not enough stone: ${stone(this.box.volume)} needed, ${stone(have)} left. Dig for more`, 1500); return; }
        this.spend();
        main.conn.send(JSON.stringify({ type: 'build', min: this.box.min, max: this.box.max }));
        main.game.sfx.build(this.box.size);
        this.start = null;
    }
    update(main) {
        if(!this.preview) return;
        let hud = main.game?.hud, a, b;
        if(this.start) { a = this.start.cell; b = this.sweptCell(main); }
        else { a = b = this.aimedCell(main); }
        if(!a || main.game?.dead) { this.box = null; this.preview.visible = false; hud?.setHint(''); return; }
        this.box = masonBox({ min: a.map((i, k) => masonLine(Math.min(i, b[k]))), max: a.map((i, k) => masonLine(Math.max(i, b[k]) + 1)) });
        if(!this.box) { this.preview.visible = false; return; }
        let { min, max, size, volume } = this.box, have = main.game?.me?.build ?? 0, afford = volume <= have + 1e-6;
        this.preview.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
        this.preview.scale.set(size[0] + 0.02, size[1] + 0.02, size[2] + 0.02);
        let color = afford ? (main.game ? main.game.teamColor(main.game.team) : '#ffffff') : '#ff3030';
        this.preview.material.color.set(color); this.preview.children[0].material.color.set(color);
        this.preview.material.opacity = this.start ? 0.3 : 0.15;
        this.preview.visible = true;
        hud?.setHint(this.start ? `${size.map(v => +v.toFixed(1)).join(' × ')} m · ${stone(volume)} of ${stone(have)}${this.floor ? ' · floor' : ''}` : '');
    }
}
const stone = (v) => `${Math.floor(v * 10 + 1e-6) / 10} m³`;

/** Grapple: hook terrain within range and get pulled there; press again, jump, or stall against something to let go.
 *  Not a tool slot: the right mouse button with any weapon, or the Hook button on a phone (GameClient owns it, passes
 *  the presses and updates it every frame). */
export class Grapple {
    constructor() {
        this.def = WEAPONS.grapple;
        this.rope = null;
        this.anchor = null;
    }
    toggle(main) { if(this.anchor) this.release(main); else this.hook(main); }
    hook(main) {
        if(main.game?.dead) return;
        if(main.game?.me?.carrying) { main.game.hud.flashText('Too heavy to grapple with a crate'); return; }
        main.raycaster.setFromCamera(new THREE.Vector2(0, 0), main.world.camera);
        main.raycaster.far = this.def.range;
        let hits = main.raycaster.intersectObjects([main.terrainBatch], true);
        main.raycaster.far = Infinity;
        if(!hits.length) { main.game?.hud.flashText('Nothing to hook within range'); return; }
        if(!this.rope) {
            let geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            this.rope = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xdddddd }));
            this.rope.frustumCulled = false;
            main.world.scene.add(this.rope);
        }
        this.anchor = hits[0].point.clone();
        // pull the capsule to a spot above and just off the surface, so hooking a ledge lands you on it
        let n = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        let target = this.anchor.clone().addScaledVector(n, 0.7); target.y += 1.6;
        main.player.grappleTarget = { x: target.x, y: target.y, z: target.z, pull: this.def.pull, maxSpeed: this.def.maxSpeed };
        this.rope.visible = false; // drawn from the first update, once it has both ends
        this.lastDistance = Infinity; this.stalledSince = 0;
        main.game.sfx.hook();
    }
    release(main) { if(this.anchor) main.game?.sfx.unhook(); main.game?.sfx.reel(false); this.anchor = null; main.player.grappleTarget = null; if(this.rope) this.rope.visible = false; }
    update(main, dt) {
        if(!this.anchor) return;
        let g = main.player.grappleTarget;
        if(!g) { this.release(main); return; } // arrived
        main.game?.sfx.reel(true);
        // let go when pressed against something and not getting closer
        let d = Math.hypot(g.x - main.player.position.x, g.y - main.player.position.y, g.z - main.player.position.z);
        if(d < this.lastDistance - 0.05) { this.lastDistance = d; this.stalledSince = 0; }
        else { this.stalledSince += dt || 0; if(this.stalledSince > 0.7) { this.release(main); return; } }
        let pos = this.rope.geometry.attributes.position.array, c = main.world.camera.position;
        pos[0] = c.x + 0.2; pos[1] = c.y - 0.3; pos[2] = c.z; pos[3] = this.anchor.x; pos[4] = this.anchor.y; pos[5] = this.anchor.z;
        this.rope.geometry.attributes.position.needsUpdate = true;
        this.rope.visible = true;
    }
}
