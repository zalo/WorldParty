/** PhysX (WASM) integration for the server ECS.
 *
 *  Persistent components describe what should exist (RigidBody, Joint,
 *  Grabbed, Player). The systems here materialize the matching PhysX
 *  objects into transient components ($PxBody, $PxJoint, $Grab,
 *  $PxKinematic) and tear them down when the persistent side goes away.
 *  That makes spawning, loading from storage, and migrating between hosts
 *  the same operation: create the entity, let the systems catch up.
 */
import PhysXInit from '../../assets/physx/physx-js-webidl.mjs';
import physxWasm from '../../assets/physx/physx-js-webidl.wasm';
import { PROP_HULLS } from '../props/PropHulls.js';
import { decodeSoup, decodeHulls } from '../net/codec.js';
import { chunkCenter, HALF } from '../terrain/grid.js';
import { DEFAULT_BODY_GRAVITY } from '../gravity.js';

const BODY_DENSITY = 500.0;
const REPLICATE_EVERY_N_TICKS = 2; // 30Hz tick -> 15Hz body replication
const KILL_PLANE_Y = -100;
/** Mass-normalized kinetic energy below which rubble sleeps: 4x the PhysX default of 5e-5 * speed², with the typical
 *  speed taken as gravity * 1 s as PhysX recommends (contact jitter in a resting pile scales with gravity, so a fixed
 *  threshold tuned at 1 g keeps every fragment awake under heavy gravity). Debris rocking in a pile is what keeps the
 *  tick expensive, so it settles a little sooner than props. */
const fragmentSleepThreshold = (gravity) => 4 * 5e-5 * gravity * gravity;

export class Physics {
    constructor() {
        this.px = null;
        this.scene = null;
        this.physics = null;
        this.cookingParams = null;
        this.material = null;
        this.filterData = null;
        /** @type {Record<number, any>} chunk index -> static actor */
        this.chunkActors = {};
        this.tick = 0;
        this.lastTime = Date.now();
        this.wasmMemory = null;
    }

    /** Size of PhysX's WASM heap in MB. */
    heapMB() { return this.wasmMemory ? this.wasmMemory.buffer.byteLength / 1048576 : 0; }

    async init() {
        this.px = await PhysXInit({
            instantiateWasm: (imports, callback) => {
                const instance = new WebAssembly.Instance(physxWasm, imports);
                this.wasmMemory = Object.values(instance.exports).find(e => e instanceof WebAssembly.Memory);
                callback(instance);
                return instance.exports;
            }
        });
        let px = this.px;
        let version = px.PHYSICS_VERSION;
        let foundation = px.CreateFoundation(version, new px.PxDefaultAllocator(), new px.PxDefaultErrorCallback());
        let tolerances = new px.PxTolerancesScale();
        tolerances.set_speed(DEFAULT_BODY_GRAVITY); // typical speed (PhysX: gravity * 1 s); sleep and bounce thresholds derive from it
        this.physics = px.CreatePhysics(version, foundation, tolerances);

        let sceneDesc = new px.PxSceneDesc(tolerances);
        sceneDesc.set_gravity(new px.PxVec3(0, -DEFAULT_BODY_GRAVITY, 0));
        sceneDesc.set_cpuDispatcher(px.DefaultCpuDispatcherCreate(0));
        sceneDesc.set_filterShader(px.DefaultFilterShader());
        this.scene = this.physics.createScene(sceneDesc);

        // Restitution near zero: terrain, rubble and crates land dead (0.6 had them bouncing like rubber, and under heavy
        // gravity nearly every contact is above the bounce threshold)
        this.material = this.physics.createMaterial(0.5, 0.5, 0.05);
        this.playerMaterial = this.physics.createMaterial(0.5, 0.5, 0.0);
        this.cookingParams = new px.PxCookingParams(tolerances);
        this.filterData = new px.PxFilterData(1, 1, 0, 0); // required by DefaultFilterShader

        this.tmpVec = new px.PxVec3(0, 0, 0);
        this.tmpQuat = new px.PxQuat(0, 0, 0, 1);
        this.tmpPose = new px.PxTransform(this.tmpVec, this.tmpQuat);
        this.velVec = new px.PxVec3(0, 0, 0);
        // scene queries (rockets)
        this.rayOrigin = new px.PxVec3(0, 0, 0);
        this.rayDir = new px.PxVec3(0, 0, 1);
        this.rayResult = new px.PxRaycastResult(); // hits come back as touches with the default filter, so collect them all and keep the nearest
        this.rayFlags = new px.PxHitFlags(px.PxHitFlagEnum.ePOSITION | px.PxHitFlagEnum.eNORMAL);
        this.rayFilter = new px.PxQueryFilterData();
    }

