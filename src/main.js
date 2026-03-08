/* eslint-env browser */
/* global PARTYKIT_HOST */

import * as THREE from 'three/webgpu';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import World from './World.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const { MeshoptDecoder } = await import( 'three/examples/jsm/libs/meshopt_decoder.module.js' );
import { PlayerController } from './PlayerController.js';
import { ADDITION, INTERSECTION, SUBTRACTION, Brush, Evaluator } from 'three-bvh-csg';
import { MeshBVH, MeshBVHHelper, StaticGeometryGenerator } from 'three-mesh-bvh';
import PartySocket from "partysocket";
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { gzipSync, gunzipSync } from 'three/examples/jsm/libs/fflate.module.js';


/** The fundamental set up and animation structures for Simulation */
export default class Main {
    constructor() {
        // Intercept Main Window Errors
        window.realConsoleError = console.error;
        window.addEventListener('error', (event) => {
            let path = event.filename.split("/");
            this.display((path[path.length - 1] + ":" + event.lineno + " - " + event.message));
        });
        console.error = this.fakeError.bind(this);
        this.timeMS = 0;
        this.deferredConstructor();
    }

    async deferredConstructor() {
        this.queryParams = new URLSearchParams(window.location.search || window.location.hash.substr(1));
        if(this.queryParams.has("room")){
            this.curRoom = this.queryParams.get('room') || "global";
        }else{
            this.curRoom = "global";
            this.queryParams.set("room", this.curRoom);
            window.history.replaceState({}, "", `${window.location.pathname}?${this.queryParams.toString()}`);
        }

        /** @type {PartySocket} - The connection object */
        this.conn = new PartySocket({
            host: PARTYKIT_HOST,
            room: this.curRoom,
        });

        /** @type {Record<string, { name: string, id:string, position: { x: number, y: number, z: number }, color:string | null}>} */
        this.players = {};

        /** @type {Record<string, { id:string, url: string | null, position: { x: number, y: number, z: number }, quaternion: { x: number, y: number, z: number, w: number }, scale: { x: number, y: number, z: number }, selectedBy: string }>} */
        this.models = {};

        this.conn.addEventListener("message", this.updateFromServer.bind(this));

        // Construct the render world
        this.serverTickMs = 0;
        this.world = new World(this, this.isMobile());

        // Configure Settings
        this.simulationParams = {
            firstPerson: true,
            gravity: - 80,
            playerSpeed: 10,
            physicsSteps: 5,
            jumpVelocity: 20.0,
            mobile: this.isMobile(),

            modelURL: "",
            spawnModelFunc: this.spawnModel.bind(this),
            spawnPhysCubeFunc: this.spawnPhysCube.bind(this),
            showBrush: false,
        };

        this.gui = new GUI();
        this.gui.add(this.simulationParams, 'spawnPhysCubeFunc').name("Spawn Physics Cube");
        this.gui.add(this.simulationParams, 'modelURL').name("Model URL (.glb)");
        this.gui.add(this.simulationParams, 'spawnModelFunc').name("Spawn Model");
        this.gui.add(this.simulationParams, 'showBrush').name("Show CSG Brush").onChange(v => {
            this.brush2.visible = v;
        });

        this.environment = this.world.scene;
        this.raycaster = new THREE.Raycaster();
        this.evaluator = new Evaluator();

        // Chunk terrain setup
        let bbox = new THREE.Box3( new THREE.Vector3( -5.0, -5.0, -5.0 ), new THREE.Vector3( 5.0, 5.0, 5.0 ) );
        this.defaultMaterial = new THREE.MeshStandardMaterial( { color: 0x808080, roughness: 0.5, metalness: 0.5 } );

        this.chunks = [];
        this.mesh = new THREE.Group();
        for( let x = 0; x < 10; x++ ) {
            for( let y = 0; y < 10; y++ ) {
                for( let z = 0; z < 10; z++ ) {
                    let geometry = y < 5 ? new THREE.BoxGeometry( 10.0, 10.0, 10.0 ).toNonIndexed () : new THREE.BoxGeometry( 0.1, 0.1, 0.1 ).toNonIndexed ();
                    let vertices = geometry.attributes.position.array;
                    for (let i = 0; i < vertices.length; i += 3) {
                        vertices[i    ] += x * 10.0 - 45.0;
                        vertices[i + 1] += y * 10.0 - 45.0;
                        vertices[i + 2] += z * 10.0 - 45.0;
                    }
                    geometry.attributes.position.needsUpdate = true;
                    let chunk = new Brush( geometry, this.defaultMaterial );
                    chunk.updateMatrixWorld( true );
                    chunk.bbox = bbox.clone().translate(
                        new THREE.Vector3( x * 10.0 - 45.0, y * 10.0 - 45.0, z * 10.0 - 45.0 )
                    );
                    chunk.prepareGeometry();
                    chunk.receiveShadow = true;
                    chunk.castShadow = true;
                    this.mesh.add( chunk );
                    this.chunks.push( chunk );
                }
            }
        }
        this.mesh.receiveShadow = true;
        this.mesh.updateMatrixWorld( true );
        this.mesh.chunks = this.chunks;

        this.placeholderGeometry = new THREE.BoxGeometry( 2, 2, 2 );
        this.placeholderMaterial = new THREE.MeshBasicMaterial( { color: 0xffffff, wireframe: true } );

        // Create the player controller
        this.player = new PlayerController(this.world.camera, this.simulationParams);
        this.world.scene.add( this.player );
        this.player.reset();

        this.transparentMaterial = new THREE.MeshStandardMaterial( { color: 0x8080a8, roughness: 0.5, metalness: 0.5, transparent: true, opacity: 0.5, side: THREE.DoubleSide } );
        this.brush2 = new Brush( new THREE.BoxGeometry(2, 2, 2).toNonIndexed(), this.transparentMaterial );
        this.brush2.position.y = -0.5;
        this.brush2.castShadow = true;
        this.brush2.visible = false;
        this.brush2.updateMatrixWorld();
        this.world.scene.add( this.brush2 );

        this.world.scene.add( this.mesh );

        this.modelsParent = new THREE.Group();
        this.world.scene.add( this.modelsParent );

        // Physics body meshes (cubes from server-side PhysX)
        // Snapshot interpolation: buffer prev/target states and lerp by elapsed time
        this.physBodyMeshes = {};
        this.physBodySnapshots = {}; // { prev: {pos, quat, time}, target: {pos, quat, time} }
        this.physSnapshotInterval = 1000 / 15; // 15Hz physics updates
        this.physBodyGeometry = new THREE.BoxGeometry(1, 1, 1);
        this.physBodyMaterial = new THREE.MeshStandardMaterial( { color: 0xdd8844, roughness: 0.4, metalness: 0.3 } );
        this.physBodiesParent = new THREE.Group();
        this.world.scene.add( this.physBodiesParent );

        this.player.chunks = this.chunks;

        this.ePressed = false;
        this.qPressed = false;
        window.addEventListener('pointerdown', (e) => {
            if(this.player && this.player.controls && this.player.controls.isLocked) {
                e.preventDefault();
                if (e.button === 0) {
                    this.qPressed = true;
                }else if (e.button === 2) {
                    this.ePressed = true;
                }
            }
        });
        window.addEventListener("wheel", (e) => {
            if(this.player && this.player.controls && this.player.controls.isLocked){
                e.preventDefault();
                this.brush2.scale.multiplyScalar(1.0 + (e.deltaY * -0.001));
            }
        }, { passive: false });

        this.frameNum = 0;
        this.lastUpdate = 0;
        this.constructorFinished = true;
    }

