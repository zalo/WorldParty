import * as THREE from '../node_modules/three/build/three.module.js';
import { GUI } from '../node_modules/three/examples/jsm/libs/lil-gui.module.min.js';
import World from './World.js';
import { TransformControls } from '../node_modules/three/examples/jsm/controls/TransformControls.js';

import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from '../node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as BufferGeometryUtils from '../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, MeshBVHHelper, StaticGeometryGenerator } from '../node_modules/three-mesh-bvh/build/index.module.js';

const { KTX2Loader } = await import( '../node_modules/three/examples/jsm/loaders/KTX2Loader.js' );
const { MeshoptDecoder } = await import( '../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js' );

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

            reset: this.reset.bind(this),
        };
        //this.gui = new GUI();
        //this.gui.add(this.simulationParams, 'numViews', 1, 10, 1).name('Number of Views')           .onChange((value) => { this.physicalCamera.numViews      = value; this.physicalCamera.setupCamera(); });
        //this.gui.add(this.simulationParams, 'resolution', 256, 4096, 256).name('Resolution')        .onChange((value) => { this.physicalCamera.resolution    = value; this.physicalCamera.setupCamera(); });
        //this.gui.add(this.simulationParams, 'aperture', 0.0, 0.1, 0.01).name('Aperture Size')       .onChange((value) => { this.physicalCamera.aperture      = value; this.physicalCamera.setupCamera(); });
        //this.gui.add(this.simulationParams, 'focalDistance', 0.4, 5.0, 0.01).name('Focal Distance').onChange((value) => { this.physicalCamera.focalDistance = value; this.physicalCamera.setupCamera(); });
        //this.gui.add(this.simulationParams, 'refractiveIndex', 1.0, 2.0, 0.01).name('Refractive Index').onChange((value) => { this.raytracedShaderMaterial.uniforms.refractiveIndex.value = value; });

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
        visFolder.add( this.simulationParams, 'displayCollider' );
        visFolder.add( this.simulationParams, 'displayBVH' );
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
        this.gui.add( this.simulationParams, 'reset' );
        this.gui.open();

        this.environment = this.world.scene;
        this.collider = null;//new THREE.Box3();
        this.visualizer = new THREE.Line3();
        this.controls = this.world.controls;
        this.playerIsOnGround = false;
        this.fwdPressed = false, this.bkdPressed = false, this.lftPressed = false, this.rgtPressed = false;
        this.playerVelocity = new THREE.Vector3();
        this.upVector = new THREE.Vector3( 0, 1, 0 );
        this.tempVector = new THREE.Vector3();
        this.tempVector2 = new THREE.Vector3();
        this.tempBox = new THREE.Box3();
        this.tempMat = new THREE.Matrix4();
        this.tempSegment = new THREE.Line3();

        // Add Keyboard Controls
        window.addEventListener( 'keydown', ( e ) => {
            switch ( e.code ) {
                case 'KeyW': this.fwdPressed = true; break;
                case 'KeyS': this.bkdPressed = true; break;
                case 'KeyD': this.rgtPressed = true; break;
                case 'KeyA': this.lftPressed = true; break;
                case 'Space':
                    if ( this.playerIsOnGround ) {
                        this.playerVelocity.y = 10.0;
                        this.playerIsOnGround = false;
                    }
                    break;
            }
        } );
        window.addEventListener( 'keyup', ( e ) => {
            switch ( e.code ) {
                case 'KeyW': this.fwdPressed = false; break;
                case 'KeyS': this.bkdPressed = false; break;
                case 'KeyD': this.rgtPressed = false; break;
                case 'KeyA': this.lftPressed = false; break;
            }
        } );

        // Create a plane to render the raytraced shader material
        this.planeGeometry = new THREE.BoxGeometry( 1.0, 1.0, 1.0 );
        this.mesh = new THREE.Mesh( this.planeGeometry, this.raytracedShaderMaterial );
        this.world.scene.add( this.mesh );

        // character
        this.player = new THREE.Mesh(
            new RoundedBoxGeometry( 1.0, 2.0, 1.0, 10, 0.5 ),
            new THREE.MeshStandardMaterial()
        );
        this.player.geometry.translate( 0, - 0.5, 0 );
        this.player.capsuleInfo = {
            radius: 0.5,
            segment: new THREE.Line3( new THREE.Vector3(), new THREE.Vector3( 0, - 1.0, 0.0 ) )
        };
        this.player.castShadow = true;
        this.player.receiveShadow = true;
        this.player.material.shadowSide = 2;
        this.world.scene.add( this.player );
        this.reset();

    }

    loadColliderEnvironment() {
        const ktx2Loader = new KTX2Loader();
		ktx2Loader.setTranscoderPath( '../node_modules/three/examples/jsm/libs/basis/' );
        let loader = new GLTFLoader();
        loader.setKTX2Loader( ktx2Loader );
        loader.setMeshoptDecoder( MeshoptDecoder );
        loader.load( '../assets/small_scene2.glb', res => {

                const gltfScene = res.scene;
                gltfScene.scale.setScalar( .01 );

                const box = new THREE.Box3();
                box.setFromObject( gltfScene );
                box.getCenter( gltfScene.position ).negate();
                gltfScene.updateMatrixWorld( true );

                // visual geometry setup
                const toMerge = {};
                gltfScene.traverse( c => {
                    console.log(c.name);
                    if (
                        /Boss/.test( c.name ) ||
                        /Enemie/.test( c.name ) ||
                        /Shield/.test( c.name ) ||
                        /Sword/.test( c.name ) ||
                        /Character/.test( c.name ) ||
                        /Gate/.test( c.name ) ||
                        // spears
                        /Cube/.test( c.name ) ||
                        // pink brick
                        c.material && c.material.color.r === 1.0
                        ) { return; }

                    if ( c.isMesh ) {
                        const hex = c.material.color.getHex();
                        toMerge[ hex ] = toMerge[ hex ] || [];
                        toMerge[ hex ].push( c );
                    }
                } );

                this.environment = new THREE.Group();
                for ( const hex in toMerge ) {

                    const arr = toMerge[ hex ];
                    const visualGeometries = [];
                    arr.forEach( mesh => {

                        if ( mesh.material.emissive.r !== 0 ) {
                            this.environment.attach( mesh );
                        } else {
                            const geom = mesh.geometry.clone();
                            geom.applyMatrix4( mesh.matrixWorld );
                            visualGeometries.push( geom );
                        }
                    } );

                    if ( visualGeometries.length ) {
                        const newGeom = BufferGeometryUtils.mergeGeometries( visualGeometries );
                        const newMesh = new THREE.Mesh( newGeom, new THREE.MeshStandardMaterial( { color: parseInt( hex ), shadowSide: 2 } ) );
                        newMesh.castShadow = true;
                        newMesh.receiveShadow = true;
                        newMesh.material.shadowSide = 2;
                        this.environment.add( newMesh );
                    }

                }

                const staticGenerator = new StaticGeometryGenerator( this.environment );
                staticGenerator.attributes = [ 'position' ];

                const mergedGeometry = staticGenerator.generate();
                mergedGeometry.boundsTree = new MeshBVH( mergedGeometry );

                this.collider = new THREE.Mesh( mergedGeometry );
                this.collider.material.wireframe = true;
                this.collider.material.opacity = 0.5;
                this.collider.material.transparent = true;

                this.visualizer = new MeshBVHHelper( this.collider, this.simulationParams.visualizeDepth );
                this.world.scene.add( this.visualizer );
                this.world.scene.add( this.collider );
                this.world.scene.add( this.environment );
            } );

    }

    reset() {
        this.playerVelocity.set( 0, 0, 0 );
        this.player.position.set( 15.75, - 3, 30 );
        this.world.camera.position.sub( this.world.controls.target );
        this.world.controls.target.copy( this.player.position );
        this.world.camera.position.add( this.player.position );
        this.world.controls.update();
    }

    updatePlayer( delta ) {
        if ( this.playerIsOnGround ) {
            this.playerVelocity.y = delta * this.simulationParams.gravity;
        } else {
            this.playerVelocity.y += delta * this.simulationParams.gravity;
        }

        this.player.position.addScaledVector( this.playerVelocity, delta );

        // move the player
        const angle = this.world.controls.getAzimuthalAngle();
        if ( this.fwdPressed ) {
            this.tempVector.set( 0, 0, - 1 ).applyAxisAngle( this.upVector, angle );
            this.player.position.addScaledVector( this.tempVector, this.simulationParams.playerSpeed * delta );
        }

        if ( this.bkdPressed ) {
            this.tempVector.set( 0, 0, 1 ).applyAxisAngle( this.upVector, angle );
            this.player.position.addScaledVector( this.tempVector, this.simulationParams.playerSpeed * delta );
        }

        if ( this.lftPressed ) {
            this.tempVector.set( - 1, 0, 0 ).applyAxisAngle( this.upVector, angle );
            this.player.position.addScaledVector( this.tempVector, this.simulationParams.playerSpeed * delta );
        }

        if ( this.rgtPressed ) {
            this.tempVector.set( 1, 0, 0 ).applyAxisAngle( this.upVector, angle );
            this.player.position.addScaledVector( this.tempVector, this.simulationParams.playerSpeed * delta );
        }

        this.player.updateMatrixWorld();

        // adjust player position based on collisions
        const capsuleInfo = this.player.capsuleInfo;
        this.tempBox.makeEmpty();
        this.tempMat.copy( this.collider.matrixWorld ).invert();
        this.tempSegment.copy( capsuleInfo.segment );

        // get the position of the capsule in the local space of the collider
        this.tempSegment.start.applyMatrix4( this.player.matrixWorld ).applyMatrix4( this.tempMat );
        this.tempSegment.end.applyMatrix4( this.player.matrixWorld ).applyMatrix4( this.tempMat );

        // get the axis aligned bounding box of the capsule
        this.tempBox.expandByPoint( this.tempSegment.start );
        this.tempBox.expandByPoint( this.tempSegment.end );

        this.tempBox.min.addScalar( - capsuleInfo.radius );
        this.tempBox.max.addScalar( capsuleInfo.radius );

        this.collider.geometry.boundsTree.shapecast( {
            intersectsBounds: box => box.intersectsBox( this.tempBox ),
            intersectsTriangle: tri => {
                // check if the triangle is intersecting the capsule and adjust the
                // capsule position if it is.
                const triPoint = this.tempVector;
                const capsulePoint = this.tempVector2;

                const distance = tri.closestPointToSegment( this.tempSegment, triPoint, capsulePoint );
                if ( distance < capsuleInfo.radius ) {
                    const depth = capsuleInfo.radius - distance;
                    const direction = capsulePoint.sub( triPoint ).normalize();

                    this.tempSegment.start.addScaledVector( direction, depth );
                    this.tempSegment.end.addScaledVector( direction, depth );
                }
            }
        } );

        // get the adjusted position of the capsule collider in world space after checking
        // triangle collisions and moving it. capsuleInfo.segment.start is assumed to be
        // the origin of the player model.
        let newPosition = this.tempVector;
        newPosition.copy( this.tempSegment.start ).applyMatrix4( this.collider.matrixWorld );

        // check how much the collider was moved
        let deltaVector = this.tempVector2;
        deltaVector.subVectors( newPosition, this.player.position );

        // if the player was primarily adjusted vertically we assume it's on something we should consider ground
        this.playerIsOnGround = deltaVector.y > Math.abs( delta * this.playerVelocity.y * 0.25 );

        let offset = Math.max( 0.0, deltaVector.length() - 1e-5 );
        deltaVector.normalize().multiplyScalar( offset );

        // adjust the player model
        this.player.position.add( deltaVector );

        if ( ! this.playerIsOnGround ) {
            deltaVector.normalize();
            this.playerVelocity.addScaledVector( deltaVector, - deltaVector.dot( this.playerVelocity ) );
        } else {
            this.playerVelocity.set( 0, 0, 0 );
        }

        // adjust the camera
        this.world.camera.position.sub( this.world.controls.target );
        this.world.controls.target.copy( this.player.position );
        this.world.camera.position.add( this.player.position );

        // if the player has fallen too far below the level reset their position to the start
        if ( this.player.position.y < - 25 ) {
            this.reset();
        }
    }

    /** Update the simulation */
    update(timeMS) {
        this.deltaTime = timeMS - this.timeMS;
        this.timeMS = timeMS;

        const delta = Math.min( this.deltaTime/1000.0, 0.1 );
        if ( this.simulationParams.firstPerson ) {
            this.world.controls.maxPolarAngle = Math.PI;
            this.world.controls.minDistance = 1e-4;
            this.world.controls.maxDistance = 1e-4;
        } else {
            this.world.controls.maxPolarAngle = Math.PI / 2;
            this.world.controls.minDistance = 1;
            this.world.controls.maxDistance = 20;
        }

        if ( this.collider ) {
            this.collider.visible = this.simulationParams.displayCollider;
            this.visualizer.visible = this.simulationParams.displayBVH;
            if (! this.collider.matrixWorld){ this.collider.updateMatrixWorld(); }
            const physicsSteps = this.simulationParams.physicsSteps;
            for ( let i = 0; i < physicsSteps; i ++ ) {
                this.updatePlayer( delta / physicsSteps );
            }
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
