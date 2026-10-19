/** Glow rock lighting: every exposed glow rock lights the tunnel around it, however many there are.
 *
 *  Twelve real point lights on the nearest rocks lit almost nothing once the field put a rock in every metre of tunnel,
 *  and every point light costs every pixel of every lit material. Instead the rocks are splatted on the CPU into a small
 *  3D texture around the camera (0.5 m texels): per texel the summed colour of the rocks that can see it (RGB) and their
 *  mean direction (a second texture). A light node (`GlowVolumeNode`, the same kind of node as the probe grid's) adds
 *  colour * max(0, 1/4 + 3/4 n.d) to the indirect diffuse of every standard material: two texture reads per pixel no
 *  matter how many rocks. That is the L1 spherical harmonic approximation of a set of point sources: a surface facing
 *  the rocks gets all of it, one turned away gets none, which keeps most of the light out of the tunnel next door.
 *
 *  Occlusion: each rock's light sits a little way out of the wall (toward where 36 coarse rays from its centre find the
 *  most room) and casts 144 rays from there (an octahedral 12x12 map of directions) against the chunk BVHs, once; a
 *  texel only takes the light if it is no further than the wall in its direction (plus a texel of slack, since texels
 *  sit behind the surfaces they light). The map is recomputed when a chunk around the rock changes.
 *
 *  Splats are additive, so a rock that appears, changes exposure or gets a new occlusion map is subtracted with its old
 *  record and added with the new one, and only the touched z slices are uploaded (three r186 uploads a Data3DTexture's
 *  `layerUpdates`, as it does for array textures). When the camera leaves the middle of the window, a second accumulator
 *  is filled for the new window a few rocks per frame and swapped in when complete. */
import * as THREE from 'three/webgpu';
import { positionWorld, normalWorld, texture3D, uniform, min as tslMin } from 'three/tsl';

const OCT = 12;                 // occlusion map resolution (OCT x OCT directions per rock)
const SLACK = 0.45;             // a texel this far behind the first wall in its direction still takes the light ...
const SOFT = 0.5;               // ... fading out over this much more (a hard cut drew the texel grid on the floor)
const STANDOFF = 0.35;          // the light sits this far out of the wall, toward the open side (see depthMap)

function octDecode(u, v) {
    let x = u * 2 - 1, y = v * 2 - 1, z = 1 - Math.abs(x) - Math.abs(y);
    let t = Math.max(-z, 0);
    x += x >= 0 ? -t : t; y += y >= 0 ? -t : t;
    let l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
}
const OCT_DIRS = [], COARSE_DIRS = [];
for(let v = 0; v < OCT; v++) for(let u = 0; u < OCT; u++) OCT_DIRS.push(octDecode((u + 0.5) / OCT, (v + 0.5) / OCT));
for(let v = 0; v < 6; v++) for(let u = 0; u < 6; u++) COARSE_DIRS.push(octDecode((u + 0.5) / 6, (v + 0.5) / 6));
/** Wall distance in a (not necessarily unit) direction: the occlusion map read bilinearly (nearest cells drew their
 *  edges on the floor as stripes of light and dark). */
function octDepth(depth, x, y, z) {
    let s = Math.abs(x) + Math.abs(y) + Math.abs(z);
    x /= s; y /= s; z /= s;
    if(z < 0) { let ox = x; x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1); y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1); }
    let fu = (x * 0.5 + 0.5) * OCT - 0.5, fv = (y * 0.5 + 0.5) * OCT - 0.5;
    let u0 = Math.floor(fu), v0 = Math.floor(fv), tu = fu - u0, tv = fv - v0;
    let u1 = u0 + 1 > OCT - 1 ? OCT - 1 : u0 + 1, v1 = v0 + 1 > OCT - 1 ? OCT - 1 : v0 + 1;
    if(u0 < 0) u0 = 0; if(v0 < 0) v0 = 0;
    let a = depth[v0 * OCT + u0], b = depth[v0 * OCT + u1], c = depth[v1 * OCT + u0], d = depth[v1 * OCT + u1];
    return (a + (b - a) * tu) * (1 - tv) + (c + (d - c) * tu) * tv;
}

