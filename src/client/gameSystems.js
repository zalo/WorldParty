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

/** Glow rocks: the pebbles the server materialized from the field (src/server/GlowRocks.js). They are instances of one
 *  lumpy icosphere per colour with an emissive material (the terrain hides whatever part is still in the ground), and
 *  each one is handed to what lights the tunnel around it (`glow`: the terrain's vertex GI, TerrainGI.setRock, or the
 *  glow volume, GlowLighting, where that does not run): every rock, not a pool of point lights on the nearest dozen. A rock dug all the way out shatters on the server; the
 *  `glowpop` message brings the sparkle (GlowSparkFx). */
export class GlowRockRenderSystem {
    constructor(scene, fieldFn, glow = null) {
        this.scene = scene; this.fieldFn = fieldFn; this.glow = glow;
        this.geometry = lumpyGeometry();
        this.materials = GLOW_ROCK.colors.map(c => new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(c).multiplyScalar(0.3), emissive: new THREE.Color(c), emissiveIntensity: GLOW_ROCK.emissive, roughness: 0.35, metalness: 0 }));
        this.colors = GLOW_ROCK.colors.map(c => new THREE.Color(c)); // linear
        this.groups = GLOW_ROCK.colors.map((_, i) => this.makeGroup(i, 256));
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
            else if(name === 'GlowRock') this.glow?.removeRock(id);
        });
        // exposure changed: the light follows (a rock barely out of the wall barely lights it)
        world.on('set', (id, name, g) => { if(name === 'GlowRock' && world.has(id, '$GlowInst')) this.light(id, world.get(id, '$GlowInst'), g); });
    }
    /** Hand a rock (again) to what lights with it. */
    light(id, inst, g) {
        if(!this.glow || !inst) return;
        this.glow.setRock(id, inst.x, inst.y, inst.z, inst.radius, this.colors[inst.color], g.free ? 0 : 0.35 + 0.65 * g.exposure);
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
            if(world.has(id, '$GlowInst') || g.free) continue; // free: a body from before rocks shattered (the server removes those)
            let [i, j, k] = g.cell.split(',').map(Number), rock = virtualRock(field, i, j, k);
            if(!rock) continue;
            this.pos.set(tf.position.x, tf.position.y, tf.position.z); this.quat.set(tf.quaternion.x, tf.quaternion.y, tf.quaternion.z, tf.quaternion.w);
            let grp = this.groups[rock.color];
            if(grp.ids.length === grp.capacity) { this.grow(rock.color); grp = this.groups[rock.color]; }
            this.tmp.compose(this.pos, this.quat, this.scl.set(rock.radius, rock.radius * GLOW_ROCK.elongation, rock.radius));
            let index = grp.ids.length;
            grp.mesh.setMatrixAt(index, this.tmp); grp.ids.push(id); grp.mesh.count = index + 1; grp.mesh.instanceMatrix.needsUpdate = true;
            let inst = { color: rock.color, index, x: rock.x, y: rock.y, z: rock.z, radius: rock.radius };
            world.add(id, '$GlowInst', inst);
            this.light(id, inst, g);
        }
    }
}

/** Shattered glow rocks: a burst of tiny shards in the rock's colour, all in one instanced mesh. */
export class GlowSparkFx {
    constructor(scene, capacity = 384) {
        this.capacity = capacity;
        let geometry = new THREE.OctahedronGeometry(1, 0);
        this.mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }), capacity);
        this.mesh.count = 0; this.mesh.frustumCulled = false;
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        scene.add(this.mesh);
        this.sparks = [];
        this.colors = GLOW_ROCK.colors.map(c => new THREE.Color(c).multiplyScalar(2.2)); // brighter than the rock: it is the glow coming out
        this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.e = new THREE.Euler();
    }
    /** rocks: [[x, y, z, colour index], ...] */
    spawn(rocks) {
        for(let [x, y, z, c] of rocks) for(let n = 0; n < 7 && this.sparks.length < this.capacity; n++) {
            let v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3);
            this.sparks.push({ p: new THREE.Vector3(x, y, z), v, t: 0, life: 0.35 + Math.random() * 0.35, size: 0.025 + Math.random() * 0.03, c: this.colors[c] || this.colors[0], spin: Math.random() * 6 });
        }
    }
    update(dt) {
        if(!this.sparks.length && !this.mesh.count) return;
        this.sparks = this.sparks.filter(s => (s.t += dt) < s.life);
        let i = 0;
        for(let s of this.sparks) {
            s.v.y -= 9 * dt; s.p.addScaledVector(s.v, dt);
            let k = 1 - s.t / s.life;
            this.q.setFromEuler(this.e.set(s.spin * s.t, s.spin * s.t * 0.7, 0));
            this.m.compose(s.p, this.q, this.s.setScalar(s.size * k));
            this.mesh.setMatrixAt(i, this.m); this.mesh.setColorAt(i, s.c);
            i++;
        }
        this.mesh.count = i;
        this.mesh.instanceMatrix.needsUpdate = true;
        if(this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
}

export const teamColorOf = (config, team) => (config?.teams?.[team]?.color) || TEAM_DEFAULTS[team]?.color || '#ffffff';