    // ---- queries and impulses (Fort War) ----------------------------------

    /** Closest blocking hit along a ray against everything in the scene (terrain, bodies, player capsules), or null. */
    /** Nearest hit along the ray, or null; `ignorePtr` skips one actor (a shooter's own capsule). */
    raycast(origin, dir, maxDist, ignorePtr = 0) {
        this.rayOrigin.set_x(origin.x); this.rayOrigin.set_y(origin.y); this.rayOrigin.set_z(origin.z);
        this.rayDir.set_x(dir.x); this.rayDir.set_y(dir.y); this.rayDir.set_z(dir.z);
        let r = this.rayResult;
        if(!this.scene.raycast(this.rayOrigin, this.rayDir, maxDist, r, this.rayFlags, this.rayFilter)) return null;
        let best = null, bestD = Infinity, n = r.getNbAnyHits();
        for(let i = 0; i < n; i++) { let h = r.getAnyHit(i), d = h.get_distance(); if(d < bestD && !(ignorePtr && h.get_actor().ptr === ignorePtr)) { bestD = d; best = h; } }
        if(!best) return null;
        let p = best.get_position(), nm = best.get_normal();
        return { distance: bestD, position: { x: p.get_x(), y: p.get_y(), z: p.get_z() }, normal: { x: nm.get_x(), y: nm.get_y(), z: nm.get_z() }, actorPtr: best.get_actor().ptr };
    }

    /** The entity whose body or player capsule a raycast hit, or null for terrain. */
    entityOfActor(world, ptr) {
        for(let [id, pb] of world.each('$PxBody')) if(pb.actor.ptr === ptr) return id;
        for(let [id, kin] of world.each('$PxKinematic')) if(kin.actor.ptr === ptr) return id;
        return null;
    }

    addVelocity(actor, v) {
        this.velVec.set_x(v.x); this.velVec.set_y(v.y); this.velVec.set_z(v.z);
        actor.addForce(this.velVec, this.px.PxForceModeEnum.eVELOCITY_CHANGE, true);
    }

    setVelocity(actor, v, angular = null) {
        this.velVec.set_x(v.x); this.velVec.set_y(v.y); this.velVec.set_z(v.z);
        actor.setLinearVelocity(this.velVec, true);
        if(angular) { this.velVec.set_x(angular.x); this.velVec.set_y(angular.y); this.velVec.set_z(angular.z); actor.setAngularVelocity(this.velVec, true); }
    }

    /** Hook entity lifecycle so PhysX objects are released with their components. */
    attach(world) {
        world.on('remove', (id, name, data) => {
            if(!this.scene) return;
            if(name === '$PxBody' || name === '$PxKinematic') {
                this.scene.removeActor(data.actor);
            } else if(name === '$PxJoint') {
                data.joint.release();
            } else if(name === '$Grab') {
                data.joint.release();
                this.scene.removeActor(data.anchor);
            }
        });
    }

    // ---- shape helpers ----------------------------------------------------

    _shapeFlags() {
        return new this.px.PxShapeFlags(this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | this.px.PxShapeFlagEnum.eSIMULATION_SHAPE);
    }

    _shape(geom, material = this.material) {
        let shape = this.physics.createShape(geom, material, true, this._shapeFlags());
        shape.setSimulationFilterData(this.filterData);
        return shape;
    }

