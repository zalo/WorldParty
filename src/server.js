/* eslint-env browser */

// @ts-check
/** @typedef {import("partykit/server").Room} Room */
/** @typedef {import("partykit/server").Server} Server */
/** @typedef {import("partykit/server").Connection} Connection */
/** @typedef {import("partykit/server").ConnectionContext} ConnectionContext */

import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ADDITION, INTERSECTION, SUBTRACTION, Brush, Evaluator } from 'three-bvh-csg';
import { gzipSync, gunzipSync } from 'three/examples/jsm/libs/fflate.module.js';

import { M } from '../assets/manifold-3d/manifold.js';
import manMod from '../assets/manifold-3d/manifold.wasm';
/** @typedef {import("../assets/manifold-3d/manifold.js").Manifold} Manifold */
/** @typedef {import("../assets/manifold-3d/manifold.js").ManifoldToplevel} ManifoldToplevel */
/** @typedef {import("../assets/manifold-3d/manifold.js").Mesh} Mesh */
/** @typedef {import("../assets/manifold-3d/manifold.js").Vec3} Vec3 */

import PhysXInit from '../assets/physx/physx-js-webidl.mjs';
import physxWasm from '../assets/physx/physx-js-webidl.wasm';
import { PROP_HULLS } from './props/PropHulls.js';

const PHYS_CUBE_COUNT = 12;
const PHYS_CUBE_HALF = 0.5;

