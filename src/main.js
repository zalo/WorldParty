/* eslint-env browser */
/* global PARTYKIT_HOST */

import * as THREE from 'three/webgpu';
import World from './World.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
const { MeshoptDecoder } = await import( 'three/examples/jsm/libs/meshopt_decoder.module.js' );
import { PlayerController } from './PlayerController.js';
import { Brush } from 'three-bvh-csg';
import { computeBoundsTree, disposeBoundsTree, computeBatchedBoundsTree, disposeBatchedBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import PartySocket from "partysocket";

import { World as EcsWorld } from './ecs/World.js';
import { encodeSoup, decodeSoup } from './net/codec.js';
import { getPropDef } from './props/PropRegistry.js';
import { SceneCleanupSystem, SnapshotSystem, BodyRenderSystem, PlayerRenderSystem, JointRenderSystem, ModelRenderSystem } from './client/systems.js';

import { CSGBrushTool } from './tools/CSGBrushTool.js';
import { PhysGunTool } from './tools/PhysGunTool.js';
import { RopeTool } from './tools/RopeTool.js';
import { WeldTool } from './tools/WeldTool.js';
import { HingeTool } from './tools/HingeTool.js';
import { SpawnMenu } from './ui/SpawnMenu.js';

const GRID = 10;
const CHUNK_COUNT = GRID * GRID * GRID;
const CHUNK_RESERVED_VERTS = 10000;
const CHUNK_RESERVED_INDICES = 30000;

/** Client entry: rendering world, local player, terrain mirror, ECS mirror of server entities, tools. */
export default class Main {
    constructor() {
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

        this.conn = new PartySocket({ host: PARTYKIT_HOST, room: this.curRoom });
        this.conn.addEventListener("message", this.updateFromServer.bind(this));

        this.serverTickMs = 0;
        this.world = new World(this, this.isMobile());
        this.simulationParams = { firstPerson: true, gravity: -80, playerSpeed: 10, physicsSteps: 5, jumpVelocity: 20.0, mobile: this.isMobile() };
        this.raycaster = new THREE.Raycaster();

        this.gltfLoader = new GLTFLoader();
        let dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
        this.gltfLoader.setDRACOLoader(dracoLoader);
        this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);

        THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
        THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
        THREE.BatchedMesh.prototype.computeBoundsTree = computeBatchedBoundsTree;
        THREE.BatchedMesh.prototype.disposeBoundsTree = disposeBatchedBoundsTree;
        THREE.BatchedMesh.prototype.raycast = acceleratedRaycast;

        this.setupTerrain();

        // Local player
        this.player = new PlayerController(this.world.camera, this.simulationParams);
        this.world.scene.add(this.player);
        this.player.reset();
        this.player.terrainBatch = this.terrainBatch;
        this.player.chunkGeoIds = this.chunkGeoIds;
        this.player.chunkBBoxes = this.chunkBBoxes;

        // CSG brush preview (owned by CSGBrushTool, created here for shared access)
        this.transparentMaterial = new THREE.MeshStandardMaterial({ color: 0x8080a8, roughness: 0.5, metalness: 0.5, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
        this.brush2 = new Brush(new THREE.BoxGeometry(2, 2, 2).toNonIndexed(), this.transparentMaterial);
        this.brush2.position.y = -0.5;
        this.brush2.castShadow = true;
        this.brush2.visible = false;
        this.brush2.updateMatrixWorld();
        this.world.scene.add(this.brush2);

        // ECS mirror of server entities
        this.physBodiesParent = new THREE.Group();
        this.modelsParent = new THREE.Group();
        this.world.scene.add(this.physBodiesParent, this.modelsParent);
        this.ecs = new EcsWorld();
        this.ecs.addSystem(new SceneCleanupSystem(this.world.scene));
        this.ecs.addSystem(new BodyRenderSystem(this.physBodiesParent, this.gltfLoader));
        this.ecs.addSystem(new ModelRenderSystem(this.modelsParent, this.gltfLoader));
        this.ecs.addSystem(new SnapshotSystem());
        this.ecs.addSystem(new PlayerRenderSystem(this.world.scene, this.world.camera, () => this.conn.id));
        this.ecs.addSystem(new JointRenderSystem(this.world.scene));
        this.player.ecs = this.ecs;

        // Tools
        let csgTool = new CSGBrushTool();
        this.tools = [new PhysGunTool(), csgTool, new RopeTool(), new WeldTool(), new HingeTool()];
        this.spawnMenu = new SpawnMenu(this, this.tools);
        csgTool.init(this);
        this.spawnMenu.onPropSelected = (propId) => this.spawnProp(propId);

        window.addEventListener('pointerdown', (e) => {
            if(this.spawnMenu.isOpen) return;
            if(this.player.controls && this.player.controls.isLocked) {
                e.preventDefault();
                let tool = this.spawnMenu.getCurrentTool();
                if(e.button === 0) tool.onPrimaryFire(this);
                else if(e.button === 2) tool.onSecondaryFire(this);
            }
        });
        window.addEventListener("wheel", (e) => {
            if(this.player.controls && this.player.controls.isLocked) {
                e.preventDefault();
                this.spawnMenu.getCurrentTool().onScroll(this, e.deltaY);
            }
        }, { passive: false });
        window.addEventListener('keydown', (e) => {
            if(e.code >= 'Digit1' && e.code <= 'Digit9') {
                let idx = parseInt(e.code.charAt(5)) - 1;
                if(idx < this.tools.length) this.spawnMenu.selectTool(idx);
            }
            if(e.code === 'KeyQ') this.spawnMenu.toggle();
        });

        this.frameNum = 0;
        this.lastUpdate = 0;
        this.constructorFinished = true;
    }

    // ---- terrain mirror ---------------------------------------------------

    setupTerrain() {
        this.defaultMaterial = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5, metalness: 0.5 });
        this.terrainBatch = new THREE.BatchedMesh(CHUNK_COUNT, CHUNK_COUNT * CHUNK_RESERVED_VERTS, CHUNK_COUNT * CHUNK_RESERVED_INDICES, this.defaultMaterial);
        this.terrainBatch.perObjectFrustumCulled = true;
        this.terrainBatch.castShadow = true;
        this.terrainBatch.receiveShadow = true;

        this.chunkGeoIds = [];
        this.chunkBBoxes = [];
        this.chunkBrushes = []; // Brush per chunk, kept for CSG message encoding
        let bbox = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));

        for(let x = 0; x < GRID; x++) for(let y = 0; y < GRID; y++) for(let z = 0; z < GRID; z++) {
            let geometry = y < 5 ? new THREE.BoxGeometry(10, 10, 10) : new THREE.BoxGeometry(0.1, 0.1, 0.1);
            geometry.translate(x * 10 - 45, y * 10 - 45, z * 10 - 45);
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();

            let geoId = this.terrainBatch.addGeometry(geometry, CHUNK_RESERVED_VERTS, CHUNK_RESERVED_INDICES);
            let instanceId = this.terrainBatch.addInstance(geoId);
            this.terrainBatch.setMatrixAt(instanceId, new THREE.Matrix4());

            // Non-indexed so brushToBase64() emits a true triangle soup (the server builds a Manifold from it)
            let brush = new Brush(geometry.toNonIndexed(), this.defaultMaterial);
            brush.updateMatrixWorld(true);
            brush.prepareGeometry();

            this.chunkGeoIds.push(geoId);
            this.chunkBBoxes.push(bbox.clone().translate(new THREE.Vector3(x * 10 - 45, y * 10 - 45, z * 10 - 45)));
            this.chunkBrushes.push(brush);
        }
        this.terrainBatch.computeBoundsTree();
        this.world.scene.add(this.terrainBatch);
    }

    fillChunk(chunkIndex, base64String) {
        let positions = decodeSoup(base64String);
        let numVerts = positions.length / 3;
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(numVerts * 2), 2));
        geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        let indices = new Uint32Array(numVerts);
        for(let i = 0; i < numVerts; i++) indices[i] = i;
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.computeVertexNormals();

        let geoId = this.chunkGeoIds[chunkIndex];
        this.terrainBatch.setGeometryAt(geoId, geometry);
        this.terrainBatch.computeBoundsTree(geoId);

        this.chunkBrushes[chunkIndex].geometry = geometry.toNonIndexed();
        this.chunkBrushes[chunkIndex].prepareGeometry();
    }

    brushToBase64(brush) { return encodeSoup(brush.geometry.attributes.position.array); }

    // ---- networking -------------------------------------------------------

    updateFromServer(event) {
        if(typeof event.data !== 'string' || !event.data.startsWith("{")) return;
        let data = JSON.parse(event.data);
        if(data.type !== "fullupdate" && data.type !== "partialupdate") return;
        if(data.serverTickMs !== undefined) this.serverTickMs = data.serverTickMs;

        if(data.entities) this.ecs.applySnapshot(data.entities, { full: data.type === "fullupdate", removed: data.removed || [] });
        for(let chunkIndex in data.chunks) this.fillChunk(chunkIndex, '' + data.chunks[chunkIndex].data);
    }

    /** Entity id for a three.js object created by a render system (walks up parents). */
    bodyIdFromObject(object) {
        for(let o = object; o; o = o.parent) if(o.userData.entityId) return o.userData.entityId;
        return null;
    }

    /** The three.js object representing an entity, if any. */
    meshFor(id) { return this.ecs.get(id, '$Mesh')?.object; }

    // ---- loop -------------------------------------------------------------

    update(timeMS) {
        if(!this.constructorFinished) return;
        this.deltaTime = timeMS - this.timeMS;
        this.timeMS = timeMS;

        let physicsSteps = this.simulationParams.physicsSteps;
        for(let i = 0; i < physicsSteps; i++) this.player.updatePlayer(Math.min(this.deltaTime / 1000.0, 0.1) / physicsSteps);

        this.spawnMenu.getCurrentTool().update(this, this.deltaTime / 1000.0);

        if(this.lastUpdate + 1000 / 30 < timeMS) {
            this.lastUpdate = timeMS;
            this.conn.send(JSON.stringify({ type: "player", position: { x: this.player.position.x, y: this.player.position.y - 0.5, z: this.player.position.z } }));
        }

        this.ecs.update(this.deltaTime / 1000.0);

        this.world.renderPipeline.render();
        this.world.stats.update();

        if(!this.serverTickDisplay) {
            this.serverTickDisplay = document.createElement('div');
            this.serverTickDisplay.style.cssText = 'position:fixed;top:0;right:0;padding:4px 8px;background:rgba(0,0,0,0.7);color:#0f0;font:12px monospace;z-index:10000;';
            document.body.appendChild(this.serverTickDisplay);
        }
        this.serverTickDisplay.textContent = 'Server: ' + this.serverTickMs + 'ms';
        this.frameNum++;
    }

    spawnProp(propId) {
        this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.world.camera);
        let intersects = this.raycaster.intersectObjects([this.terrainBatch, this.physBodiesParent], true);
        let halfExtent = getPropDef(propId).halfExtent;
        let spawnPos = new THREE.Vector3();
        if(intersects.length > 0) {
            let hit = intersects[0];
            let normal = hit.face ? hit.face.normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
            spawnPos.copy(hit.point).addScaledVector(normal, halfExtent + 0.05);
        } else {
            this.world.camera.getWorldDirection(spawnPos).normalize().multiplyScalar(6).add(this.player.position);
        }
        this.conn.send(JSON.stringify({ type: "spawnprop", propId, position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }));
    }

    fakeError(...args) {
        if(args.length > 0 && args[0]) this.display(JSON.stringify(args[0]));
        window.realConsoleError.apply(console, arguments);
    }

    display(text) {
        let errorNode = window.document.createElement("div");
        errorNode.innerHTML = text.fontcolor("red");
        window.document.getElementById("info").appendChild(errorNode);
    }

    isMobile() {
        return /android|iphone|ipad|ipod|mobile|blackberry|iemobile|opera mini/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
    }
}

var main = new Main();
window._main = main; // Exposed for debugging/testing