    _pose(p, q = { x: 0, y: 0, z: 0, w: 1 }) {
        return new this.px.PxTransform(new this.px.PxVec3(p.x, p.y, p.z), new this.px.PxQuat(q.x, q.y, q.z, q.w));
    }

    _setTmpPose(p, q) {
        this.tmpVec.set_x(p.x); this.tmpVec.set_y(p.y); this.tmpVec.set_z(p.z);
        this.tmpQuat.set_x(q.x); this.tmpQuat.set_y(q.y); this.tmpQuat.set_z(q.z); this.tmpQuat.set_w(q.w);
        this.tmpPose.set_p(this.tmpVec);
        this.tmpPose.set_q(this.tmpQuat);
        return this.tmpPose;
    }

    /** Attach one or more shapes for a RigidBody description. Returns true if any shape attached. */
    _attachShapes(body, rb, fragment) {
        let px = this.px;
        let half = rb.halfExtent;
        if(rb.shape === 'sphere') {
            body.attachShape(this._shape(new px.PxSphereGeometry(half)));
            return true;
        }
        if(rb.shape === 'capsule') {
            body.attachShape(this._shape(new px.PxCapsuleGeometry(half * 0.6, half * 0.4)));
            return true;
        }
        if(rb.shape === 'hulls') {
            let hulls = PROP_HULLS[rb.propId];
            let scale = half * 2; // hulls are normalized to unit size
            let attached = false;
            for(let hull of hulls || []) {
                let verts = hull.vertices;
                if(!verts || verts.length < 4) continue;
                let pxVerts = new px.PxArray_PxVec3(verts.length);
                for(let i = 0; i < verts.length; i++) pxVerts.set(i, new px.PxVec3(verts[i][0] * scale, verts[i][1] * scale, verts[i][2] * scale));
                let desc = new px.PxConvexMeshDesc();
                desc.points.set_count(verts.length);
                desc.points.set_stride(12);
                desc.points.set_data(pxVerts.begin());
                desc.flags.raise(px.PxConvexFlagEnum.eCOMPUTE_CONVEX);
                let convex = px.CreateConvexMesh(this.cookingParams, desc);
                if(!convex) { console.warn(`Failed to cook convex hull for ${rb.propId}`); continue; }
                body.attachShape(this._shape(new px.PxConvexMeshGeometry(convex)));
                attached = true;
            }
            if(attached) return true;
            // fall through to box
        }
        if(rb.shape === 'trimesh') {
            if(!fragment) return false;
            // Compound of convex hulls when the fragment has them (cheap, sleeps well); else the exact SDF mesh.
            if(fragment.hulls) {
                let attached = 0;
                for(let pts of decodeHulls(fragment.hulls)) {
                    let convex = this.cookConvex(pts);
                    if(convex) { body.attachShape(this._shape(new px.PxConvexMeshGeometry(convex))); attached++; }
                }
                if(attached) return true;
            }
            let positions = decodeSoup(fragment.data);
            let triMesh = this.cookTriangleMeshSDF(positions);
            if(!triMesh) return false;
            body.attachShape(this._shape(new px.PxTriangleMeshGeometry(triMesh)));
            return true;
        }
        body.attachShape(this._shape(new px.PxBoxGeometry(half, half, half)));
        return true;
    }

    /** Cook the convex hull of a point set (xyz triples); null if PhysX cannot (degenerate or too few points). */
    cookConvex(points) {
        let px = this.px, numVerts = points.length / 3;
        if(numVerts < 4) return null;
        let vptr = px._webidl_malloc(numVerts * 12);
        px.HEAPF32.set(points.subarray(0, numVerts * 3), vptr >> 2);
        let desc = new px.PxConvexMeshDesc();
        desc.points.set_count(numVerts); desc.points.set_stride(12); desc.points.set_data(vptr);
        desc.flags.raise(px.PxConvexFlagEnum.eCOMPUTE_CONVEX);
        let convex = px.CreateConvexMesh(this.cookingParams, desc);
        desc.__destroy__(); px._webidl_free(vptr);
        return convex || null;
    }

