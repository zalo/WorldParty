import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, MeshBVHHelper, StaticGeometryGenerator } from 'three-mesh-bvh';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import nipplejs from '../assets/nipplejs/src/index.js';

const OFF_GROUND_GRACE = 0.05; // Coyote time: seconds after leaving ground where jump still works

export class PlayerController extends THREE.Group {
    constructor(camera, simulationParams) {
        super();

        this.simulationParams = simulationParams;

        this.camera = camera;
        if (this.simulationParams.mobile) {
            this.controls = null;
            this.nipple = nipplejs.create({
                zone: document.getElementById('appbody'),
                multitouch: true,
                maxNumberOfNipples: 2,
                mode: 'dynamic',
                size: 150,
                color: 'gray'
            });
        } else {
            this.controls = new PointerLockControls(camera, document.body);
            document.getElementById('appbody').addEventListener( 'click', () => { this.controls.lock(); });

            const crosshairs = document.getElementById('crosshairs');
            this.controls.addEventListener('lock', () => {
                crosshairs.style.display = 'block';
            });
            this.controls.addEventListener('unlock', () => {
                crosshairs.style.display = 'none';
            });
        }

        this.name = 'PlayerController';
        this.playerIsOnGround = false;
        this.offGroundTimer = 0;
        this.keysPressed = {};
        this.jumpRequested = false;
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
        this.walkAnimation = 0;

        // Keyboard controls
        window.addEventListener('keydown', (e) => {
            switch (e.code) {
                case 'KeyW': this.keysPressed['KeyW'] = true; break;
                case 'KeyS': this.keysPressed['KeyS'] = true; break;
                case 'KeyD': this.keysPressed['KeyD'] = true; break;
                case 'KeyA': this.keysPressed['KeyA'] = true; break;
                case 'Space':
                    this.jumpRequested = true;
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

        // Character mesh
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
        this.playerMesh.material.shadowSide = 2;
        this.add(this.playerMesh);
    }

    reset() {
        this.playerVelocity.set(0, 0, 0);
        this.position.set(0, 3.0, 0);
        this.camera.position.copy(this.position);
        this.camera.position.y += 0.5;
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
            if (this.nipple) {
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

        // Mobile: tap look joystick to jump
        if(!this.lookedThisFrame){
            if(this.lookTimer > 0 && this.lookTimer < 0.1) {
                this.jumpRequested = true;
            }
            this.lookTimer = 0.0;
        } else {
            this.lookTimer += delta;
        }

        // Mobile: tap walk joystick for action
        this.tappedAction = false;
        if(!this.walkedThisFrame){
            if(this.walkTimer > 0 && this.walkTimer < 0.1) {
                this.tappedAction = true;
            }
            this.walkTimer = 0.0;
        } else {
            this.tappedAction = false;
            this.walkTimer += delta;
        }

        // Jump with coyote time
        if (this.jumpRequested) {
            if (this.playerIsOnGround || this.offGroundTimer < OFF_GROUND_GRACE) {
                this.playerVelocity.y = this.simulationParams.jumpVelocity;
                this.playerIsOnGround = false;
                this.offGroundTimer = OFF_GROUND_GRACE; // Consume coyote time
            }
            this.jumpRequested = false;
        }

        // Gravity
        if (this.playerIsOnGround) {
            this.playerVelocity.y = delta * this.simulationParams.gravity;
        } else {
            this.playerVelocity.y += delta * this.simulationParams.gravity;
        }

        this.position.addScaledVector(this.playerVelocity, delta);

        // Camera rotation (mobile joystick or arrow keys)
        let _euler = new THREE.Euler( 0, 0, 0, 'YXZ' );
        _euler.setFromQuaternion(this.camera.quaternion);
        _euler.y -= this.lookMovement.x * 0.01;
        _euler.x -= this.lookMovement.y * 0.01;
        _euler.x = Math.max( -Math.PI / 2, Math.min( Math.PI / 2, _euler.x ) );
        this.camera.quaternion.setFromEuler(_euler);

        // Camera-relative movement
        this.rightVector.setFromMatrixColumn( this.camera.matrix, 0 );
        this.forwardVector.crossVectors( this.camera.up, this.rightVector );
        this.forwardVector.normalize().multiplyScalar(this.simulationParams.playerSpeed * delta * this.walkMovement.y);
        this.  rightVector.normalize().multiplyScalar(this.simulationParams.playerSpeed * delta * this.walkMovement.x);
        this.position.add(this.forwardVector);
        this.position.add(this.rightVector);

        this.updateMatrixWorld();

        // Capsule collision against chunk BVHs
        const capsuleInfo = this.capsuleInfo;
        this.tempSegment.copy(capsuleInfo.segment);
        this.tempSegment.start.applyMatrix4(this.matrixWorld);
        this.tempSegment.end  .applyMatrix4(this.matrixWorld);

        let globalBox = new THREE.Box3().makeEmpty();
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
                continue;
            }

            this.tempBox.makeEmpty();
            this.tempMat.copy(this.chunks[i].matrixWorld).invert();

            // Transform capsule into chunk local space
            this.tempSegment.start.applyMatrix4(this.tempMat);
            this.tempSegment.end  .applyMatrix4(this.tempMat);

            this.tempBox.expandByPoint(this.tempSegment.start);
            this.tempBox.expandByPoint(this.tempSegment.end);
            this.tempBox.min.addScalar(- capsuleInfo.radius);
            this.tempBox.max.addScalar(capsuleInfo.radius);

            /** @type {MeshBVH} */
            let bvh = this.chunks[i].geometry.boundsTree;
            bvh.shapecast({
                intersectsBounds: box => box.intersectsBox(this.tempBox),
                intersectsTriangle: tri => {
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

            // Transform back to world space
            this.tempSegment.start.applyMatrix4(this.chunks[i].matrixWorld);
            this.tempSegment.end.applyMatrix4(this.chunks[i].matrixWorld);
        }

        // Resolve final position from collision
        let newPosition = this.tempVector;
        newPosition.copy(this.tempSegment.start);

        let deltaVector = this.tempVector2;
        deltaVector.subVectors(newPosition, this.position);

        // Ground detection
        const wasOnGround = this.playerIsOnGround;
        this.playerIsOnGround = deltaVector.y > Math.abs(delta * this.playerVelocity.y * 0.25);

        // Track time off ground for coyote time
        if (this.playerIsOnGround) {
            this.offGroundTimer = 0;
        } else {
            this.offGroundTimer += delta;
        }

        let offset = Math.max(0.0, deltaVector.length() - 1e-5);
        deltaVector.normalize().multiplyScalar(offset);

        this.position.add(deltaVector);

        if (!this.playerIsOnGround) {
            // Remove velocity component along collision normal
            deltaVector.normalize();
            this.playerVelocity.addScaledVector(deltaVector, - deltaVector.dot(this.playerVelocity));
        } else {
            this.playerVelocity.set(0, 0, 0);
        }

        // Walk animation (bounce)
        let isMoving = Math.abs(this.walkMovement.x) > 0.1 || Math.abs(this.walkMovement.y) > 0.1;
        if (this.playerIsOnGround && isMoving) {
            this.walkAnimation += delta * 12;
            this.playerMesh.position.y = Math.abs(Math.sin(this.walkAnimation)) * 0.15;
            this.playerMesh.rotation.x = Math.sin(this.walkAnimation) * 0.08;
        } else {
            this.playerMesh.position.y = 0;
            this.playerMesh.rotation.x = 0;
            this.walkAnimation = 0;
        }

        // Update camera to follow player
        this.camera.position.copy(this.position);
        this.camera.position.y += 0.5;
        if(this.controls){ this.controls.update(); }

        // Reset if fallen too far
        if (this.position.y < - 100) {
            this.reset();
        }
    }

}