/** The light object the node reads: two volume textures and where they sit. */
export class GlowVolumeLight extends THREE.Light {
    constructor() {
        super(0xffffff, 1);
        this.isGlowVolumeLight = true;
        this.type = 'GlowVolumeLight';
        this.textureA = null;              // RGB: sqrt(colour sum / maxValue)
        this.textureB = null;              // RGB: mean direction to the rocks * 0.5 + 0.5
        this.origin = new THREE.Vector3(); // world position of the window's min corner
        this.size = new THREE.Vector3(1, 1, 1);
        this.texel = 0.5;
        this.maxValue = 3;
        this.fade = 3;                     // metres over which the light fades out at the window's edge
    }
}

/** Adds the glow volume's irradiance to standard materials (see the file comment). Updated per render, not per frame,
 *  so the probe bake can switch it off for its captures within a frame (the probes would bake the glow in at 6 m). */
export class GlowVolumeNode extends THREE.AnalyticLightNode {
    static get type() { return 'GlowVolumeNode'; }
    constructor(light = null) {
        super(light);
        this.updateType = THREE.NodeUpdateType.RENDER;
        this._origin = uniform(new THREE.Vector3());
        this._size = uniform(new THREE.Vector3(1, 1, 1));
        this._intensity = uniform(1);
        this._max = uniform(3);
        this._offset = uniform(0.3);
        this._fade = uniform(3);
    }
    update() {
        let l = this.light;
        this._origin.value.copy(l.origin); this._size.value.copy(l.size);
        this._intensity.value = l.intensity; this._max.value = l.maxValue; this._offset.value = l.texel * 0.6; this._fade.value = l.fade;
    }
    setup(builder) {
        let light = this.light;
        if(!light.textureA || !light.textureB) return;
        let p = positionWorld.add(normalWorld.mul(this._offset));   // off the surface, into the air it faces
        let uvw = p.sub(this._origin).div(this._size);
        let a = texture3D(light.textureA).sample(uvw).rgb;
        let d = texture3D(light.textureB).sample(uvw).rgb.mul(2.0).sub(1.0);
        let colour = a.mul(a).mul(this._max);
        let facing = normalWorld.dot(d).mul(0.75).add(0.25).max(0.0);
        let q = tslMin(p.sub(this._origin), this._origin.add(this._size).sub(p));
        let edge = tslMin(q.x, tslMin(q.y, q.z)).div(this._fade).clamp(0.0, 1.0);
        builder.context.irradiance.addAssign(colour.mul(facing).mul(edge).mul(this._intensity));
    }
}

/** A window of accumulated light: 7 floats per texel (RGB sum, luminance-weighted direction sum, luminance sum). */
class Accumulator {
    constructor(dims) { this.dims = dims; this.n = dims[0] * dims[1] * dims[2]; this.data = new Float32Array(this.n * 7); this.origin = [0, 0, 0]; }
}

export class GlowLighting {
    static supported(renderer) { return !!(renderer && renderer.library); }

