import * as THREE from 'three/webgpu';
import { BaseTool } from './BaseTool.js';

/** PhysGun: grab, move, rotate, freeze physics bodies using a D6 joint drive */
export class PhysGunTool extends BaseTool {
    constructor() {
        super('PhysGun', '🔫');
        this.grabbedBodyId = null;
        this.holdDistance = 6;
        this.holdRotation = new THREE.Quaternion();
        this.beam = null;
        this.beamTarget = new THREE.Vector3();
        this.mobileActions = [
            { label: 'Grab/Drop', icon: '✊', action: 'primary' },
            { label: 'Freeze', icon: '❄️', action: 'secondary' },
            { label: 'Closer', icon: '🔼', action: 'scrollDown' },
            { label: 'Further', icon: '🔽', action: 'scrollUp' },
        ];
    }

    onEquip(main) {
        // Create beam line
        if(!this.beam) {
            let geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            this.beam = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x44aaff, linewidth: 2 }));
            this.beam.frustumCulled = false;
            main.world.scene.add(this.beam);
        }
        this.beam.visible = false;
    }

    onUnequip(main) {
        if(this.grabbedBodyId) {
            main.conn.send(JSON.stringify({ type: "physgun_release", bodyId: this.grabbedBodyId }));
            this.grabbedBodyId = null;
        }
        if(this.beam) this.beam.visible = false;
    }

    onPrimaryFire(main) {
        if(this.grabbedBodyId) {
            // Release
            main.conn.send(JSON.stringify({ type: "physgun_release", bodyId: this.grabbedBodyId }));
            this.grabbedBodyId = null;
            this.beam.visible = false;
            return;
        }

        // Raycast against physics body meshes
        main.raycaster.setFromCamera(new THREE.Vector2(0, 0), main.world.camera);
        let intersects = main.raycaster.intersectObjects(main.physBodiesParent.children, true);
        if(intersects.length > 0) {
            let hit = intersects[0];
            // Find which body this mesh belongs to
            let bodyId = this.findBodyIdFromMesh(main, hit.object);
            if(bodyId) {
                this.grabbedBodyId = bodyId;
                this.holdDistance = hit.distance;
                this.holdRotation.copy(main.physBodyMeshes[bodyId].quaternion);
                main.conn.send(JSON.stringify({ type: "physgun_grab", bodyId: bodyId }));
                this.beam.visible = true;
            }
        }
    }

    onSecondaryFire(main) {
        if(this.grabbedBodyId) {
            // Freeze in place
            main.conn.send(JSON.stringify({ type: "physgun_freeze", bodyId: this.grabbedBodyId }));
            this.grabbedBodyId = null;
            this.beam.visible = false;
        }
    }

    onScroll(main, delta) {
        if(this.grabbedBodyId) {
            this.holdDistance = Math.max(2, this.holdDistance + delta * -0.01);
        }
    }

    update(main, delta) {
        if(!this.grabbedBodyId) return;

        // Compute target position in front of camera
        let targetPos = new THREE.Vector3();
        main.world.camera.getWorldDirection(targetPos).normalize().multiplyScalar(this.holdDistance).add(main.world.camera.position);
        this.beamTarget.copy(targetPos);

        main.conn.send(JSON.stringify({
            type: "physgun_move",
            bodyId: this.grabbedBodyId,
            targetPos: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
            targetQuat: { x: this.holdRotation.x, y: this.holdRotation.y, z: this.holdRotation.z, w: this.holdRotation.w }
        }));

        // Update beam visual
        if(this.beam && this.beam.visible) {
            let positions = this.beam.geometry.attributes.position.array;
            let handPos = main.world.camera.position;
            positions[0] = handPos.x; positions[1] = handPos.y - 0.3; positions[2] = handPos.z;
            let meshPos = main.physBodyMeshes[this.grabbedBodyId]?.position;
            if(meshPos) {
                positions[3] = meshPos.x; positions[4] = meshPos.y; positions[5] = meshPos.z;
            }
            this.beam.geometry.attributes.position.needsUpdate = true;
        }
    }

    findBodyIdFromMesh(main, object) {
        // Walk up parent chain to find a mesh that matches a physics body
        let current = object;
        while(current) {
            for(let bodyId in main.physBodyMeshes) {
                if(main.physBodyMeshes[bodyId] === current) return bodyId;
            }
            current = current.parent;
        }
        // Also check by direct child match for GLB-loaded props
        for(let bodyId in main.physBodyMeshes) {
            let mesh = main.physBodyMeshes[bodyId];
            if(mesh && (mesh === object || mesh.getObjectById(object.id))) {
                return bodyId;
            }
        }
        return null;
    }
}