    /** Cook a triangle soup with a lazy SDF so it can be used on a dynamic body. */
    cookTriangleMeshSDF(positions) {
        let px = this.px;
        let numVerts = positions.length / 3;
        let numTris = Math.floor(numVerts / 3);
        if(numVerts < 4 || numTris < 1) return null;

        let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for(let i = 0; i < numVerts; i++) for(let a = 0; a < 3; a++) {
            let v = positions[i * 3 + a];
            if(v < min[a]) min[a] = v;
            if(v > max[a]) max[a] = v;
        }
        let longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
        if(longest < 0.01) return null;

        let indices = new Uint32Array(numTris * 3);
        for(let i = 0; i < indices.length; i++) indices[i] = i;
        let { desc, free } = this._meshDesc(positions, indices);
        let sdf = new px.PxSDFDesc();
        sdf.set_spacing(longest / 24);               // ~24 voxels along the longest axis
        sdf.set_subgridSize(0);                      // dense grid (required for lazy mode)
        sdf.set_lazyEvaluation(true);                // compute voxels on demand, no upfront bake
        sdf.set_numThreadsForSdfConstruction(1);     // no threads in WASM
        desc.set_sdfDesc(sdf);

        let triMesh = px.CreateTriangleMesh(this.cookingParams, desc);
        free(); sdf.__destroy__();
        if(!triMesh) console.warn(`SDF cook failed (${numVerts} verts, ${numTris} tris)`);
        return triMesh;
    }

    /** An indexed mesh copied straight into the WASM heap as a PxTriangleMeshDesc (one PxVec3 wrapper per
     *  vertex was most of the cooking time, and leaked). Call free() once the mesh is cooked. */
    _meshDesc(positions, indices) {
        let px = this.px;
        let numVerts = positions.length / 3, numTris = Math.floor(indices.length / 3);
        let vptr = px._webidl_malloc(numVerts * 12), iptr = px._webidl_malloc(numTris * 12);
        px.HEAPF32.set(positions.subarray(0, numVerts * 3), vptr >> 2);
        px.HEAPU32.set(indices.subarray(0, numTris * 3), iptr >> 2);
        let desc = new px.PxTriangleMeshDesc();
        desc.points.set_count(numVerts); desc.points.set_stride(12); desc.points.set_data(vptr);
        desc.triangles.set_count(numTris); desc.triangles.set_stride(12); desc.triangles.set_data(iptr);
        return { desc, free: () => { desc.__destroy__(); px._webidl_free(vptr); px._webidl_free(iptr); } };
    }

    // ---- terrain colliders ------------------------------------------------

    /** Static box collider for an unmodified solid chunk. */
    setDefaultChunkCollider(index, cx, cy, cz, half = 5.0) {
        this._removeChunkActor(index);
        let actor = this.physics.createRigidStatic(this._pose({ x: cx, y: cy, z: cz }));
        actor.attachShape(this._shape(new this.px.PxBoxGeometry(half, half, half)));
        this.scene.addActor(actor);
        this.chunkActors[index] = actor;
    }

    /** Static triangle-mesh collider for a CSG-modified chunk (world-space indexed mesh), or none if `mesh` is null.
     *  Does not wake anything: colliders also come and go with activity, and only a geometry change (a carve or a
     *  shed fragment, see the server's settleNow) should disturb what rests on them. */
    setChunkCollider(index, mesh) {
        this._removeChunkActor(index);
        if(!mesh) return;
        let px = this.px;
        let { positions, indices } = mesh;
        let numVerts = positions.length / 3;
        let numTris = Math.floor(indices.length / 3);
        if(numTris < 1) return;

        let { desc, free } = this._meshDesc(positions, indices);
        if(!desc.isValid()) { console.warn(`Invalid triangle mesh desc for chunk ${index}`); free(); return; }
        let triMesh = px.CreateTriangleMesh(this.cookingParams, desc);
        free();
        if(!triMesh) { console.warn(`Failed to cook triangle mesh for chunk ${index}`); return; }

        let actor = this.physics.createRigidStatic(this._pose({ x: 0, y: 0, z: 0 }));
        actor.attachShape(this._shape(new px.PxTriangleMeshGeometry(triMesh)));
        this.scene.addActor(actor);
        this.chunkActors[index] = actor;
    }

