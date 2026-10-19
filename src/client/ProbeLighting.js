/** Irradiance probe grid over the world (three's LightProbeGrid, WebGPU only).
 *  Probes are baked on the GPU in small batches each frame, and only the
 *  probes near a chunk that changed are rebaked, so destruction keeps the
 *  bounce lighting honest without ever rebaking the whole volume.
 *
 *  Probe positions sit on a world-space lattice (multiples of `spacing`), so when the volume grows (the client
 *  holds a new row of chunks) the new grid shares positions with the old one and copies its baked rows over
 *  instead of starting from black: before this, every refit threw the whole bake away and the grid never
 *  finished in normal play (walking into the vault was enough), which is why "the probes did nothing". */
import * as THREE from 'three/webgpu';
import { array, attribute, getShIrradianceAt, normalWorld, positionWorld, texture3D, uniform, vec3 } from 'three/tsl';
import { LightProbeGrid as CubeCameraGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightProbeGrid as BatchedGrid } from './vendor/LightProbeGrid.js';
import { LightProbeGridNode, ATLAS_PADDING } from 'three/addons/tsl/lighting/LightProbeGridNode.js';
import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';

/** Sample offset along the surface normal, metres. three's node pushes the sample half a probe spacing into the
 *  surface (3 m here), which on a wall between a sunlit courtyard and a sewer reads the probes on the far side:
 *  the sewer wall lit like the courtyard. One metre still clears the surface's own cell. */
const SAMPLE_OFFSET = 1.0;

/** Irradiance of a grid's baked SH atlas at texel-centre coordinates `uvw` for a normal (seven RGBA sub-volumes
 *  stacked along Z, each nz + 2 padding slices: LightProbeGrid._repackProbes). */
function shAt(grid, uvw, normal) {
    const atlas = texture3D(grid.texture), res = uniform(grid.resolution.clone());
    const nz = res.z, paddedSlices = nz.add(2.0 * ATLAS_PADDING), atlasDepth = paddedSlices.mul(7.0);
    const uvZBase = uvw.z.mul(nz).add(ATLAS_PADDING);
    const slice = (t) => atlas.sample(vec3(uvw.xy, uvZBase.add(paddedSlices.mul(t)).div(atlasDepth)));
    const s0 = slice(0), s1 = slice(1), s2 = slice(2), s3 = slice(3), s4 = slice(4), s5 = slice(5), s6 = slice(6);
    const sh = array([ s0.xyz, vec3(s0.w, s1.xy), vec3(s1.zw, s2.x), s2.yzw, s3.xyz, vec3(s3.w, s4.xy), vec3(s4.zw, s5.x), s5.yzw, s6.xyz ]);
    return getShIrradianceAt(normal, sh).max(vec3(0.0));
}

/** three's LightProbeGridNode with a fixed sample offset instead of half the spacing (see SAMPLE_OFFSET). */
class ProbeGridNode extends LightProbeGridNode {

    static get type() { return 'ProbeGridNode'; }

    setup(builder) {
        const light = this.light;
        if(light.texture === null) return;
        const min = this._min, max = this._max, res = this._resolution;
        const range = max.sub(min);
        const resMinusOne = res.sub(1.0);
        const samplePos = positionWorld.add(normalWorld.mul(SAMPLE_OFFSET));
        const uvw = samplePos.sub(min).div(range).clamp(0.0, 1.0).mul(resMinusOne).div(res).add(vec3(0.5).div(res));
        // the atlas: seven RGBA sub-volumes along Z, each nz + 2 padding slices (LightProbeGrid._repackProbes)
        const atlas = texture3D(light.texture);
        const nz = res.z, paddedSlices = nz.add(2.0 * ATLAS_PADDING), atlasDepth = paddedSlices.mul(7.0);
        const uvZBase = uvw.z.mul(nz).add(ATLAS_PADDING);
        const slice = (t) => atlas.sample(vec3(uvw.xy, uvZBase.add(paddedSlices.mul(t)).div(atlasDepth)));
        const s0 = slice(0), s1 = slice(1), s2 = slice(2), s3 = slice(3), s4 = slice(4), s5 = slice(5), s6 = slice(6);
        const sh = array([ s0.xyz, vec3(s0.w, s1.xy), vec3(s1.zw, s2.x), s2.yzw, s3.xyz, vec3(s3.w, s4.xy), vec3(s4.zw, s5.x), s5.yzw, s6.xyz ]);
        let irradiance = getShIrradianceAt(normalWorld, sh).max(vec3(0.0)).mul(this._intensity);
        if(light.falloff > 0) {
            const outside = min.sub(positionWorld).max(0.0).add(positionWorld.sub(max).max(0.0));
            irradiance = irradiance.mul(outside.length().smoothstep(0.0, this._falloff).oneMinus());
        }
        // terrain with vertex GI (TerrainGI): its own light replaces the probes' as it gathers samples
        const gi = builder.material && builder.material.giNode;
        if(gi) irradiance = irradiance.mul(gi.w.oneMinus());
        builder.context.irradiance.addAssign(irradiance);
    }
}

