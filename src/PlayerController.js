import * as THREE from '../node_modules/three/build/three.module.js';
import { RoundedBoxGeometry } from '../node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as BufferGeometryUtils from '../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, MeshBVHHelper, StaticGeometryGenerator } from '../node_modules/three-mesh-bvh/build/index.module.js';

export class PlayerController extends THREE.Group {
    constructor(controls, camera, simulationParams) {
        super();
        this.controls = controls;
        this.camera = camera;
        this.simulationParams = simulationParams;

        this.name = 'PlayerController';
        this.playerIsOnGround = false;
        this.fwdPressed = false, this.bkdPressed = false, this.lftPressed = false, this.rgtPressed = false;
        this.playerVelocity = new THREE.Vector3();
        this.upVector = new THREE.Vector3(0, 1, 0);
        this.tempVector = new THREE.Vector3();
        this.tempVector2 = new THREE.Vector3();
        this.tempBox = new THREE.Box3();
        this.tempMat = new THREE.Matrix4();
        this.tempSegment = new THREE.Line3();

        // Add Keyboard Controls
        window.addEventListener('keydown', (e) => {
            switch (e.code) {
                case 'KeyW': this.fwdPressed = true; break;
                case 'KeyS': this.bkdPressed = true; break;
                case 'KeyD': this.rgtPressed = true; break;
                case 'KeyA': this.lftPressed = true; break;
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
                case 'KeyW': this.fwdPressed = false; break;
                case 'KeyS': this.bkdPressed = false; break;
                case 'KeyD': this.rgtPressed = false; break;
                case 'KeyA': this.lftPressed = false; break;
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
        this.playerMesh.receiveShadow = true;
        this.playerMesh.material.shadowSide = 2;
        this.add(this.playerMesh);

    }

    reset() {
        this.playerVelocity.set(0, 0, 0);
        this.position.set(15.75, - 3, 30);
        this.camera.position.sub(this.controls.target);
        this.controls.target.copy(this.position);
        this.camera.position.add(this.position);
        this.controls.update();
    }

    updatePlayer(delta) {
        if (!this.collider) return;
        if (!this.collider.matrixWorld){ this.collider.updateMatrixWorld(); }

        if ( this.simulationParams.firstPerson ) {
            this.controls.maxPolarAngle = Math.PI;
            this.controls.minDistance = 1e-4;
            this.controls.maxDistance = 1e-4;
        } else {
            this.controls.maxPolarAngle = Math.PI / 2;
            this.controls.minDistance = 1;
            this.controls.maxDistance = 20;
        }

        if (this.playerIsOnGround) {
            this.playerVelocity.y = delta * this.simulationParams.gravity;
        } else {
            this.playerVelocity.y += delta * this.simulationParams.gravity;
        }

        this.position.addScaledVector(this.playerVelocity, delta);

        // move the player
        const angle = this.controls.getAzimuthalAngle();
        if (this.fwdPressed) {
            this.tempVector.set(0, 0, - 1).applyAxisAngle(this.upVector, angle);
            this.position.addScaledVector(this.tempVector, this.simulationParams.playerSpeed * delta);
        }

        if (this.bkdPressed) {
            this.tempVector.set(0, 0, 1).applyAxisAngle(this.upVector, angle);
            this.position.addScaledVector(this.tempVector, this.simulationParams.playerSpeed * delta);
        }

        if (this.lftPressed) {
            this.tempVector.set(- 1, 0, 0).applyAxisAngle(this.upVector, angle);
            this.position.addScaledVector(this.tempVector, this.simulationParams.playerSpeed * delta);
        }

        if (this.rgtPressed) {
            this.tempVector.set(1, 0, 0).applyAxisAngle(this.upVector, angle);
            this.position.addScaledVector(this.tempVector, this.simulationParams.playerSpeed * delta);
        }

        this.updateMatrixWorld();

        // adjust player position based on collisions
        const capsuleInfo = this.capsuleInfo;
        this.tempBox.makeEmpty();
        this.tempMat.copy(this.collider.matrixWorld).invert();
        this.tempSegment.copy(capsuleInfo.segment);

        // get the position of the capsule in the local space of the collider
        this.tempSegment.start.applyMatrix4(this.matrixWorld).applyMatrix4(this.tempMat);
        this.tempSegment.end.applyMatrix4(this.matrixWorld).applyMatrix4(this.tempMat);

        // get the axis aligned bounding box of the capsule
        this.tempBox.expandByPoint(this.tempSegment.start);
        this.tempBox.expandByPoint(this.tempSegment.end);

        this.tempBox.min.addScalar(- capsuleInfo.radius);
        this.tempBox.max.addScalar(capsuleInfo.radius);

        /** @type {MeshBVH} */
        let bvh = this.collider.geometry.boundsTree;
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

        // get the adjusted position of the capsule collider in world space after checking
        // triangle collisions and moving it. capsuleInfo.segment.start is assumed to be
        // the origin of the player model.
        let newPosition = this.tempVector;
        newPosition.copy(this.tempSegment.start).applyMatrix4(this.collider.matrixWorld);

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

        // adjust the camera
        this.camera.position.sub(this.controls.target);
        this.controls.target.copy(this.position);
        this.camera.position.add(this.position);

        // if the player has fallen too far below the level reset their position to the start
        if (this.position.y < - 25) {
            this.reset();
        }
    }

    bakeCollisionGeometry(environment) {
        let staticGenerator = new StaticGeometryGenerator( environment );
        staticGenerator.attributes = [ 'position' ];
        let mergedGeometry = staticGenerator.generate();
        mergedGeometry.boundsTree = new MeshBVH( mergedGeometry );
        this.collider = new THREE.Mesh( mergedGeometry );
        this.collider.material.wireframe = true;
        this.collider.material.opacity = 0.5;
        this.collider.material.transparent = true;
        this.collider.visible = this.simulationParams.displayCollider;

        // create a helper to visualize the BVH
        let helper = new MeshBVHHelper(this.collider, mergedGeometry.boundsTree,  this.simulationParams.visualizeDepth);
        helper.update();
        this.collider.add(helper);
        this.collider.helper = helper;
        this.collider.helper.visible = this.simulationParams.displayBVH;

        return this.collider;
    }
}