    /** @param {MessageEvent} event - The message event */
    updateFromServer(event) {
        /** @type {string} */
        let dataString = event.data;
        if (!dataString.startsWith("{")) {
            console.log(`Received -> ${dataString}`);
            return;
        }

        let data = JSON.parse(dataString);
        if (!data.type.includes("update")) return;

        // Capture server profiling
        if(data.serverTickMs !== undefined) {
            this.serverTickMs = data.serverTickMs;
        }

        if(data.type === "fullupdate"){
            for (let  model in this. models) { this. models[ model].dirty = true; }
            for (let player in this.players) { this.players[player].dirty = true; }
        }

        // Update players
        for (let player in data.players) {
            if (this.players[player] === undefined) {
                this.players[player] = data.players[player];
                this.players[player].mesh = new THREE.Mesh(
                    new RoundedBoxGeometry(1.0, 2.0, 1.0, 10, 0.5),
                    new THREE.MeshStandardMaterial()
                );
                this.players[player].mesh.visible = player !== this.conn.id;
                this.world.scene.add(this.players[player].mesh);
            } else {
                Object.assign(this.players[player], data.players[player]);
            }
            this.players[player].dirty = false;
        }

        // Update chunks
        for (let chunkIndex in data.chunks) {
            this.base64FillChunkIndex(chunkIndex, ''+data.chunks[chunkIndex].data.normalize("NFC"));
        }

        // Update models
        for (let modelId in data.models) {
            if (this.models[modelId] === undefined) {
                this.models[modelId] = data.models[modelId];
                if(this.models[modelId].url){
                    this.loadModelMesh(modelId);
                }else{
                    this.createPlaceholderMesh(modelId);
                }
            } else {
                Object.assign(this.models[modelId], data.models[modelId]);

                if (this.models[modelId].mesh && this.models[modelId].mesh.geometry == this.placeholderGeometry && this.models[modelId].url) {
                    console.log("Loading model at:", this.models[modelId].url);
                    this.modelsParent.remove(this.models[modelId].mesh);
                    this.models[modelId].mesh = null;
                    this.loadModelMesh(modelId);
                } else if (this.models[modelId].mesh) {
                    this.models[modelId].mesh.quaternion.set(
                        this.models[modelId].quaternion.x,
                        this.models[modelId].quaternion.y,
                        this.models[modelId].quaternion.z,
                        this.models[modelId].quaternion.w);
                    this.models[modelId].mesh.scale.set(
                        this.models[modelId].scale.x,
                        this.models[modelId].scale.y,
                        this.models[modelId].scale.z);

                    if (this.models[modelId].selectedBy === this.conn.id) {
                        this.curSelected = this.models[modelId].mesh;
                        this.curSelectedId = modelId;
                    } else if (this.curSelected === this.models[modelId].mesh) {
                        this.curSelected = null;
                        this.curSelectedId = null;
                    }
                }
            }
            this.models[modelId].dirty = false;
        }

        // Update physics body snapshots for interpolation
        if(data.physBodies) {
            let now = performance.now();
            for (let bodyId in data.physBodies) {
                let bd = data.physBodies[bodyId];
                if(!this.physBodyMeshes[bodyId]) {
                    let s = bd.halfExtent * 2;
                    let mesh = new THREE.Mesh(this.physBodyGeometry, this.physBodyMaterial);
                    mesh.scale.set(s, s, s);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    this.physBodiesParent.add(mesh);
                    this.physBodyMeshes[bodyId] = mesh;
                }
                let newPos = new THREE.Vector3(bd.position.x, bd.position.y, bd.position.z);
                let newQuat = new THREE.Quaternion(bd.quaternion.x, bd.quaternion.y, bd.quaternion.z, bd.quaternion.w);
                let snap = this.physBodySnapshots[bodyId];
                let mesh = this.physBodyMeshes[bodyId];
                if(!snap) {
                    // First snapshot: set both prev and target to the same value
                    this.physBodySnapshots[bodyId] = {
                        prev:   { pos: newPos.clone(), quat: newQuat.clone(), time: now },
                        target: { pos: newPos, quat: newQuat, time: now }
                    };
                    mesh.position.copy(newPos);
                    mesh.quaternion.copy(newQuat);
                } else {
                    // Set prev to current rendered position (not old target) for seamless blend
                    snap.prev.pos.copy(mesh.position);
                    snap.prev.quat.copy(mesh.quaternion);
                    snap.prev.time = now;
                    snap.target.pos.copy(newPos);
                    snap.target.quat.copy(newQuat);
                    snap.target.time = now + this.physSnapshotInterval;
                }
            }
        }

        // Remove disconnected players and deleted models on full update
        if(data.type === "fullupdate"){
            for (let player in this.players) {
                if (this.players[player].dirty) {
                    console.log(`Player ${this.players[player].name} has disconnected!`);
                    this.world.scene.remove(this.players[player].mesh);
                    delete this.players[player];
                }
            }

            for (let model in this.models) {
                if (this.models[model].dirty) {
                    this.world.scene.remove(this.models[model].mesh);
                    delete this.models[model];
                }
            }
        }
    }

