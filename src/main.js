import * as THREE from '../node_modules/three/build/three.module.js';
import { GUI } from '../node_modules/three/examples/jsm/libs/lil-gui.module.min.js';
import World from './World.js';
import { TransformControls } from '../node_modules/three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
const { MeshoptDecoder } = await import( '../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js' );
import { PlayerController } from './PlayerController.js';

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
        // Construct the render world
        this.world = new World(this);

        // Configure Settings
        this.simulationParams = {
            firstPerson: false,

            displayCollider: false,
            displayBVH: false,
            visualizeDepth: 10,
            gravity: - 30,
            playerSpeed: 10,
            physicsSteps: 5,

            //reset: this.player.reset.bind(this),
        };

        this.loadColliderEnvironment();

        this.gui = new GUI();
        this.gui.add( this.simulationParams, 'firstPerson' ).onChange( v => {
            if ( ! v ) {
                this.world.camera
                    .position
                    .sub( this.world.controls.target )
                    .normalize()
                    .multiplyScalar( 10 )
                    .add( this.world.controls.target );
            }
        } );

        let visFolder = this.gui.addFolder( 'Visualization' );
        visFolder.add( this.simulationParams, 'displayCollider' ).onChange( v => { this.collider.visible = v; } );
        visFolder.add( this.simulationParams, 'displayBVH' ).onChange( v => { this.visualizer.visible = v; } );
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
        this.gui.open();

        this.environment = this.world.scene;
        this.collider = null;//new THREE.Box3();
        this.visualizer = new THREE.Line3();
        this.controls = this.world.controls;

        // Create a plane to render the raytraced shader material
        this.planeGeometry = new THREE.BoxGeometry( 1.0, 1.0, 1.0 );
        this.mesh = new THREE.Mesh( this.planeGeometry, this.raytracedShaderMaterial );
        this.world.scene.add( this.mesh );

        // character
        this.player = new PlayerController(this.controls, this.world.camera, this.simulationParams);
        this.world.scene.add( this.player );
        this.player.reset();
    }

    loadColliderEnvironment() {
        let loader = new GLTFLoader();
        loader.setMeshoptDecoder( MeshoptDecoder );
        loader.load( '../assets/small_scene2.glb', res => {
                let gltfScene = res.scene;
                gltfScene.scale.setScalar( .01 );

                new THREE.Box3().setFromObject( gltfScene ).getCenter( gltfScene.position ).negate();
                gltfScene.updateMatrixWorld( true );

                this.environment = gltfScene;

                this.collider = this.player.bakeCollisionGeometry( this.environment );
                this.visualizer = this.collider.helper;
                this.world.scene.add( this.visualizer );
                this.world.scene.add( this.collider );
                this.world.scene.add( this.environment );
            } );
    }

    /** Update the simulation */
    update(timeMS) {
        this.deltaTime = timeMS - this.timeMS;
        this.timeMS = timeMS;

        let physicsSteps = this.simulationParams.physicsSteps;
        for ( let i = 0; i < physicsSteps; i ++ ) {
            this.player.updatePlayer( Math.min( this.deltaTime/1000.0, 0.1 ) / physicsSteps );
        }
    
        this.world.controls.update();
        this.world.renderer.render(this.world.scene, this.world.camera);
        this.world.stats.update();
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
}

var main = new Main();