/** The grid class: three PR #34909's batched capture (vendor/LightProbeGrid.js: eight probes per render through one
 *  48-view ArrayCamera, every queued run in one bake call) unless `?probebake=cube` asks for r186's (a CubeCamera per
 *  probe: six renders and a submit each, and a bake call per run). */
const BATCHED = typeof location === 'undefined' || new URLSearchParams(location.search).get('probebake') !== 'cube';
const LightProbeGrid = BATCHED ? BatchedGrid : CubeCameraGrid;

const AXES = [ [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1] ].map(a => new THREE.Vector3(...a));
const _ray = new THREE.Ray(), _inv = new THREE.Matrix4(), _min = new THREE.Vector3(), _max = new THREE.Vector3();

export class ProbeLighting {

    static supported(renderer) { return !!(renderer.backend && renderer.backend.isWebGPUBackend); }

    // LightProbeGrid bakes into render targets one row (or one slice) per probe, so the probe count
    // must stay under the device's 2D texture limit (8192 on most adapters) with room to spare.
    /** `ambient` scales the probe light. Measured against the sun, this sky's zenith is about half as bright as a real
     *  one, and a walled courtyard floor sees only the zenith cone, so physically its shade sat near 1:80 of the sunlit
     *  cobbles next to it (a linear render has no eye to adapt); the multiplier lifts the shade toward what a game reads.
     *
     *  What the probes see decides whether they mean anything: a capture renders the scene with the sky's image based
     *  light on every surface, and that light knows nothing about occlusion, so at the old 7x a probe in the vault saw
     *  walls lit like the courtyard and handed that back to the vault (the vault looked like daylight and the probes
     *  looked like nothing). Captures now use `bakeEnvironment` (a little sky light on surfaces: the first bounce of the
     *  shaded ground outdoors, nearly nothing indoors) while the probes see the sky itself and the sunlit surfaces in
     *  full, so the occlusion is in the probes. Once they are baked the scene's own image based light drops to
     *  `environmentFloor`, a specular sheen and a minimum in unlit corners; before that it stands in at `environmentUnbaked`.
     *  `?ambient=`, `?envfloor=` and `?bakeenv=` override the three for tuning. */
    constructor(renderer, scene, { spacing = 6, maxProbes = 4000, perFrame = 8, cubemapSize = 8, ambient = 10, bakeEnvironment = 0.35, environmentFloor = 0.2, environmentUnbaked = 2.5, budgetMs = 5 } = {}) {
        let q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
        let num = (k, d) => q.has(k) && Number.isFinite(parseFloat(q.get(k))) ? parseFloat(q.get(k)) : d;
        ambient = num('ambient', ambient); environmentFloor = num('envfloor', environmentFloor); bakeEnvironment = num('bakeenv', bakeEnvironment);
        this.showProbes = q.get('probes') === 'show'; // debug: a sphere per probe, shaded by what it baked, where it baked from
        this.helper = null;
        this.bakeEnvironment = bakeEnvironment;
        this.environmentFloor = environmentFloor;
        this.environmentUnbaked = environmentUnbaked;
        this.renderer = renderer;
        this.scene = scene;
        this.spacing = spacing;   // requested lattice step (metres); `step` is the one in use (coarser if the cap binds)
        this.step = spacing;
        this.maxProbes = maxProbes;
        this.perFrame = perFrame;
        this.budgetMs = budgetMs;         // bake CPU time per frame to aim for (a phone gets less: World)
        this.skipFrames = 0;              // frames to rest after a single probe that took longer than the budget
        this.cubemapSize = cubemapSize;
        this.ambient = ambient;
        this.grid = null;
        this.dirty = new Set();   // probe indices waiting for a bake
        this.bakedOnce = false;
        this.disabled = false;    // after repeated bake failures: the sky light stays up instead
        this.failures = 0;
        this.min = new THREE.Vector3();   // lattice-aligned volume in use
        this.max = new THREE.Vector3();
        this.requested = null;            // the box last asked for (before lattice alignment)
        this.occluders = null;            // Group of closed meshes with BVHs (the terrain chunks) for the inside-solid test
        this.occludersIn = null;          // (min, max) => those of them within a box (Main: the chunk meshes there)
        this.captureView = null;          // (on) => void: swap in what captures draw of the terrain (TerrainMirror.captureView)
        this.relocated = new Map();       // probe index -> position baked from instead (inside solid) or null (in air)
        this.mute = [];                   // lights switched off while baking (the glow volume)
        // our sampling node for the grid (LightProbeGrid.bake registers three's only if none is there yet)
        if(renderer.library.getLightNodeClass(LightProbeGrid) === null) renderer.library.addLight(ProbeGridNode, LightProbeGrid);
    }

