/* eslint-env browser */
/* global PARTYKIT_HOST */

import * as THREE from '../node_modules/three/build/three.module.js';
import { GUI } from '../node_modules/three/examples/jsm/libs/lil-gui.module.min.js';
import World from './World.js';
import { TransformControls } from '../node_modules/three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
const { MeshoptDecoder } = await import( '../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js' );
import { PlayerController } from './PlayerController.js';
import { ADDITION, INTERSECTION, SUBTRACTION, Brush, Evaluator } from '../node_modules/three-bvh-csg/build/index.module.js';
import { MeshBVH, MeshBVHHelper, StaticGeometryGenerator } from '../node_modules/three-mesh-bvh/build/index.module.js';
import PartySocket from "../node_modules/partysocket/dist/index.mjs";
import { RoundedBoxGeometry } from '../node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js';
const { gzipSync, gunzipSync }  = await import( '../node_modules/three/examples/jsm/libs/fflate.module.js' );

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
            // @ts-expect-error This should be typed as a global string
            host: window.location.host.includes("github.io") ? "https://worldparty.zalo.partykit.dev" : "http://127.0.0.1:1999",
            room: this.curRoom,
        });

        /** @type {Record<string, { name: string, id:string, position: { x: number, y: number, z: number }, color:string | null}>} */
        this.players = {};

        //this.conn.addEventListener("open"   , this.start           .bind(this));
        this.conn.addEventListener("message", this.updateFromServer.bind(this));

        // Construct the render world
        this.world = new World(this);

        // Configure Settings
        this.simulationParams = {
            firstPerson: true,

            displayCollider: false,
            displayBVH: false,
            displayGround: true,
            visualizeDepth: 10,
            gravity: - 30,
            playerSpeed: 10,
            physicsSteps: 5,
            mobile: this.isMobile(),
        };        

        this.gui = new GUI();

        let visFolder = this.gui.addFolder( 'Visualization' );
        visFolder.add( this.simulationParams, 'displayCollider' ).onChange( v => { this.collider.visible = v; } );
        visFolder.add( this.simulationParams, 'displayBVH' ).onChange( v => { this.visualizer.visible = v; } );
        visFolder.add( this.simulationParams, 'displayGround' ).onChange( v => { this.mesh.visible = v; } );
        visFolder.add( this.simulationParams, 'visualizeDepth', 1, 20, 1 ).onChange( v => {
            this.visualizer.depth = v;
            this.visualizer.update();
        } );
        visFolder.open();

        let physicsFolder = this.gui.addFolder( 'Player' );
        physicsFolder.add( this.simulationParams, 'physicsSteps', 0, 30, 1 );
        physicsFolder.add( this.simulationParams, 'gravity', - 100, 100, 0.01 ).onChange( v => {
            this.simulationParams.gravity = parseFloat( v );
        } );
        physicsFolder.add( this.simulationParams, 'playerSpeed', 1, 20 );
        physicsFolder.open();
        //this.gui.add( this.simulationParams, 'reset' );
        if(this.simulationParams.mobile){
            this.gui.close();
        }else{
            this.gui.open();
        }

        this.environment = this.world.scene;
        this.collider = null;//new THREE.Box3();
        this.visualizer = new THREE.Line3();
        //this.controls = this.world.controls;

        this.evaluator = new Evaluator();

        // Create a plane to render the raytraced shader material
        let bbox = new THREE.Box3( new THREE.Vector3( -5.0, -5.0, -5.0 ), new THREE.Vector3( 5.0, 5.0, 5.0 ) );
        this.defaultMaterial = new THREE.MeshStandardMaterial( { color: 0x808080, roughness: 0.5, metalness: 0.5 } );
        //this.mesh = new Brush( this.chunkGeometry, this.defaultMaterial );
        this.bigChunk = new Brush( new THREE.BoxGeometry( 100.0, 100.0, 100.0 ), this.defaultMaterial );
        this.littleChunk = new Brush( new THREE.BoxGeometry( 10.0, 10.0, 10.0 ), this.defaultMaterial );
        this.wholeChunk = this.evaluator.evaluate( this.bigChunk, this.littleChunk, SUBTRACTION );
        //this.wholeChunk = new Brush( this.chunkGeometry, this.defaultMaterial );
        this.chunks = [];
        this.mesh = new THREE.Group();
        for( let x = 0; x < 10; x++ ) {
            for( let y = 0; y < 10; y++ ) {
                for( let z = 0; z < 10; z++ ) {
                    let geometry = y < 5 ? new THREE.BoxGeometry( 10.0, 10.0, 10.0 ) : new THREE.BoxGeometry( 0.1, 0.1, 0.1 );
                    // Offset the vertices in the chunk geometry by the chunk position
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
                    this.mesh.add( chunk );
                    this.chunks.push( chunk );
                }
            }
        }
        this.mesh.receiveShadow = true;
        this.mesh.updateMatrixWorld( true );
        this.mesh.chunks = this.chunks;

        // Create the player controller
        this.player = new PlayerController(this.world.camera, this.simulationParams);
        this.world.scene.add( this.player );
        this.player.reset();

        this.brush2 = new Brush( new THREE.BoxGeometry(2, 2, 2), this.defaultMaterial );
        this.brush2.position.y = -0.5;
        this.brush2.updateMatrixWorld();
        this.world.scene.add( this.brush2 );

        this.world.scene.add( this.mesh );

        this.player.chunks = this.chunks;

        this.ePressed = false;
        this.qPressed = false;
        window.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if(this.player && this.player.controls && this.player.controls.isLocked) {
                if (e.button === 0) {
                    this.qPressed = true;
                }else if (e.button === 2) {
                    this.ePressed = true;
                }
            }
        });
        this.frameNum = 0;
        this.lastUpdate = 0;
    }

    /** @param {MessageEvent} event - The message event */
    updateFromServer(event) {
        /** @type {string} */
        let dataString = event.data;
        if (dataString.startsWith("{")) {
            let data = JSON.parse(dataString);
            if (data.type.includes("update")) {
                if(data.type === "fullupdate"){
                    // Enumerate through the cards and the players, marking all dirty
                    for (let   card in this.  cards) { this.  cards[  card].dirty = true; }
                    for (let player in this.players) { this.players[player].dirty = true; }
                }

                // Enumerate through the players, updating as necessary (and marking clean)
                for (let player in data.players) {
                    if (this.players[player] === undefined) {
                        // Create the player on the client since it doesn't exist
                        this.players[player] = data.players[player];
                        // Create a new player object, which is a capsule
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

                // Enumerate through the players, updating as necessary (and marking clean)
                for (let chunkIndex in data.chunks) {
                    //console.log(chunkIndex, data.chunks[chunkIndex].data.normalize("NFC"), typeof(data.chunks[chunkIndex].data.normalize("NFC")));
                    this.base64FillChunkIndex(chunkIndex, ''+data.chunks[chunkIndex].data.normalize("NFC"));
                }

                // Enumerate through the players, removing any that are still dirty
                if(data.type === "fullupdate"){
                    for (let player in this.players) {
                        if (this.players[player].dirty) {
                            console.log(`Player ${this.players[player].name} has disconnected!`);
                            this.world.scene.remove(this.players[player].mesh);
                            delete this.players[player];
                        }
                    }
                }
            }
        } else {
            console.log(`Received -> ${dataString}`);
        }
    }

    /** Update the simulation */
    update(timeMS) {
        this.deltaTime = timeMS - this.timeMS;
        this.timeMS = timeMS;

        let physicsSteps = this.simulationParams.physicsSteps;
        for ( let i = 0; i < physicsSteps; i ++ ) {
            this.player.updatePlayer( Math.min( this.deltaTime/1000.0, 0.1 ) / physicsSteps );
            if( i == 0 && this.player.tappedAction) { this.qPressed = true; } // Bind tapping the action to Q
        }

        //this.world.controls.update();

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

        for (let player in this.players) {
            this.players[player].mesh.position.lerp(new THREE.Vector3(this.players[player].position.x, this.players[player].position.y, this.players[player].position.z), 0.1);
            //this.players[player].mesh.updateMatrixWorld();
        }

        // Cast a ray against the environment collider and place the brush2 there
        this.world.camera.getWorldDirection(this.brush2.position).normalize().multiplyScalar(6).add(this.player.position);
        this.brush2.lookAt(this.world.camera.position);
        this.brush2.updateMatrixWorld();

        if ( this.ePressed || this.qPressed ) {
            let box1 = new THREE.Box3();
            box1.setFromObject(this.brush2);

            for(let i = 0; i < this.chunks.length; i++) {
                if (box1.intersectsBox(this.chunks[i].bbox)) {
                    this.mesh.remove(this.chunks[i]);
                    let bbox = this.chunks[i].bbox;
                    this.chunks[i] = this.evaluator.evaluate( this.chunks[i], this.brush2, this.ePressed ? ADDITION : SUBTRACTION);
                    // This part prevents additive chunks from leaking into neighboring chunks
                    // Really slow for some reason???
                    //bbox.getCenter(this.wholeChunk.position);
                    //this.wholeChunk.updateMatrixWorld( true);
                    //this.chunks[i] = this.evaluator.evaluate( this.chunks[i], this.wholeChunk, SUBTRACTION);

                    let compressedChunk = this.chunkIndexToBase64(i);

                    this.conn.send(JSON.stringify({
                        type: "chunk",
                        index: i,
                        data: compressedChunk
                    }));

                    this.base64FillChunkIndex(i, compressedChunk);

                    this.chunks[i].updateMatrixWorld();
                    this.chunks[i].prepareGeometry();
                    this.chunks[i].bbox = bbox;
                    this.mesh.add(this.chunks[i]);
                }
            }
            this.ePressed = false;
            this.qPressed = false;
        }

        this.world.renderer.render(this.world.scene, this.world.camera);
        this.world.stats.update();
        this.frameNum++;
    }

    b64encode(input) { 
        return btoa(encodeURIComponent(input)); 
    }
    b64decode(input) { 
        return decodeURIComponent(atob(input));
    }

    chunkIndexToBase64(chunkIndex) {
        let compressedPositions = gzipSync(new Uint8Array(this.chunks[chunkIndex].geometry.attributes.position.array.buffer));
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
