import * as THREE from 'three/webgpu';
import { ADDITION, SUBTRACTION, Brush } from 'three-bvh-csg';
import { BaseTool } from './BaseTool.js';
import { MATERIALS, materialColor } from '../terrain/materials.js';

export class CSGBrushTool extends BaseTool {
    constructor() {
        super('CSG Brush', '🔨');
        this.brushMesh = null;
        this.material = 0;
        this.mobileActions = [
            { label: 'Subtract', icon: '➖', action: 'primary' },
            { label: 'Add', icon: '➕', action: 'secondary' },
            { label: 'Bigger', icon: '🔼', action: 'scrollUp' },
            { label: 'Smaller', icon: '🔽', action: 'scrollDown' },
            { label: 'Material', icon: '🎨', action: 'material' },
        ];
    }

    /** Desktop: R cycles the brush material. */
    onKey(main, code) { if(code === 'KeyR') this.onAction(main, 'material'); }

    onAction(main, action) {
        if(action !== 'material') return;
        this.material = (this.material + 1) % MATERIALS.length;
        this.applyMaterial(main);
    }

    applyMaterial(main) {
        main.brush2.material.color.setHex(materialColor(this.material));
        main.spawnMenu.setStatus(this, MATERIALS[this.material].name);
    }

    onEquip(main) {
        if(this.brushMesh) this.brushMesh.visible = true;
        this.applyMaterial(main);
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
        let keys = main.terrain.intersecting(box);
        if(keys.length === 0) return;
        main.conn.send(JSON.stringify({
            type: "csg",
            keys,
            brush: main.brushToBase64(main.brush2),
            operation,
            material: this.material,
            position: { x: main.brush2.position.x, y: main.brush2.position.y, z: main.brush2.position.z },
            quaternion: { x: main.brush2.quaternion.x, y: main.brush2.quaternion.y, z: main.brush2.quaternion.z, w: main.brush2.quaternion.w },
            scale: { x: main.brush2.scale.x, y: main.brush2.scale.y, z: main.brush2.scale.z }
        }));
    }
}
