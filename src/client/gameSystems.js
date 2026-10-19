/** Fort War client systems: rockets (dead-reckoned between updates), supply markers and carried crates, fuse
 *  blinking, glow rocks, and short-lived explosion effects. */
import * as THREE from 'three/webgpu';
import { SUPPLY, TEAM_DEFAULTS, GLOW_ROCK, virtualRock } from '../game/rules.js';

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

/** A crystal nodule: a low-poly icosphere whose vertices are pushed in and out by a hash of their position (the same
 *  for every face sharing a vertex, so the faces stay joined), drawn to points at both ends of its local y, flat shaded.
 *  Every rock is this, scaled by its radius (stretched along y, `GLOW_ROCK.elongation`) and turned by its spin. */
function lumpyGeometry() {
    let g = new THREE.IcosahedronGeometry(1, 1), pos = g.attributes.position, v = new THREE.Vector3();
    for(let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        let h = Math.imul(Math.round(v.x * 1000) * 73856093 ^ Math.round(v.y * 1000) * 19349663 ^ Math.round(v.z * 1000) * 83492791, 0x9E3779B1) >>> 0;
        let taper = 1 - 0.45 * Math.abs(v.y); // narrower toward the tips
        v.multiplyScalar(0.8 + 0.3 * (h / 4294967296));
        v.x *= taper; v.z *= taper;
        pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundsTree();
    return g;
}

/** Glow rocks: the pebbles the server materialized from the field (src/server/GlowRocks.js). Embedded ones are
 *  instances of one lumpy icosphere per colour with an emissive material, so the probe grid bakes their light into
 *  the tunnels around them (the terrain hides whatever part is still in the ground); a freed one, a body now, gets a
 *  mesh of its own so the snapshot interpolation and the player's collision treat it like any prop. A small pool of
 *  real point lights sits on the rocks nearest the camera, since every light costs every pixel. */
export class GlowRockRenderSystem {
    constructor(parent, scene, camera, fieldFn) {
        this.parent = parent; this.scene = scene; this.camera = camera; this.fieldFn = fieldFn;
        this.geometry = lumpyGeometry();
        this.materials = GLOW_ROCK.colors.map(c => new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(c).multiplyScalar(0.3), emissive: new THREE.Color(c), emissiveIntensity: GLOW_ROCK.emissive, roughness: 0.35, metalness: 0 }));
        this.groups = GLOW_ROCK.colors.map((_, i) => this.makeGroup(i, 256));
        this.lights = Array.from({ length: GLOW_ROCK.light.count }, () => { let l = new THREE.PointLight(0xffffff, 0, GLOW_ROCK.light.distance, GLOW_ROCK.light.decay); scene.add(l); return l; });
        this.colorOf = new Map(); // entity id -> colour index
        this.frame = 0;
        this.tmp = new THREE.Matrix4(); this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion(); this.scl = new THREE.Vector3();
    }
    makeGroup(color, capacity) {
        let mesh = new THREE.InstancedMesh(this.geometry, this.materials[color], capacity);
        mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(mesh);
        return { mesh, ids: [], capacity };
    }
    init(world) {
        this.world = world;
        world.on('remove', (id, name, data) => {
            if(name === '$GlowInst') this.release(data);
            else if(name === 'GlowRock') this.colorOf.delete(id);
        });
        // freed: out of the instances; the next update gives it a mesh of its own
        world.on('set', (id, name, g) => { if(name === 'GlowRock' && g.free && world.has(id, '$GlowInst')) world.remove(id, '$GlowInst'); });
    }
    /** Take an instance out of its group: the last one moves into its slot. */
    release(inst) {
        let grp = this.groups[inst.color], last = grp.ids.length - 1;
        if(inst.index < last) {
            let moved = grp.ids[last];
            grp.ids[inst.index] = moved;
            grp.mesh.getMatrixAt(last, this.tmp); grp.mesh.setMatrixAt(inst.index, this.tmp);
            let mi = this.world.get(moved, '$GlowInst'); if(mi) mi.index = inst.index;
        }
        grp.ids.pop(); grp.mesh.count = grp.ids.length; grp.mesh.instanceMatrix.needsUpdate = true;
    }
    /** Twice the room when a group is full. */
    grow(color) {
        let old = this.groups[color], grp = this.makeGroup(color, old.capacity * 2);
        grp.mesh.instanceMatrix.array.set(old.mesh.instanceMatrix.array.subarray(0, old.ids.length * 16));
        grp.ids = old.ids; grp.mesh.count = grp.ids.length; grp.mesh.instanceMatrix.needsUpdate = true;
        old.mesh.removeFromParent(); old.mesh.dispose();
        this.groups[color] = grp;
    }
    update(world) {
        let field = this.fieldFn();
        if(field) for(let [id, g, tf] of world.each('GlowRock', 'Transform')) {
            if(world.has(id, '$GlowInst') || world.has(id, '$Mesh')) continue;
            let [i, j, k] = g.cell.split(',').map(Number), rock = virtualRock(field, i, j, k);
            if(!rock) continue;
            this.colorOf.set(id, rock.color);
            this.pos.set(tf.position.x, tf.position.y, tf.position.z); this.quat.set(tf.quaternion.x, tf.quaternion.y, tf.quaternion.z, tf.quaternion.w);
            if(g.free) {
                let mesh = new THREE.Mesh(this.geometry, this.materials[rock.color]);
                mesh.position.copy(this.pos); mesh.quaternion.copy(this.quat); mesh.scale.set(rock.radius, rock.radius * GLOW_ROCK.elongation, rock.radius);
                mesh.userData.sharedGeometry = true; mesh.userData.entityId = id; mesh.userData.halfExtent = rock.radius; mesh.userData.collisionBVH = this.geometry.boundsTree;
                this.parent.add(mesh);
                world.add(id, '$Mesh', { object: mesh });
                world.remove(id, '$Snapshot');
                continue;
            }
            let grp = this.groups[rock.color];
            if(grp.ids.length === grp.capacity) { this.grow(rock.color); grp = this.groups[rock.color]; }
            this.tmp.compose(this.pos, this.quat, this.scl.set(rock.radius, rock.radius * GLOW_ROCK.elongation, rock.radius));
            let index = grp.ids.length;
            grp.mesh.setMatrixAt(index, this.tmp); grp.ids.push(id); grp.mesh.count = index + 1; grp.mesh.instanceMatrix.needsUpdate = true;
            world.add(id, '$GlowInst', { color: rock.color, index });
        }
        if(++this.frame % 6 === 0) this.assignLights(world);
        else for(let l of this.lights) { let o = l.userData.follow; if(o) l.position.copy(o.position); } // a rolling rock carries its light
    }
    /** The pool of lights goes to the nearest rocks that show (exposure scales the light: a rock barely out of the wall
     *  barely lights it). */
    assignLights(world) {
        let cam = this.camera.position, reach = (GLOW_ROCK.light.distance * 2) ** 2, cands = [];
        for(let [id, g, tf] of world.each('GlowRock', 'Transform')) {
            if(g.exposure <= 0) continue;
            let o = world.get(id, '$Mesh')?.object, p = o ? o.position : tf.position;
            let d = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2 + (p.z - cam.z) ** 2;
            if(d < reach) cands.push({ d, p, o, g, id });
        }
        cands.sort((a, b) => a.d - b.d);
        this.lights.forEach((l, i) => {
            let c = cands[i];
            if(!c) { l.intensity = 0; l.userData.follow = null; return; }
            l.color.set(GLOW_ROCK.colors[this.colorOf.get(c.id) ?? 0]);
            l.intensity = GLOW_ROCK.light.intensity * (c.g.free ? 1 : 0.35 + 0.65 * c.g.exposure);
            l.position.copy(c.p);
            l.userData.follow = c.o || null;
        });
    }
}

export const teamColorOf = (config, team) => (config?.teams?.[team]?.color) || TEAM_DEFAULTS[team]?.color || '#ffffff';
