import * as THREE from '../node_modules/three/build/three.module.js';
import { RoundedBoxGeometry } from '../node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as BufferGeometryUtils from '../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, MeshBVHHelper, StaticGeometryGenerator } from '../node_modules/three-mesh-bvh/build/index.module.js';
import { PointerLockControls } from '../node_modules/three/examples/jsm/controls/PointerLockControls.js';
import nipplejs from '../assets/nipplejs/src/index.js';

export class PlayerController extends THREE.Group {
    constructor(camera, simulationParams) {
        super();

        this.simulationParams = simulationParams;

        this.camera = camera;
        if (this.simulationParams.mobile){//navigator.userAgentData.mobile) {
            this.controls = null;
            this.nipple = nipplejs.create({
                zone: document.getElementById('appbody'),
                multitouch: true,
                maxNumberOfNipples: 2,
                mode: 'dynamic',
                size: 150,
                color: 'gray'
            });
        }else{
            this.controls = new PointerLockControls(camera, document.body);
            document.getElementById('appbody').addEventListener( 'click', () => { this.controls.lock(); });
            //this.camera.parent.add( this.controls.object );
        }

        this.name = 'PlayerController';
        this.playerIsOnGround = false;
        this.keysPressed = {};
        this.lookMovement = new THREE.Vector2();
        this.walkMovement = new THREE.Vector2();
        this.playerVelocity = new THREE.Vector3();
        this.upVector = new THREE.Vector3(0, 1, 0);
        this.tempVector = new THREE.Vector3();
        this.tempVector2 = new THREE.Vector3();
        this.forwardVector = new THREE.Vector3();
        this.rightVector = new THREE.Vector3();
        this.tempBox = new THREE.Box3();
        this.tempMat = new THREE.Matrix4();
        this.tempSegment = new THREE.Line3();

        // Add Keyboard Controls
        window.addEventListener('keydown', (e) => {
            switch (e.code) {
                case 'KeyW': this.keysPressed['KeyW'] = true; break;
                case 'KeyS': this.keysPressed['KeyS'] = true; break;
                case 'KeyD': this.keysPressed['KeyD'] = true; break;
                case 'KeyA': this.keysPressed['KeyA'] = true; break;
                case 'Space':
                    if (this.playerIsOnGround) {
                        this.playerVelocity.y = 10.0;
                        this.playerIsOnGround = false;
                    }
                    break;
            }
        });
        window.addEventListener('keyup', (e) => {
            switch (e.code) {
                case 'KeyW': this.keysPressed['KeyW'] = false; break;
                case 'KeyS': this.keysPressed['KeyS'] = false; break;
                case 'KeyD': this.keysPressed['KeyD'] = false; break;
                case 'KeyA': this.keysPressed['KeyA'] = false; break;
            }
        });

        // character
        this.playerMesh = new THREE.Mesh(
            new RoundedBoxGeometry(1.0, 2.0, 1.0, 10, 0.5),
            new THREE.MeshStandardMaterial()
        );
        this.playerMesh.geometry.translate(0, - 0.5, 0);
        this.capsuleInfo = {
            radius: 0.5,
            segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, - 1.0, 0.0))
        };
        this.playerMesh.castShadow = true;
        //this.playerMesh.receiveShadow = true;
        this.playerMesh.material.shadowSide = 2;
        this.add(this.playerMesh);
    }

    reset() {
        this.playerVelocity.set(0, 0, 0);
        this.position.set(0,3.0,0);
        //this.camera.position.sub(this.controls.target);
        //this.controls.target.copy(this.position);
        //this.camera.position.add(this.position);
        this.camera.position.copy(this.position);
        this.camera.position.y += 0.5; // adjust camera height
        if(this.controls){ this.controls.update(); }
    }

    updatePlayer(delta) {
        if (!this.chunks) return;

        this.walkMovement.x = 0;
        this.walkMovement.y = 0;
        this.lookMovement.x = 0;
        this.lookMovement.y = 0;
        this.walkedThisFrame = false;
        this.lookedThisFrame = false;

        if (this.simulationParams.mobile) {
            if (this.nipple && this.nipple) {
                for(let i = 0; i < this.nipple.ids.length; i++) {
                    let nipple = this.nipple.get(this.nipple.ids[i]);
                    if (nipple && nipple.position && nipple.frontPosition) {
                        if(nipple.position.x < window.innerWidth / 2) {
                            this.walkMovement.x = ( 2 * nipple.frontPosition.x / nipple.options.size);
                            this.walkMovement.y = (-2 * nipple.frontPosition.y / nipple.options.size);
                            this.walkedThisFrame = true;
                        } else {
                            this.lookMovement.x = ( 2 * nipple.frontPosition.x / nipple.options.size);
                            this.lookMovement.y = ( 2 * nipple.frontPosition.y / nipple.options.size);
                            this.lookedThisFrame = true;
                        }
                    }
                }
            }
        } else {
            this.walkMovement.x  = (this.keysPressed['KeyD'] ? 1 : 0) - (this.keysPressed['KeyA'] ? 1 : 0);
            this.walkMovement.y  = (this.keysPressed['KeyW'] ? 1 : 0) - (this.keysPressed['KeyS'] ? 1 : 0);
            this.lookMovement.x  = this.keysPressed['ArrowRight'] ? 1 : 0;
            this.lookMovement.x -= this.keysPressed['ArrowLeft'] ? 1 : 0;
            this.lookMovement.y  = this.keysPressed['ArrowUp'] ? 1 : 0;
            this.lookMovement.y -= this.keysPressed['ArrowDown'] ? 1 : 0;
        }

        // Jump the player if they tap the look joystick
        if(!this.lookedThisFrame){
            if(this.lookTimer > 0 && this.lookTimer < 0.1 && this.playerIsOnGround) {
                this.playerVelocity.y = 10.0;
                this.playerIsOnGround = false;
            }
            this.lookTimer = 0.0;
        } else {
            this.lookTimer += delta;
        }

        // Trigger an action if the walk joystick was tapped
        this.tappedAction = false;
        if(!this.walkedThisFrame){
            if(this.walkTimer > 0 && this.walkTimer < 0.1) {
                console.log('Tapped action');
                this.tappedAction = true;
            }
            this.walkTimer = 0.0;
        } else {
            this.tappedAction = false;
            this.walkTimer += delta;
        }

        if (this.playerIsOnGround) {
            this.playerVelocity.y = delta * this.simulationParams.gravity;
        } else {
            this.playerVelocity.y += delta * this.simulationParams.gravity;
        }

        this.position.addScaledVector(this.playerVelocity, delta);

        // adjust the camera rotation
        let _euler = new THREE.Euler( 0, 0, 0, 'YXZ' );
        _euler.setFromQuaternion(this.camera.quaternion);
        _euler.y -= this.lookMovement.x * 0.01;
        _euler.x -= this.lookMovement.y * 0.01;
        _euler.x = Math.max(Math.PI / 2 - Math.PI, Math.min(Math.PI / 2, _euler.x ) );
        this.camera.quaternion.setFromEuler(_euler);

        // move the player
		this.rightVector.setFromMatrixColumn( this.camera.matrix, 0 );
		this.forwardVector.crossVectors( this.camera.up, this.rightVector );
        this.forwardVector.normalize().multiplyScalar(this.simulationParams.playerSpeed * delta * this.walkMovement.y);
        this.  rightVector.normalize().multiplyScalar(this.simulationParams.playerSpeed * delta * this.walkMovement.x);
        this.position.add(this.forwardVector);
        this.position.add(this.rightVector);

        this.updateMatrixWorld();

        // adjust player position based on collisions
        const capsuleInfo = this.capsuleInfo;
        this.tempSegment.copy(capsuleInfo.segment);
        this.tempSegment.start.applyMatrix4(this.matrixWorld);
        this.tempSegment.end  .applyMatrix4(this.matrixWorld);    

        let globalBox = new THREE.Box3().makeEmpty();

        // get the axis aligned bounding box of the capsule
        globalBox.expandByPoint(this.tempSegment.start);
        globalBox.expandByPoint(this.tempSegment.end);
        globalBox.min.addScalar(- capsuleInfo.radius);
        globalBox.max.addScalar(capsuleInfo.radius);

        for( let i = 0; i < this.chunks.length; i++ ) {
            if (this.chunks[i].matrixWorld.dirty) {
                this.chunks[i].updateMatrixWorld();
            }
            if(!this.chunks[i].geometry.boundsTree) { continue; }
            if(!globalBox.intersectsBox(this.chunks[i].bbox)) {
                continue; // skip chunks that are not intersecting the capsule
            }

            this.tempBox.makeEmpty();
            this.tempMat.copy(this.chunks[i].matrixWorld).invert();

            // get the position of the capsule in the local space of the collider
            this.tempSegment.start.applyMatrix4(this.tempMat);
            this.tempSegment.end  .applyMatrix4(this.tempMat);

            // get the axis aligned bounding box of the capsule
            this.tempBox.expandByPoint(this.tempSegment.start);
            this.tempBox.expandByPoint(this.tempSegment.end);

            this.tempBox.min.addScalar(- capsuleInfo.radius);
            this.tempBox.max.addScalar(capsuleInfo.radius);

            /** @type {MeshBVH} */
            let bvh = this.chunks[i].geometry.boundsTree;
            bvh.shapecast({
                intersectsBounds: box => box.intersectsBox(this.tempBox),
                intersectsTriangle: tri => {
                    // check if the triangle is intersecting the capsule and adjust the capsule position if it is.
                    const triPoint = this.tempVector;
                    const capsulePoint = this.tempVector2;

                    const distance = tri.closestPointToSegment(this.tempSegment, triPoint, capsulePoint);
                    if (distance < capsuleInfo.radius) {
                        const depth = capsuleInfo.radius - distance;
                        const direction = capsulePoint.sub(triPoint).normalize();

                        this.tempSegment.start.addScaledVector(direction, depth);
                        this.tempSegment.end.addScaledVector(direction, depth);
                    }
                }
            });

            this.tempSegment.start.applyMatrix4(this.chunks[i].matrixWorld);
            this.tempSegment.end.applyMatrix4(this.chunks[i].matrixWorld);
        }

        // get the adjusted position of the capsule collider in world space after checking
        // triangle collisions and moving it. capsuleInfo.segment.start is assumed to be
        // the origin of the player model.
        let newPosition = this.tempVector;
        newPosition.copy(this.tempSegment.start);

        // check how much the collider was moved
        let deltaVector = this.tempVector2;
        deltaVector.subVectors(newPosition, this.position);

        // if the player was primarily adjusted vertically we assume it's on something we should consider ground
        this.playerIsOnGround = deltaVector.y > Math.abs(delta * this.playerVelocity.y * 0.25);

        let offset = Math.max(0.0, deltaVector.length() - 1e-5);
        deltaVector.normalize().multiplyScalar(offset);

        // adjust the player model
        this.position.add(deltaVector);

        if (!this.playerIsOnGround) {
            deltaVector.normalize();
            this.playerVelocity.addScaledVector(deltaVector, - deltaVector.dot(this.playerVelocity));
        } else {
            this.playerVelocity.set(0, 0, 0);
        }

        //// adjust the camera
        //this.camera.position.sub(this.controls.target);
        //this.controls.target.copy(this.position);
        //this.camera.position.add(this.position);
        this.camera.position.copy(this.position);
        this.camera.position.y += 0.5; // adjust camera height
        if(this.controls){ this.controls.update(); }

        // if the player has fallen too far below the level reset their position to the start
        if (this.position.y < - 25) {
            this.reset();
        }
    }

}