/** Irradiance probe grid over the world (three's LightProbeGrid, WebGPU only).
 *  Probes are baked on the GPU in small batches each frame, and only the
 *  probes near a chunk that changed are rebaked, so destruction keeps the
 *  bounce lighting honest without ever rebaking the whole volume. */
import * as THREE from 'three/webgpu';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';

export class ProbeLighting {

    static supported(renderer) { return !!(renderer.backend && renderer.backend.isWebGPUBackend); }

    // LightProbeGrid bakes into render targets one row (or one slice) per probe, so the probe count
    // must stay under the device's 2D texture limit (8192 on most adapters) with room to spare.
    constructor(renderer, scene, { spacing = 5, maxProbes = 4096, perFrame = 8, cubemapSize = 8 } = {}) {
        this.renderer = renderer;
        this.scene = scene;
        this.spacing = spacing;
        this.maxProbes = maxProbes;
        this.perFrame = perFrame;
        this.cubemapSize = cubemapSize;
        this.grid = null;
        this.dirty = new Set();   // probe indices waiting for a bake
        this.bakedOnce = false;
        this.min = new THREE.Vector3();
        this.max = new THREE.Vector3();
    }

    /** (Re)create the grid to cover a world-space box; everything becomes dirty. */
    setBounds(min, max) {
        if(this.grid) { this.scene.remove(this.grid); this.grid.dispose(); }
        this.min.copy(min); this.max.copy(max);
        let size = new THREE.Vector3().subVectors(max, min);
        let counts = [size.x, size.y, size.z].map(s => Math.max(2, Math.ceil(s / this.spacing) + 1));
        // Cap the probe count by coarsening uniformly until it fits
        let limit = Math.min(this.maxProbes, (this.renderer.backend?.device?.limits?.maxTextureDimension2D || 8192) - 256);
        for(let guard = 0; counts[0] * counts[1] * counts[2] > limit && guard < 32; guard++) {
            let f = Math.cbrt(limit / (counts[0] * counts[1] * counts[2]));
            counts = counts.map(c => Math.max(2, Math.floor(c * f)));
        }
        this.grid = new LightProbeGrid(size.x, size.y, size.z, counts[0], counts[1], counts[2]);
        this.grid.position.copy(min).add(size.clone().multiplyScalar(0.5));
        this.grid.intensity = 1;
        this.scene.add(this.grid);
        this.dirty.clear();
        let n = counts[0] * counts[1] * counts[2];
        for(let i = 0; i < n; i++) this.dirty.add(i);
        this.bakedOnce = false;
    }

    /** Probe linear index as LightProbeGrid orders them: ix + iz * nx + iy * nx * nz. */
    index(ix, iy, iz) { let r = this.grid.resolution; return ix + iz * r.x + iy * r.x * r.z; }

    /** Mark every probe whose cell overlaps `box` (world units) for rebaking. */
    markDirty(box) {
        if(!this.grid) return;
        let r = this.grid.resolution, size = new THREE.Vector3().subVectors(this.max, this.min);
        let step = [size.x / (r.x - 1), size.y / (r.y - 1), size.z / (r.z - 1)];
        let lo = [box.min.x, box.min.y, box.min.z], hi = [box.max.x, box.max.y, box.max.z];
        let mn = [this.min.x, this.min.y, this.min.z], res = [r.x, r.y, r.z];
        let i0 = [], i1 = [];
        for(let a = 0; a < 3; a++) {
            i0[a] = Math.max(0, Math.floor((lo[a] - mn[a]) / step[a]) - 1);
            i1[a] = Math.min(res[a] - 1, Math.ceil((hi[a] - mn[a]) / step[a]) + 1);
        }
        for(let iy = i0[1]; iy <= i1[1]; iy++) for(let iz = i0[2]; iz <= i1[2]; iz++) for(let ix = i0[0]; ix <= i1[0]; ix++) this.dirty.add(this.index(ix, iy, iz));
    }

    /** Bake up to `perFrame` dirty probes, grouped into contiguous ranges. */
    update() {
        if(!this.grid || this.dirty.size === 0 || this.renderer.initialized === false) return;
        let take = [...this.dirty].sort((a, b) => a - b).slice(0, this.perFrame);
        for(let i of take) this.dirty.delete(i);
        let runs = [];
        for(let i of take) {
            let last = runs[runs.length - 1];
            if(last && last.start + last.count === i) last.count++; else runs.push({ start: i, count: 1 });
        }
        try {
            for(let r of runs) this.grid.bake(this.renderer, this.scene, { start: r.start, count: r.count, cubemapSize: this.cubemapSize, near: 0.1, far: 200 });
            this.bakedOnce = true;
        } catch(e) {
            console.warn('probe bake failed: ' + e.message);
            this.dirty.clear();
        }
    }

    stats() { return this.grid ? { probes: this.grid.resolution.x * this.grid.resolution.y * this.grid.resolution.z, dirty: this.dirty.size } : null; }
}
