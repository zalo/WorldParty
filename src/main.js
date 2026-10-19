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
import { discordMode, connectDiscord } from './client/Discord.js';

import { World as EcsWorld } from './ecs/World.js';
import { encodeSoup, unpackChunkFrame } from './net/codec.js';
import { TerrainMirror } from './client/TerrainMirror.js';
import { TerrainTextures } from './client/TerrainTextures.js';
import { makeTerrainMaterial } from './client/terrainMaterial.js';
import { getPropDef } from './props/PropRegistry.js';
import { PLAYER_GRAVITY } from './gravity.js';
import { SceneCleanupSystem, SnapshotSystem, BodyRenderSystem, PlayerRenderSystem, JointRenderSystem, ModelRenderSystem } from './client/systems.js';

import { CSGBrushTool } from './tools/CSGBrushTool.js';
import { PhysGunTool } from './tools/PhysGunTool.js';
import { RopeTool } from './tools/RopeTool.js';
import { WeldTool } from './tools/WeldTool.js';
import { HingeTool } from './tools/HingeTool.js';
import { SpawnMenu } from './ui/SpawnMenu.js';
import { GameClient } from './client/GameClient.js';


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
        // Reach the server through whatever served this page (a reverse proxy may add a path
        // prefix); the bundler's PARTYKIT_HOST is only the fallback for non-http origins.
        let proxied = /^https?:$/.test(window.location.protocol);
        this.basePath = proxied ? window.location.pathname.replace(/\/[^/]*$/, '') : '';
        this.serverHost = proxied ? window.location.host : PARTYKIT_HOST;
        // As a Discord Activity (src/client/Discord.js) the room is the activity instance, so everyone who
        // launched it from the same channel plays together, and the room starts as Fort War (importFortWarIfEmpty)
        let discord = discordMode();
        if(discord) {
            this.discord = await connectDiscord(discord, this.basePath);
            this.curRoom = 'discord-' + this.discord.instanceId;
            this.autoImport = './assets/worlds/fortwar.json';
        } else if(this.queryParams.has("room")){
            this.curRoom = this.queryParams.get('room') || "global";
        }else{
            this.curRoom = "global";
            this.queryParams.set("room", this.curRoom);
            window.history.replaceState({}, "", `${window.location.pathname}?${this.queryParams.toString()}`);
        }

        this.conn = new PartySocket({ host: this.serverHost, room: this.curRoom, prefix: (this.basePath ? this.basePath.slice(1) + '/' : '') + 'parties' });
        try { this.conn.binaryType = 'arraybuffer'; } catch(e) {}
        this.conn.addEventListener("message", this.updateFromServer.bind(this));
        // every (re)connection is a new server-side player: name it after the Discord user each time
        if(this.discord?.name) this.conn.addEventListener("open", () => this.conn.send(JSON.stringify({ type: "name", name: this.discord.name })));
        // ?gravity=<m/s²> sets the room's body gravity (persisted with the world config; see src/gravity.js)
        if(this.queryParams.has("gravity")) {
            let gravity = parseFloat(this.queryParams.get("gravity"));
            this.conn.addEventListener("open", () => this.conn.send(JSON.stringify({ type: "setgravity", gravity })), { once: true });
        }
        // ?import=<manifest url> uploads a world (tools/import-world.mjs output) into the room once connected
        if(this.queryParams.has("import")) {
            let url = this.queryParams.get("import");
            this.conn.addEventListener("open", () => this.importWorld(url).catch(e => console.error('importWorld failed: ' + e.message)), { once: true });
        }

        this.serverTickMs = 0;
        this.world = new World(this, this.isMobile());
        this.simulationParams = { firstPerson: true, gravity: -PLAYER_GRAVITY, playerSpeed: 10, physicsSteps: 5, jumpVelocity: 20.0, mobile: this.isMobile() };
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
        this.ecs.addSystem(new BodyRenderSystem(this.physBodiesParent, this.gltfLoader, () => this.terrain.table, () => this.terrain.layers, this.fragmentMaterial));
        this.ecs.addSystem(new ModelRenderSystem(this.modelsParent, this.gltfLoader));
        this.ecs.addSystem(new SnapshotSystem());
        this.ecs.addSystem(new PlayerRenderSystem(this.world.scene, this.world.camera, () => this.conn.id));
        this.ecs.addSystem(new JointRenderSystem(this.world.scene));
        this.player.ecs = this.ecs;

        // Tools
        let csgTool = new CSGBrushTool();
        this.tools = [new PhysGunTool(), csgTool, new RopeTool(), new WeldTool(), new HingeTool()];
        this.spawnMenu = new SpawnMenu(this, this.tools);
        this.spawnMenu.setVisible(false); // the sandbox tools must not flash up in a Fort War room: wait for the world config
        csgTool.init(this);
        this.spawnMenu.onPropSelected = (propId) => this.spawnProp(propId);

        this.primaryHeld = false;
        window.addEventListener('pointerdown', (e) => {
            if(this.spawnMenu.isOpen) return;
            if(this.player.controls && this.player.controls.isLocked) {
                e.preventDefault();
                let tool = this.spawnMenu.getCurrentTool();
                if(e.button === 0) { this.primaryHeld = true; tool.onPrimaryFire(this); }
                else if(e.button === 2) tool.onSecondaryFire(this);
            }
        });
        window.addEventListener('pointerup', (e) => {
            if(e.button !== 0) return;
            let held = this.primaryHeld;
            this.primaryHeld = false;
            let tool = this.spawnMenu.getCurrentTool();
            if(held && tool.onPrimaryRelease) tool.onPrimaryRelease(this);
        });
        // the wheel switches tools unless the current tool claims it (a held physgun object, Shift with the mason)
        this.wheelAcc = 0;
        window.addEventListener("wheel", (e) => {
            if(this.player.controls && this.player.controls.isLocked) {
                e.preventDefault();
                if(this.spawnMenu.getCurrentTool().onScroll(this, e.deltaY, e)) { this.wheelAcc = 0; return; }
                this.wheelAcc += e.deltaY;
                if(Math.abs(this.wheelAcc) < 40) return; // one notch of a mouse wheel; trackpads add up to it
                let n = this.tools.length, i = (this.spawnMenu.currentToolIndex + (this.wheelAcc > 0 ? 1 : n - 1)) % n;
                this.wheelAcc = 0;
                this.spawnMenu.selectTool(i);
            }
        }, { passive: false });
        window.addEventListener('keydown', (e) => {
            if(e.target && e.target.tagName === 'INPUT') return;
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
        // Flat-colour materials use the per-face vertex colour; textured ones sample the world's texture array
        // by the per-vertex layer index (`slot`, -1 = flat), triplanar in world space or by UV (terrainMaterial.js)
        this.textures = new TerrainTextures();
        let tridebug = parseInt(this.queryParams.get('tridebug') || '0') || 0;
        this.defaultMaterial = makeTerrainMaterial(this.textures.texture, 'world', tridebug);
        this.fragmentMaterial = makeTerrainMaterial(this.textures.texture, 'local', tridebug);
        this.terrain = new TerrainMirror(this.world.scene, this.defaultMaterial);
        this.terrain.fetchChunk = (index, version) => this.fetchChunk(index, version);
        this.terrain.onWorldChanged = (w) => this.onWorldChanged(w);
        this.chunkListeners = [];   // (key, box) => void after a chunk's content changed: the probe grid, the glow volume
        // box: what changed (a carve's region), clipped to the chunk; the whole chunk when there is nothing to compare with
        this.terrain.onChunkChanged = (key, box) => {
            let region = box ? box.clone().intersect(this.terrain.bbox(key)) : this.terrain.bbox(key);
            if(region.isEmpty()) region = this.terrain.bbox(key);
            for(let fn of this.chunkListeners) fn(key, region);
        };
        this.terrainBatch = this.terrain.group; // raycast target for tools (one mesh per chunk)
        this.onWorldChanged(this.terrain.world);
    }

    /** A world config arrived (or changed): refresh textures and anything sized by the bounds. */
    onWorldChanged(world) {
        this.textures.load(world).then(layers => this.terrain.setTextureLayers(layers));
        this.probeRows = null; // a new world: the probe band starts over
        let band = this.probeBounds(world); if(band) this.probes?.setBounds(...band);
        // Fort War: a level manifest's rules arm the player and bring up the HUD (src/client/GameClient.js)
        if(world.game && !this.game && this.constructorFinished) this.game = new GameClient(this, world.game);
        else if(world.game && this.game) this.game.configure(world.game);
    }

    /** The probe volume: the world bounds, clipped vertically to the rows of chunks the client holds, so a
     *  deep world's probes are spent on the band with terrain in it rather than on empty sky and buried rock
     *  (Twin Forts: 40 m of content inside 80 m of bounds, 3x the probe density for the same count). The band
     *  only ever grows (the union of every row held so far), so a trip into the vault adds a row of probes
     *  (ProbeLighting keeps the baked ones) rather than shrinking the band again on the way back. Null until
     *  the first chunks arrive: a grid over the full bounds would be thrown away a second later. */
    probeBounds(w) {
        const CHUNK = 10;
        let rows = [...this.terrain.versions.keys()].map(k => +k.split(',')[1]);
        if(!rows.length) return null;
        this.probeRows = { min: Math.min(this.probeRows?.min ?? Infinity, ...rows), max: Math.max(this.probeRows?.max ?? -Infinity, ...rows) };
        let min = new THREE.Vector3(...w.bounds.min.map(v => v * CHUNK)), max = new THREE.Vector3(...w.bounds.max.map(v => (v + 1) * CHUNK));
        min.y = Math.max(min.y, this.probeRows.min * CHUNK); max.y = Math.min(max.y, (this.probeRows.max + 1) * CHUNK);
        return [min, max];
    }

    /** Re-fit the probe grid when the held chunks reach rows it does not cover (debounced: chunks arrive in bursts). */
    refitProbes() {
        if(!this.probes) return;
        clearTimeout(this.probeRefit);
        this.probeRefit = setTimeout(() => {
            let band = this.probeBounds(this.terrain.world);
            if(band) this.probes.setBounds(...band); // a no-op for the band it already covers
        }, 1500);
    }

    /** Probe grid follows the world bounds and rebakes around every chunk change. */
    attachProbes(probes) {
        this.probes = probes;
        probes.occluders = this.terrain.group; // chunk meshes with BVHs: probes that land inside rock bake from the nearest air
        let band = this.probeBounds(this.terrain.world);
        if(band) probes.setBounds(...band);
        this.chunkListeners.push((key, region) => probes.markDirty(region));
        for(let light of this.probeMuted || []) probes.mute.push(light);
    }

    /** A light the probe bake should not see (the glow volume: the probes would bake it in again at their 6 m). */
    muteDuringProbeBake(light) {
        (this.probeMuted ||= []).push(light);
        this.probes?.mute.push(light);
    }

    /** Upload a world manifest written by tools/import-world.mjs to the room, in batches under the message limit. */
    async importWorld(url) {
        let manifest = await (await fetch(url)).json();
        const send = (msg) => this.conn.send(JSON.stringify(msg));
        send({ type: 'import_begin', world: manifest.world, name: manifest.name });
        const LIMIT = 300000; // base64 chars per message, well under the 1 MiB WebSocket frame limit
        let batch = {}, size = 0, sent = 0;
        const flush = () => { if(size) { send({ type: 'import_chunks', chunks: batch }); batch = {}; size = 0; } };
        for(let key in manifest.chunks) {
            let rec = manifest.chunks[key], b64 = rec.bytes;
            sent++;
            if(b64.length > LIMIT) {
                // one chunk per message, in pieces the server joins back
                flush();
                let parts = Math.ceil(b64.length / LIMIT);
                for(let i = 0; i < parts; i++) send({ type: 'import_chunks', chunks: { [key]: { version: rec.version, part: i, parts, bytes: b64.slice(i * LIMIT, (i + 1) * LIMIT) } } });
                continue;
            }
            batch[key] = rec;
            size += b64.length;
            if(size > LIMIT) flush();
        }
        flush();
        send({ type: 'import_end' });
        console.log(`importWorld: sent ${sent} chunks from ${url}`);
        return sent;
    }

    /** Chunk bytes by content version over HTTP (cacheable, immutable per version). */
    async fetchChunk(key, version) {
        let protocol = location.protocol === 'https:' ? 'https:' : 'http:';
        let res = await fetch(`${protocol}//${this.serverHost}${this.basePath}/parties/main/${encodeURIComponent(this.curRoom)}/chunk/${key}?v=${version}`);
        if(res.status === 204) return null;
        if(!res.ok) throw new Error('HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
    }

    brushToBase64(brush) { return encodeSoup(brush.geometry.attributes.position.array); }

    // ---- networking -------------------------------------------------------

    updateFromServer(event) {
        if(event.data instanceof ArrayBuffer) {
            let frame = unpackChunkFrame(event.data);
            if(frame) {
                let t0 = performance.now();
                let applied = frame.delta ? this.terrain.applyDelta(frame.key, frame.version, frame.baseVersion, frame.bytes) : (this.terrain.setChunk(frame.key, frame.bytes, frame.version), true);
                let ms = performance.now() - t0;
                if(!applied) console.log(`chunk ${frame.key}: delta against ${frame.baseVersion} not applicable (holding ${this.terrain.versions.get(frame.key)}), waiting for a full version`);
                else if(ms > 30 || frame.delta) console.log(`chunk ${frame.key}: ${(frame.bytes ? frame.bytes.length / 1024 : 0).toFixed(0)} KB ${frame.delta ? 'delta' : 'full'} applied in ${ms.toFixed(0)} ms`);
            }
            return;
        }
        if(typeof event.data !== 'string' || !event.data.startsWith("{")) return;
        let data = JSON.parse(event.data);
        if(data.type !== "fullupdate" && data.type !== "partialupdate") {
            if(this.game) this.game.onMessage(data);
            else if(data.type === 'chat') console.log(`chat ${data.sender}: ${data.message}`);
            return;
        }
        if(data.serverTickMs !== undefined) this.serverTickMs = data.serverTickMs;

        let full = data.type === "fullupdate";
        if(data.chunks || data.rock || data.cull || full) this.terrain.applyUpdate(data, full); // world config first: the game client wants to exist before its entities arrive
        if(data.entities) this.ecs.applySnapshot(data.entities, { full, removed: data.removed || [] });
        if(full && this.autoImport) this.importIfEmpty(data);
        if(full && !this.roomKnown) { this.roomKnown = true; this.spawnMenu.setVisible(true); }
        if(full) this.refitProbes();
    }

    /** A fresh Discord room has no level yet: the first full update without game rules makes the player with the
     *  lowest connection id (so two simultaneous launchers agree on one) upload the Fort War manifest. */
    importIfEmpty(data) {
        if(this.terrain.world?.game) { this.autoImport = null; return; }
        let players = Object.entries(data.entities || {}).filter(([, e]) => e.Player).map(([id]) => id).sort();
        if(players.length && players[0] !== this.conn.id) return;
        let url = this.autoImport; this.autoImport = null;
        this.importWorld(url).catch(e => console.error('importWorld failed: ' + e.message));
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
        if(this.game) this.game.update(this.deltaTime / 1000.0);

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