    /** @param terrain TerrainMirror (chunk BVHs for occlusion)
     *  @param opts.dims texels per axis; opts.texel metres per texel; opts.reach metres a rock lights;
     *         opts.intensity light node intensity; opts.falloff distance (m) where a rock's light has halved */
    constructor(renderer, scene, terrain, { dims = [80, 32, 80], texel = 0.5, reach = 3.5, falloff = 1.4, intensity = 35, budgetMs = 2 } = {}) {
        this.renderer = renderer; this.scene = scene; this.terrain = terrain;
        this.dims = dims; this.h = texel; this.reach = reach; this.d0 = falloff; this.budgetMs = budgetMs;
        if(renderer.library.getLightNodeClass(GlowVolumeLight) === null) renderer.library.addLight(GlowVolumeNode, GlowVolumeLight);
        let [nx, ny, nz] = dims, n = nx * ny * nz;
        this.front = new Accumulator(dims);
        this.back = new Accumulator(dims);
        this.bytesA = new Uint8Array(n * 4);
        this.bytesB = new Uint8Array(n * 4);
        for(let i = 0; i < n; i++) { this.bytesA[i * 4 + 3] = 255; this.bytesB[i * 4] = this.bytesB[i * 4 + 1] = this.bytesB[i * 4 + 2] = 128; this.bytesB[i * 4 + 3] = 255; }
        let make = (bytes) => {
            let t = new THREE.Data3DTexture(bytes, nx, ny, nz);
            t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
            t.minFilter = t.magFilter = THREE.LinearFilter;
            t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
            t.generateMipmaps = false; t.unpackAlignment = 1;
            // partial uploads: the WebGPU backend uploads only these z slices when the set is not empty
            t.layerUpdates = new Set();
            t.addLayerUpdate = (k) => t.layerUpdates.add(k);
            t.clearLayerUpdates = () => t.layerUpdates.clear();
            t.needsUpdate = true;
            return t;
        };
        this.light = new GlowVolumeLight();
        this.light.textureA = make(this.bytesA);
        this.light.textureB = make(this.bytesB);
        this.light.texel = texel;
        this.light.intensity = intensity;
        this.light.size.set(nx * texel, ny * texel, nz * texel);
        this.light.frustumCulled = false;
        scene.add(this.light);
        this.rocks = new Map();      // id -> { x, y, z, radius, r, g, b, lum, depth, rec }   (rec: what is splatted in the front, or null)
        this.needDepth = new Set();  // ids waiting for an occlusion map
        this.dirty = null;           // texel box of the front that changed since the last upload [i0, j0, k0, i1, j1, k1]
        this.rebuild = null;         // { list, at, done: Set } while the back is being filled for a new window
        this.placed = false;
        this.ray = new THREE.Ray();
        this.stats = { depthMaps: 0, splats: 0, uploads: 0, rebuilds: 0 };
    }

    // ---- rocks ------------------------------------------------------------------

    /** Add or update a rock. `color` is a THREE.Color (linear); `power` scales its light (exposure). */
    setRock(id, x, y, z, radius, color, power) {
        let r = this.rocks.get(id);
        let lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
        if(r && r.x === x && r.y === y && r.z === z && Math.abs(r.power - power) < 0.01) return;
        let moved = !r || r.x !== x || r.y !== y || r.z !== z;
        if(!r) { r = { id, depth: null, rec: null }; this.rocks.set(id, r); if(this.rebuild) this.rebuild.list.push(r); }
        Object.assign(r, { x, y, z, radius, power, r: color.r * power, g: color.g * power, b: color.b * power, lum: lum * power });
        if(moved) { r.depth = null; this.needDepth.add(id); }
        else this.commit(r);
    }

    removeRock(id) {
        let r = this.rocks.get(id);
        if(!r) return;
        this.rocks.delete(id); this.needDepth.delete(id);
        if(r.rec) this.apply(r, r.rec, -1);
        r.rec = null;
    }

    clear() { for(let id of [...this.rocks.keys()]) this.removeRock(id); }

    /** A chunk changed: the rocks whose light reaches into it need new occlusion maps. */
    chunkChanged(box) {
        let R = this.reach + 1; // the light stands off the rock by up to half a metre
        for(let r of this.rocks.values()) {
            if(r.x + R < box.min.x || r.x - R > box.max.x || r.y + R < box.min.y || r.y - R > box.max.y || r.z + R < box.min.z || r.z - R > box.max.z) continue;
            this.needDepth.add(r.id);
        }
    }

    /** Replace what the front holds for a rock with its current state. */
    commit(r) {
        let rec = r.depth ? { x: r.x, y: r.y, z: r.z, lx: r.lx, ly: r.ly, lz: r.lz, r: r.r, g: r.g, b: r.b, lum: r.lum, depth: r.depth } : null;
        if(r.rec) this.apply(r, r.rec, -1);
        r.rec = rec;
        if(rec) this.apply(r, rec, 1);
    }

