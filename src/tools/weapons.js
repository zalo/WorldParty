/** Fort War weapons as tools (see src/game/rules.js). Each sends a message; the server does the carving, the
 *  projectiles and the damage. The grapple is the exception: player movement is client-authoritative, so it pulls
 *  the local PlayerController directly. */
import * as THREE from 'three/webgpu';
import { BaseTool } from './BaseTool.js';
import { WEAPONS } from '../game/rules.js';

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

/** Drill: hold to carve ahead of you. Point it down to burrow. */
export class DrillTool extends Weapon {
    constructor() {
        super('drill');
        this.preview = null;
        this.mobileActions = [{ label: 'Dig', icon: '⛏️', action: 'primary' }];
    }
    onEquip(main) {
        if(!this.preview) {
            let d = this.def;
            this.preview = new THREE.Mesh(new THREE.SphereGeometry(d.radius, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffcc66, wireframe: true, transparent: true, opacity: 0.35 }));
            main.world.scene.add(this.preview);
        }
        this.preview.visible = true;
    }
    onUnequip(main) { if(this.preview) this.preview.visible = false; main.game?.sfx.drillLoop(false); }
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
        main.game?.sfx.drillLoop(held && !main.game.dead); // the motor runs while the button is held; dig() adds a bite per carve
        if(!this.preview) return;
        let c = main.world.camera, d = this.def;
        c.getWorldDirection(_dir);
        this.preview.position.copy(c.position).addScaledVector(_dir, d.reach); this.preview.position.y -= d.drop;
    }
}

/** Mason: place blocks of your team's stone. Right click cycles the shape, scroll moves it, R turns it. */
export class MasonTool extends Weapon {
    constructor() {
        super('mason');
        this.shapes = Object.keys(this.def.shapes);
        this.shapeIndex = 0;
        this.distance = 5;
        this.turned = false;
        this.preview = null;
        this.mobileActions = [{ label: 'Place', icon: '🧱', action: 'primary' }, { label: 'Shape', icon: '🔁', action: 'secondary' }, { label: 'Turn', icon: '↪️', action: 'turn' }, { label: 'Closer', icon: '🔼', action: 'scrollDown' }, { label: 'Further', icon: '🔽', action: 'scrollUp' }];
    }
    get shape() { return this.shapes[this.shapeIndex]; }
    onEquip(main) {
        if(!this.preview) {
            this.preview = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
            main.world.scene.add(this.preview);
        }
        this.preview.material.color.set(main.game?.teamColor || '#ffffff');
        this.preview.visible = true;
        this.status(main);
    }
    onUnequip(main) { if(this.preview) this.preview.visible = false; }
    status(main) { main.spawnMenu.setStatus(this, `${this.shape} · ${main.game?.me?.build ?? 0} left`); }
    onSecondaryFire(main) { this.shapeIndex = (this.shapeIndex + 1) % this.shapes.length; this.status(main); }
    onScroll(main, delta, e) { // Shift + wheel moves the block; the plain wheel switches weapons
        if(!e || !e.shiftKey) return false;
        this.distance = Math.max(2, Math.min(this.def.maxDistance, this.distance - delta * 0.004));
        return true;
    }
    onKey(main, code) { if(code === 'KeyR') this.turned = !this.turned; }
    onAction(main, action) { if(action === 'turn') this.turned = !this.turned; }
    onPrimaryFire(main) {
        if(!this.canFire(main) || !this.preview || !this.preview.visible) return;
        let me = main.game?.me;
        if(!me || me.build <= 0) { main.game?.hud.flashText('Out of stone, it comes back over time'); return; }
        this.spend();
        let p = this.preview.position, q = this.preview.quaternion;
        main.conn.send(JSON.stringify({ type: 'build', shape: this.shape, position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } }));
        main.game.sfx.build(this.def.shapes[this.shape]);
    }
    update(main) {
        if(!this.preview) return;
        let dims = this.def.shapes[this.shape];
        let c = main.world.camera;
        c.getWorldDirection(_dir);
        // yaw only: walls stand up, turned across or along the view
        let yaw = Math.atan2(_dir.x, _dir.z) + (this.turned ? Math.PI / 2 : 0);
        this.preview.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        this.preview.scale.set(dims[0], dims[1], dims[2]);
        // sit it on whatever the crosshair points at within reach, else float it ahead
        main.raycaster.setFromCamera(new THREE.Vector2(0, 0), c);
        main.raycaster.far = this.distance + 1;
        let hits = main.raycaster.intersectObjects([main.terrainBatch, main.physBodiesParent], true);
        main.raycaster.far = Infinity;
        if(hits.length && hits[0].face) {
            let n = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
            if(n.y > 0.5) this.preview.position.copy(hits[0].point).add(new THREE.Vector3(0, dims[1] / 2 + 0.02, 0));
            else this.preview.position.copy(hits[0].point).addScaledVector(n, Math.min(dims[0], dims[2]) / 2 + 0.02);
        } else this.preview.position.copy(c.position).addScaledVector(_dir, this.distance);
        this.status(main);
    }
}

/** Grapple: hook terrain within range and get pulled there. Jump or fire again to let go. */
export class GrappleTool extends Weapon {
    constructor() {
        super('grapple');
        this.rope = null;
        this.anchor = null;
        this.mobileActions = [{ label: 'Hook', icon: '🪝', action: 'primary' }, { label: 'Release', icon: '✋', action: 'secondary' }];
    }
    onEquip(main) {
        if(!this.rope) {
            let geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            this.rope = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xdddddd }));
            this.rope.frustumCulled = false;
            main.world.scene.add(this.rope);
        }
        this.rope.visible = false;
    }
    onUnequip(main) { this.release(main); }
    onPrimaryFire(main) {
        if(this.anchor) { this.release(main); return; }
        if(main.game?.dead) return;
        if(main.game?.me?.carrying) { main.game.hud.flashText('Too heavy to grapple with a crate'); return; }
        main.raycaster.setFromCamera(new THREE.Vector2(0, 0), main.world.camera);
        main.raycaster.far = this.def.range;
        let hits = main.raycaster.intersectObjects([main.terrainBatch], true);
        main.raycaster.far = Infinity;
        if(!hits.length) { main.game?.hud.flashText('Nothing to hook within range'); return; }
        this.anchor = hits[0].point.clone();
        // pull the capsule to a spot above and just off the surface, so hooking a ledge lands you on it
        let n = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        let target = this.anchor.clone().addScaledVector(n, 0.7); target.y += 1.6;
        main.player.grappleTarget = { x: target.x, y: target.y, z: target.z, pull: this.def.pull, maxSpeed: this.def.maxSpeed };
        this.rope.visible = true;
        this.lastDistance = Infinity; this.stalledSince = 0;
        main.game.sfx.hook();
    }
    onSecondaryFire(main) { this.release(main); }
    onKey(main, code) { if(code === 'Space') this.release(main); }
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
    }
}
