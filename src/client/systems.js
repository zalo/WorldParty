/** Client-side ECS systems: turn replicated components into three.js
 *  objects, interpolate replicated transforms, and clean up when entities
 *  or their visual components go away. Every system is a plain object with
 *  update(world, dt) and optional init(world). */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { decodeSoup } from '../net/codec.js';
import { getPropDef } from '../props/PropRegistry.js';

const SNAPSHOT_INTERVAL_MS = 1000 / 15;
const FROZEN_COLOR = 0x8888ff;

const toVec3 = (p) => new THREE.Vector3(p.x, p.y, p.z);
const toQuat = (q) => new THREE.Quaternion(q.x, q.y, q.z, q.w);

/** Removes three.js objects / DOM nodes when their transient component is removed. */
export class SceneCleanupSystem {
    constructor(scene) { this.scene = scene; }
    init(world) {
        world.on('remove', (id, name, data) => {
            if(name === '$Mesh' || name === '$Line') {
                data.object.removeFromParent();
                data.object.traverse?.(o => { if(o.geometry && !o.userData.sharedGeometry) o.geometry.dispose(); });
            } else if(name === '$Label') {
                data.el.remove();
            }
        });
    }
    update() {}
}

/** Records prev/target poses for replicated RigidBody transforms so they can be interpolated. */
export class SnapshotSystem {
    init(world) {
        world.on('set', (id, name, tf) => {
            if(name !== 'Transform' || !world.has(id, 'RigidBody')) return;
            let now = performance.now();
            let mesh = world.get(id, '$Mesh')?.object;
            let snap = world.get(id, '$Snapshot');
            let target = { pos: toVec3(tf.position), quat: toQuat(tf.quaternion), time: now + SNAPSHOT_INTERVAL_MS };
            if(!snap || !mesh) {
                world.add(id, '$Snapshot', { prev: { pos: target.pos.clone(), quat: target.quat.clone(), time: now }, target });
            } else {
                snap.prev.pos.copy(mesh.position); snap.prev.quat.copy(mesh.quaternion); snap.prev.time = now;
                snap.target = target;
            }
        });
    }
    update(world) {
        let now = performance.now();
        for(let [, m, snap] of world.each('$Mesh', '$Snapshot')) {
            let duration = snap.target.time - snap.prev.time;
            if(duration <= 0) duration = SNAPSHOT_INTERVAL_MS;
            let t = Math.max(0, Math.min((now - snap.prev.time) / duration, 1.0));
            m.object.position.lerpVectors(snap.prev.pos, snap.target.pos, t);
            m.object.quaternion.slerpQuaternions(snap.prev.quat, snap.target.quat, t);
        }
    }
}

