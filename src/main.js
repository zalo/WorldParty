/* eslint-env browser */
/* global PARTYKIT_HOST */

import * as THREE from 'three/webgpu';
import World from './World.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
const { MeshoptDecoder } = await import( 'three/examples/jsm/libs/meshopt_decoder.module.js' );
import { PlayerController } from './PlayerController.js';
import { Brush, Evaluator } from 'three-bvh-csg';
import { MeshBVH, computeBoundsTree, disposeBoundsTree, computeBatchedBoundsTree, disposeBatchedBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import PartySocket from "partysocket";
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { gzipSync, gunzipSync } from 'three/examples/jsm/libs/fflate.module.js';

import { CSGBrushTool } from './tools/CSGBrushTool.js';
import { PhysGunTool } from './tools/PhysGunTool.js';
import { RopeTool } from './tools/RopeTool.js';
import { WeldTool } from './tools/WeldTool.js';
import { HingeTool } from './tools/HingeTool.js';
import { SpawnMenu } from './ui/SpawnMenu.js';


/** The fundamental set up and animation structures for Simulation */
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
        this.players = {};
        this.models = {};
        this.conn.addEventListener("message", this.updateFromServer.bind(this));

        // Construct the render world
        this.serverTickMs = 0;
        this.world = new World(this, this.isMobile());

        this.simulationParams = {
            firstPerson: true,
            gravity: - 80,
            playerSpeed: 10,
            physicsSteps: 5,
            jumpVelocity: 20.0,
            mobile: this.isMobile(),
        };

        this.raycaster = new THREE.Raycaster();

        // Shared GLTF loader with Draco + Meshopt support
        this.gltfLoader = new GLTFLoader();
        let dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
        this.gltfLoader.setDRACOLoader(dracoLoader);
        this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);

        // Chunk terrain setup using BatchedMesh for minimal draw calls
        const CHUNK_RESERVED_VERTS = 10000;
        const CHUNK_RESERVED_INDICES = 30000; // ~3 indices per vertex for non-indexed triangle soup
        const CHUNK_COUNT = 1000; // 10x10x10
        let bbox = new THREE.Box3( new THREE.Vector3( -5.0, -5.0, -5.0 ), new THREE.Vector3( 5.0, 5.0, 5.0 ) );
        this.defaultMaterial = new THREE.MeshStandardMaterial( { color: 0x808080, roughness: 0.5, metalness: 0.5 } );

        // Install BVH extensions on geometry prototypes
        THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
        THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
        THREE.BatchedMesh.prototype.computeBoundsTree = computeBatchedBoundsTree;
        THREE.BatchedMesh.prototype.disposeBoundsTree = disposeBatchedBoundsTree;
        THREE.BatchedMesh.prototype.raycast = acceleratedRaycast;

        this.terrainBatch = new THREE.BatchedMesh(CHUNK_COUNT, CHUNK_COUNT * CHUNK_RESERVED_VERTS, CHUNK_COUNT * CHUNK_RESERVED_INDICES, this.defaultMaterial);
        this.terrainBatch.perObjectFrustumCulled = true;
        this.terrainBatch.castShadow = true;
        this.terrainBatch.receiveShadow = true;

        // Per-chunk metadata (bbox for broadphase, geoId/instanceId into the batch)
        this.chunkGeoIds = [];
        this.chunkInstanceIds = [];
        this.chunkBBoxes = [];
        // Keep Brush objects for CSG encoding (brushToBase64 needs them)
        this.chunkBrushes = [];

        for( let x = 0; x < 10; x++ ) {
            for( let y = 0; y < 10; y++ ) {
                for( let z = 0; z < 10; z++ ) {
                    // BoxGeometry is indexed with position, normal, uv
                    let geometry = y < 5 ? new THREE.BoxGeometry( 10.0, 10.0, 10.0 ) : new THREE.BoxGeometry( 0.1, 0.1, 0.1 );
                    let vertices = geometry.attributes.position.array;
                    for (let i = 0; i < vertices.length; i += 3) {
                        vertices[i    ] += x * 10.0 - 45.0;
                        vertices[i + 1] += y * 10.0 - 45.0;
                        vertices[i + 2] += z * 10.0 - 45.0;
                    }
                    geometry.attributes.position.needsUpdate = true;
                    geometry.computeBoundingBox();
                    geometry.computeBoundingSphere();

                    let geoId = this.terrainBatch.addGeometry(geometry, CHUNK_RESERVED_VERTS, CHUNK_RESERVED_INDICES);
                    let instanceId = this.terrainBatch.addInstance(geoId);
                    // Identity matrix - geometry is already in world space
                    this.terrainBatch.setMatrixAt(instanceId, new THREE.Matrix4());

                    let chunkBbox = bbox.clone().translate(
                        new THREE.Vector3( x * 10.0 - 45.0, y * 10.0 - 45.0, z * 10.0 - 45.0 )
                    );

                    // Keep a Brush for CSG serialization
                    let brush = new Brush( geometry.clone(), this.defaultMaterial );
                    brush.updateMatrixWorld( true );
                    brush.prepareGeometry();

                    this.chunkGeoIds.push(geoId);
                    this.chunkInstanceIds.push(instanceId);
                    this.chunkBBoxes.push(chunkBbox);
                    this.chunkBrushes.push(brush);
                }
            }
        }

        // Compute BVH for all geometries in the batch
        this.terrainBatch.computeBoundsTree();

        // Legacy compat: this.chunks array used by CSGBrushTool and PlayerController
        this.chunks = this.chunkBrushes;

        this.placeholderGeometry = new THREE.BoxGeometry( 2, 2, 2 );
        this.placeholderMaterial = new THREE.MeshBasicMaterial( { color: 0xffffff, wireframe: true } );

        // Player controller
        this.player = new PlayerController(this.world.camera, this.simulationParams);
        this.world.scene.add( this.player );
        this.player.reset();

        // CSG brush (owned by CSGBrushTool but created here for shared access)
        this.transparentMaterial = new THREE.MeshStandardMaterial( { color: 0x8080a8, roughness: 0.5, metalness: 0.5, transparent: true, opacity: 0.5, side: THREE.DoubleSide } );
        this.brush2 = new Brush( new THREE.BoxGeometry(2, 2, 2).toNonIndexed(), this.transparentMaterial );
        this.brush2.position.y = -0.5;
        this.brush2.castShadow = true;
        this.brush2.visible = false;
        this.brush2.updateMatrixWorld();
        this.world.scene.add( this.brush2 );

        this.world.scene.add( this.terrainBatch );

        this.modelsParent = new THREE.Group();
        this.world.scene.add( this.modelsParent );

        // Physics body meshes + snapshot interpolation
        this.physBodyMeshes = {};
        this.physBodySnapshots = {};
        this.physSnapshotInterval = 1000 / 15;
        this.physBodyGeometry = new THREE.BoxGeometry(1, 1, 1);
        this.physBodySphereGeometry = new THREE.SphereGeometry(0.5, 16, 12);
        this.physBodyCylinderGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
        this.physBodyConeGeometry = new THREE.ConeGeometry(0.5, 1, 16);

        // BVH cache per prop type for player collision (propId/key -> MeshBVH)
        this.propBVHCache = {};
        // Pre-compute BVH for primitive geometries
        this.physBodyGeometry.computeBoundsTree();
        this.propBVHCache['cube'] = this.physBodyGeometry.boundsTree;
        this.physBodySphereGeometry.computeBoundsTree();
        this.propBVHCache['_sphere'] = this.physBodySphereGeometry.boundsTree;
        this.physBodyCylinderGeometry.computeBoundsTree();
        this.propBVHCache['_cylinder'] = this.physBodyCylinderGeometry.boundsTree;
        this.physBodyConeGeometry.computeBoundsTree();
        this.propBVHCache['_cone'] = this.physBodyConeGeometry.boundsTree;
        this.physBodyMaterial = new THREE.MeshStandardMaterial( { color: 0xdd8844, roughness: 0.4, metalness: 0.3 } );
        this.propColors = {
            cube: 0xdd8844, barrel: 0x8B4513, crate: 0xDEB887, plank: 0xCD853F,
            sphere: 0xCC4444, wheel: 0x555555, ramp: 0x888888, cone: 0xFF8C00,
            cylinder: 0x6B8E23, bigcube: 0x8B0000, smallcube: 0xFFD700
        };
        this.physBodiesParent = new THREE.Group();
        this.world.scene.add( this.physBodiesParent );

        // Joint visuals
        this.jointVisuals = {};
        this.jointLineMaterial = new THREE.LineBasicMaterial({ color: 0xffaa00 });

        this.player.chunks = this.chunks; // Legacy: Brush array for CSGBrushTool
        this.player.terrainBatch = this.terrainBatch;
        this.player.chunkGeoIds = this.chunkGeoIds;
        this.player.chunkBBoxes = this.chunkBBoxes;
        this.player.physBodyMeshes = this.physBodyMeshes;

        // --- Tool system ---
        let csgTool = new CSGBrushTool();
        let physGunTool = new PhysGunTool();
        let ropeTool = new RopeTool();
        let weldTool = new WeldTool();
        let hingeTool = new HingeTool();

        this.tools = [physGunTool, csgTool, ropeTool, weldTool, hingeTool];
        this.spawnMenu = new SpawnMenu(this, this.tools);

        // Initialize tools that need setup
        csgTool.init(this);

        // Spawn menu callback
        this.spawnMenu.onPropSelected = (propId) => {
            this.spawnProp(propId);
        };

        // Input handling: route to active tool
        window.addEventListener('pointerdown', (e) => {
            if(this.spawnMenu.isOpen) return;
            if(this.player && this.player.controls && this.player.controls.isLocked) {
                e.preventDefault();
                let tool = this.spawnMenu.getCurrentTool();
                if (e.button === 0) {
                    tool.onPrimaryFire(this);
                } else if (e.button === 2) {
                    tool.onSecondaryFire(this);
                }
            }
        });
        window.addEventListener("wheel", (e) => {
            if(this.player && this.player.controls && this.player.controls.isLocked){
                e.preventDefault();
                this.spawnMenu.getCurrentTool().onScroll(this, e.deltaY);
            }
        }, { passive: false });
        window.addEventListener('keydown', (e) => {
            // Tool switching with number keys
            if(e.code >= 'Digit1' && e.code <= 'Digit9') {
                let idx = parseInt(e.code.charAt(5)) - 1;
                if(idx < this.tools.length) this.spawnMenu.selectTool(idx);
            }
            // Q to toggle spawn menu
            if(e.code === 'KeyQ') {
                this.spawnMenu.toggle();
            }
        });

        this.frameNum = 0;
        this.lastUpdate = 0;
        this.constructorFinished = true;
    }

    /** @param {MessageEvent} event - The message event */
    updateFromServer(event) {
        let dataString = event.data;
        if (!dataString.startsWith("{")) return;

        let data = JSON.parse(dataString);
        if (!data.type.includes("update")) return;

        if(data.serverTickMs !== undefined) this.serverTickMs = data.serverTickMs;

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

                // Name label
                let label = document.createElement('div');
                label.textContent = this.players[player].name || 'Player';
                label.style.cssText = 'position:fixed;color:#fff;font:bold 12px monospace;background:rgba(0,0,0,0.5);padding:2px 6px;border-radius:3px;pointer-events:none;white-space:nowrap;z-index:1500;';
                label.style.display = player !== this.conn.id ? 'block' : 'none';
                document.body.appendChild(label);
                this.players[player].label = label;
            } else {
                Object.assign(this.players[player], data.players[player]);
                if(this.players[player].label) {
                    this.players[player].label.textContent = this.players[player].name || 'Player';
                }
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
                    this.modelsParent.remove(this.models[modelId].mesh);
                    this.models[modelId].mesh = null;
                    this.loadModelMesh(modelId);
                } else if (this.models[modelId].mesh) {
                    this.models[modelId].mesh.quaternion.set(
                        this.models[modelId].quaternion.x, this.models[modelId].quaternion.y,
                        this.models[modelId].quaternion.z, this.models[modelId].quaternion.w);
                    this.models[modelId].mesh.scale.set(
                        this.models[modelId].scale.x, this.models[modelId].scale.y, this.models[modelId].scale.z);
                }
            }
            this.models[modelId].dirty = false;
        }

        // Update physics body snapshots
        if(data.physBodies) {
            let now = performance.now();
            for (let bodyId in data.physBodies) {
                let bd = data.physBodies[bodyId];
                if(!this.physBodyMeshes[bodyId]) {
                  if(bd.meshData) {
                    // Terrain fragment: create mesh from server-provided geometry
                    let fragMesh = this.createFragmentMesh(bd.meshData);
                    fragMesh.castShadow = true;
                    fragMesh.receiveShadow = true;
                    this.physBodiesParent.add(fragMesh);
                    this.physBodyMeshes[bodyId] = fragMesh;
                    // BVH for player collision
                    fragMesh.geometry.computeBoundsTree();
                    fragMesh.userData.collisionBVH = fragMesh.geometry.boundsTree;
                    fragMesh.userData.halfExtent = bd.halfExtent;
                  } else {
                    let s = bd.halfExtent * 2;
                    // Create placeholder mesh immediately
                    let color = this.propColors[bd.propId] || 0xdd8844;
                    let mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 });
                    let mesh = new THREE.Mesh(this.physBodyGeometry, mat);
                    mesh.scale.set(s, s, s);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    this.physBodiesParent.add(mesh);
                    this.physBodyMeshes[bodyId] = mesh;

                    // Assign BVH for collision — primitives use cached BVH
                    mesh.userData.collisionBVH = this.propBVHCache['cube'];
                    mesh.userData.halfExtent = bd.halfExtent;

                    // Load GLTF model if available, replace placeholder
                    if(bd.propUrl) {
                        let propCacheKey = bd.propId || bd.propUrl;
                        this.gltfLoader.load(bd.propUrl, (gltf) => {
                            let model = gltf.scene;
                            // Fit model to physics body size
                            let box = new THREE.Box3().setFromObject(model);
                            let size = new THREE.Vector3();
                            box.getSize(size);
                            let maxDim = Math.max(size.x, size.y, size.z);
                            let scale = (bd.halfExtent * 2) / (maxDim || 1);
                            model.scale.set(scale, scale, scale);
                            // Center model
                            let center = new THREE.Vector3();
                            box.getCenter(center);
                            model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
                            // Wrap in group to apply transforms
                            let group = new THREE.Group();
                            group.add(model);
                            group.castShadow = true;
                            group.receiveShadow = true;
                            model.traverse(c => { if(c.isMesh) { c.castShadow = true; c.receiveShadow = true; }});

                            // Compute and cache BVH for this prop type
                            if(!this.propBVHCache[propCacheKey]) {
                                // Merge all child meshes into one geometry for BVH
                                let geoms = [];
                                model.updateMatrixWorld(true);
                                model.traverse(c => {
                                    if(c.isMesh && c.geometry) {
                                        let g = c.geometry.clone();
                                        g.applyMatrix4(c.matrixWorld);
                                        if(!g.index) {
                                            let idx = new Uint32Array(g.attributes.position.count);
                                            for(let j = 0; j < idx.length; j++) idx[j] = j;
                                            g.setIndex(new THREE.BufferAttribute(idx, 1));
                                        }
                                        geoms.push(g);
                                    }
                                });
                                if(geoms.length > 0) {
                                    let merged = mergeGeometries(geoms);
                                    if(merged) {
                                        merged.computeBoundsTree();
                                        this.propBVHCache[propCacheKey] = merged.boundsTree;
                                    }
                                }
                            }

                            group.userData.collisionBVH = this.propBVHCache[propCacheKey] || null;
                            group.userData.halfExtent = bd.halfExtent;

                            // Replace placeholder
                            this.physBodiesParent.remove(mesh);
                            this.physBodiesParent.add(group);
                            group.position.copy(mesh.position);
                            group.quaternion.copy(mesh.quaternion);
                            this.physBodyMeshes[bodyId] = group;
                        });
                    }
                  }
                }
                let newPos = new THREE.Vector3(bd.position.x, bd.position.y, bd.position.z);
                let newQuat = new THREE.Quaternion(bd.quaternion.x, bd.quaternion.y, bd.quaternion.z, bd.quaternion.w);
                let snap = this.physBodySnapshots[bodyId];
                let mesh = this.physBodyMeshes[bodyId];
                if(!snap) {
                    this.physBodySnapshots[bodyId] = {
                        prev:   { pos: newPos.clone(), quat: newQuat.clone(), time: now },
                        target: { pos: newPos, quat: newQuat, time: now }
                    };
                    mesh.position.copy(newPos);
                    mesh.quaternion.copy(newQuat);
                } else {
                    snap.prev.pos.copy(mesh.position);
                    snap.prev.quat.copy(mesh.quaternion);
                    snap.prev.time = now;
                    snap.target.pos.copy(newPos);
                    snap.target.quat.copy(newQuat);
                    snap.target.time = now + this.physSnapshotInterval;
                }

                // Highlight frozen bodies
                if(bd.frozen && mesh.material) {
                    mesh.material.color.setHex(0x8888ff);
                } else if(mesh.material) {
                    mesh.material.color.setHex(0xdd8844);
                }
            }
        }

        // Update joint visuals
        if(data.joints) {
            for(let jointId in data.joints) {
                let j = data.joints[jointId];
                if(!this.jointVisuals[jointId]) {
                    let geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
                    let line = new THREE.Line(geom, this.jointLineMaterial);
                    line.frustumCulled = false;
                    this.world.scene.add(line);
                    this.jointVisuals[jointId] = { line, data: j };
                } else {
                    this.jointVisuals[jointId].data = j;
                }
            }
            // Remove joints no longer in data (on full update)
            if(data.type === "fullupdate") {
                for(let jointId in this.jointVisuals) {
                    if(!data.joints[jointId]) {
                        this.world.scene.remove(this.jointVisuals[jointId].line);
                        delete this.jointVisuals[jointId];
                    }
                }
            }
        }

        // Remove disconnected players and deleted models on full update
        if(data.type === "fullupdate"){
            for (let player in this.players) {
                if (this.players[player].dirty) {
                    this.world.scene.remove(this.players[player].mesh);
                    if(this.players[player].label) this.players[player].label.remove();
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
        this.gltfLoader.load(this.models[modelId].url, (gltf) => {
            gltf.scene.position.copy(this.models[modelId].position);
            gltf.scene.quaternion.copy(this.models[modelId].quaternion);
            gltf.scene.scale.copy(this.models[modelId].scale);
            gltf.scene.name = modelId;
            this.modelsParent.add(gltf.scene);
            this.models[modelId].mesh = gltf.scene;
            this.models[modelId].mesh.name = modelId;
        });
    }

    createPlaceholderMesh(modelId) {
        this.models[modelId].mesh = new THREE.Mesh( this.placeholderGeometry, this.placeholderMaterial );
        this.models[modelId].mesh.position.set(
            this.models[modelId].position.x, this.models[modelId].position.y, this.models[modelId].position.z);
        this.models[modelId].mesh.quaternion.set(
            this.models[modelId].quaternion.x, this.models[modelId].quaternion.y,
            this.models[modelId].quaternion.z, this.models[modelId].quaternion.w);
        this.models[modelId].mesh.scale.set(
            this.models[modelId].scale.x, this.models[modelId].scale.y, this.models[modelId].scale.z);
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
        }

        // Update active tool
        let tool = this.spawnMenu.getCurrentTool();
        tool.update(this, this.deltaTime / 1000.0);

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
        }

        // Interpolate remote player positions + update name labels
        for (let player in this.players) {
            let p = this.players[player];
            p.mesh.position.lerp(new THREE.Vector3(p.position.x, p.position.y, p.position.z), 0.1);

            // Project name label to screen
            if(p.label && p.mesh.visible) {
                let labelPos = new THREE.Vector3().copy(p.mesh.position);
                labelPos.y += 1.5;
                labelPos.project(this.world.camera);
                let x = (labelPos.x * 0.5 + 0.5) * window.innerWidth;
                let y = (-labelPos.y * 0.5 + 0.5) * window.innerHeight;
                if(labelPos.z < 1) {
                    p.label.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
                    p.label.style.display = 'block';
                } else {
                    p.label.style.display = 'none';
                }
            }
        }

        // Interpolate model positions
        for (let model in this.models) {
            if(this.models[model].mesh) {
                this.models[model].mesh.position.lerp(new THREE.Vector3(this.models[model].position.x, this.models[model].position.y, this.models[model].position.z), 0.1);
            }
        }

        // Interpolate physics bodies
        let now = performance.now();
        for(let bodyId in this.physBodySnapshots) {
            let snap = this.physBodySnapshots[bodyId];
            let mesh = this.physBodyMeshes[bodyId];
            if(!mesh || !snap) continue;
            let duration = snap.target.time - snap.prev.time;
            if(duration <= 0) duration = this.physSnapshotInterval;
            let t = Math.max(0, Math.min((now - snap.prev.time) / duration, 1.0));
            mesh.position.lerpVectors(snap.prev.pos, snap.target.pos, t);
            mesh.quaternion.slerpQuaternions(snap.prev.quat, snap.target.quat, t);
        }

        // Update joint visuals (lines between attachment points on connected bodies)
        let _offsetVec = new THREE.Vector3();
        for(let jointId in this.jointVisuals) {
            let jv = this.jointVisuals[jointId];
            let meshA = this.physBodyMeshes[jv.data.bodyIdA];
            let meshB = this.physBodyMeshes[jv.data.bodyIdB];
            if(meshA && meshB) {
                let positions = jv.line.geometry.attributes.position.array;
                // Compute world-space attachment points: body position + local offset rotated by body quaternion
                let oA = jv.data.localOffsetA || {x:0,y:0,z:0};
                _offsetVec.set(oA.x, oA.y, oA.z).applyQuaternion(meshA.quaternion).add(meshA.position);
                positions[0] = _offsetVec.x; positions[1] = _offsetVec.y; positions[2] = _offsetVec.z;
                let oB = jv.data.localOffsetB || {x:0,y:0,z:0};
                _offsetVec.set(oB.x, oB.y, oB.z).applyQuaternion(meshB.quaternion).add(meshB.position);
                positions[3] = _offsetVec.x; positions[4] = _offsetVec.y; positions[5] = _offsetVec.z;
                jv.line.geometry.attributes.position.needsUpdate = true;
            }
        }

        this.world.renderPipeline.render();
        this.world.stats.update();

        // Server tick display
        if(!this.serverTickDisplay) {
            this.serverTickDisplay = document.createElement('div');
            this.serverTickDisplay.style.cssText = 'position:fixed;top:0;right:0;padding:4px 8px;background:rgba(0,0,0,0.7);color:#0f0;font:12px monospace;z-index:10000;';
            document.body.appendChild(this.serverTickDisplay);
        }
        this.serverTickDisplay.textContent = 'Server: ' + this.serverTickMs + 'ms';

        this.frameNum++;
    }

    spawnProp(propId) {
        // Raycast from camera to find a surface to place the prop on
        this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.world.camera);

        // Collect all collidable objects: terrain batch + physics body meshes
        let targets = [this.terrainBatch];
        for(let id in this.physBodyMeshes) {
            if(this.physBodyMeshes[id]) targets.push(this.physBodyMeshes[id]);
        }

        let intersects = this.raycaster.intersectObjects(targets, true);
        let spawnPos = new THREE.Vector3();
        let halfExtent = 0.5;

        // Look up prop-specific half extent from registry
        let propDefs = { cube: 0.5, barrel: 0.5, crate: 0.5, chest: 0.4, bench: 0.5, ball: 0.3, can: 0.15, pot: 0.3, tower: 0.6, board: 0.3, sword: 0.2 };
        if(propDefs[propId] !== undefined) halfExtent = propDefs[propId];

        if(intersects.length > 0) {
            let hit = intersects[0];
            let normal = hit.face ? hit.face.normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
            // Place prop at hit point, offset by half-extent along surface normal
            spawnPos.copy(hit.point).addScaledVector(normal, halfExtent + 0.05);
        } else {
            // Fallback: place in front of camera
            this.world.camera.getWorldDirection(spawnPos).normalize().multiplyScalar(6).add(this.player.position);
        }

        if(propId === 'cube') {
            this.conn.send(JSON.stringify({
                type: "spawnphyscube",
                position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
                halfExtent: halfExtent
            }));
        } else {
            this.conn.send(JSON.stringify({
                type: "spawnprop",
                propId: propId,
                position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
                quaternion: { x: 0, y: 0, z: 0, w: 1 }
            }));
        }
    }

    b64encode(input) { return btoa(encodeURIComponent(input)); }
    b64decode(input) { return decodeURIComponent(atob(input)); }

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
        let numVerts = decompressedPositions.length / 3;
        let newGeometry = new THREE.BufferGeometry();
        newGeometry.setAttribute('position', new THREE.BufferAttribute(decompressedPositions, 3));
        newGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(numVerts * 2), 2));
        newGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(decompressedPositions.length), 3));
        // Add sequential index to match BatchedMesh's indexed mode
        let indices = new Uint32Array(numVerts);
        for(let i = 0; i < numVerts; i++) indices[i] = i;
        newGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
        newGeometry.computeBoundingBox();
        newGeometry.computeBoundingSphere();
        newGeometry.computeVertexNormals();

        // Update the BatchedMesh geometry
        let geoId = this.chunkGeoIds[chunkIndex];
        this.terrainBatch.setGeometryAt(geoId, newGeometry);
        // Recompute BVH for this geometry
        this.terrainBatch.computeBoundsTree(geoId);

        // Update the Brush copy for CSG encoding (non-indexed for position serialization)
        let brushGeom = newGeometry.toNonIndexed();
        this.chunkBrushes[chunkIndex].geometry = brushGeom;
        this.chunkBrushes[chunkIndex].prepareGeometry();
    }

    /** Create a Three.js mesh from server-provided fragment geometry (gzip+base64 triangle soup) */
    createFragmentMesh(meshData) {
        let binaryString = this.b64decode(meshData.normalize("NFC"));
        let compressed = new Uint8Array(binaryString.length);
        for(let b = 0; b < binaryString.length; b++) {
            compressed[b] = binaryString.charCodeAt(b);
        }
        let positions = new Float32Array(gunzipSync(compressed).buffer);
        let numVerts = positions.length / 3;
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        let indices = new Uint32Array(numVerts);
        for(let i = 0; i < numVerts; i++) indices[i] = i;
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return new THREE.Mesh(geometry, this.defaultMaterial);
    }

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
window._main = main; // Exposed for debugging/testing