    /** Colliders also go away when a region has nothing awake in it; that must not wake what rests on them
     *  (wakeOnLostTouch = false), or every sleeping body would keep its terrain loaded forever. */
    _removeChunkActor(index) {
        if(this.chunkActors[index]) {
            this.scene.removeActor(this.chunkActors[index], false);
            delete this.chunkActors[index];
        }
    }

    /** Wake the sleeping bodies whose extent reaches into a chunk (plus `margin`) whose geometry changed. Each
     *  woken body costs tick time until it sleeps again, so this is deliberately tight: a carve wakes the rubble it
     *  could have undermined, not every pile in the neighbourhood. */
    wakeNear(key, margin = 0.25) {
        if(!this._world) return;
        let c = chunkCenter(key);
        for(let [, pb, tf, rb] of this._world.each('$PxBody', 'Transform', 'RigidBody')) {
            let p = tf.position, r = HALF + margin + (rb.halfExtent || 0);
            if(Math.abs(p.x - c.x) > r || Math.abs(p.y - c.y) > r || Math.abs(p.z - c.z) > r) continue;
            if(pb.actor.isSleeping()) pb.actor.wakeUp();
        }
    }

    // ---- systems ----------------------------------------------------------

    /** Create PhysX actors for RigidBody entities that don't have one yet. */
    bodySystem(world) {
        for(let [id, rb, tf] of world.each('RigidBody', 'Transform')) {
            if(world.has(id, '$PxBody')) continue;
            let body = this.physics.createRigidDynamic(this._pose(tf.position, tf.quaternion));
            let fragment = world.get(id, 'FragmentMesh');
            if(!this._attachShapes(body, rb, fragment)) {
                console.warn(`Could not build collider for ${id} (${rb.shape}); destroying`);
                world.destroy(id);
                continue;
            }
            this.px.PxRigidBodyExt.prototype.updateMassAndInertia(body, BODY_DENSITY);
            // Under heavy gravity a body falling off the castle covers over 2 m per 30 Hz step, enough to pass through a
            // floor between steps; speculative contacts catch that without a CCD pass or filter-shader support
            body.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eENABLE_SPECULATIVE_CCD, true);
            if(fragment) body.setSleepThreshold(fragmentSleepThreshold(-this.scene.getGravity().get_y()));
            if(rb.frozen || rb.kinematic) body.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, true);
            this.scene.addActor(body);
            world.add(id, '$PxBody', { actor: body });
        }
    }

    /** Kinematic capsules for players, driven by their replicated positions. */
    playerSystem(world, dt) {
        for(let [id, player, tf] of world.each('Player', 'Transform')) {
            let kin = world.get(id, '$PxKinematic');
            let target = { x: tf.position.x, y: tf.position.y + 1.0, z: tf.position.z };
            if(!kin) {
                let actor = this.physics.createRigidDynamic(this._pose(target));
                actor.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, true);
                // Slightly larger than the client capsule so players can push objects
                actor.attachShape(this._shape(new this.px.PxCapsuleGeometry(0.65, 0.6), this.playerMaterial));
                this.scene.addActor(actor);
                kin = world.add(id, '$PxKinematic', { actor, prev: { ...target } });
                continue;
            }
            // Project the kinematic target forward by one step so PhysX sees the
            // player's velocity and transfers momentum on contact.
            let vx = (target.x - kin.prev.x) / dt, vy = (target.y - kin.prev.y) / dt, vz = (target.z - kin.prev.z) / dt;
            kin.prev = { ...target };
            kin.actor.setKinematicTarget(this._setTmpPose(
                { x: target.x + vx * dt, y: target.y + vy * dt, z: target.z + vz * dt },
                { x: 0, y: 0, z: 0, w: 1 }));

            // Wake sleeping bodies near a moving player
            if(Math.sqrt(vx * vx + vy * vy + vz * vz) > 0.5) {
                for(let [bid, pb, btf] of world.each('$PxBody', 'Transform')) {
                    if(!pb.actor.isSleeping()) continue;
                    let dx = btf.position.x - target.x, dy = btf.position.y - target.y, dz = btf.position.z - target.z;
                    if(dx * dx + dy * dy + dz * dz < 9.0) pb.actor.wakeUp();
                }
            }
        }
    }

    /** Materialize joints once both bodies exist; drop joints whose bodies are gone. */
    jointSystem(world) {
        for(let [id, joint] of world.each('Joint')) {
            let a = world.get(joint.bodyA, '$PxBody');
            let b = world.get(joint.bodyB, '$PxBody');
            if(!world.has(joint.bodyA) || !world.has(joint.bodyB)) { world.destroy(id); continue; }
            if(world.has(id, '$PxJoint') || !a || !b) continue;

            let px = this.px;
            let oA = joint.localOffsetA, oB = joint.localOffsetB;
            let q = new px.PxQuat(0, 0, 0, 1);
            let pxJoint = null;
            if(joint.type === 'rope') {
                pxJoint = px.DistanceJointCreate(this.physics, a.actor, this._pose(oA), b.actor, this._pose(oB));
                let tfA = world.get(joint.bodyA, 'Transform').position, tfB = world.get(joint.bodyB, 'Transform').position;
                let dist = Math.hypot(tfA.x + oA.x - tfB.x - oB.x, tfA.y + oA.y - tfB.y - oB.y, tfA.z + oA.z - tfB.z - oB.z);
                pxJoint.setMaxDistance(Math.max(dist, 0.5));
                pxJoint.setDistanceJointFlag(px.PxDistanceJointFlagEnum.eMAX_DISTANCE_ENABLED, true);
                pxJoint.setStiffness(100);
                pxJoint.setDamping(10);
                pxJoint.setDistanceJointFlag(px.PxDistanceJointFlagEnum.eSPRING_ENABLED, true);
            } else if(joint.type === 'weld') {
                pxJoint = px.FixedJointCreate(this.physics, a.actor, this._pose(oA), b.actor, this._pose(oB));
                pxJoint.setBreakForce(100000, 100000);
            } else if(joint.type === 'hinge') {
                let axis = joint.axis || { x: 0, y: 1, z: 0 };
                let hingeQ = new px.PxQuat(0, new px.PxVec3(axis.x, axis.y, axis.z));
                pxJoint = px.RevoluteJointCreate(this.physics,
                    a.actor, new px.PxTransform(new px.PxVec3(oA.x, oA.y, oA.z), hingeQ),
                    b.actor, new px.PxTransform(new px.PxVec3(oB.x, oB.y, oB.z), hingeQ));
            }
            if(!pxJoint) { console.warn(`Unknown joint type ${joint.type}`); world.destroy(id); continue; }
            a.actor.wakeUp(); b.actor.wakeUp();
            world.add(id, '$PxJoint', { joint: pxJoint });
        }
    }

    /** PhysGun holds: a kinematic anchor + D6 spring drive per Grabbed body. */
    grabSystem(world) {
        // Release holds whose Grabbed component is gone
        for(let [id] of world.each('$Grab')) {
            if(!world.has(id, 'Grabbed')) {
                world.remove(id, '$Grab');
                world.remove(id, '$GrabTarget');
                let pb = world.get(id, '$PxBody'); if(pb) pb.actor.wakeUp();
            }
        }
        for(let [id, grabbed, pb] of world.each('Grabbed', '$PxBody')) {
            let grab = world.get(id, '$Grab');
            if(!grab) {
                let px = this.px;
                let pose = pb.actor.getGlobalPose();
                let anchor = this.physics.createRigidDynamic(new px.PxTransform(pose.get_p(), pose.get_q()));
                anchor.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eKINEMATIC, true);
                this.scene.addActor(anchor);
                let identity = new px.PxTransform(px.PxIDENTITYEnum.PxIdentity);
                let joint = px.D6JointCreate(this.physics, anchor, identity, pb.actor, identity);
                for(let axis of ['eX', 'eY', 'eZ', 'eTWIST', 'eSWING1', 'eSWING2']) joint.setMotion(px.PxD6AxisEnum[axis], px.PxD6MotionEnum.eFREE);
                let linear = new px.PxD6JointDrive(5000, 500, Infinity, true);
                joint.setDrive(px.PxD6DriveEnum.eX, linear);
                joint.setDrive(px.PxD6DriveEnum.eY, linear);
                joint.setDrive(px.PxD6DriveEnum.eZ, linear);
                joint.setDrive(px.PxD6DriveEnum.eSLERP, new px.PxD6JointDrive(3000, 300, Infinity, true));
                grab = world.add(id, '$Grab', { anchor, joint });
                pb.actor.wakeUp();
            }
            // Hold targets arrive many times a second; they live in a transient
            // component so they are never replicated or persisted.
            let target = world.get(id, '$GrabTarget');
            if(target) {
                grab.anchor.setKinematicTarget(this._setTmpPose(target.pos, target.quat));
                pb.actor.wakeUp();
            }
        }
    }

    /** Body gravity (m/s², positive down); the room's world config decides it. Wakes everything so piles re-settle. */
    setGravity(world, g) {
        if(Math.abs(this.scene.getGravity().get_y() + g) < 1e-6) return;
        this.scene.setGravity(new this.px.PxVec3(0, -g, 0));
        for(let [id, pb] of world.each('$PxBody')) {
            if(world.has(id, 'FragmentMesh')) pb.actor.setSleepThreshold(fragmentSleepThreshold(g));
            pb.actor.wakeUp();
        }
    }

    /** Toggle frozen (kinematic) state on a body entity. */
    setFrozen(world, id, frozen) {
        let rb = world.get(id, 'RigidBody');
        let pb = world.get(id, '$PxBody');
        if(!rb || !pb) return;
        world.set(id, 'RigidBody', { frozen });
        pb.actor.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, frozen);
        if(!frozen) pb.actor.wakeUp();
    }

    /** Step the scene and write poses back into Transform. Returns true if any body is awake. */
    stepSystem(world) {
        this._world = world;
        let now = Date.now();
        let dt = Math.min((now - this.lastTime) / 1000, 0.05);
        this.lastTime = now;
        if(dt <= 0) return false;

        this.scene.simulate(dt);
        this.scene.fetchResults(true);
        this.tick++;

        let replicate = (this.tick % REPLICATE_EVERY_N_TICKS) === 0;
        let anyAwake = false;
        for(let [id, pb, tf, rb] of world.each('$PxBody', 'Transform', 'RigidBody')) {
            // Kill plane: bodies that leave the world would otherwise fall (and stay awake) forever
            if(pb.actor.getGlobalPose().get_p().get_y() < KILL_PLANE_Y) { world.destroy(id); continue; }
            let sleeping = pb.actor.isSleeping();
            if(sleeping && !rb.frozen && !world.has(id, 'Grabbed')) {
                if(!rb.sleeping) { this._readPose(pb.actor, tf); world.touch(id, 'Transform'); world.set(id, 'RigidBody', { sleeping: true }); }
                continue;
            }
            anyAwake = true;
            if(rb.sleeping) world.set(id, 'RigidBody', { sleeping: false });
            this._readPose(pb.actor, tf);
            if(replicate) world.touch(id, 'Transform');
        }
        return anyAwake;
    }

    _readPose(actor, tf) {
        let pose = actor.getGlobalPose();
        let p = pose.get_p(), q = pose.get_q();
        tf.position.x = p.get_x(); tf.position.y = p.get_y(); tf.position.z = p.get_z();
        tf.quaternion.x = q.get_x(); tf.quaternion.y = q.get_y(); tf.quaternion.z = q.get_z(); tf.quaternion.w = q.get_w();
    }

    /** Run all systems in order for one tick. */
    update(world, dt) {
        this.playerSystem(world, dt);
        this.bodySystem(world);
        this.jointSystem(world);
        this.grabSystem(world);
        return this.stepSystem(world);
    }
}
