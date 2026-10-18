/** Fort War client systems: rockets (dead-reckoned between updates), supply markers and carried crates, fuse
 *  blinking, and short-lived explosion effects. */
import * as THREE from 'three/webgpu';
import { SUPPLY, TEAM_DEFAULTS } from '../game/rules.js';

const toVec3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

/** Rockets fly on the client from their last replicated position and velocity; a new Transform snaps them. */
export class ProjectileRenderSystem {
    constructor(scene) {
        this.scene = scene;
        this.geometry = new THREE.SphereGeometry(0.22, 10, 8);
        this.material = new THREE.MeshBasicMaterial({ color: 0xffaa33 });
        this.trailMaterial = new THREE.LineBasicMaterial({ color: 0xffdd88, transparent: true, opacity: 0.7 });
    }
    init(world) {
        world.on('set', (id, name, tf) => {
            if(name !== 'Transform' || !world.has(id, 'Projectile')) return;
            let m = world.get(id, '$Mesh'); if(m) m.object.position.copy(toVec3(tf.position));
        });
    }
    update(world, dt) {
        for(let [id, pr, tf] of world.each('Projectile', 'Transform')) {
            let m = world.get(id, '$Mesh');
            if(!m) {
                let object = new THREE.Group();
                let ball = new THREE.Mesh(this.geometry, this.material);
                ball.userData.sharedGeometry = true;
                object.add(ball);
                let trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 8 }, () => toVec3(tf.position))), this.trailMaterial);
                trail.frustumCulled = false;
                this.scene.add(trail);
                object.userData.trail = trail;
                object.position.copy(toVec3(tf.position));
                this.scene.add(object);
                m = world.add(id, '$Mesh', { object });
                continue;
            }
            m.object.position.x += pr.vel.x * dt; m.object.position.y += pr.vel.y * dt; m.object.position.z += pr.vel.z * dt;
            let trail = m.object.userData.trail, pos = trail.geometry.attributes.position.array;
            for(let i = pos.length - 3; i >= 3; i -= 3) { pos[i] = pos[i - 3]; pos[i + 1] = pos[i - 2]; pos[i + 2] = pos[i - 1]; }
            pos[0] = m.object.position.x; pos[1] = m.object.position.y; pos[2] = m.object.position.z;
            trail.geometry.attributes.position.needsUpdate = true;
        }
    }
    /** Called by the cleanup hook: trails live outside the group. */
    static dispose(object) { let t = object.userData.trail; if(t) { t.removeFromParent(); t.geometry.dispose(); } }
}

/** Supplies: a marker over every crate (team coloured, gold for loot), and a crate above whoever carries one. */
export class SupplyRenderSystem {
    constructor(scene, camera, localId, teamColor) {
        this.scene = scene; this.camera = camera; this.localId = localId; this.teamColor = teamColor;
        this.markerGeometry = new THREE.OctahedronGeometry(0.3);
        this.crateGeometry = new THREE.BoxGeometry(SUPPLY.halfExtent * 2, SUPPLY.halfExtent * 2, SUPPLY.halfExtent * 2);
        this.crateMaterial = new THREE.MeshStandardMaterial({ color: 0xffc830, emissive: 0x664400, roughness: 0.4 });
        this.materials = {};
    }
    /** Marker material per team; the beacon variant (a carried crate) draws through walls. */
    materialFor(team, beacon = false) {
        let key = (team || 'loot') + (beacon ? ':beacon' : '');
        if(!this.materials[key]) this.materials[key] = new THREE.MeshBasicMaterial({ color: team ? this.teamColor(team) : '#ffc830', depthTest: !beacon, transparent: beacon, opacity: beacon ? 0.9 : 1 });
        return this.materials[key];
    }
    update(world, dt) {
        let t = performance.now() / 1000;
        for(let [id, s] of world.each('Supply')) {
            let fx = world.get(id, '$SupplyFx');
            if(!fx) {
                let marker = new THREE.Mesh(this.markerGeometry, this.materialFor(s.team));
                marker.userData.sharedGeometry = true;
                marker.renderOrder = 10; // a carried crate's marker is drawn over the terrain
                let crate = new THREE.Mesh(this.crateGeometry, this.crateMaterial);
                crate.userData.sharedGeometry = true;
                crate.visible = false;
                this.scene.add(marker, crate);
                fx = world.add(id, '$SupplyFx', { marker, crate, team: s.team });
            }
            let beacon = s.state === 'carried';
            if(fx.team !== s.team || fx.beacon !== beacon) { fx.marker.material = this.materialFor(s.team, beacon); fx.team = s.team; fx.beacon = beacon; }
            let body = world.get(id, '$Mesh')?.object;
            if(s.state === 'carried') {
                let carrierMesh = world.get(s.carriedBy, '$Mesh')?.object;
                let mine = s.carriedBy === this.localId();
                fx.crate.visible = !mine && !!carrierMesh;
                fx.marker.visible = !mine && !!carrierMesh;
                if(carrierMesh) {
                    fx.crate.position.copy(carrierMesh.position); fx.crate.position.y += 1.9;
                    fx.crate.rotation.y = t * 1.5;
                    fx.marker.position.copy(fx.crate.position); fx.marker.position.y += 0.9;
                    fx.marker.scale.setScalar(1.6 + Math.sin(t * 6) * 0.3); // a carried crate pulses, visible through walls
                }
            } else {
                fx.crate.visible = false;
                // buried loot stays a secret until someone digs it out (the server clears `buried` on pickup)
                fx.marker.visible = !!body && !s.buried;
                fx.marker.scale.setScalar(1);
                if(body) { fx.marker.position.copy(body.position); fx.marker.position.y += 1.1 + Math.sin(t * 2 + id.length) * 0.1; }
            }
            fx.marker.rotation.y = t;
        }
    }
}

