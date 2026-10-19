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
        this.averages = [];        // layer index -> mean linear RGB
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
                let blob = await (await fetch(new URL(m.texture, document.baseURI))).blob(); // relative paths resolve under a proxy prefix too
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
        // The GPU texture was created at the placeholder's size; dispose it so the backend recreates it at the new
        // dimensions (writing 1024² layers into a 1×1 texture fails validation and leaves every layer white)
        this.texture.dispose();
        this.texture.image = { data, width: SIZE, height: SIZE, depth: textured.length };
        this.texture.needsUpdate = true;
        this.layers = layers;
        // each layer's mean colour in linear light: the albedo the vertex GI's rays see (TerrainGI)
        let lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        this.averages = textured.map((m, i) => {
            let base = i * SIZE * SIZE * 4, sum = [0, 0, 0], n = 0;
            for(let p = base; p < base + SIZE * SIZE * 4; p += 4 * 7) { sum[0] += lin(data[p]); sum[1] += lin(data[p + 1]); sum[2] += lin(data[p + 2]); n++; }
            return sum.map(v => v / n);
        });
        return layers;
    }
}