    loadModelMesh(modelId) {
        let loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.load(this.models[modelId].url, (gltf) => {
            gltf.scene.position.copy(this.models[modelId].position);
            gltf.scene.quaternion.copy(this.models[modelId].quaternion);
            gltf.scene.scale.copy(this.models[modelId].scale);
            gltf.scene.name = modelId;
            this.modelsParent.add(gltf.scene);
            this.models[modelId].mesh = gltf.scene;
            this.models[modelId].mesh.name = modelId;
            if(gltf.scene.children[0] && gltf.scene.children[0].children[0]) {
                gltf.scene.children[0].children[0].name = modelId;
            }
        });
    }

    createPlaceholderMesh(modelId) {
        this.models[modelId].mesh = new THREE.Mesh( this.placeholderGeometry, this.placeholderMaterial );
        this.models[modelId].mesh.position.set(
            this.models[modelId].position.x,
            this.models[modelId].position.y,
            this.models[modelId].position.z);
        this.models[modelId].mesh.quaternion.set(
            this.models[modelId].quaternion.x,
            this.models[modelId].quaternion.y,
            this.models[modelId].quaternion.z,
            this.models[modelId].quaternion.w);
        this.models[modelId].mesh.scale.set(
            this.models[modelId].scale.x,
            this.models[modelId].scale.y,
            this.models[modelId].scale.z);
        this.models[modelId].mesh.name = modelId;
        this.modelsParent.add(this.models[modelId].mesh);
    }