    /** Splat a record into the front, and into the back if a rebuild has already passed this rock (one it has not
     *  reached yet gets whatever record the rock has when it does). */
    apply(r, rec, sign) {
        this.splat(this.front, rec, sign, true);
        if(this.rebuild && this.rebuild.done.has(r.id)) this.splat(this.back, rec, sign, false);
    }

    // ---- occlusion --------------------------------------------------------------

    /** First wall along each direction from `o` (0 where the ray starts in solid), capped at the reach. */
    castAll(bvhs, ox, oy, oz, dirs, start, out) {
        let R = this.reach, ray = this.ray;
        for(let i = 0; i < dirs.length; i++) {
            let d = dirs[i];
            ray.origin.set(ox + d[0] * start, oy + d[1] * start, oz + d[2] * start);
            ray.direction.set(d[0], d[1], d[2]);
            let best = R, back = false;
            for(let b of bvhs) {
                let hit = b.raycastFirst(ray, THREE.DoubleSide, 0, best);
                if(hit && hit.distance < best) { best = hit.distance; let n = hit.face.normal; back = n.x * d[0] + n.y * d[1] + n.z * d[2] > 0; }
            }
            out[i] = back ? 0 : best + start;
        }
        return out;
    }

    /** Place the rock's light and map what it can see. The light sits a little way out of the wall, toward where the
     *  rock looks out (the mean of a coarse set of directions from its centre, weighted by how open they are): a source
     *  flush with the wall lights that wall only at grazing angles, and a crystal should throw a halo on the rock around
     *  it. From there, the distance to the first wall in each of the OCT x OCT directions is the occlusion map. */
    depthMap(r) {
        let R = this.reach, box = new THREE.Box3(new THREE.Vector3(r.x - R - 1, r.y - R - 1, r.z - R - 1), new THREE.Vector3(r.x + R + 1, r.y + R + 1, r.z + R + 1));
        let bvhs = [];
        for(let key of this.terrain.intersecting(box)) { let b = this.terrain.bvh(key); if(b) bvhs.push(b); }
        let coarse = this.castAll(bvhs, r.x, r.y, r.z, COARSE_DIRS, r.radius + 0.02, new Float32Array(COARSE_DIRS.length));
        let ox = 0, oy = 0, oz = 0;
        for(let i = 0; i < COARSE_DIRS.length; i++) { let w = coarse[i] / R, d = COARSE_DIRS[i]; ox += d[0] * w; oy += d[1] * w; oz += d[2] * w; }
        let l = Math.hypot(ox, oy, oz), k = l > 1e-3 ? (r.radius + STANDOFF) / l : 0;
        r.lx = r.x + ox * k; r.ly = r.y + oy * k; r.lz = r.z + oz * k;
        let out = this.castAll(bvhs, r.lx, r.ly, r.lz, OCT_DIRS, 0.01, new Float32Array(OCT * OCT));
        this.stats.depthMaps++;
        return out;
    }

    /** Is a rock's own chunk held? A rock in a chunk the client does not hold (a sealed pocket elsewhere) has nothing
     *  to block its rays, and would light the tunnel next to it through the wall. */
    held(r) {
        let e = r.radius;
        return this.terrain.intersecting(new THREE.Box3(new THREE.Vector3(r.x - e, r.y - e, r.z - e), new THREE.Vector3(r.x + e, r.y + e, r.z + e))).some(k => this.terrain.bvh(k));
    }

    // ---- splatting --------------------------------------------------------------

    falloff(d) { let s = d / this.reach, t = 1 - s * s; return t * t / (1 + (d / this.d0) ** 2); }

