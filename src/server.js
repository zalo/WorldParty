/* eslint-env browser */

// @ts-check
// Optional JS type checking, powered by TypeScript.
/** @typedef {import("partykit/server").Room} Room */
/** @typedef {import("partykit/server").Server} Server */
/** @typedef {import("partykit/server").Connection} Connection */
/** @typedef {import("partykit/server").ConnectionContext} ConnectionContext */

import * as THREE from '../node_modules/three/build/three.module.js';
import { mergeVertices, toCreasedNormals } from '../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { ADDITION, INTERSECTION, SUBTRACTION, Brush, Evaluator } from '../node_modules/three-bvh-csg/build/index.module.js';
import { gzipSync, gunzipSync } from '../node_modules/three/examples/jsm/libs/fflate.module.js';

import { M } from '../assets/manifold-3d/manifold.js';
import manMod from '../assets/manifold-3d/manifold.wasm';
/** @typedef {import("../assets/manifold-3d/manifold.js").CrossSection} CrossSection */
/** @typedef {import("../assets/manifold-3d/manifold.js").Manifold} Manifold */
/** @typedef {import("../assets/manifold-3d/manifold.js").ManifoldToplevel} ManifoldToplevel */
/** @typedef {import("../assets/manifold-3d/manifold.js").Mesh} Mesh */
/** @typedef {import("../assets/manifold-3d/manifold.js").Vec3} Vec3 */

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
    this.globalPlayerCount = 0;

    /** @type {Record<string, boolean>} */
    this.needsUpdate = {};

    // Send an update message to all the connections
    this.updateCounter = 0;
    this.hasNewInfoToSend = false;
    this.interval = setInterval(() => {
      if(!this.hasNewInfoToSend) return;

      if(this.updateCounter % 300 === 0){
        // Send full update: Inefficient, but simple and robust
        this.room.broadcast(JSON.stringify({
          type: "fullupdate",
          players: this.players,
          chunks: this.chunks
        }));
      } else {
        // Accumulate partial updates from the objects that need updating
        /** @type {{type:string, players:Record<string, { name: string, id:string, position: { x: number, y: number, z: number }, color:string | null}>, chunks:Record<number, { index:number, data: string }>}}} */
        let partialUpdate = { type: "partialupdate", players: {}, chunks: {} };
        for(let player in this.players){
          if(this.needsUpdate[player]){
            partialUpdate.players[player] = this.players[player];
            this.needsUpdate[player] = false;
          }
        }
        for(let chunkIndex in this.chunks){
          if(this.needsUpdate[""+chunkIndex]){
            partialUpdate.chunks[chunkIndex] = this.chunks[chunkIndex];
            this.needsUpdate[""+chunkIndex] = false;
          }
        }

        // Send the partial update
        this.room.broadcast(JSON.stringify(partialUpdate));
      }
      this.updateCounter += 1;

      this.hasNewInfoToSend = false;
    }, 1000/30);

    this.initializeManifold();
  }

  async initializeManifold() {
    /** @type {ManifoldToplevel} */
    this.manifold = await M({
      instantiateWasm: (imports, callback) => {
        const instance = new WebAssembly.Instance(manMod, imports);
        callback(instance);
        return instance.exports;
      }
    });
    this.manifold.setup();
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

    // Add the player to the list of players
    this.globalPlayerCount += 1;
    this.players[conn.id] = {
      name: "noob " + this.globalPlayerCount,
      color: this.playerColors[this.globalPlayerCount % this.playerColors.length],
      id: conn.id,
      position: { x: 0, y: 0, z: 0 }
    };
    this.needsUpdate[conn.id] = true;

    // Send an update message to all the connections
    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      chunks: this.chunks
    }));
  }

  /**
   * @param {string} message
   * @param {Connection} sender */
  onMessage(message, sender) {
    //console.log(`connection ${sender.id} sent message: ${message}`);

    if(message.startsWith("{")){
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

        // Create a new Brush from the original chunk data and the incoming brush data
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
        this.needsUpdate[""+data.index] = true;
      } else if(data.type === "manifoldcsgoperation") {
        if(!this.chunks[data.index] || !this.chunks[data.index].manifold){
          if(!data.originalChunk){ console.error("Received csgoperation without originalChunk for fresh index: " + data.index); return; }
          this.chunks[data.index] = { index: data.index, data: data.originalChunk, manifold: this.base64ToManifold(data.originalChunk) };
        }

        // Create a new Brush from the original chunk data and the incoming brush data
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

        // Intersect the result with a cube the size of the original chunk to prevent overlaps between chunks
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
        //resultManifold.delete();
        this.chunks[data.index].manifold = resultManifold;
        this.needsUpdate[""+data.index] = true;
      } else if(data.type === "name"){
        this.players[sender.id].name = data.name;
        this.needsUpdate[sender.id] = true;
      } else if(data.type === "chat"){
        this.room.broadcast(JSON.stringify({
          type: "chat",
          sender: sender.id,
          message: data.message,
        }));
      } else if(data.type === "reset"){

      } else {
        console.error("Unknown message type: " + message);
      }
    }

    //// Broadcast the received message to all other connections in the room except the sender
    //this.room.broadcast(`${sender.id}: ${message}`, [sender.id]);

    // Send an update message to all the connections
    // TODO: Only send this at 15hz or so many active players don't exponentially increase outgoing bandwidth
    //this.room.broadcast(JSON.stringify({
    //  type: "fullupdate",
    //  players: this.players,
    //  cards: this.cards,
    //}));
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
    //let normal   = geometry.attributes.normal.array;
    let index    = geometry.index.array;

    let matrix = new THREE.Matrix4().compose(position, quaternion, scale);

    let transformedPosition = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        let vertex = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
        vertex.applyMatrix4(matrix);
        transformedPosition[i    ] = vertex.x;
        transformedPosition[i + 1] = vertex.y;
        transformedPosition[i + 2] = vertex.z;

        //transformedPosition[i + 3] = normal[i];
        //transformedPosition[i + 4] = normal[i + 1];
        //transformedPosition[i + 5] = normal[i + 2];
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
    //let compressedPositions = gzipSync(new Uint8Array(manifold.getMesh().vertProperties.buffer));
    // Need to convert the manifold to a BufferGeometry and create a nonIndexed geometry from it.
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
  onDisconnect(conn){

    // Remove the player from the list of players
    delete this.players[conn.id];
    delete this.needsUpdate[conn.id];

    // Send an update message to all the connections
    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      chunks: this.chunks
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