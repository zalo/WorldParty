/** Texture array for textured terrain materials. Every textured entry of the
 *  world's material table gets one layer (resampled to a common size), and the
 *  terrain geometry carries the layer index per vertex (`slot`, -1 for flat
 *  colours). The array texture object is kept stable so the TSL material keeps
 *  pointing at it; its contents and layer count change when a world does. */
import * as THREE from 'three/webgpu';
import { materialTable } from '../terrain/materials.js';

const SIZE = 1024;

export class TerrainTextures {
    constructor() {
        this.texture = new THREE.DataArrayTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 1);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
        this.texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.generateMipmaps = true;
        this.texture.needsUpdate = true;
        this.layers = new Map();   // material id -> layer index
        this.loading = null;
    }

    /** Load the textured materials of a world config; resolves to the material id -> layer map. */
    async load(world) {
        let table = materialTable(world);
        let textured = table.filter(m => m.texture);
        let token = this.loading = {};
        let layers = new Map();
        if(textured.length === 0) {
            this.layers = layers;
            return layers;
        }
        let data = new Uint8Array(textured.length * SIZE * SIZE * 4);
        await Promise.all(textured.map(async (m, i) => {
            try {
                let blob = await (await fetch(m.texture)).blob();
                let bitmap = await createImageBitmap(blob, { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'high' });
                let canvas = new OffscreenCanvas(SIZE, SIZE);
                let ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0);
                // flip vertically: glTF UV origin is top-left, three samples with origin bottom-left (flipY is ignored for array textures)
                let img = ctx.getImageData(0, 0, SIZE, SIZE).data;
                let base = i * SIZE * SIZE * 4;
                for(let y = 0; y < SIZE; y++) data.set(img.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), base + (SIZE - 1 - y) * SIZE * 4);
                layers.set(m.id, i);
            } catch(e) {
                console.warn(`terrain texture ${m.texture} failed: ${e.message}`);
                // leave the layer white; the material's colour still shows through the slot fallback
                let base = i * SIZE * SIZE * 4;
                data.fill(255, base, base + SIZE * SIZE * 4);
                layers.set(m.id, i);
            }
        }));
        if(this.loading !== token) return this.layers; // superseded by a newer world
        this.texture.image = { data, width: SIZE, height: SIZE, depth: textured.length };
        this.texture.needsUpdate = true;
        this.layers = layers;
        return layers;
    }
}