/** Builds meshes for RigidBody entities (props, cubes, terrain fragments) and keeps a BVH for player collision. */
export class BodyRenderSystem {
    constructor(parent, gltfLoader) {
        this.parent = parent;
        this.gltfLoader = gltfLoader;
        this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
        this.boxGeometry.computeBoundsTree();
        this.bvhCache = { box: this.boxGeometry.boundsTree };
    }
    init(world) {
        // Frozen highlight
        world.on('set', (id, name, rb) => {
            if(name !== 'RigidBody' || world.has(id, 'FragmentMesh')) return;
            let obj = world.get(id, '$Mesh')?.object;
            if(obj?.material) obj.material.color.setHex(rb.frozen ? FROZEN_COLOR : getPropDef(rb.propId).color);
        });
    }
    update(world) {
        for(let [id, rb, tf] of world.each('RigidBody', 'Transform')) {
            if(world.has(id, '$Mesh')) continue;
            let fragment = world.get(id, 'FragmentMesh');
            let object = fragment ? this.makeFragmentMesh(fragment, rb) : this.makePlaceholder(rb);
            object.position.copy(toVec3(tf.position));
            object.quaternion.copy(toQuat(tf.quaternion));
            this.register(world, id, object, rb);
            let prop = world.get(id, 'Prop');
            if(prop?.url) this.loadProp(world, id, prop, rb);
        }
    }
    register(world, id, object, rb) {
        object.userData.entityId = id;
        object.userData.halfExtent = rb.halfExtent;
        this.parent.add(object);
        world.add(id, '$Mesh', { object });
        world.remove(id, '$Snapshot'); // re-seed interpolation from the new object
    }
    makePlaceholder(rb) {
        let s = rb.halfExtent * 2;
        let mat = new THREE.MeshStandardMaterial({ color: rb.frozen ? FROZEN_COLOR : getPropDef(rb.propId).color, roughness: 0.5, metalness: 0.2 });
        let mesh = new THREE.Mesh(this.boxGeometry, mat);
        mesh.scale.set(s, s, s);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.sharedGeometry = true;
        mesh.userData.collisionBVH = this.bvhCache.box;
        return mesh;
    }
    makeFragmentMesh(fragment, rb) {
        let positions = decodeSoup(fragment.data);
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        let indices = new Uint32Array(positions.length / 3);
        for(let i = 0; i < indices.length; i++) indices[i] = i;
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.computeBoundsTree();
        let mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5, metalness: 0.5 }));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.collisionBVH = geometry.boundsTree;
        return mesh;
    }
    loadProp(world, id, prop, rb) {
        this.gltfLoader.load(prop.url, (gltf) => {
            let placeholder = world.get(id, '$Mesh')?.object;
            if(!placeholder) return; // entity went away while loading
            let model = gltf.scene;
            let box = new THREE.Box3().setFromObject(model);
            let size = new THREE.Vector3(); box.getSize(size);
            let scale = (rb.halfExtent * 2) / (Math.max(size.x, size.y, size.z) || 1);
            let center = new THREE.Vector3(); box.getCenter(center);
            model.scale.setScalar(scale);
            model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
            model.traverse(c => { if(c.isMesh) { c.castShadow = c.receiveShadow = true; c.userData.sharedGeometry = true; } });

            let group = new THREE.Group();
            group.add(model);
            group.position.copy(placeholder.position);
            group.quaternion.copy(placeholder.quaternion);
            group.userData.collisionBVH = this.propBVH(prop.propId, model);
            world.remove(id, '$Mesh');
            this.register(world, id, group, rb);
        });
    }
    /** Merged-geometry BVH per prop type, cached, for capsule collision. */
    propBVH(propId, model) {
        if(this.bvhCache[propId]) return this.bvhCache[propId];
        let geoms = [];
        model.updateMatrixWorld(true);
        model.traverse(c => {
            if(!c.isMesh || !c.geometry) return;
            let g = c.geometry.clone().applyMatrix4(c.matrixWorld);
            for(let name of Object.keys(g.attributes)) if(name !== 'position') g.deleteAttribute(name);
            if(!g.index) { let idx = new Uint32Array(g.attributes.position.count); for(let j = 0; j < idx.length; j++) idx[j] = j; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
            geoms.push(g);
        });
        let merged = geoms.length ? mergeGeometries(geoms) : null;
        if(merged) { merged.computeBoundsTree(); this.bvhCache[propId] = merged.boundsTree; }
        return this.bvhCache[propId] || null;
    }
}

/** Remote player avatars with floating name labels. The local player's entity gets no avatar. */
export class PlayerRenderSystem {
    constructor(scene, camera, localId) { this.scene = scene; this.camera = camera; this.localId = localId; }
    init(world) {
        world.on('set', (id, name, player) => {
            if(name === 'Player') { let label = world.get(id, '$Label'); if(label) label.el.textContent = player.name || 'Player'; }
        });
    }
    update(world) {
        for(let [id, player, tf] of world.each('Player', 'Transform')) {
            if(id === this.localId()) continue;
            let m = world.get(id, '$Mesh');
            if(!m) {
                let mesh = new THREE.Mesh(new RoundedBoxGeometry(1.0, 2.0, 1.0, 10, 0.5), new THREE.MeshStandardMaterial({ color: player.color || '#ffffff' }));
                mesh.position.copy(toVec3(tf.position));
                mesh.userData.entityId = id;
                this.scene.add(mesh);
                m = world.add(id, '$Mesh', { object: mesh });
                let el = document.createElement('div');
                el.textContent = player.name || 'Player';
                el.style.cssText = 'position:fixed;color:#fff;font:bold 12px monospace;background:rgba(0,0,0,0.5);padding:2px 6px;border-radius:3px;pointer-events:none;white-space:nowrap;z-index:1500;';
                document.body.appendChild(el);
                world.add(id, '$Label', { el });
            }
            m.object.position.lerp(toVec3(tf.position), 0.1);

            let label = world.get(id, '$Label');
            if(label) {
                let p = m.object.position.clone(); p.y += 1.5; p.project(this.camera);
                if(p.z < 1) {
                    label.el.style.transform = `translate(-50%, -50%) translate(${(p.x * 0.5 + 0.5) * window.innerWidth}px, ${(-p.y * 0.5 + 0.5) * window.innerHeight}px)`;
                    label.el.style.display = 'block';
                } else label.el.style.display = 'none';
            }
        }
    }
}