    /** Update the simulation */
    update(timeMS) {
        if(!this.constructorFinished) return;
        this.deltaTime = timeMS - this.timeMS;
        this.timeMS = timeMS;

        let physicsSteps = this.simulationParams.physicsSteps;
        for ( let i = 0; i < physicsSteps; i ++ ) {
            this.player.updatePlayer( Math.min( this.deltaTime/1000.0, 0.1 ) / physicsSteps );
            if( i == 0 && this.player.tappedAction) { this.qPressed = true; }
        }

        // Place the CSG brush in front of the camera
        this.world.camera.getWorldDirection(this.brush2.position).normalize().multiplyScalar(6).add(this.player.position);
        let lookTarget = new THREE.Vector3().copy(this.world.camera.position);
        lookTarget.y = this.brush2.position.y;
        this.brush2.lookAt(lookTarget);
        this.brush2.updateMatrixWorld();

        // Send position updates at 30Hz
        if(this.lastUpdate + 1000/30 < timeMS) {
            this.lastUpdate = timeMS;
            this.conn.send(JSON.stringify({
                type: "player",
                position: {
                    x: this.player.position.x,
                    y: this.player.position.y - 0.5,
                    z: this.player.position.z
                }
            }));

            if(this.curSelected){
                this.conn.send(JSON.stringify({
                    type: "model",
                    id: this.curSelectedId,
                    position: {
                        x: this.brush2.position.x,
                        y: this.brush2.position.y,
                        z: this.brush2.position.z
                    },
                    quaternion: {
                        x: this.brush2.quaternion.x,
                        y: this.brush2.quaternion.y,
                        z: this.brush2.quaternion.z,
                        w: this.brush2.quaternion.w
                    },
                    scale: {
                        x: this.brush2.scale.x,
                        y: this.brush2.scale.y,
                        z: this.brush2.scale.z
                    }
                }));
            }
        }

        // Interpolate remote player positions
        for (let player in this.players) {
            this.players[player].mesh.position.lerp(new THREE.Vector3(this.players[player].position.x, this.players[player].position.y, this.players[player].position.z), 0.1);
        }

        // Interpolate model positions
        for (let model in this.models) {
            if(this.models[model].mesh) {
                this.models[model].mesh.position.lerp(new THREE.Vector3(this.models[model].position.x, this.models[model].position.y, this.models[model].position.z), 0.1);
            }
        }

        if ( this.ePressed || this.qPressed ) {

            if(!this.curSelected){
                // Raycast to select models
                this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.world.camera);
                let intersects = this.raycaster.intersectObjects(this.modelsParent.children, true);

                if (intersects.length > 0) {
                    let hit = intersects[0];
                    this.conn.send(JSON.stringify({
                        type: "select",
                        id: hit.object.name
                    }));
                    this.ePressed = false;
                    this.qPressed = false;
                    return;
                }
            }else{
                this.conn.send(JSON.stringify({
                    type: "deselect",
                    id: this.curSelectedId
                }));
                this.ePressed = false;
                this.qPressed = false;
                return;
            }

            // CSG terrain operation
            let box1 = new THREE.Box3();
            box1.setFromObject(this.brush2);

            for(let i = 0; i < this.chunks.length; i++) {
                if (box1.intersectsBox(this.chunks[i].bbox)) {
                    this.conn.send(JSON.stringify({
                        type: "manifoldcsgoperation",
                        index: i,
                        originalChunk: this.brushToBase64(this.chunks[i]),
                        brush: this.brushToBase64(this.brush2),
                        operation: this.ePressed ? ADDITION : SUBTRACTION,
                        brushPosition: {
                            x: this.brush2.position.x,
                            y: this.brush2.position.y,
                            z: this.brush2.position.z
                        },
                        brushQuaternion: {
                            x: this.brush2.quaternion.x,
                            y: this.brush2.quaternion.y,
                            z: this.brush2.quaternion.z,
                            w: this.brush2.quaternion.w
                        },
                        brushScale: {
                            x: this.brush2.scale.x,
                            y: this.brush2.scale.y,
                            z: this.brush2.scale.z
                        }
                    }));
                }
            }
            this.ePressed = false;
            this.qPressed = false;
        }

