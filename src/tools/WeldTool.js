import * as THREE from 'three/webgpu';
import { BaseTool } from './BaseTool.js';

/** Weld Tool: create fixed joints between two physics bodies */
export class WeldTool extends BaseTool {
    constructor() {
        super('Weld', '⚡');
        this.firstHit = null;
        this.indicator = null;
        this.mobileActions = [
            { label: 'Select', icon: '👆', action: 'primary' },
            { label: 'Cancel', icon: '✖️', action: 'secondary' },
        ];
    }

    onEquip(main) {
        this.firstHit = null;
        if(!this.indicator) {
            this.indicator = new THREE.Mesh(
                new THREE.SphereGeometry(0.1, 8, 8),
                new THREE.MeshBasicMaterial({ color: 0xff4400 })
            );
            this.indicator.visible = false;
            main.world.scene.add(this.indicator);
        }
    }

    onUnequip(main) {
        this.firstHit = null;
        if(this.indicator) this.indicator.visible = false;
    }

    onPrimaryFire(main) {
        main.raycaster.setFromCamera(new THREE.Vector2(0, 0), main.world.camera);
        let intersects = main.raycaster.intersectObjects(main.physBodiesParent.children, true);
        if(intersects.length === 0) return;

        let hit = intersects[0];
        let bodyId = this.findBodyId(main, hit.object);
        if(!bodyId) return;

        let worldPos = hit.point;

        if(!this.firstHit) {
            this.firstHit = { bodyId, worldPos: worldPos.clone() };
            this.indicator.position.copy(worldPos);
            this.indicator.visible = true;
        } else {
            main.conn.send(JSON.stringify({
                type: "createjoint",
                jointType: "weld",
                bodyIdA: this.firstHit.bodyId,
                bodyIdB: bodyId,
                worldPosA: { x: this.firstHit.worldPos.x, y: this.firstHit.worldPos.y, z: this.firstHit.worldPos.z },
                worldPosB: { x: worldPos.x, y: worldPos.y, z: worldPos.z }
            }));
            this.firstHit = null;
            this.indicator.visible = false;
        }
    }

    onSecondaryFire(main) {
        this.firstHit = null;
        if(this.indicator) this.indicator.visible = false;
    }

    findBodyId(main, object) {
        let current = object;
        while(current) {
            for(let bodyId in main.physBodyMeshes) {
                if(main.physBodyMeshes[bodyId] === current) return bodyId;
            }
            current = current.parent;
        }
        for(let bodyId in main.physBodyMeshes) {
            let mesh = main.physBodyMeshes[bodyId];
            if(mesh && (mesh === object || mesh.getObjectById(object.id))) return bodyId;
        }
        return null;
    }
}