/** Draws a line between the attachment points of each Joint. */
export class JointRenderSystem {
    constructor(scene) { this.scene = scene; this.material = new THREE.LineBasicMaterial({ color: 0xffaa00 }); this.tmp = new THREE.Vector3(); }
    update(world) {
        for(let [id, joint] of world.each('Joint')) {
            let line = world.get(id, '$Line');
            if(!line) {
                let geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
                let object = new THREE.Line(geom, this.material);
                object.frustumCulled = false;
                this.scene.add(object);
                line = world.add(id, '$Line', { object });
            }
            let a = world.get(joint.bodyA, '$Mesh')?.object, b = world.get(joint.bodyB, '$Mesh')?.object;
            if(!a || !b) continue;
            let pos = line.object.geometry.attributes.position.array;
            this.tmp.set(joint.localOffsetA.x, joint.localOffsetA.y, joint.localOffsetA.z).applyQuaternion(a.quaternion).add(a.position);
            pos[0] = this.tmp.x; pos[1] = this.tmp.y; pos[2] = this.tmp.z;
            this.tmp.set(joint.localOffsetB.x, joint.localOffsetB.y, joint.localOffsetB.z).applyQuaternion(b.quaternion).add(b.position);
            pos[3] = this.tmp.x; pos[4] = this.tmp.y; pos[5] = this.tmp.z;
            line.object.geometry.attributes.position.needsUpdate = true;
        }
    }
}

/** Legacy static models placed by URL. */
export class ModelRenderSystem {
    constructor(parent, gltfLoader) {
        this.parent = parent; this.gltfLoader = gltfLoader;
        this.placeholderGeometry = new THREE.BoxGeometry(2, 2, 2);
        this.placeholderMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
    }
    init(world) {
        world.on('set', (id, name, tf) => {
            if(name !== 'Transform' || !world.has(id, 'Model')) return;
            let obj = world.get(id, '$Mesh')?.object; if(!obj) return;
            obj.quaternion.copy(toQuat(tf.quaternion));
            obj.scale.copy(toVec3(tf.scale));
        });
    }
    update(world) {
        for(let [id, model, tf] of world.each('Model', 'Transform')) {
            let m = world.get(id, '$Mesh');
            if(!m) {
                let mesh = new THREE.Mesh(this.placeholderGeometry, this.placeholderMaterial);
                mesh.userData.sharedGeometry = true;
                mesh.userData.entityId = id;
                mesh.position.copy(toVec3(tf.position)); mesh.quaternion.copy(toQuat(tf.quaternion)); mesh.scale.copy(toVec3(tf.scale));
                this.parent.add(mesh);
                m = world.add(id, '$Mesh', { object: mesh, placeholder: true });
            }
            if(m.placeholder && model.url && !m.loading) {
                m.loading = true;
                this.gltfLoader.load(model.url, (gltf) => {
                    let cur = world.get(id, '$Mesh'); if(!cur) return;
                    gltf.scene.position.copy(cur.object.position); gltf.scene.quaternion.copy(cur.object.quaternion); gltf.scene.scale.copy(cur.object.scale);
                    gltf.scene.userData.entityId = id;
                    gltf.scene.traverse(c => { c.userData.sharedGeometry = true; });
                    world.remove(id, '$Mesh');
                    this.parent.add(gltf.scene);
                    world.add(id, '$Mesh', { object: gltf.scene });
                });
            }
            m.object.position.lerp(toVec3(tf.position), 0.1);
        }
    }
}