        // Interpolate physics bodies between snapshots (render one interval behind)
        let now = performance.now();
        for(let bodyId in this.physBodySnapshots) {
            let snap = this.physBodySnapshots[bodyId];
            let mesh = this.physBodyMeshes[bodyId];
            if(!mesh || !snap) continue;
            let duration = snap.target.time - snap.prev.time;
            if(duration <= 0) duration = this.physSnapshotInterval;
            // t goes from 0 (at prev time) to 1 (at target time)
            let t = (now - snap.prev.time) / duration;
            t = Math.max(0, Math.min(t, 1.0));
            mesh.position.lerpVectors(snap.prev.pos, snap.target.pos, t);
            mesh.quaternion.slerpQuaternions(snap.prev.quat, snap.target.quat, t);
        }

        this.world.renderPipeline.render();
        this.world.stats.update();

        // Display server tick profiling
        if(!this.serverTickDisplay) {
            this.serverTickDisplay = document.createElement('div');
            this.serverTickDisplay.style.cssText = 'position:fixed;top:0;right:0;padding:4px 8px;background:rgba(0,0,0,0.7);color:#0f0;font:12px monospace;z-index:10000;';
            document.body.appendChild(this.serverTickDisplay);
        }
        this.serverTickDisplay.textContent = 'Server: ' + this.serverTickMs + 'ms';