    /** First hit of a world-space ray against the occluders (both face sides), or null. */
    raycast(origin, dir, far) {
        let best = null, meshes = this.occluders.children;
        if(this.occludersIn) {
            _min.set(Math.min(origin.x, origin.x + dir.x * far), Math.min(origin.y, origin.y + dir.y * far), Math.min(origin.z, origin.z + dir.z * far));
            _max.set(Math.max(origin.x, origin.x + dir.x * far), Math.max(origin.y, origin.y + dir.y * far), Math.max(origin.z, origin.z + dir.z * far));
            meshes = this.occludersIn(_min, _max); // testing all of Twin Forts' 356 chunks cost ~0.45 ms per probe placed
        }
        for(let mesh of meshes) {
            let bvh = mesh.geometry && mesh.geometry.boundsTree;
            if(!bvh) continue;
            _ray.origin.copy(origin); _ray.direction.copy(dir);
            _ray.applyMatrix4(_inv.copy(mesh.matrixWorld).invert());
            let hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, best ? best.distance : far);
            if(hit && (!best || hit.distance < best.distance)) best = { distance: hit.distance, point: hit.point.applyMatrix4(mesh.matrixWorld), normal: hit.face.normal.clone().transformDirection(mesh.matrixWorld) };
        }
        return best;
    }

    /** Where to bake probe `i` from: its lattice position, unless that is inside solid. A probe inside rock
     *  sees the sky through every back-face-culled surface and nothing lit (a row 10 cm under the plaza lit the
     *  bottom of every wall sky-blue and never with the sand's bounce); it is moved just outside the nearest
     *  surface instead, so the cells around it blend from something a surface there could actually see. The
     *  first hit along any axis being a back face means we are inside; repeat in case that was only a chunk's
     *  boundary face. Deep rock with nothing within reach stays where it is (nothing samples there). */
    bakePosition(i, pos) {
        if(this.relocated.has(i)) return this.relocated.get(i) || pos;
        let out = null;
        if(this.occluders) {
            let p = pos.clone();
            for(let hop = 0; hop < 4; hop++) {
                let nearest = null;
                for(let d of AXES) {
                    let hit = this.raycast(p, d, this.step * 1.5);
                    if(hit && hit.normal.dot(d) > 0 && (!nearest || hit.distance < nearest.distance)) nearest = hit;
                }
                if(!nearest) break;
                p = nearest.point.addScaledVector(nearest.normal, 0.3);
                out = p;
            }
        }
        this.relocated.set(i, out);
        return out || pos;
    }

    /** Route the grid's capture positions through `bakePosition`. */
    patchGrid(grid) {
        const base = LightProbeGrid.prototype.getProbePosition;
        grid.getProbePosition = (ix, iy, iz, target) => {
            base.call(grid, ix, iy, iz, target);
            return target.copy(this.bakePosition(this.index(ix, iy, iz), target));
        };
    }

    /** Probe count limit: the cap, and the device's 2D texture height (the bake batches one row per probe). */
    limit() { return Math.min(this.maxProbes, (this.renderer.backend?.device?.limits?.maxTextureDimension2D || 8192) - 256); }

    /** Lattice-aligned grid for a box: positions are multiples of `step`; the step coarsens until the count fits. */
    layout(min, max) {
        let step = this.spacing, limit = this.limit();
        for(let guard = 0; guard < 16; guard++) {
            let lo = [min.x, min.y, min.z].map(v => Math.floor(v / step) * step), hi = [max.x, max.y, max.z].map(v => Math.ceil(v / step) * step);
            let counts = [0, 1, 2].map(a => Math.max(2, Math.round((hi[a] - lo[a]) / step) + 1));
            if(counts[0] * counts[1] * counts[2] <= limit) return { step, lo, hi, counts };
            step = Math.round(step * 1.25 * 100) / 100;
        }
        return null;
    }

    /** (Re)create the grid to cover a world-space box. Rows the old grid had baked at the same lattice
     *  positions are copied over (atlas texture copy, no readback); only the new ones become dirty. */
    setBounds(min, max) {
        if(this.requested && this.requested.min.equals(min) && this.requested.max.equals(max) && this.grid) return;
        this.requested = { min: min.clone(), max: max.clone() };
        let L = this.layout(min, max);
        if(!L) { console.warn('probe grid: no layout fits'); return; }
        let old = this.grid ? { grid: this.grid, min: this.min.clone(), max: this.max.clone(), step: this.step, dirty: this.dirty } : null;
        let { step, lo, hi, counts } = L;
        this.step = step;
        this.min.set(lo[0], lo[1], lo[2]); this.max.set(hi[0], hi[1], hi[2]);
        let size = new THREE.Vector3((counts[0] - 1) * step, (counts[1] - 1) * step, (counts[2] - 1) * step);
        this.max.copy(this.min).add(size);
        this.grid = new LightProbeGrid(size.x, size.y, size.z, counts[0], counts[1], counts[2]);
        this.grid.position.copy(this.min).add(size.clone().multiplyScalar(0.5));
        this.grid.intensity = 0;
        this.patchGrid(this.grid);
        this.relocated = new Map();
        this.scene.add(this.grid);
        this.dirty = new Set();
        let n = counts[0] * counts[1] * counts[2];
        for(let i = 0; i < n; i++) this.dirty.add(i);
        this.bakedOnce = false;
        this.disabled = false; this.failures = 0;
        if(old) {
            try { this.inherit(old); } catch(e) { console.warn('probe grid: could not keep the old bake: ' + e.message); }
            this.scene.remove(old.grid); old.grid.dispose();
        }
        if(this.helper) { this.scene.remove(this.helper); this.helper.dispose(); this.helper = null; }
    }

    /** Copy the rows of the previous grid that share this grid's lattice (same step, same x/z lattice). */
    inherit(old) {
        let g = this.grid, og = old.grid, r = g.resolution, or = og.resolution;
        if(!og._renderTarget || old.step !== this.step) return;
        if(old.min.x !== this.min.x || old.min.z !== this.min.z || or.x !== r.x || or.z !== r.z) return;
        let step = this.step;
        let yLo = Math.max(old.min.y, this.min.y), yHi = Math.min(old.max.y, this.max.y);
        if(yHi < yLo) return;
        let srcRow = Math.round((yLo - old.min.y) / step), dstRow = Math.round((yLo - this.min.y) / step), rows = Math.round((yHi - yLo) / step) + 1;
        g._ensureTextures();
        this.renderer.initRenderTarget(g._renderTarget);
        this.renderer.initRenderTarget(og._renderTarget);
        let depth = og._renderTarget.depth;
        let region = new THREE.Box3(new THREE.Vector3(0, srcRow, 0), new THREE.Vector3(r.x, srcRow + rows, depth));
        this.renderer.copyTextureToTexture(og._renderTarget.texture, g._renderTarget.texture, region, new THREE.Vector3(0, dstRow, 0));
        // the copied rows are baked unless they were still waiting in the old grid
        let perLayer = r.x * r.z;
        for(let iy = dstRow; iy < dstRow + rows; iy++) for(let i = iy * perLayer; i < (iy + 1) * perLayer; i++) this.dirty.delete(i);
        for(let i of old.dirty) {
            let oiy = Math.floor(i / perLayer); if(oiy < srcRow || oiy >= srcRow + rows) continue;
            this.dirty.add(i + (dstRow - srcRow) * perLayer);
        }
        this.bakedOnce = true;
    }

    /** Probe linear index as LightProbeGrid orders them: ix + iz * nx + iy * nx * nz. */
    index(ix, iy, iz) { let r = this.grid.resolution; return ix + iz * r.x + iy * r.x * r.z; }

    /** Mark the probes around `box` (world units: what a carve changed, see TerrainMirror's changedBox) for rebaking:
     *  the corners of every cell it overlaps, 8 to 27 for a drill bite. (It was a step beyond the whole chunk, ~125
     *  probes per bite, each six renders of the scene, which a held drill never let the bake catch up with.) */
    markDirty(box) {
        if(!this.grid || this.disabled) return;
        let r = this.grid.resolution, step = this.step, m = 0;
        let lo = [box.min.x - m, box.min.y - m, box.min.z - m], hi = [box.max.x + m, box.max.y + m, box.max.z + m];
        let mn = [this.min.x, this.min.y, this.min.z], res = [r.x, r.y, r.z];
        let i0 = [], i1 = [];
        for(let a = 0; a < 3; a++) {
            i0[a] = Math.max(0, Math.floor((lo[a] - mn[a]) / step));
            i1[a] = Math.min(res[a] - 1, Math.ceil((hi[a] - mn[a]) / step));
        }
        for(let iy = i0[1]; iy <= i1[1]; iy++) for(let iz = i0[2]; iz <= i1[2]; iz++) for(let ix = i0[0]; ix <= i1[0]; ix++) {
            let i = this.index(ix, iy, iz);
            this.dirty.add(i);
            this.relocated.delete(i); // the solid around it changed
        }
    }

    /** Fraction of the grid baked so far (unbaked probes contribute black). */
    bakedFraction() {
        if(!this.grid || this.disabled) return 0;
        let n = this.grid.resolution.x * this.grid.resolution.y * this.grid.resolution.z;
        return n ? 1 - this.dirty.size / n : 1;
    }

    /** World position of a probe by linear index. */
    probePosition(i) {
        let r = this.grid.resolution, ix = i % r.x, iz = Math.floor(i / r.x) % r.z, iy = Math.floor(i / (r.x * r.z));
        return new THREE.Vector3(this.min.x + ix * this.step, this.min.y + iy * this.step, this.min.z + iz * this.step);
    }

    /** Bake a few dirty probes per frame, nearest the camera first, grouped into contiguous ranges. The batch
     *  size adapts to keep the bake around `budgetMs` per frame, so a heavy scene does not stall interaction; when a
     *  single probe already costs more than that (a phone: ~5x this desktop's 4 ms), the bake rests for as many frames
     *  as it overran, so the average stays within the budget instead of costing a probe every frame.
     *  While the grid is still mostly unbaked its intensity is held down (an unbaked probe is black) and the
     *  caller keeps the sky's image based light up instead; see `environmentIntensity()`. A failed bake puts
     *  its probes back and pauses; it never pretends the grid is done (a cleared queue over an empty atlas was
     *  the old failure mode, black probes everywhere). */
    update(camera = null) {
        if(!this.grid) return;
        this.grid.intensity = this.ambient * Math.min(1, this.bakedFraction() * 1.25);
        if(this.showProbes) this.updateHelper();
        if(this.disabled || this.dirty.size === 0 || this.renderer.initialized === false) return;
        if(this.pauseUntil && performance.now() < this.pauseUntil) return;
        if(this.skipFrames > 0) { this.skipFrames--; return; }
        if(this.lastBakeMs !== undefined) {
            if(this.lastBakeMs > this.budgetMs * 1.5) this.perFrame = Math.max(1, Math.floor(this.perFrame / 2));
            else if(this.lastBakeMs < this.budgetMs * 0.5) this.perFrame = Math.min(BATCHED ? 64 : 32, this.perFrame + 1);
        }
        let take = this.nearestDirty(camera, this.perFrame).sort((a, b) => a - b);
        for(let i of take) this.dirty.delete(i);
        let runs = [];
        for(let i of take) {
            let last = runs[runs.length - 1];
            if(last && last.start + last.count === i) last.count++; else runs.push({ start: i, count: 1 });
        }
        let muted = this.mute.map(l => l.intensity), env = this.scene.environmentIntensity;
        try {
            let t0 = performance.now();
            for(let l of this.mute) l.intensity = 0;
            this.scene.environmentIntensity = this.bakeEnvironment;
            if(this.helper) this.helper.visible = false;
            this.captureView?.(true);
            if(BATCHED) this.grid.bake(this.renderer, this.scene, { runs, cubemapSize: this.cubemapSize, near: 0.1, far: 200 });
            else for(let r of runs) this.grid.bake(this.renderer, this.scene, { start: r.start, count: r.count, cubemapSize: this.cubemapSize, near: 0.1, far: 200 });
            this.captureView?.(false);
            this.mute.forEach((l, i) => l.intensity = muted[i]);
            this.scene.environmentIntensity = env;
            if(this.helper) this.helper.visible = true;
            this.bakedOnce = true;
            this.failures = 0;
            this.lastBakeMs = performance.now() - t0;
            this.bakedTotal = (this.bakedTotal || 0) + take.length;
            if(take.length === 1 && this.lastBakeMs > this.budgetMs) this.skipFrames = Math.min(30, Math.ceil(this.lastBakeMs / this.budgetMs) - 1);
            if(this.lastBakeMs > 50) console.log(`probe bake: ${take.length} probes in ${this.lastBakeMs.toFixed(0)} ms (${this.dirty.size} left, now ${this.perFrame}/frame)`);
        } catch(e) {
            this.captureView?.(false);
            this.mute.forEach((l, i) => l.intensity = muted[i]);
            this.scene.environmentIntensity = env;
            if(this.helper) this.helper.visible = true;
            for(let i of take) this.dirty.add(i);
            this.failures++;
            this.pauseUntil = performance.now() + 2000 * this.failures;
            console.warn(`probe bake failed (${this.failures}): ${e.message}`);
            if(this.failures >= 5) { console.warn('probe lighting disabled; the sky light stays up'); this.disabled = true; this.grid.intensity = 0; }
        }
    }

    /** The `k` dirty probes nearest the camera (lowest indices without one), by a linear scan: sorting the whole queue
     *  with a Vector3 per comparison every frame cost more than a probe bake on a big grid. */
    nearestDirty(camera, k) {
        if(!camera) return [...this.dirty].sort((a, b) => a - b).slice(0, k);
        let r = this.grid.resolution, nx = r.x, nxz = r.x * r.z, step = this.step, c = camera.position;
        let ox = (c.x - this.min.x) / step, oy = (c.y - this.min.y) / step, oz = (c.z - this.min.z) / step;
        let best = [], bestD = [];
        for(let i of this.dirty) {
            let dx = i % nx - ox, dz = Math.floor(i / nx) % r.z - oz, dy = Math.floor(i / nxz) - oy, d = dx * dx + dy * dy + dz * dz;
            if(best.length < k) { best.push(i); bestD.push(d); }
            else if(d < bestD[k - 1]) { best[k - 1] = i; bestD[k - 1] = d; }
            else continue;
            for(let j = best.length - 1; j > 0 && bestD[j - 1] > bestD[j]; j--) {   // keep the list sorted by distance
                let t = best[j]; best[j] = best[j - 1]; best[j - 1] = t;
                t = bestD[j]; bestD[j] = bestD[j - 1]; bestD[j - 1] = t;
            }
        }
        return best;
    }

    /** How much of the sky's image based light the scene should use: `environmentUnbaked` until the probes carry the
     *  diffuse sky light themselves, then only `environmentFloor` (it lights every surface alike, the vault as much as
     *  the plaza, so anything more washes out what the probes know about occlusion). */
    environmentIntensity() { let f = this.bakedFraction(); return this.environmentUnbaked + (this.environmentFloor - this.environmentUnbaked) * f; }

    /** ?probes=show: the grid's own helper (three's LightProbeGridHelper: one sphere per probe shaded by its
     *  irradiance) at the positions the probes baked from; hidden while baking so the probes never see it. */
    updateHelper() {
        if(!this.grid.texture) return;
        let now = performance.now();
        if(!this.helper) {
            this.helper = new LightProbeGridHelper(this.grid, 0.3);
            // its own shading shows raw irradiance (white at these levels) without tone mapping; the same SH read as
            // the colour of an unlit material instead, scaled to what a grey (0.2) surface facing that way receives
            this.helper.material.dispose();
            this.helper.material = new THREE.MeshBasicNodeMaterial();
            this.helper.material.colorNode = shAt(this.grid, attribute('instanceUVW', 'vec3'), normalWorld).mul(this.ambient * 0.2 / Math.PI);
            this.helper.frustumCulled = false;
            this.scene.add(this.helper);
            this.helperAt = 0;
        }
        if(now - this.helperAt > 2000) { this.helperAt = now; this.helper.update(); } // positions move as probes relocate
    }

    stats() { return this.grid ? { probes: this.grid.resolution.x * this.grid.resolution.y * this.grid.resolution.z, dirty: this.dirty.size, step: this.step } : null; }
}