    splat(acc, rec, sign, markDirty) {
        let h = this.h, R = this.reach, R2 = R * R, [nx, ny, nz] = acc.dims, o = acc.origin, a = acc.data;
        let i0 = Math.max(0, Math.ceil((rec.lx - R - o[0]) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((rec.lx + R - o[0]) / h - 0.5));
        let j0 = Math.max(0, Math.ceil((rec.ly - R - o[1]) / h - 0.5)), j1 = Math.min(ny - 1, Math.floor((rec.ly + R - o[1]) / h - 0.5));
        let k0 = Math.max(0, Math.ceil((rec.lz - R - o[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((rec.lz + R - o[2]) / h - 0.5));
        if(i0 > i1 || j0 > j1 || k0 > k1) return;
        let depth = rec.depth;
        for(let k = k0; k <= k1; k++) {
            let vz = o[2] + (k + 0.5) * h - rec.lz;
            for(let j = j0; j <= j1; j++) {
                let vy = o[1] + (j + 0.5) * h - rec.ly, row = (k * ny + j) * nx;
                for(let i = i0; i <= i1; i++) {
                    let vx = o[0] + (i + 0.5) * h - rec.lx, d2 = vx * vx + vy * vy + vz * vz;
                    if(d2 > R2) continue;
                    let d = Math.sqrt(d2), vis = 1;
                    if(d > 1e-3) {
                        vis = (octDepth(depth, vx, vy, vz) + SLACK + SOFT - d) / SOFT;
                        if(vis <= 0) continue;
                        if(vis > 1) vis = 1;
                    }
                    let w = sign * vis * this.falloff(d), t = (row + i) * 7, lw = rec.lum * w, inv = d > 1e-3 ? lw / d : 0;
                    a[t] += rec.r * w; a[t + 1] += rec.g * w; a[t + 2] += rec.b * w;
                    a[t + 3] -= vx * inv; a[t + 4] -= vy * inv; a[t + 5] -= vz * inv; a[t + 6] += lw;
                }
            }
        }
        this.stats.splats++;
        if(markDirty) {
            let b = this.dirty;
            if(!b) this.dirty = [i0, j0, k0, i1, j1, k1];
            else { b[0] = Math.min(b[0], i0); b[1] = Math.min(b[1], j0); b[2] = Math.min(b[2], k0); b[3] = Math.max(b[3], i1); b[4] = Math.max(b[4], j1); b[5] = Math.max(b[5], k1); }
        }
    }

    /** Front texels in a box -> texture bytes; the slices go up with the next render. */
    encode(box) {
        let [nx, ny] = this.dims, a = this.front.data, A = this.bytesA, B = this.bytesB, inv = 1 / this.light.maxValue;
        let [i0, j0, k0, i1, j1, k1] = box;
        for(let k = k0; k <= k1; k++) {
            for(let j = j0; j <= j1; j++) for(let i = i0; i <= i1; i++) {
                let v = (k * ny + j) * nx + i, t = v * 7, p = v * 4;
                A[p] = Math.round(Math.sqrt(Math.min(1, Math.max(0, a[t] * inv))) * 255);
                A[p + 1] = Math.round(Math.sqrt(Math.min(1, Math.max(0, a[t + 1] * inv))) * 255);
                A[p + 2] = Math.round(Math.sqrt(Math.min(1, Math.max(0, a[t + 2] * inv))) * 255);
                let w = a[t + 6];
                if(w > 1e-5) {
                    B[p] = Math.round(Math.min(1, Math.max(-1, a[t + 3] / w)) * 127.5 + 127.5);
                    B[p + 1] = Math.round(Math.min(1, Math.max(-1, a[t + 4] / w)) * 127.5 + 127.5);
                    B[p + 2] = Math.round(Math.min(1, Math.max(-1, a[t + 5] / w)) * 127.5 + 127.5);
                } else { B[p] = B[p + 1] = B[p + 2] = 128; }
            }
            this.light.textureA.addLayerUpdate(k); this.light.textureB.addLayerUpdate(k);
        }
        this.light.textureA.needsUpdate = true; this.light.textureB.needsUpdate = true;
        this.stats.uploads++;
    }

    // ---- per frame ---------------------------------------------------------------

    /** Lattice-aligned window origin centred on a point. */
    originFor(p) {
        let h = this.h, step = h * 4, [nx, ny, nz] = this.dims;
        return [Math.round((p.x - nx * h / 2) / step) * step, Math.round((p.y - ny * h / 2) / step) * step, Math.round((p.z - nz * h / 2) / step) * step];
    }

    /** Has the camera left the middle half (horizontally) / middle third (vertically) of the window? */
    offCentre(p) {
        let o = this.front.origin, h = this.h, [nx, ny, nz] = this.dims;
        return Math.abs(p.x - (o[0] + nx * h / 2)) > nx * h / 4 || Math.abs(p.z - (o[2] + nz * h / 2)) > nz * h / 4 || Math.abs(p.y - (o[1] + ny * h / 2)) > ny * h / 6;
    }

    inWindow(acc, r) {
        let o = acc.origin, R = this.reach, h = this.h, [nx, ny, nz] = this.dims;
        return r.x + R > o[0] && r.x - R < o[0] + nx * h && r.y + R > o[1] && r.y - R < o[1] + ny * h && r.z + R > o[2] && r.z - R < o[2] + nz * h;
    }

    update(camera) {
        let t0 = performance.now(), p = camera.position, budget = this.budgetMs;
        if(!this.placed) {
            // first placement: an empty front can simply move
            this.front.origin = this.originFor(p);
            this.light.origin.set(...this.front.origin);
            this.placed = true;
        } else if(!this.rebuild && this.offCentre(p)) {
            this.back.origin = this.originFor(p);
            this.back.data.fill(0);
            this.rebuild = { list: [...this.rocks.values()], at: 0, done: new Set() };
            this.stats.rebuilds++;
        }
        // occlusion maps for the rocks that need one, nearest first (a few dozen distance checks a frame is nothing)
        // (rocks outside both windows wait in the set until a window reaches them)
        if(this.needDepth.size) {
            let cand = [];
            for(let id of this.needDepth) {
                let r = this.rocks.get(id);
                if(!r) { this.needDepth.delete(id); continue; }
                if(this.inWindow(this.front, r) || (this.rebuild && this.inWindow(this.back, r))) cand.push(r);
            }
            cand.sort((a, b) => ((a.x - p.x) ** 2 + (a.y - p.y) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 + (b.z - p.z) ** 2));
            for(let r of cand) {
                if(performance.now() - t0 > budget) break;
                this.needDepth.delete(r.id);
                r.depth = this.held(r) ? this.depthMap(r) : null;   // not held: dark until its chunk arrives (chunkChanged)
                this.commit(r);
            }
        }
        // fill the back for the new window, then swap
        if(this.rebuild) {
            let rb = this.rebuild;
            while(rb.at < rb.list.length && performance.now() - t0 < budget * 2) {
                let r = rb.list[rb.at++];
                if(!this.rocks.has(r.id)) continue;
                rb.done.add(r.id);
                if(r.rec) this.splat(this.back, r.rec, 1, false);
                else if(!r.depth) this.needDepth.add(r.id);
            }
            if(rb.at >= rb.list.length) {
                let f = this.front; this.front = this.back; this.back = f;
                this.rebuild = null;
                this.light.origin.set(...this.front.origin);
                let [nx, ny, nz] = this.dims;
                this.dirty = null;
                this.light.textureA.layerUpdates.clear(); this.light.textureB.layerUpdates.clear();
                this.encode([0, 0, 0, nx - 1, ny - 1, nz - 1]);
                this.light.textureA.layerUpdates.clear(); this.light.textureB.layerUpdates.clear(); // all of it: the plain full upload
            }
        }
        if(this.dirty) { this.encode(this.dirty); this.dirty = null; }
    }

    dispose() {
        this.scene.remove(this.light);
        this.light.textureA.dispose(); this.light.textureB.dispose();
    }
}