// shape: 'box'|'sphere'|'capsule'|'hulls' — analytic shapes are faster and more accurate
const PROP_DEFS = {
  barrel:  { half: 0.5, shape: 'hulls',   url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/barrel/model.gltf" },
  crate:   { half: 0.5, shape: 'box',     url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/sci-fi-crate/model.gltf" },
  chest:   { half: 0.4, shape: 'box',     url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/chest/model.gltf" },
  bench:   { half: 0.5, shape: 'hulls',   url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/bench/model.gltf" },
  ball:    { half: 0.3, shape: 'sphere',  url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/cannon-ball/model.gltf" },
  can:     { half: 0.15,shape: 'hulls',   url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/soda-can/model.gltf" },
  pot:     { half: 0.3, shape: 'hulls',   url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/pot/model.gltf" },
  tower:   { half: 0.6, shape: 'hulls',   url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/tower/model.gltf" },
  board:   { half: 0.3, shape: 'box',     url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/cutting-board/model.gltf" },
  sword:   { half: 0.2, shape: 'hulls',   url: "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/sword/model.gltf" },
};

/** @implements {Server} */
class PartyServer {
  /** @param {Room} room */
  constructor(room) {
    this.playerColors = ["#FF0000", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#FF8000", "#FF0080", "#8000FF", "#0080FF", "#80FF00", "#00FF80", "#FF8080", "#8080FF", "#FF80FF", "#80FFFF", "#FFFF80", "#FF80FF"];

    /** @type {Room} */
    this.room = room;

    /** @type {Record<string, { name: string, id:string, position: { x: number, y: number, z: number }, color:string | null}>} */
    this.players = {};
    /** @type {Record<number, { index:number, data: string, manifold: Manifold | null}>} */
    this.chunks = {};
    /** @type {Record<string, { id:string, url: string, position: { x: number, y: number, z: number }, quaternion: { x: number, y: number, z: number, w: number }, scale: { x: number, y: number, z: number }, selectedBy: string }> } */
    this.models = {};
    this.globalPlayerCount = 0;

    /** @type {Record<string, boolean>} */
    this.needsUpdate = {};

    // PhysX state
    this.px = null;
    this.pxScene = null;
    this.pxPhysics = null;
    this.pxCookingParams = null;
    this.pxMaterial = null;
    /** @type {Array<{body: any, id: string, sleeping: boolean}>} */
    this.physBodies = [];
    /** @type {Record<string, any>} */
    this.playerKinematics = {};
    /** @type {Record<number, any>} - Static physics actors for chunk terrain */
    this.chunkPhysActors = {};
    /** @type {Record<string, {id:string, type:string, bodyIdA:string, bodyIdB:string, pxJoint:any}>} */
    this.joints = {};
    this.jointCounter = 0;
    this.lastPhysTime = Date.now();

    this.updateCounter = 0;
    this.hasNewInfoToSend = false;
    this.serverTickMs = 0;
    this.interval = setInterval(() => {
      let tickStart = Date.now();

      // Step physics
      this.stepPhysics();

      if(!this.hasNewInfoToSend) return;

      // Physics bodies only at 15Hz (every other tick of the 30Hz loop)
      let includePhys = (this.updateCounter % 2 === 0);

      if(this.updateCounter % 300 === 0){
        let msg = {
          type: "fullupdate",
          players: this.players,
          chunks: this.getSerializableChunks(),
          models: this.models,
          physBodies: this.getPhysBodiesState(),
          joints: this.getJointsState(),
          serverTickMs: this.serverTickMs
        };
        this.room.broadcast(JSON.stringify(msg));
      } else {
        let partialUpdate = { type: "partialupdate", players: {}, chunks: {}, models: {}, serverTickMs: this.serverTickMs };
        for(let player in this.players){
          if(this.needsUpdate[player]){
            partialUpdate.players[player] = this.players[player];
            this.needsUpdate[player] = false;
          }
        }
        for(let chunkIndex in this.chunks){
          if(this.needsUpdate[""+chunkIndex]){
            partialUpdate.chunks[chunkIndex] = { index: this.chunks[chunkIndex].index, data: this.chunks[chunkIndex].data };
            this.needsUpdate[""+chunkIndex] = false;
          }
        }

        for(let modelId in this.models){
          if(this.needsUpdate[""+modelId]){
            partialUpdate.models[modelId] = this.models[modelId];
            this.needsUpdate[""+modelId] = false;
          }
        }

        // Only include awake physics bodies at 15Hz
        if(includePhys) {
          let awakePhysBodies = this.getAwakePhysBodiesState();
          if(awakePhysBodies) {
            partialUpdate.physBodies = awakePhysBodies;
          }
        }

        this.room.broadcast(JSON.stringify(partialUpdate));
      }
      this.updateCounter += 1;
      this.hasNewInfoToSend = false;

      this.serverTickMs = Date.now() - tickStart;
    }, 1000/30);
  }

  /** Strip non-serializable manifold objects from chunks for storage/broadcast */
  getSerializableChunks() {
    let result = {};
    for(let key in this.chunks) {
      result[key] = { index: this.chunks[key].index, data: this.chunks[key].data };
    }
    return result;
  }

  /** Get all physics body states (for full updates) */
  getPhysBodiesState() {
    let result = {};
    for(let b of this.physBodies) {
      let pose = b.body.getGlobalPose();
      let p = pose.get_p();
      let q = pose.get_q();
      let entry = {
        id: b.id,
        position: { x: p.get_x(), y: p.get_y(), z: p.get_z() },
        quaternion: { x: q.get_x(), y: q.get_y(), z: q.get_z(), w: q.get_w() },
        halfExtent: b.halfExtent || PHYS_CUBE_HALF,
        propId: b.propId || null,
        propUrl: b.propUrl || null,
        frozen: b.frozen || false
      };
      if(b.meshData) entry.meshData = b.meshData;
      result[b.id] = entry;
    }
    return result;
  }

  /** Get only awake physics body states (for partial updates), returns null if all sleeping */
  getAwakePhysBodiesState() {
    let result = {};
    let hasAny = false;
    for(let b of this.physBodies) {
      if(!b.body.isSleeping() || b.frozen) {
        let pose = b.body.getGlobalPose();
        let p = pose.get_p();
        let q = pose.get_q();
        let entry = {
          id: b.id,
          position: { x: p.get_x(), y: p.get_y(), z: p.get_z() },
          quaternion: { x: q.get_x(), y: q.get_y(), z: q.get_z(), w: q.get_w() },
          halfExtent: b.halfExtent || PHYS_CUBE_HALF,
          propId: b.propId || null,
          propUrl: b.propUrl || null,
          frozen: b.frozen || false
        };
        if(b.meshData) entry.meshData = b.meshData;
        result[b.id] = entry;
        hasAny = true;
      }
    }
    return hasAny ? result : null;
  }

  stepPhysics() {
    if(!this.pxScene) return;

    let now = Date.now();
    let dt = Math.min((now - this.lastPhysTime) / 1000, 0.05);
    this.lastPhysTime = now;
    if(dt <= 0) return;

    // Update player kinematic actors — compute velocity and project target forward
    for(let playerId in this.players) {
      let kin = this.playerKinematics[playerId];
      if(!kin) continue;
      let player = this.players[playerId];
      let pos = player.position;
      let newX = pos.x;
      let newY = pos.y + 1.0;
      let newZ = pos.z;

      // Compute velocity from position delta
      let prev = player._prevPhysPos || { x: newX, y: newY, z: newZ };
      let vx = 0, vy = 0, vz = 0;
      if(dt > 0) {
        vx = (newX - prev.x) / dt;
        vy = (newY - prev.y) / dt;
        vz = (newZ - prev.z) / dt;
      }
      player._prevPhysPos = { x: newX, y: newY, z: newZ };
      player._velocity = { x: vx, y: vy, z: vz };
      let speed = Math.sqrt(vx*vx + vy*vy + vz*vz);

      // Project kinematic target forward by one timestep using velocity
      // This ensures PhysX sees the kinematic moving at the player's speed,
      // transferring proper momentum to dynamic bodies on contact
      let targetX = newX + vx * dt;
      let targetY = newY + vy * dt;
      let targetZ = newZ + vz * dt;

      this.pxTmpVec.set_x(targetX);
      this.pxTmpVec.set_y(targetY);
      this.pxTmpVec.set_z(targetZ);
      this.pxTmpQuat.set_x(0); this.pxTmpQuat.set_y(0);
      this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(1);
      this.pxTmpPose.set_p(this.pxTmpVec);
      this.pxTmpPose.set_q(this.pxTmpQuat);
      kin.setKinematicTarget(this.pxTmpPose);

      // Wake up sleeping bodies near a moving player
      if(speed > 0.5) {
        for(let b of this.physBodies) {
          if(b.body.isSleeping()) {
            let bpose = b.body.getGlobalPose();
            let bp = bpose.get_p();
            let dx = bp.get_x() - newX;
            let dy = bp.get_y() - newY;
            let dz = bp.get_z() - newZ;
            let dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if(dist < 3.0) {
              b.body.wakeUp();
            }
          }
        }
      }
    }

    this.pxScene.simulate(dt);
    this.pxScene.fetchResults(true);

    // Check if any body is awake — if so, mark update needed
    for(let b of this.physBodies) {
      if(!b.body.isSleeping()) {
        this.hasNewInfoToSend = true;
        break;
      }
    }
  }

  /** Spawn a physics cube at the given position */
  spawnPhysCube(x, y, z, half) {
    if(!this.px || !this.pxScene) return null;
    let boxGeom = new this.px.PxBoxGeometry(half, half, half);
    let bv = new this.px.PxVec3(x, y, z);
    let bq = new this.px.PxQuat(0, 0, 0, 1);
    let bpose = new this.px.PxTransform(bv, bq);
    let shapeFlags = new this.px.PxShapeFlags(
      this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
      this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
    );
    let boxShape = this.pxPhysics.createShape(boxGeom, this.pxMaterial, true, shapeFlags);
    boxShape.setSimulationFilterData(this.pxFilterData);
    let box = this.pxPhysics.createRigidDynamic(bpose);
    box.attachShape(boxShape);
    this.px.PxRigidBodyExt.prototype.updateMassAndInertia(box, 500.0);
    this.pxScene.addActor(box);
    let id = "phys_" + (this.physBodyCounter++);
    this.physBodies.push({ body: box, id: id, halfExtent: half });
    this.hasNewInfoToSend = true;
    console.log(`Spawned phys cube ${id} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) half=${half}`);
    return id;
  }

  /** Spawn a prop with CoACD convex hull colliders */
  spawnPropWithHulls(x, y, z, half, hulls, propId, propUrl) {
    if(!this.px || !this.pxScene) return null;
    let scale = half * 2; // hulls are normalized to unit size

    let bv = new this.px.PxVec3(x, y, z);
    let bq = new this.px.PxQuat(0, 0, 0, 1);
    let bpose = new this.px.PxTransform(bv, bq);
    let body = this.pxPhysics.createRigidDynamic(bpose);

    let attachedAny = false;
    for(let hull of hulls) {
      let verts = hull.vertices;
      if(!verts || verts.length < 4) continue;

      // Create PxArray with scaled vertices
      let pxVerts = new this.px.PxArray_PxVec3(verts.length);
      for(let i = 0; i < verts.length; i++) {
        let v = new this.px.PxVec3(verts[i][0] * scale, verts[i][1] * scale, verts[i][2] * scale);
        pxVerts.set(i, v);
      }

      let desc = new this.px.PxConvexMeshDesc();
      desc.points.set_count(verts.length);
      desc.points.set_stride(12);
      desc.points.set_data(pxVerts.begin());
      desc.flags.raise(this.px.PxConvexFlagEnum.eCOMPUTE_CONVEX);

      let convexMesh = this.px.CreateConvexMesh(this.pxCookingParams, desc);
      if(!convexMesh) {
        console.warn(`Failed to cook convex hull for ${propId}`);
        continue;
      }

      let convexGeom = new this.px.PxConvexMeshGeometry(convexMesh);
      let sf = new this.px.PxShapeFlags(
        this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
        this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
      );
      let shape = this.pxPhysics.createShape(convexGeom, this.pxMaterial, true, sf);
      shape.setSimulationFilterData(this.pxFilterData);
      body.attachShape(shape);
      attachedAny = true;
    }

    if(!attachedAny) {
      // Fallback to box if all hulls failed
      let boxGeom = new this.px.PxBoxGeometry(half, half, half);
      let sf = new this.px.PxShapeFlags(
        this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
        this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
      );
      let shape = this.pxPhysics.createShape(boxGeom, this.pxMaterial, true, sf);
      shape.setSimulationFilterData(this.pxFilterData);
      body.attachShape(shape);
    }

    this.px.PxRigidBodyExt.prototype.updateMassAndInertia(body, 500.0);
    this.pxScene.addActor(body);
    let id = "phys_" + (this.physBodyCounter++);
    this.physBodies.push({ body, id, halfExtent: half, propId, propUrl: propUrl || null });
    this.hasNewInfoToSend = true;
    console.log(`Spawned prop ${propId} (${id}) with ${hulls.length} convex hulls at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
    return id;
  }

  /** Spawn a prop with the appropriate collider type based on PROP_DEFS.shape */
  spawnPropBody(x, y, z, def, propId) {
    if(!this.px || !this.pxScene) return null;
    let half = def.half;

    let bv = new this.px.PxVec3(x, y, z);
    let bq = new this.px.PxQuat(0, 0, 0, 1);
    let bpose = new this.px.PxTransform(bv, bq);
    let body = this.pxPhysics.createRigidDynamic(bpose);

    let sf = new this.px.PxShapeFlags(
      this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
      this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
    );

    let shape = null;
    if(def.shape === 'sphere') {
      let geom = new this.px.PxSphereGeometry(half);
      shape = this.pxPhysics.createShape(geom, this.pxMaterial, true, sf);
    } else if(def.shape === 'capsule') {
      // PhysX capsule: radius + halfHeight along X axis
      let geom = new this.px.PxCapsuleGeometry(half * 0.6, half * 0.4);
      shape = this.pxPhysics.createShape(geom, this.pxMaterial, true, sf);
    } else if(def.shape === 'hulls') {
      let hulls = PROP_HULLS[propId];
      if(hulls && hulls.length > 0) {
        let id = this.spawnPropWithHulls(x, y, z, half, hulls, propId, def.url);
        return id; // spawnPropWithHulls handles everything
      }
      // Fallback to box
      let geom = new this.px.PxBoxGeometry(half, half, half);
      shape = this.pxPhysics.createShape(geom, this.pxMaterial, true, sf);
    } else {
      // Default: box
      let geom = new this.px.PxBoxGeometry(half, half, half);
      shape = this.pxPhysics.createShape(geom, this.pxMaterial, true, sf);
    }

    if(shape) {
      shape.setSimulationFilterData(this.pxFilterData);
      body.attachShape(shape);
    }

    this.px.PxRigidBodyExt.prototype.updateMassAndInertia(body, 500.0);
    this.pxScene.addActor(body);
    let id = "phys_" + (this.physBodyCounter++);
    this.physBodies.push({ body, id, halfExtent: half, propId, propUrl: def.url || null });
    this.hasNewInfoToSend = true;
    console.log(`Spawned ${def.shape || 'box'} prop ${propId} (${id}) at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
    return id;
  }

  // --- PhysGun: D6 joint with spring drives (keeps body dynamic for collisions) ---

  physGunGrab(playerId, bodyId) {
    if(!this.px || !this.pxScene) return;
    let bodyEntry = this.physBodies.find(b => b.id === bodyId);
    if(!bodyEntry || bodyEntry.grabbedBy) return;

    let body = bodyEntry.body;
    body.wakeUp();

    // Create an anchor (invisible kinematic body at the object's current position)
    let pose = body.getGlobalPose();
    let anchorPose = new this.px.PxTransform(pose.get_p(), pose.get_q());
    let anchor = this.pxPhysics.createRigidDynamic(anchorPose);
    anchor.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    let sf = new this.px.PxShapeFlags(0); // No collision shape needed
    this.pxScene.addActor(anchor);

    // Create D6 joint between anchor and body with spring drives
    let identityPose = new this.px.PxTransform(this.px.PxIDENTITYEnum.PxIdentity);
    let joint = this.px.D6JointCreate(this.pxPhysics, anchor, identityPose, body, identityPose);

    // Free all axes, driven by springs
    joint.setMotion(this.px.PxD6AxisEnum.eX, this.px.PxD6MotionEnum.eFREE);
    joint.setMotion(this.px.PxD6AxisEnum.eY, this.px.PxD6MotionEnum.eFREE);
    joint.setMotion(this.px.PxD6AxisEnum.eZ, this.px.PxD6MotionEnum.eFREE);
    joint.setMotion(this.px.PxD6AxisEnum.eTWIST, this.px.PxD6MotionEnum.eFREE);
    joint.setMotion(this.px.PxD6AxisEnum.eSWING1, this.px.PxD6MotionEnum.eFREE);
    joint.setMotion(this.px.PxD6AxisEnum.eSWING2, this.px.PxD6MotionEnum.eFREE);

    // Strong position + rotation spring drives
    let linearDrive = new this.px.PxD6JointDrive(5000, 500, Infinity, true);
    joint.setDrive(this.px.PxD6DriveEnum.eX, linearDrive);
    joint.setDrive(this.px.PxD6DriveEnum.eY, linearDrive);
    joint.setDrive(this.px.PxD6DriveEnum.eZ, linearDrive);

    let angularDrive = new this.px.PxD6JointDrive(3000, 300, Infinity, true);
    joint.setDrive(this.px.PxD6DriveEnum.eSLERP, angularDrive);

    bodyEntry.grabbedBy = playerId;
    bodyEntry.grabJoint = joint;
    bodyEntry.grabAnchor = anchor;
    this.hasNewInfoToSend = true;
    console.log(`PhysGun grab: ${bodyId} by ${playerId}`);
  }

  physGunMove(playerId, bodyId, targetPos, targetQuat) {
    let bodyEntry = this.physBodies.find(b => b.id === bodyId);
    if(!bodyEntry || bodyEntry.grabbedBy !== playerId || !bodyEntry.grabAnchor) return;

    // Move the kinematic anchor to the target pose
    this.pxTmpVec.set_x(targetPos.x);
    this.pxTmpVec.set_y(targetPos.y);
    this.pxTmpVec.set_z(targetPos.z);
    this.pxTmpQuat.set_x(targetQuat.x);
    this.pxTmpQuat.set_y(targetQuat.y);
    this.pxTmpQuat.set_z(targetQuat.z);
    this.pxTmpQuat.set_w(targetQuat.w);
    this.pxTmpPose.set_p(this.pxTmpVec);
    this.pxTmpPose.set_q(this.pxTmpQuat);
    bodyEntry.grabAnchor.setKinematicTarget(this.pxTmpPose);

    bodyEntry.body.wakeUp();
    this.hasNewInfoToSend = true;
  }

  physGunRelease(playerId, bodyId) {
    let bodyEntry = this.physBodies.find(b => b.id === bodyId);
    if(!bodyEntry || bodyEntry.grabbedBy !== playerId) return;

    if(bodyEntry.grabJoint) bodyEntry.grabJoint.release();
    if(bodyEntry.grabAnchor) {
      this.pxScene.removeActor(bodyEntry.grabAnchor);
    }
    bodyEntry.grabJoint = null;
    bodyEntry.grabAnchor = null;
    bodyEntry.grabbedBy = null;
    bodyEntry.body.wakeUp();
    this.hasNewInfoToSend = true;
    console.log(`PhysGun release: ${bodyId}`);
  }

  physGunFreeze(bodyId) {
    let bodyEntry = this.physBodies.find(b => b.id === bodyId);
    if(!bodyEntry) return;

    // Release grab if held
    if(bodyEntry.grabJoint) bodyEntry.grabJoint.release();
    if(bodyEntry.grabAnchor) this.pxScene.removeActor(bodyEntry.grabAnchor);
    bodyEntry.grabJoint = null;
    bodyEntry.grabAnchor = null;
    bodyEntry.grabbedBy = null;

    // Toggle frozen state
    bodyEntry.frozen = !bodyEntry.frozen;
    if(bodyEntry.frozen) {
      bodyEntry.body.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    } else {
      bodyEntry.body.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, false);
      bodyEntry.body.wakeUp();
    }
    this.hasNewInfoToSend = true;
    console.log(`PhysGun ${bodyEntry.frozen ? 'freeze' : 'unfreeze'}: ${bodyId}`);
  }

  // --- Constraint Tools ---

  createJoint(data) {
    if(!this.px || !this.pxScene) return;
    let bodyA = this.physBodies.find(b => b.id === data.bodyIdA);
    let bodyB = this.physBodies.find(b => b.id === data.bodyIdB);
    if(!bodyA || !bodyB) return;

    // Compute local frames from world positions
    let poseA = bodyA.body.getGlobalPose();
    let poseB = bodyB.body.getGlobalPose();

    // World pos to local frame (simplified: just offset, no rotation transform)
    let wpA = data.worldPosA;
    let wpB = data.worldPosB;
    let pA = poseA.get_p();
    let pB = poseB.get_p();

    let localA = new this.px.PxVec3(wpA.x - pA.get_x(), wpA.y - pA.get_y(), wpA.z - pA.get_z());
    let localB = new this.px.PxVec3(wpB.x - pB.get_x(), wpB.y - pB.get_y(), wpB.z - pB.get_z());
    let q = new this.px.PxQuat(0, 0, 0, 1);
    let frameA = new this.px.PxTransform(localA, q);
    let frameB = new this.px.PxTransform(localB, q);

    let pxJoint = null;
    let jointId = "joint_" + (this.jointCounter++);

    if(data.jointType === "rope") {
      pxJoint = this.px.DistanceJointCreate(this.pxPhysics, bodyA.body, frameA, bodyB.body, frameB);
      if(pxJoint) {
        let dist = Math.sqrt(
          (wpA.x-wpB.x)**2 + (wpA.y-wpB.y)**2 + (wpA.z-wpB.z)**2
        );
        pxJoint.setMaxDistance(Math.max(dist, 0.5));
        pxJoint.setDistanceJointFlag(this.px.PxDistanceJointFlagEnum.eMAX_DISTANCE_ENABLED, true);
        pxJoint.setStiffness(100);
        pxJoint.setDamping(10);
        pxJoint.setDistanceJointFlag(this.px.PxDistanceJointFlagEnum.eSPRING_ENABLED, true);
      }
    } else if(data.jointType === "weld") {
      pxJoint = this.px.FixedJointCreate(this.pxPhysics, bodyA.body, frameA, bodyB.body, frameB);
      if(pxJoint) {
        pxJoint.setBreakForce(100000, 100000);
      }
    } else if(data.jointType === "hinge") {
      // For hinge, orient frame along the provided axis
      let axis = data.axis || { x: 0, y: 1, z: 0 };
      let axisVec = new this.px.PxVec3(axis.x, axis.y, axis.z);
      let hingeQ = new this.px.PxQuat(0, axisVec);
      let hingeFrameA = new this.px.PxTransform(localA, hingeQ);
      let hingeFrameB = new this.px.PxTransform(localB, hingeQ);
      pxJoint = this.px.RevoluteJointCreate(this.pxPhysics, bodyA.body, hingeFrameA, bodyB.body, hingeFrameB);
    }

    if(pxJoint) {
      // Store local offsets for visual rendering
      let lA = { x: wpA.x - pA.get_x(), y: wpA.y - pA.get_y(), z: wpA.z - pA.get_z() };
      let lB = { x: wpB.x - pB.get_x(), y: wpB.y - pB.get_y(), z: wpB.z - pB.get_z() };
      this.joints[jointId] = {
        id: jointId, type: data.jointType,
        bodyIdA: data.bodyIdA, bodyIdB: data.bodyIdB,
        localOffsetA: lA, localOffsetB: lB,
        pxJoint: pxJoint
      };
      bodyA.body.wakeUp();
      bodyB.body.wakeUp();
      this.hasNewInfoToSend = true;
      console.log(`Created ${data.jointType} joint ${jointId} between ${data.bodyIdA} and ${data.bodyIdB}`);
    }
  }

  removeJoint(jointId) {
    let joint = this.joints[jointId];
    if(!joint) return;
    if(joint.pxJoint) joint.pxJoint.release();
    delete this.joints[jointId];
    this.hasNewInfoToSend = true;
  }

  /** Get serializable joint state for broadcasting */
  getJointsState() {
    let result = {};
    for(let id in this.joints) {
      let j = this.joints[id];
      result[id] = { id: j.id, type: j.type, bodyIdA: j.bodyIdA, bodyIdB: j.bodyIdB, localOffsetA: j.localOffsetA, localOffsetB: j.localOffsetB };
    }
    return result;
  }

  /** Cook a triangle mesh with lazy SDF for dynamic fragment collision.
   *  Lazy SDF allocates the grid but computes voxel values on demand during
   *  collision detection, avoiding the expensive upfront bake. */
  cookTriangleMeshSDF(vertices, indices) {
    let numVerts = vertices.length / 3;
    let numTris = indices.length / 3;
    if(numVerts < 4 || numTris < 1) return null;

    // Compute bounding box for SDF grid spacing
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for(let i = 0; i < numVerts; i++) {
      let x = vertices[i*3], y = vertices[i*3+1], z = vertices[i*3+2];
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }

    let longestAxis = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    if(longestAxis < 0.01) return null;
    // ~24 voxels along longest axis — coarse enough for fast init
    let spacing = longestAxis / 24;

    let inputVerts = new this.px.PxArray_PxVec3(numVerts);
    for(let i = 0; i < numVerts; i++) {
      inputVerts.set(i, new this.px.PxVec3(vertices[i*3], vertices[i*3+1], vertices[i*3+2]));
    }
    let inputTris = new this.px.PxArray_PxU32(indices.length);
    for(let i = 0; i < indices.length; i++) {
      inputTris.set(i, indices[i]);
    }

    let pointsData = new this.px.PxBoundedData();
    pointsData.set_count(numVerts);
    pointsData.set_stride(12);
    pointsData.set_data(inputVerts.begin());

    let trisData = new this.px.PxBoundedData();
    trisData.set_count(numTris);
    trisData.set_stride(12);
    trisData.set_data(inputTris.begin());

    let desc = new this.px.PxTriangleMeshDesc();
    desc.set_points(pointsData);
    desc.set_triangles(trisData);

    // Lazy SDF: dense grid, values computed on demand (no upfront baking)
    let sdfDesc = new this.px.PxSDFDesc();
    sdfDesc.set_spacing(spacing);
    sdfDesc.set_subgridSize(0);                    // dense SDF (required for lazy mode)
    sdfDesc.set_lazyEvaluation(true);              // skip baking — compute on demand
    sdfDesc.set_numThreadsForSdfConstruction(1);   // WASM has no thread support
    desc.set_sdfDesc(sdfDesc);

    let triMesh = this.px.CreateTriangleMesh(this.pxCookingParams, desc);

    // Cleanup temporary WASM objects
    inputVerts.__destroy__();
    inputTris.__destroy__();
    pointsData.__destroy__();
    trisData.__destroy__();
    desc.__destroy__();
    sdfDesc.__destroy__();

    if(!triMesh) {
      console.warn(`SDF cook failed for fragment (${numVerts} verts, ${numTris} tris)`);
    } else {
      console.log(`SDF lazy init: ${numTris} tris, spacing=${spacing.toFixed(2)}`);
    }
    return triMesh;
  }

  /** Spawn a dynamic rigid body from a disconnected terrain fragment manifold.
   *  Uses lazy SDF triangle mesh collider, similar to PhysicsWorkshop props. */
  spawnChunkFragment(fragmentManifold) {
    if(!this.px || !this.pxScene) { fragmentManifold.delete(); return; }

    let mesh = fragmentManifold.getMesh();
    let vertProps = mesh.vertProperties; // Float32Array, 3 floats per vert
    let triVerts = mesh.triVerts;        // Uint32Array, 3 indices per tri
    let numVerts = vertProps.length / 3;
    let numTris = triVerts.length / 3;

    if(numVerts < 4 || numTris < 1) { fragmentManifold.delete(); return; }

    // Compute centroid for body position
    let cx = 0, cy = 0, cz = 0;
    for(let i = 0; i < numVerts; i++) {
      cx += vertProps[i*3];
      cy += vertProps[i*3+1];
      cz += vertProps[i*3+2];
    }
    cx /= numVerts;
    cy /= numVerts;
    cz /= numVerts;

    // Local-space vertices (centred on centroid)
    let localVerts = new Float32Array(vertProps.length);
    for(let i = 0; i < numVerts; i++) {
      localVerts[i*3]   = vertProps[i*3]   - cx;
      localVerts[i*3+1] = vertProps[i*3+1] - cy;
      localVerts[i*3+2] = vertProps[i*3+2] - cz;
    }
    let localIndices = new Uint32Array(triVerts);

    // Cook SDF triangle mesh (lazy — no upfront bake)
    let triMesh = this.cookTriangleMeshSDF(localVerts, localIndices);
    if(!triMesh) {
      console.warn('Failed to cook SDF for chunk fragment, skipping');
      fragmentManifold.delete();
      return;
    }

    // Create PhysX shape + dynamic body
    let triGeom = new this.px.PxTriangleMeshGeometry(triMesh);
    let sf = new this.px.PxShapeFlags(
      this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
      this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
    );
    let shape = this.pxPhysics.createShape(triGeom, this.pxMaterial, true, sf);
    shape.setSimulationFilterData(this.pxFilterData);

    let bv = new this.px.PxVec3(cx, cy, cz);
    let bq = new this.px.PxQuat(0, 0, 0, 1);
    let bpose = new this.px.PxTransform(bv, bq);
    let body = this.pxPhysics.createRigidDynamic(bpose);
    body.attachShape(shape);
    this.px.PxRigidBodyExt.prototype.updateMassAndInertia(body, 500.0);
    this.pxScene.addActor(body);

    // Encode local-space mesh for client replication (non-indexed triangle soup, gzip+base64)
    let nonIndexedPositions = new Float32Array(numTris * 9);
    for(let t = 0; t < numTris; t++) {
      let i0 = localIndices[t*3], i1 = localIndices[t*3+1], i2 = localIndices[t*3+2];
      nonIndexedPositions[t*9  ] = localVerts[i0*3];   nonIndexedPositions[t*9+1] = localVerts[i0*3+1]; nonIndexedPositions[t*9+2] = localVerts[i0*3+2];
      nonIndexedPositions[t*9+3] = localVerts[i1*3];   nonIndexedPositions[t*9+4] = localVerts[i1*3+1]; nonIndexedPositions[t*9+5] = localVerts[i1*3+2];
      nonIndexedPositions[t*9+6] = localVerts[i2*3];   nonIndexedPositions[t*9+7] = localVerts[i2*3+1]; nonIndexedPositions[t*9+8] = localVerts[i2*3+2];
    }
    let compressed = gzipSync(new Uint8Array(nonIndexedPositions.buffer));
    let meshDataStr = this.b64encode(String.fromCharCode.apply(null, compressed));

    // Bounding half-extent for client placeholder sizing
    let halfX = 0, halfY = 0, halfZ = 0;
    for(let i = 0; i < numVerts; i++) {
      halfX = Math.max(halfX, Math.abs(localVerts[i*3]));
      halfY = Math.max(halfY, Math.abs(localVerts[i*3+1]));
      halfZ = Math.max(halfZ, Math.abs(localVerts[i*3+2]));
    }
    let halfExtent = Math.max(halfX, halfY, halfZ);

    let id = "phys_" + (this.physBodyCounter++);
    this.physBodies.push({
      body, id, halfExtent,
      meshData: meshDataStr,
      isFragment: true
    });
    this.hasNewInfoToSend = true;
    console.log(`Spawned chunk fragment ${id}: ${numVerts} verts, ${numTris} tris at (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)})`);

    fragmentManifold.delete();
  }

  /** Rebuild the PhysX static triangle mesh collider for a given chunk index */
  rebuildChunkPhysics(chunkIndex) {
    if(!this.px || !this.pxScene || !this.chunks[chunkIndex]) return;

    // Remove old actor if it exists
    if(this.chunkPhysActors[chunkIndex]) {
      this.pxScene.removeActor(this.chunkPhysActors[chunkIndex]);
      this.chunkPhysActors[chunkIndex] = null;
    }

    // Decode the chunk geometry
    let base64String = this.chunks[chunkIndex].data;
    let binaryString = this.b64decode(base64String.normalize("NFC"));
    let compressed = new Uint8Array(binaryString.length);
    for(let b = 0; b < binaryString.length; b++) {
      compressed[b] = binaryString.charCodeAt(b);
    }
    let positions = new Float32Array(gunzipSync(compressed).buffer);

    // Non-indexed triangle soup: every 3 floats = 1 vertex, every 3 vertices = 1 triangle
    let numVerts = positions.length / 3;
    let numTris = numVerts / 3;
    if(numTris < 1) return;

    // Use PhysX array types for proper WASM memory alignment
    let pxVerts = new this.px.PxArray_PxVec3(numVerts);
    for(let i = 0; i < numVerts; i++) {
      let v = new this.px.PxVec3(positions[i*3], positions[i*3+1], positions[i*3+2]);
      pxVerts.set(i, v);
    }

    let pxIndices = new this.px.PxArray_PxU32(numTris * 3);
    for(let i = 0; i < numTris * 3; i++) {
      pxIndices.set(i, i);
    }

    // Set up triangle mesh descriptor using .begin() for proper WASM pointers
    let desc = new this.px.PxTriangleMeshDesc();
    desc.points.set_count(numVerts);
    desc.points.set_stride(12); // sizeof(PxVec3) = 3 * 4 bytes
    desc.points.set_data(pxVerts.begin());
    desc.triangles.set_count(numTris);
    desc.triangles.set_stride(12); // 3 * sizeof(PxU32) = 3 * 4 bytes
    desc.triangles.set_data(pxIndices.begin());

    if(!desc.isValid()) {
      console.warn(`Invalid triangle mesh desc for chunk ${chunkIndex} (${numVerts} verts, ${numTris} tris)`);
      return;
    }

    // Cook the triangle mesh
    let triMesh = this.px.CreateTriangleMesh(this.pxCookingParams, desc);

    if(!triMesh) {
      console.warn(`Failed to cook triangle mesh for chunk ${chunkIndex} (${numVerts} verts, ${numTris} tris)`);
      return;
    }

    // Create static actor with the triangle mesh (own transform, not shared)
    let triMeshGeom = new this.px.PxTriangleMeshGeometry(triMesh);
    let triShapeFlags = new this.px.PxShapeFlags(
      this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
      this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
    );
    let shape = this.pxPhysics.createShape(triMeshGeom, this.pxMaterial, true, triShapeFlags);
    shape.setSimulationFilterData(this.pxFilterData);
    let poseVec = new this.px.PxVec3(0, 0, 0);
    let poseQuat = new this.px.PxQuat(0, 0, 0, 1);
    let pose = new this.px.PxTransform(poseVec, poseQuat);
    let actor = this.pxPhysics.createRigidStatic(pose);
    actor.attachShape(shape);
    this.pxScene.addActor(actor);
    this.chunkPhysActors[chunkIndex] = actor;
    console.log(`Rebuilt chunk ${chunkIndex} physics: ${numVerts} verts, ${numTris} tris cooked OK`);

    // Wake up any nearby physics bodies so they react to the new terrain
    for(let b of this.physBodies) {
      if(b.body.isSleeping()) {
        b.body.wakeUp();
      }
    }
  }

  async onStart(){
    let storedChunks = await this.room.storage.get("chunks") || {};
    let storedModels = await this.room.storage.get("models") || {};
    this.models = storedModels;

    /** @type {ManifoldToplevel} */
    this.manifold = await M({
      instantiateWasm: (imports, callback) => {
        const instance = new WebAssembly.Instance(manMod, imports);
        callback(instance);
        return instance.exports;
      }
    });
    this.manifold.setup();

    for(let chunk in storedChunks) {
      this.chunks[chunk] = {
        index: storedChunks[chunk].index,
        data: storedChunks[chunk].data,
        manifold: this.base64ToManifold(storedChunks[chunk].data)
      };
    }

    // Initialize PhysX
    this.px = await PhysXInit({
      instantiateWasm: (imports, callback) => {
        const instance = new WebAssembly.Instance(physxWasm, imports);
        callback(instance);
        return instance.exports;
      }
    });

    let version = this.px.PHYSICS_VERSION;
    let allocator = new this.px.PxDefaultAllocator();
    let errorCb = new this.px.PxDefaultErrorCallback();
    let foundation = this.px.CreateFoundation(version, allocator, errorCb);

    let tolerances = new this.px.PxTolerancesScale();
    this.pxPhysics = this.px.CreatePhysics(version, foundation, tolerances);

    let tmpVec = new this.px.PxVec3(0, -9.81, 0);
    let sceneDesc = new this.px.PxSceneDesc(tolerances);
    sceneDesc.set_gravity(tmpVec);
    sceneDesc.set_cpuDispatcher(this.px.DefaultCpuDispatcherCreate(0));
    sceneDesc.set_filterShader(this.px.DefaultFilterShader());
    this.pxScene = this.pxPhysics.createScene(sceneDesc);

    this.pxMaterial = this.pxPhysics.createMaterial(0.5, 0.5, 0.6);
    this.pxCookingParams = new this.px.PxCookingParams(tolerances);
    this.pxShapeFlags = new this.px.PxShapeFlags(
      this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
      this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
    );

    // Filter data required by DefaultFilterShader for collision to work
    this.pxFilterData = new this.px.PxFilterData(1, 1, 0, 0);

    // Reusable temp PhysX objects to avoid per-frame allocation leaks
    this.pxTmpVec = new this.px.PxVec3(0, 0, 0);
    this.pxTmpQuat = new this.px.PxQuat(0, 0, 0, 1);
    this.pxTmpPose = new this.px.PxTransform(this.pxTmpVec, this.pxTmpQuat);
    this.physBodyCounter = 0;

    // Second temp vec for velocity calculations
    this.pxTmpVec2 = new this.px.PxVec3(0, 0, 0);

    // Build default terrain colliders: chunks at y<5 are solid 10-unit boxes
    // Each actor gets its own PxTransform to avoid shared-reference issues
    let defaultChunkGeom = new this.px.PxBoxGeometry(5.0, 5.0, 5.0);
    for(let x = 0; x < 10; x++) {
      for(let y = 0; y < 5; y++) {
        for(let z = 0; z < 10; z++) {
          let chunkIndex = x * 100 + y * 10 + z;
          if(this.chunks[chunkIndex]) continue;
          let cv = new this.px.PxVec3(x * 10.0 - 45.0, y * 10.0 - 45.0, z * 10.0 - 45.0);
          let cq = new this.px.PxQuat(0, 0, 0, 1);
          let cpose = new this.px.PxTransform(cv, cq);
          let sf = new this.px.PxShapeFlags(
            this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
            this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
          );
          let shape = this.pxPhysics.createShape(defaultChunkGeom, this.pxMaterial, true, sf);
          shape.setSimulationFilterData(this.pxFilterData);
          let actor = this.pxPhysics.createRigidStatic(cpose);
          actor.attachShape(shape);
          this.pxScene.addActor(actor);
          this.chunkPhysActors[chunkIndex] = actor;
        }
      }
    }

    // Build triangle mesh colliders for CSG-modified chunks
    for(let chunkIndex in this.chunks) {
      this.rebuildChunkPhysics(parseInt(chunkIndex));
    }

    console.log(`PhysX initialized with 500 terrain chunk colliders`);
  }

  /**
   * @param {Connection} conn - The connection object.
   * @param {ConnectionContext} ctx - The context object. */
  onConnect(conn, ctx) {
    console.log(
      `Connected:
       id: ${conn.id}
       room: ${this.room.id}
       url: ${new URL(ctx.request.url).pathname}`
    );

    this.globalPlayerCount += 1;
    this.players[conn.id] = {
      name: "Player " + this.globalPlayerCount,
      color: this.playerColors[this.globalPlayerCount % this.playerColors.length],
      id: conn.id,
      position: { x: 0, y: 0, z: 0 }
    };
    this.needsUpdate[conn.id] = true;

    // Create a kinematic capsule for this player in the physics scene
    if(this.pxPhysics && this.pxScene) {
      let material = this.pxPhysics.createMaterial(0.5, 0.5, 0.0);
      // Slightly larger than client capsule (0.5 radius) so players push objects
      let capsuleGeom = new this.px.PxCapsuleGeometry(0.65, 0.6);
      let shapeFlags = new this.px.PxShapeFlags(
        this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
        this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
      );
      let shape = this.pxPhysics.createShape(capsuleGeom, material, true, shapeFlags);
      shape.setSimulationFilterData(this.pxFilterData);
      let pv = new this.px.PxVec3(0, 1, 0);
      let pq = new this.px.PxQuat(0, 0, 0, 1);
      let pose = new this.px.PxTransform(pv, pq);
      let kinBody = this.pxPhysics.createRigidDynamic(pose);
      kinBody.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, true);
      kinBody.attachShape(shape);
      this.pxScene.addActor(kinBody);
      this.playerKinematics[conn.id] = kinBody;
    }

    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      chunks: this.getSerializableChunks(),
      models: this.models,
      physBodies: this.getPhysBodiesState()
    }));
  }

  /**
   * @param {string} message
   * @param {Connection} sender */
  async onMessage(message, sender) {
    if(!message.startsWith("{")) return;

    let data = JSON.parse(message);
    if(data.type === "player"){
      this.players[sender.id].position.x = data.position.x;
      this.players[sender.id].position.y = data.position.y;
      this.players[sender.id].position.z = data.position.z;
      this.needsUpdate[sender.id] = true;
    } else if(data.type === "chunk"){
      if(!this.chunks[data.index]){
        this.chunks[data.index] = { index: data.index, data: data.data, manifold: null };
      } else {
        this.chunks[data.index].data = data.data;
      }
      this.needsUpdate[""+data.index] = true;
    } else if(data.type === "csgoperation") {
      if(!this.chunks[data.index]){
        if(!data.originalChunk){ console.error("Received csgoperation without originalChunk for fresh index: " + data.index); return; }
        this.chunks[data.index] = { index: data.index, data: data.originalChunk, manifold: null };
      }

      let scene         = new THREE.Scene();
      let originalChunk = this.base64ToBrush(this.chunks[data.index].data);
      let brush         = this.base64ToBrush(data.brush);
      scene.add(originalChunk);
      scene.add(brush);
      brush.position  .set(
        data.brushPosition.x + ((Math.random()-0.5)*0.0001),
        data.brushPosition.y + ((Math.random()-0.5)*0.0001),
        data.brushPosition.z + ((Math.random()-0.5)*0.0001));
      brush.quaternion.set(
        data.brushQuaternion.x + ((Math.random()-0.5)*0.0001),
        data.brushQuaternion.y + ((Math.random()-0.5)*0.0001),
        data.brushQuaternion.z + ((Math.random()-0.5)*0.0001),
        data.brushQuaternion.w + ((Math.random()-0.5)*0.0001));
      brush.scale     .set(data.brushScale.x, data.brushScale.y, data.brushScale.z);
      brush.updateMatrixWorld(true);
      this.chunks[data.index].data = this.brushToBase64(new Evaluator().evaluate( originalChunk, brush, parseInt(data.operation)));
      this.rebuildChunkPhysics(data.index);
      this.needsUpdate[""+data.index] = true;
    } else if(data.type === "manifoldcsgoperation") {
      if(!this.chunks[data.index] || !this.chunks[data.index].manifold){
        if(!data.originalChunk){ console.error("Received csgoperation without originalChunk for fresh index: " + data.index); return; }
        this.chunks[data.index] = { index: data.index, data: data.originalChunk, manifold: this.base64ToManifold(data.originalChunk) };
      }

      let manifoldA = this.chunks[data.index].manifold;
      let manifoldB = this.base64ToManifold(data.brush,
        new THREE.Vector3(data.brushPosition.x, data.brushPosition.y, data.brushPosition.z),
        new THREE.Quaternion(data.brushQuaternion.x, data.brushQuaternion.y, data.brushQuaternion.z, data.brushQuaternion.w),
        new THREE.Vector3(data.brushScale.x, data.brushScale.y, data.brushScale.z));

      let operation = parseInt(data.operation);
      let resultManifold = null;
      if(operation === ADDITION){
        resultManifold = manifoldA.add(manifoldB);
      } else if(operation === INTERSECTION){
        resultManifold = manifoldA.intersect(manifoldB);
      } else if(operation === SUBTRACTION){
        resultManifold = manifoldA.subtract(manifoldB);
      } else {
        console.error("Unknown manifold operation: " + operation);
      }

      let z = data.index % 10;
      let y = Math.floor(data.index / 10) % 10;
      let x = Math.floor(data.index / 100);
      let cubeManifold = this.manifold.Manifold.cube([10, 10, 10], true).translate(
        x * 10.0 - 45.0,
        y * 10.0 - 45.0,
        z * 10.0 - 45.0
      );
      resultManifold = resultManifold.intersect(cubeManifold);
      cubeManifold.delete();

      manifoldA.delete();
      manifoldB.delete();

      // --- Cross-chunk decomposition ---
      // Union the modified chunk with all face-adjacent modified neighbors,
      // decompose the union to find globally-disconnected pieces, then
      // intersect each island back into per-chunk boundaries.
      let ci = data.index;
      let z0 = ci % 10, y0 = Math.floor(ci / 10) % 10, x0 = Math.floor(ci / 100);
      let affectedIndices = [ci];
      let affectedManifolds = [resultManifold];
      let offsets = [[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
      for(let [dx,dy,dz] of offsets) {
        let nx = x0+dx, ny = y0+dy, nz = z0+dz;
        if(nx<0||nx>9||ny<0||ny>9||nz<0||nz>9) continue;
        let ni = nx*100 + ny*10 + nz;
        if(this.chunks[ni] && this.chunks[ni].manifold) {
          affectedIndices.push(ni);
          affectedManifolds.push(this.chunks[ni].manifold);
        }
      }

      // Union all affected chunks into one combined manifold
      let combined = affectedManifolds[0];
      let combinedIsNew = false;
      for(let i = 1; i < affectedManifolds.length; i++) {
        let next = combined.add(affectedManifolds[i]);
        if(combinedIsNew) combined.delete();
        combined = next;
        combinedIsNew = true;
      }

      // Decompose the combined manifold to find globally-disconnected pieces
      let islands = combined.decompose();

      if(islands.length <= 1) {
        // Single connected piece — no fragmentation needed
        for(let i = 0; i < islands.length; i++) islands[i].delete();
        if(combinedIsNew) combined.delete();
        // Just update the modified chunk
        this.chunks[ci].data = this.manifoldToBase64(resultManifold);
        this.chunks[ci].manifold = resultManifold;
        this.rebuildChunkPhysics(ci);
        this.needsUpdate[""+ci] = true;
      } else {
        // Multiple islands — sort by volume, split back into chunk boundaries
        let islandInfo = [];
        for(let i = 0; i < islands.length; i++) {
          islandInfo.push({ idx: i, volume: islands[i].volume() });
        }
        islandInfo.sort((a, b) => b.volume - a.volume);

        let fragmentCount = 0;
        for(let c = 0; c < affectedIndices.length; c++) {
          let aci = affectedIndices[c];
          let az = aci%10, ay = Math.floor(aci/10)%10, ax = Math.floor(aci/100);
          let cubeBounds = this.manifold.Manifold.cube([10,10,10], true).translate(
            ax*10-45, ay*10-45, az*10-45
          );

          // Largest island clipped to this chunk's bounds → new chunk terrain
          let chunkTerrain = null;
          try {
            chunkTerrain = islands[islandInfo[0].idx].intersect(cubeBounds);
            if(chunkTerrain.volume() < 0.001) { chunkTerrain.delete(); chunkTerrain = null; }
          } catch(e) { chunkTerrain = null; }

          if(chunkTerrain) {
            // Replace chunk manifold (delete old neighbor manifold if it's a neighbor)
            if(c > 0 && this.chunks[aci] && this.chunks[aci].manifold) {
              this.chunks[aci].manifold.delete();
            }
            this.chunks[aci].data = this.manifoldToBase64(chunkTerrain);
            this.chunks[aci].manifold = chunkTerrain;
          }

          // Smaller islands clipped to this chunk's bounds → fragments
          for(let j = 1; j < islandInfo.length; j++) {
            if(islandInfo[j].volume < 0.01) continue;
            let fragInChunk = null;
            try {
              fragInChunk = islands[islandInfo[j].idx].intersect(cubeBounds);
              if(fragInChunk.volume() < 0.01) { fragInChunk.delete(); fragInChunk = null; }
            } catch(e) { fragInChunk = null; }
            if(fragInChunk) {
              this.spawnChunkFragment(fragInChunk); // takes ownership
              fragmentCount++;
            }
          }

          cubeBounds.delete();
          this.rebuildChunkPhysics(aci);
          this.needsUpdate[""+aci] = true;
        }

        // Cleanup
        for(let i = 0; i < islands.length; i++) islands[i].delete();
        if(combinedIsNew) combined.delete();
        resultManifold.delete();
        console.log(`Cross-chunk decompose (${affectedIndices.length} chunks): ${islands.length} islands, ${fragmentCount} fragments spawned`);
      }
    } else if(data.type === "model"){
      if(!this.models[data.id]){
        this.models[data.id] = {
          id: data.id,
          url: data.url,
          position: data.position,
          quaternion: data.quaternion,
          scale: data.scale,
          selectedBy: data.selectedBy || ""
        };
      }else{
        Object.assign(this.models[data.id], data);
      }
      this.needsUpdate[""+data.id] = true;
    } else if(data.type === "name"){
      this.players[sender.id].name = data.name;
      this.needsUpdate[sender.id] = true;
    } else if(data.type === "select"){
      if(this.models[""+data.id]) {
        this.models[""+data.id].selectedBy = sender.id;
        this.needsUpdate[""+data.id] = true;
      }
    } else if(data.type === "deselect"){
      if(this.models[""+data.id]) {
        this.models[""+data.id].selectedBy = "";
        this.needsUpdate[""+data.id] = true;
      }
    } else if(data.type === "deletemodel"){
      if(this.models[""+data.id]) {
        delete this.models[""+data.id];
        this.room.broadcast(JSON.stringify({
          type: "fullupdate",
          players: this.players,
          chunks: this.getSerializableChunks(),
          models: this.models,
          physBodies: this.getPhysBodiesState()
        }));
      }
    } else if(data.type === "spawnphyscube"){
      let pos = data.position || { x: 0, y: 5, z: 0 };
      let half = data.halfExtent || PHYS_CUBE_HALF;
      this.spawnPhysCube(pos.x, pos.y, pos.z, half);
    } else if(data.type === "spawnprop"){
      let pos = data.position || { x: 0, y: 5, z: 0 };
      let propId = data.propId || "crate";
      let def = PROP_DEFS[propId] || { half: PHYS_CUBE_HALF, shape: 'box' };
      let id = this.spawnPropBody(pos.x, pos.y, pos.z, def, propId);
    } else if(data.type === "physgun_grab"){
      this.physGunGrab(sender.id, data.bodyId);
    } else if(data.type === "physgun_move"){
      this.physGunMove(sender.id, data.bodyId, data.targetPos, data.targetQuat);
    } else if(data.type === "physgun_release"){
      this.physGunRelease(sender.id, data.bodyId);
    } else if(data.type === "physgun_freeze"){
      this.physGunFreeze(data.bodyId);
    } else if(data.type === "createjoint"){
      this.createJoint(data);
    } else if(data.type === "removejoint"){
      this.removeJoint(data.jointId);
    } else if(data.type === "chat"){
      this.room.broadcast(JSON.stringify({
        type: "chat",
        sender: sender.id,
        message: data.message,
      }));
    } else if(data.type === "reset"){
        await this.room.storage.delete("chunks");
        await this.room.storage.delete("models");
        for(let chunk in this.chunks) {
          if(this.chunks[chunk].manifold) this.chunks[chunk].manifold.delete();
        }
        this.chunks = {};
        this.models = {};
        this.room.broadcast(JSON.stringify({
          type: "fullupdate",
          players: this.players,
          chunks: this.chunks,
          models: this.models,
          physBodies: this.getPhysBodiesState()
        }));
    } else {
      console.error("Unknown message type: " + message);
    }

    this.hasNewInfoToSend = true;
  }

  base64ToBrush(base64String) {
    let binaryString = this.b64decode(base64String.normalize("NFC"));
    let unbase64CompressedPositions = new Uint8Array(binaryString.length);
    for (let b = 0; b < binaryString.length; b++) {
        unbase64CompressedPositions[b] = binaryString.charCodeAt(b);
    }
    let decompressedPositions = new Float32Array(gunzipSync(unbase64CompressedPositions).buffer);
    let newGeometry = new THREE.BufferGeometry();
    newGeometry.setAttribute('position', new THREE.BufferAttribute(decompressedPositions, 3));
    newGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(decompressedPositions.length / 3 * 2), 2));
    newGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(decompressedPositions.length), 3));
    newGeometry.index = null;
    return new Brush(newGeometry);
  }

  base64ToManifold(base64String, position = new THREE.Vector3(0, 0, 0), quaternion = new THREE.Quaternion(0, 0, 0, 1), scale = new THREE.Vector3(1, 1, 1)) {
    let binaryString = this.b64decode(base64String.normalize("NFC"));
    let unbase64CompressedPositions = new Uint8Array(binaryString.length);
    for (let b = 0; b < binaryString.length; b++) {
        unbase64CompressedPositions[b] = binaryString.charCodeAt(b);
    }
    let decompressedPositions = new Float32Array(gunzipSync(unbase64CompressedPositions).buffer);
    let newGeometry = new THREE.BufferGeometry();
    newGeometry.setAttribute('position', new THREE.BufferAttribute(decompressedPositions, 3));
    newGeometry.index = null;
    let geometry = mergeVertices(newGeometry, 1e-4);
    let positions = geometry.attributes.position.array;
    let index    = geometry.index.array;

    let matrix = new THREE.Matrix4().compose(position, quaternion, scale);

    let transformedPosition = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        let vertex = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
        vertex.applyMatrix4(matrix);
        transformedPosition[i    ] = vertex.x;
        transformedPosition[i + 1] = vertex.y;
        transformedPosition[i + 2] = vertex.z;
    }

    let vertProperties = new Float32Array(transformedPosition.length);
    vertProperties.set(transformedPosition);

    let triVerts = new Uint32Array(index.length);
    triVerts.set(index);

    let meshOptions = {
        numProp: 3,
        vertProperties: vertProperties,
        triVerts: triVerts
    };

    let mesh = new this.manifold.Mesh(meshOptions);
    let outputManifold = new this.manifold.Manifold(mesh);
    outputManifold.simplify(0.1);
    return outputManifold;
  }

  b64encode(input) { return btoa(encodeURIComponent(input)); }
  b64decode(input) { return decodeURIComponent(atob(input)); }

  brushToBase64(brush) {
    let compressedPositions = gzipSync(new Uint8Array(brush.geometry.attributes.position.array.buffer));
    let toReturn = this.b64encode(String.fromCharCode.apply(null, compressedPositions));
    return toReturn.normalize("NFC");
  }

  /** @param {Manifold} manifold - The manifold object. */
  manifoldToBase64(manifold) {
    let mesh = manifold.getMesh();
    let newGeometry = new THREE.BufferGeometry();
    newGeometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties, 3));
    newGeometry.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
    let nonIndexedGeometry = newGeometry.toNonIndexed();
    let compressedPositions = gzipSync(new Uint8Array(nonIndexedGeometry.attributes.position.array.buffer));
    let toReturn = this.b64encode(String.fromCharCode.apply(null, compressedPositions));
    return toReturn.normalize("NFC");
  }

  /** @param {Connection} conn - The connection object. */
  async onDisconnect(conn){
    if(!this.players[conn.id]) return;

    delete this.players[conn.id];
    delete this.needsUpdate[conn.id];

    // Remove player kinematic from physics scene
    if(this.playerKinematics[conn.id] && this.pxScene) {
      this.pxScene.removeActor(this.playerKinematics[conn.id]);
      delete this.playerKinematics[conn.id];
    }

    await this.room.storage.put("chunks", this.getSerializableChunks());
    await this.room.storage.put("models", this.models);
    console.log("Wrote the world state to KV storage");

    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      chunks: this.getSerializableChunks(),
      models: this.models,
      physBodies: this.getPhysBodiesState()
    }));
  }

  /** @param {Connection} conn - The connection object. */
  onClose(conn){ this.onDisconnect(conn); }
  /**
   * @param {Connection} conn - The connection object.
   * @param {Error} error - The error object. */
  onError(conn, error){ console.error(error); this.onDisconnect(conn); }
}

export default PartyServer;
