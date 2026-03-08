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

const PHYS_CUBE_COUNT = 12;
const PHYS_CUBE_HALF = 0.5; // half-extent
const PHYS_GROUND_Y = -0.5; // top of ground at y=0

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
    this.physBodyStates = {};
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
      result[b.id] = {
        id: b.id,
        position: { x: p.get_x(), y: p.get_y(), z: p.get_z() },
        quaternion: { x: q.get_x(), y: q.get_y(), z: q.get_z(), w: q.get_w() },
        halfExtent: b.halfExtent || PHYS_CUBE_HALF
      };
    }
    return result;
  }

  /** Get only awake physics body states (for partial updates), returns null if all sleeping */
  getAwakePhysBodiesState() {
    let result = {};
    let hasAny = false;
    for(let b of this.physBodies) {
      if(!b.body.isSleeping()) {
        let pose = b.body.getGlobalPose();
        let p = pose.get_p();
        let q = pose.get_q();
        result[b.id] = {
          id: b.id,
          position: { x: p.get_x(), y: p.get_y(), z: p.get_z() },
          quaternion: { x: q.get_x(), y: q.get_y(), z: q.get_z(), w: q.get_w() },
          halfExtent: b.halfExtent || PHYS_CUBE_HALF
        };
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

    // Update player kinematic actors with velocity-based kinematic target
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
      if(dt > 0) {
        let vx = (newX - prev.x) / dt;
        let vy = (newY - prev.y) / dt;
        let vz = (newZ - prev.z) / dt;
        let speed = Math.sqrt(vx*vx + vy*vy + vz*vz);

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
      player._prevPhysPos = { x: newX, y: newY, z: newZ };

      this.pxTmpVec.set_x(newX);
      this.pxTmpVec.set_y(newY);
      this.pxTmpVec.set_z(newZ);
      this.pxTmpQuat.set_x(0); this.pxTmpQuat.set_y(0);
      this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(1);
      this.pxTmpPose.set_p(this.pxTmpVec);
      this.pxTmpPose.set_q(this.pxTmpQuat);
      kin.setKinematicTarget(this.pxTmpPose);
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
    this.pxScene.addActor(box);
    let id = "phys_" + (this.physBodyCounter++);
    this.physBodies.push({ body: box, id: id, halfExtent: half });
    this.hasNewInfoToSend = true;
    console.log(`Spawned phys cube ${id} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) half=${half}`);
    return id;
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
      let capsuleGeom = new this.px.PxCapsuleGeometry(0.5, 0.5);
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
      this.chunks[data.index].data = this.manifoldToBase64(resultManifold);
      this.chunks[data.index].manifold = resultManifold;
      this.rebuildChunkPhysics(data.index);
      this.needsUpdate[""+data.index] = true;
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