        this.frameNum++;
    }

    spawnPhysCube(){
        this.conn.send(JSON.stringify({
            type: "spawnphyscube",
            position: {
                x: this.brush2.position.x,
                y: this.brush2.position.y,
                z: this.brush2.position.z
            },
            halfExtent: 0.5
        }));
    }

    spawnModel(){
        let url = this.simulationParams.modelURL.trim();
        if(!url) return;

        if(url === "reset"){
            this.conn.send(JSON.stringify({ type: "reset" }));
            return;
        }

        this.conn.send(JSON.stringify({
            type: "model",
            id: ""+Math.floor(Math.random() * 1000000),
            url: url,
            position: {
                x: this.brush2.position.x,
                y: this.brush2.position.y,
                z: this.brush2.position.z
            },
            quaternion: {
                x: this.brush2.quaternion.x,
                y: this.brush2.quaternion.y,
                z: this.brush2.quaternion.z,
                w: this.brush2.quaternion.w
            },
            scale: {
                x: this.brush2.scale.x,
                y: this.brush2.scale.y,
                z: this.brush2.scale.z
            },
            selectedBy: ""
        }));
    }

    b64encode(input) {
        return btoa(encodeURIComponent(input));
    }
    b64decode(input) {
        return decodeURIComponent(atob(input));
    }

    brushToBase64(brush) {
        let compressedPositions = gzipSync(new Uint8Array(brush.geometry.attributes.position.array.buffer));
        let toReturn = this.b64encode(String.fromCharCode.apply(null, compressedPositions));
        return toReturn.normalize("NFC");
    }

    base64FillChunkIndex(chunkIndex, base64String) {
        let binaryString = this.b64decode(base64String.normalize("NFC"));
        let unbase64CompressedPositions = new Uint8Array(binaryString.length);
        for (let b = 0; b < binaryString.length; b++) {
            unbase64CompressedPositions[b] = binaryString.charCodeAt(b);
        }
        let decompressedPositions = new Float32Array(gunzipSync(unbase64CompressedPositions).buffer);
        let newGeometry = this.chunks[chunkIndex].geometry.clone();
        newGeometry.setAttribute('position', new THREE.BufferAttribute(decompressedPositions, 3));
        newGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(decompressedPositions.length / 3 * 2), 2));
        newGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(decompressedPositions.length), 3));
        newGeometry.index = null;
        newGeometry.attributes.position.needsUpdate = true;
        newGeometry.attributes.uv.needsUpdate = true;
        newGeometry.attributes.normal.needsUpdate = true;
        newGeometry.needsUpdate = true;
        newGeometry.computeBoundingBox();
        newGeometry.computeBoundingSphere();
        newGeometry.computeVertexNormals();
        newGeometry.boundsTree = null;
        this.chunks[chunkIndex].geometry = newGeometry;
        this.chunks[chunkIndex].prepareGeometry();
    }

    // Log Errors as <div>s over the main viewport
    fakeError(...args) {
        if (args.length > 0 && args[0]) { this.display(JSON.stringify(args[0])); }
        window.realConsoleError.apply(console, arguments);
    }

    display(text) {
        let errorNode = window.document.createElement("div");
        errorNode.innerHTML = text.fontcolor("red");
        window.document.getElementById("info").appendChild(errorNode);
    }

    isMobile() {
        let check = false;
        ((a) => {if(/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0,4))) check = true;})(navigator.userAgent||navigator.vendor||window.opera);
        return check;
    }
}

var main = new Main();
