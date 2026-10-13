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
import { encodeSoup, unpackChunkFrame } from './net/codec.js';
import { TerrainMirror } from './client/TerrainMirror.js';
import { getPropDef } from './props/PropRegistry.js';
import { SceneCleanupSystem, SnapshotSystem, BodyRenderSystem, PlayerRenderSystem, JointRenderSystem, ModelRenderSystem } from './client/systems.js';

import { CSGBrushTool } from './tools/CSGBrushTool.js';
import { PhysGunTool } from './tools/PhysGunTool.js';
import { RopeTool } from './tools/RopeTool.js';
import { WeldTool } from './tools/WeldTool.js';
import { HingeTool } from './tools/HingeTool.js';
import { SpawnMenu } from './ui/SpawnMenu.js';


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
        try { this.conn.binaryType = 'arraybuffer'; } catch(e) {}
        this.conn.addEventListener("message", this.updateFromServer.bind(this));
        // ?import=<manifest url> uploads a world (tools/import-world.mjs output) into the room once connected
        if(this.queryParams.has("import")) {
            let url = this.queryParams.get("import");
            this.conn.addEventListener("open", () => this.importWorld(url).catch(e => console.error('importWorld failed: ' + e.message)), { once: true });
        }

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
        this.player.terrain = this.terrain;

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
            let tool = this.spawnMenu.getCurrentTool();
            if(tool.onKey) tool.onKey(this, e.code);
        });

        this.frameNum = 0;
        this.lastUpdate = 0;
        this.constructorFinished = true;
    }

    // ---- terrain mirror ---------------------------------------------------

    setupTerrain() {
        this.defaultMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.7, metalness: 0.1, flatShading: true });
        this.terrain = new TerrainMirror(this.world.scene, this.defaultMaterial);
        this.terrain.fetchChunk = (index, version) => this.fetchChunk(index, version);
        this.terrainBatch = this.terrain.batch; // raycast target for tools
    }

    /** Upload a world manifest written by tools/import-world.mjs to the room, in batches under the message limit. */
    async importWorld(url) {
        let manifest = await (await fetch(url)).json();
        const send = (msg) => this.conn.send(JSON.stringify(msg));
        send({ type: 'import_begin', world: manifest.world, name: manifest.name });
        let batch = {}, size = 0, sent = 0;
        const flush = () => { if(size) { send({ type: 'import_chunks', chunks: batch }); batch = {}; size = 0; } };
        for(let key in manifest.chunks) {
            batch[key] = manifest.chunks[key];
            size += manifest.chunks[key].bytes.length;
            sent++;
            if(size > 400000) flush();
        }
        flush();
        send({ type: 'import_end' });
        console.log(`importWorld: sent ${sent} chunks from ${url}`);
        return sent;
    }

    /** Chunk bytes by content version over HTTP (cacheable, immutable per version). */
    async fetchChunk(key, version) {
        let protocol = location.protocol === 'https:' ? 'https:' : 'http:';
        let res = await fetch(`${protocol}//${PARTYKIT_HOST}/parties/main/${encodeURIComponent(this.curRoom)}/chunk/${key}?v=${version}`);
        if(res.status === 204) return null;
        if(!res.ok) throw new Error('HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
    }

    brushToBase64(brush) { return encodeSoup(brush.geometry.attributes.position.array); }

    // ---- networking -------------------------------------------------------

    updateFromServer(event) {
        if(event.data instanceof ArrayBuffer) {
            let frame = unpackChunkFrame(event.data);
            if(frame) this.terrain.setChunk(frame.key, frame.bytes, frame.version);
            return;
        }
        if(typeof event.data !== 'string' || !event.data.startsWith("{")) return;
        let data = JSON.parse(event.data);
        if(data.type !== "fullupdate" && data.type !== "partialupdate") return;
        if(data.serverTickMs !== undefined) this.serverTickMs = data.serverTickMs;

        let full = data.type === "fullupdate";
        if(data.entities) this.ecs.applySnapshot(data.entities, { full, removed: data.removed || [] });
        if(data.chunks || data.rock || data.cull || full) this.terrain.applyUpdate(data, full);
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
        this.world.update(this.deltaTime / 1000.0);

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