/** Grenades and busters blink faster as their fuse runs down. */
export class FuseFxSystem {
    update(world) {
        let now = performance.now();
        for(let [id, fuse] of world.each('Fuse')) {
            let m = world.get(id, '$Mesh')?.object;
            if(!m || !m.material) continue;
            let fx = world.get(id, '$FuseFx') || world.add(id, '$FuseFx', { seen: now });
            let age = (now - fx.seen) / 1000;
            let rate = 3 + age * 3;
            let on = Math.sin(age * rate * Math.PI) > 0;
            m.material.emissive?.setHex(on ? (fuse.kind === 'buster' ? 0xff2200 : 0xff8800) : 0x000000);
        }
    }
}

/** Explosions: a flash sphere that grows and fades, plus a handful of debris cubes. Not an ECS system. */
export class ExplosionFx {
    constructor(scene) {
        this.scene = scene;
        this.effects = [];
        this.sphereGeometry = new THREE.SphereGeometry(1, 16, 12);
        this.debrisGeometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        this.debrisMaterial = new THREE.MeshStandardMaterial({ color: 0x5a4a3a });
    }
    spawn(position, radius, kind) {
        let color = kind === 'buster' ? 0xff3300 : 0xffaa33;
        let flash = new THREE.Mesh(this.sphereGeometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
        flash.position.copy(position);
        this.scene.add(flash);
        let debris = [];
        for(let i = 0; i < 14; i++) {
            let d = new THREE.Mesh(this.debrisGeometry, this.debrisMaterial);
            d.position.copy(position);
            d.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.2 + 0.3, (Math.random() - 0.5) * 2).normalize().multiplyScalar(8 + Math.random() * 10 * radius / 3);
            d.userData.spin = new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6);
            d.scale.setScalar(0.5 + Math.random() * radius / 3);
            this.scene.add(d);
            debris.push(d);
        }
        this.effects.push({ flash, debris, t: 0, radius });
    }
    update(dt) {
        for(let e of this.effects) {
            e.t += dt;
            let k = e.t / 0.45;
            if(k < 1) { e.flash.scale.setScalar(e.radius * (0.3 + k * 1.1)); e.flash.material.opacity = 0.9 * (1 - k); }
            else if(e.flash.parent) { e.flash.removeFromParent(); e.flash.material.dispose(); }
            for(let d of e.debris) {
                d.userData.vel.y -= 40 * dt;
                d.position.addScaledVector(d.userData.vel, dt);
                d.rotation.x += d.userData.spin.x * dt; d.rotation.y += d.userData.spin.y * dt;
            }
        }
        this.effects = this.effects.filter(e => { if(e.t < 1.4) return true; for(let d of e.debris) d.removeFromParent(); return false; });
    }
}

export const teamColorOf = (config, team) => (config?.teams?.[team]?.color) || TEAM_DEFAULTS[team]?.color || '#ffffff';
