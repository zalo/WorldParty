import * as THREE from 'three/webgpu';
import { ADDITION, SUBTRACTION, Brush } from 'three-bvh-csg';
import { BaseTool } from './BaseTool.js';

export class CSGBrushTool extends BaseTool {
    constructor() {
        super('CSG Brush', '🔨');
        this.brushMesh = null;
        this.mobileActions = [
            { label: 'Subtract', icon: '➖', action: 'primary' },
            { label: 'Add', icon: '➕', action: 'secondary' },
            { label: 'Bigger', icon: '🔼', action: 'scrollUp' },
            { label: 'Smaller', icon: '🔽', action: 'scrollDown' },
        ];
    }

    onEquip(main) {
        if(this.brushMesh) this.brushMesh.visible = true;
    }

    onUnequip(main) {
        if(this.brushMesh) this.brushMesh.visible = false;
    }

    init(main) {
        this.brushMesh = main.brush2;
    }

    onPrimaryFire(main) {
        this.performCSG(main, SUBTRACTION);
    }

    onSecondaryFire(main) {
        this.performCSG(main, ADDITION);
    }

    onScroll(main, delta) {
        main.brush2.scale.multiplyScalar(1.0 + (delta * -0.001));
    }

    update(main, delta) {
        // Position brush in front of camera
        main.world.camera.getWorldDirection(main.brush2.position).normalize().multiplyScalar(6).add(main.player.position);
        let lookTarget = new THREE.Vector3().copy(main.world.camera.position);
        lookTarget.y = main.brush2.position.y;
        main.brush2.lookAt(lookTarget);
        main.brush2.updateMatrixWorld();
    }

    performCSG(main, operation) {
        let box = new THREE.Box3().setFromObject(main.brush2);
        let indices = main.terrain.intersecting(box);
        if(indices.length === 0) return;
        main.conn.send(JSON.stringify({
            type: "csg",
            indices,
            brush: main.brushToBase64(main.brush2),
            operation,
            position: { x: main.brush2.position.x, y: main.brush2.position.y, z: main.brush2.position.z },
            quaternion: { x: main.brush2.quaternion.x, y: main.brush2.quaternion.y, z: main.brush2.quaternion.z, w: main.brush2.quaternion.w },
            scale: { x: main.brush2.scale.x, y: main.brush2.scale.y, z: main.brush2.scale.z }
        }));
    }
}
