/** Vertex GI, the GPU half (the CPU half, refinement, records and scheduling, is giCore.js; read its comment first).
 *
 *  Rays: three-mesh-bvh's BVHComputeData packs the coarse chunk meshes (the collision meshes TerrainMirror already
 *  builds, each with its own BVH, so only a changed chunk's BVH is rebuilt; the top level is a ClusteredBVH over them)
 *  into storage buffers, and its `raycastFirstHit` runs in a compute pass. Every frame a fixed budget of records (jobs)
 *  each take one cosine-distributed ray (`giSample`): one that leaves the level sees the sky (a gradient fitted to the
 *  atmosphere's hemisphere irradiance and horizon), one that hits a surface sees its albedo times the sun there (a
 *  shadow ray) plus its own cached indirect light (the hit triangle's corner records, interpolated), so every pass adds
 *  a bounce; a back face means the ray started inside rock and sees black. The result goes into the record's sum and
 *  count (an exponential average past `maxSamples`).
 *
 *  The packed BVH is rebuilt in full by `update()` (a TODO in three-mesh-bvh), so it is refreshed at most once a
 *  second while the terrain changes, and a chunk is not sampled until the packed BVH has its current geometry: a new
 *  surface would otherwise trace from inside the old solid.
 *
 *  Display: each render vertex carries its record (`rec`); the terrain material reads the record in the vertex stage
 *  and adds mean * weight * giScale as indirect diffuse, the probe grid fading out by the same weight (terrainMaterial.js,
 *  ProbeLighting.js). Nothing is uploaded per frame but the jobs (4 bytes each), the new records' positions and the ops.
 *
 *  `?vgi=0` disables it (the probe grid lights the terrain as before); `?girays=<n>` sets the jobs per frame (32768,
 *  4096 on mobile); `?tridebug=7` shows the gathered light unlit, `?tridebug=8` the weight. */
import * as THREE from 'three/webgpu';
import { Fn, If, instanceIndex, storage, uniform, attribute, varying, vec3, vec4, float, uint, min, max, select } from 'three/tsl';
import { BVHComputeData, rayStruct, rayIntersectionResultStruct, wgslTagFn } from 'three-mesh-bvh/webgpu';
import { GICore, OP_INIT, NO_RECORD } from './giCore.js';
import { G } from '../sky/Globals.js';
import { CHUNK_SIZE, isRockKey } from '../terrain/grid.js';

export class TerrainGI {
    static supported(renderer) { return !!(renderer.backend && renderer.backend.isWebGPUBackend); }

    constructor(renderer, scene, terrain, materials, { mobile = false, jobs, layersOf = null } = {}) {
        this.renderer = renderer; this.scene = scene; this.terrain = terrain; this.materials = materials;
        this.layersOf = layersOf;                     // () => average linear colour per texture layer, or null
        // a phone gets half the records and a coarser base mesh (Twin Forts: ~97k records at 2 m, of 131k)
        this.core = new GICore(mobile ? { capacity: 1 << 17, maxEdge: 3 } : { capacity: 1 << 18 });
        let C = this.core.p.capacity, R = this.core.records;
        this.maxJobs = jobs || (mobile ? 4096 : 32768);
        this.maxOps = 16384;
        this.maxDistance = 120;
        // records: position and normal (CPU-written, two vec4s each), sum and count, sample sequence (GPU-written). The
        // gather pass may bind 8 storage buffers (WebGPU's default, and many phones' limit): these four, the jobs, and
        // the BVH's four; the sun and sky go in as uniforms.
        this.geoAttr = new THREE.StorageBufferAttribute(R.geo, 4);
        this.stateAttr = new THREE.StorageBufferAttribute(new Float32Array(C * 4), 4);
        this.seqAttr = new THREE.StorageBufferAttribute(new Uint32Array(C), 1);
        this.jobsAttr = new THREE.StorageBufferAttribute(new Uint32Array(this.maxJobs), 1);
        this.opsAttr = new THREE.StorageBufferAttribute(new Uint32Array(this.maxOps * 4), 4);
        this.geo = storage(this.geoAttr, 'vec4', C * 2).toReadOnly();
        this.state = storage(this.stateAttr, 'vec4', C);
        this.stateRead = storage(this.stateAttr, 'vec4', C).toReadOnly(); // the vertex stage may only read
        this.seq = storage(this.seqAttr, 'uint', C);
        this.jobs = storage(this.jobsAttr, 'uint', this.maxJobs).toReadOnly();
        this.ops = storage(this.opsAttr, 'uvec4', this.maxOps).toReadOnly();
        this.uSun = uniform(new THREE.Vector4(0.3, 0.8, -0.5, this.maxDistance)); // direction to the sun, ray length
        this.uSunE = uniform(new THREE.Vector3(8, 8, 8));    // sun irradiance
        this.uSkyZ = uniform(new THREE.Vector3());           // sky radiance at the zenith ...
        this.uSkyH = uniform(new THREE.Vector3());           // ... and at the horizon
        this.uGround = uniform(new THREE.Vector3());         // the plain beyond the level
        this.uE0 = uniform(new THREE.Vector3());             // what an unsampled record stands in with
        this.jobCount = uniform(0, 'uint');
        this.opCount = uniform(0, 'uint');
        this.maxSamples = uniform(this.core.p.maxSamples);
        this.giScale = uniform(10);
        // the BVH: a proxy mesh per chunk sharing the collision geometry (and its BVH), not in the scene
        this.proxies = new Map();     // key -> Mesh
        this.bvh = new BVHComputeData([], { attributes: { position: 'vec4f', surface: 'vec4f' } });
        this.bvhDirty = false; this.bvhAt = 0; this.bvhReady = false; this.bvhEpoch = 0;
        this.pendingReady = new Set(); // chunks waiting for the packed BVH to include them
        this.classes = new Map();     // "r,g,b,slot,tile" -> material class (render vertices of different classes are not shared)
        this.classList = [];
        this.staged = [];             // chunks waiting for a readback to decide adaptive splits
        this.readbackAt = 0; this.reading = false;
        this.stats = { jobs: 0, ops: 0, bvhUpdates: 0, bvhMs: 0, readbacks: 0, chunks: 0 };
        this.buildOps();
        this.attachMaterials();
        terrain.onGeometry = (key, geometry) => this.onGeometry(key, geometry);
        for(let [key, mesh] of terrain.objects) this.onGeometry(key, mesh.geometry); // chunks that arrived before us
    }

    // ---- shaders --------------------------------------------------------------------

    /** The gather pass. Built after every BVH update: three-mesh-bvh's proxies resolve to the packed buffers of the
     *  moment a node is built, and update() makes new ones (the WGSL is the same, so the pipeline comes from the cache). */
    buildGather() {
        let { geo, state, seq, jobs, bvh } = this;
        let attrs = bvh.storage.attributes, raycast = bvh.fns.raycastFirstHit;
        // an unsampled record (or a plane triangle's corner) stands in with half the open sky
        const cached = wgslTagFn/* wgsl */`
            // fn
            fn giCached( r: f32, e0: vec3f ) -> vec3f {
                if ( r < 0.0 ) { return e0; }
                let s = ${ state }[ u32( r ) ];
                if ( s.w < 1.0 ) { return e0; }
                return s.xyz / s.w;
            }
        `;
        // one sample of the irradiance at a record: pi times the radiance from one cosine-distributed direction
        this.sampleFn = wgslTagFn/* wgsl */`
            // fn
            fn giSample( id: u32, n0: u32, sun: vec4f, sunE: vec3f, skyZ: vec3f, skyH: vec3f, ground: vec3f, e0: vec3f ) -> vec3f {
                let P = ${ geo }[ id * 2u ];
                let N = ${ geo }[ id * 2u + 1u ];
                let n = normalize( N.xyz );
                let k = f32( n0 );
                let u1 = fract( P.w + k * 0.7548776662466927 );
                let u2 = fract( N.w + k * 0.5698402909980532 );
                let sg = select( -1.0, 1.0, n.z >= 0.0 );
                let a = -1.0 / ( sg + n.z );
                let b = n.x * n.y * a;
                let t = vec3f( 1.0 + sg * n.x * n.x * a, sg * b, -sg * n.x );
                let bt = vec3f( b, sg + n.y * n.y * a, -n.y );
                let r = sqrt( u1 );
                let phi = 6.283185307179586 * u2;
                let d = normalize( t * ( r * cos( phi ) ) + bt * ( r * sin( phi ) ) + n * sqrt( max( 0.0, 1.0 - u1 ) ) );
                var ray: ${ rayStruct };
                ray.origin = P.xyz + n * 0.004;
                ray.direction = d;
                ray.maxDist = sun.w;
                var hit: ${ rayIntersectionResultStruct };
                ${ raycast }( ray, &hit );
                if ( ! hit.didHit ) {
                    if ( d.y >= 0.0 ) {
                        let h = pow( 1.0 - d.y, 3.0 );
                        return 3.141592653589793 * mix( skyZ, skyH, h );
                    }
                    return 3.141592653589793 * ground;
                }
                if ( hit.side < 0.0 ) { return vec3f( 0.0 ); }
                let sa = ${ attrs }[ hit.indices.x ].surface;
                let sb = ${ attrs }[ hit.indices.y ].surface;
                let sc = ${ attrs }[ hit.indices.z ].surface;
                let w = hit.barycoord;
                var light = w.x * ${ cached }( sa.x, e0 ) + w.y * ${ cached }( sb.x, e0 ) + w.z * ${ cached }( sc.x, e0 );
                let L = sun.xyz;
                let c = dot( hit.normal, L );
                if ( c > 0.0 ) {
                    var shadow: ${ rayStruct };
                    shadow.origin = ray.origin + d * hit.dist + hit.normal * 0.004;
                    shadow.direction = L;
                    shadow.maxDist = sun.w;
                    var blocked: ${ rayIntersectionResultStruct };
                    ${ raycast }( shadow, &blocked );
                    if ( ! blocked.didHit ) { light += sunE * c; }
                }
                return sa.yzw * light;
            }
        `;
        let sample = this.sampleFn, maxS = this.maxSamples, jobCount = this.jobCount;
        let old = this.gatherKernel;
        this.gatherKernel = Fn(() => {
            If(instanceIndex.lessThan(jobCount), () => {
                const id = jobs.element(instanceIndex).toVar();
                const n = seq.element(id).toVar();
                const e = sample(id, n, this.uSun, this.uSunE, this.uSkyZ, this.uSkyH, this.uGround, this.uE0).toVar();
                seq.element(id).assign(n.add(uint(1)));
                const s = state.element(id).toVar();
                s.addAssign(vec4(e, 1.0));
                If(s.w.greaterThan(maxS), () => { s.mulAssign(maxS.div(s.w)); });
                state.element(id).assign(s);
            });
        })().compute(this.maxJobs).setName('TerrainGI gather');
        old?.dispose?.();
    }

    /** Initialise and knock back records (giCore's ops). */
    buildOps() {
        let { state, seq, ops, opCount } = this;
        this.opsKernel = Fn(() => {
            If(instanceIndex.lessThan(opCount), () => {
                const op = ops.element(instanceIndex).toVar();
                const id = op.y;
                If(op.x.equal(uint(OP_INIT)), () => {
                    If(op.z.equal(uint(NO_RECORD)), () => {
                        state.element(id).assign(vec4(0.0));
                    }).Else(() => {
                        // seeded from the edge's two ends: their mean, at a low weight
                        const sa = state.element(op.z).toVar(), sb = state.element(op.w).toVar();
                        const w = min(min(sa.w, sb.w), float(16)).mul(0.5);
                        const mean = sa.xyz.div(max(sa.w, 1.0)).add(sb.xyz.div(max(sb.w, 1.0))).mul(0.5);
                        state.element(id).assign(vec4(mean.mul(w), w));
                    });
                    seq.element(id).assign(uint(0));
                }).Else(() => {
                    // keep at most n samples' worth: the mean stays, its weight drops
                    const s = state.element(id).toVar(), n = float(op.z);
                    If(s.w.greaterThan(n), () => { state.element(id).assign(s.mul(n.div(s.w))); });
                });
            });
        })().compute(this.maxOps).setName('TerrainGI ops');
    }

    /** The terrain materials read their vertices' records (per vertex, interpolated). */
    attachMaterials() {
        let rec = attribute('rec', 'float'), wAt = this.core.p.weightAt;
        let st = this.stateRead.element(uint(max(rec, 0.0)));
        let giNode = varying(vec4(st.xyz.div(max(st.w, 1.0)), select(rec.greaterThanEqual(0.0), min(st.w.div(wAt), 1.0), 0.0)), 'vTerrainGI');
        for(let m of this.materials) {
            if(m.tridebug === 7) m.colorNode = giNode.xyz.mul(this.giScale).mul(0.25 / Math.PI);
            else if(m.tridebug === 8) m.colorNode = vec3(giNode.w);
            else if(m.tridebug >= 6) continue;
            else { m.giNode = giNode; m.giScale = this.giScale; }
            m.needsUpdate = true;
        }
    }

    // ---- chunks -----------------------------------------------------------------------

    classOf(r, g, b, slot, tile) {
        let key = `${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)},${slot},${tile}`;
        let k = this.classes.get(key);
        if(k === undefined) { k = this.classList.length; this.classes.set(key, k); this.classList.push([r, g, b, slot, tile]); }
        return k;
    }

    /** A chunk's collision geometry changed (or went): refine it, give TerrainMirror the render geometry, and put the
     *  coarse one (with each corner's record and albedo) in the BVH. */
    onGeometry(key, geometry) {
        let old = this.proxies.get(key);
        if(old) { this.proxies.delete(key); this.bvhDirty = true; }
        this.pendingReady.delete(key);
        if(!geometry) { this.core.removeChunk(key); return; }
        let A = geometry.attributes, I = geometry.index.array, nt = geometry.index.count / 3;
        let P = A.position.array, Nn = A.normal.array, U = A.uv ? A.uv.array : null, Cc = A.color.array, S = A.slot.array, T = A.tile.array;
        let pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9), uv = new Float32Array(nt * 6), cls = new Uint16Array(nt), alb = new Float32Array(nt * 3);
        let layers = this.layersOf ? this.layersOf() : null;
        for(let t = 0; t < nt; t++) {
            for(let k = 0; k < 3; k++) {
                let v = I[t * 3 + k];
                pos.set(P.subarray(v * 3, v * 3 + 3), t * 9 + k * 3); nrm.set(Nn.subarray(v * 3, v * 3 + 3), t * 9 + k * 3);
                if(U) { uv[t * 6 + k * 2] = U[v * 2]; uv[t * 6 + k * 2 + 1] = U[v * 2 + 1]; }
            }
            let v = I[t * 3], r = Cc[v * 3], g = Cc[v * 3 + 1], b = Cc[v * 3 + 2], slot = Math.round(S[v]), tile = T[v];
            cls[t] = this.classOf(r, g, b, slot, tile);
            let L = layers && slot >= 0 ? layers[slot] : null;
            alb[t * 3] = r * (L ? L[0] : 1); alb[t * 3 + 1] = g * (L ? L[1] : 1); alb[t * 3 + 2] = b * (L ? L[2] : 1);
        }
        let skip = this.hiddenOnPlanes(key, pos, nrm, nt);
        let ch = this.core.setChunk(key, geometry.uuid, { pos, nrm, uv: U ? uv : null, cls, skip });
        this.pushRender(ch);
        // the coarse geometry for the BVH: per vertex the record of that corner and the triangle's albedo
        let surface = new Float32Array(A.position.count * 4);
        for(let t = 0; t < nt; t++) for(let k = 0; k < 3; k++) {
            let v = I[t * 3 + k];
            surface[v * 4] = ch.coarseRec[t * 3 + k];
            surface[v * 4 + 1] = alb[t * 3]; surface[v * 4 + 2] = alb[t * 3 + 1]; surface[v * 4 + 3] = alb[t * 3 + 2];
        }
        geometry.setAttribute('surface', new THREE.BufferAttribute(surface, 4));
        let proxy = new THREE.Mesh(geometry);
        proxy.updateMatrixWorld();
        this.proxies.set(key, proxy);
        this.pendingReady.add(key);
        ch.ready = false;
        this.bvhDirty = true;
        this.stats.chunks = this.core.chunks.size;
    }

    /** Flags the triangles of a chunk that lie on one of its boundary planes and cannot be seen: facing into the chunk
     *  (a zero-thickness sheet, never real geometry), or facing out against solid in the next chunk (the cap where a
     *  solid crosses the plane; the next chunk has the matching one). A cap facing air is a real surface (Twin Forts has
     *  walls exactly on x = -40), as are the faces of untouched rock the server has us draw. The faces of the world box
     *  that look out of the bounds are skipped too: Twin Forts' outer skin is ~45k m², more than the level itself. */
    hiddenOnPlanes(key, pos, nrm, nt) {
        let [cx, cy, cz] = key.split(',').map(Number), min = [cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE], T = this.terrain;
        let skip = new Uint8Array(nt), c = [0, 0, 0];
        for(let t = 0; t < nt; t++) {
            let o = t * 9;
            for(let a = 0; a < 3; a++) for(let side = 0; side < 2; side++) {
                let s = min[a] + side * CHUNK_SIZE;
                if(Math.abs(pos[o + a] - s) > 1e-3 || Math.abs(pos[o + 3 + a] - s) > 1e-3 || Math.abs(pos[o + 6 + a] - s) > 1e-3) continue;
                let out = side === 0 ? -1 : 1, facing = (nrm[o + a] + nrm[o + 3 + a] + nrm[o + 6 + a]) * out;
                if(facing <= 0) { skip[t] = 1; continue; }
                for(let k = 0; k < 3; k++) c[k] = (pos[o + k] + pos[o + 3 + k] + pos[o + 6 + k]) / 3;
                c[a] = s + out * 0.02;
                let nk = [cx, cy, cz]; nk[a] += out;
                let b = T.world.bounds;
                if(nk[a] < b.min[a] || nk[a] > b.max[a]) { skip[t] = 1; continue; } // the outside of the world box: nobody looks at it
                skip[t] = this.solidAt(nk.join(','), c, a, out) ? 1 : 0;
            }
        }
        return skip;
    }

    /** Is the next chunk solid just past this point of a shared plane (axis `a`, coordinate `p[a]`, approached from the
     *  side `out` points away from)? A held modified chunk is solid there when it has its own cap on that plane facing
     *  back at us that covers the point (its full decoded mesh: the drawn one may have culled faces); an empty held chunk
     *  is air; anything else is what the world config says (implicit rock or air). */
    solidAt(key, p, a, out) {
        let T = this.terrain;
        if(T.rockMask.has(key) || T.pending.has(key)) return true; // (a chunk still on its way: most caps are hidden)
        let mesh = T.meshes.get(key);
        if(!mesh) return T.versions.has(key) ? false : isRockKey(T.world, key);
        let caps = this.capsOf(key, mesh, a, p[a], -out), u = (a + 1) % 3, v = (a + 2) % 3, x = p[u], y = p[v];
        for(let i = 0; i < caps.length; i += 6) {
            let ax = caps[i], ay = caps[i + 1], bx = caps[i + 2], by = caps[i + 3], cx = caps[i + 4], cy = caps[i + 5];
            let d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by), d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy), d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
            if(!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
        }
        return false;
    }

    /** A chunk mesh's triangles on a plane (axis `a` = `s`) whose normal points along `dir` on that axis, as 2D triangles
     *  in the plane's other two axes; cached per mesh. */
    capsOf(key, mesh, a, s, dir) {
        let cache = mesh._caps || (mesh._caps = new Map()), ck = `${a},${s},${dir}`;
        let list = cache.get(ck);
        if(list) return list;
        let P = mesh.positions, I = mesh.indices, u = (a + 1) % 3, v = (a + 2) % 3, out = [];
        for(let t = 0; t < I.length; t += 3) {
            let i0 = I[t] * 3, i1 = I[t + 1] * 3, i2 = I[t + 2] * 3;
            if(Math.abs(P[i0 + a] - s) > 1e-3 || Math.abs(P[i1 + a] - s) > 1e-3 || Math.abs(P[i2 + a] - s) > 1e-3) continue;
            // the normal's component on the axis, from the winding
            let e1u = P[i1 + u] - P[i0 + u], e1v = P[i1 + v] - P[i0 + v], e2u = P[i2 + u] - P[i0 + u], e2v = P[i2 + v] - P[i0 + v];
            if((e1u * e2v - e1v * e2u) * dir <= 0) continue;
            out.push(P[i0 + u], P[i0 + v], P[i1 + u], P[i1 + v], P[i2 + u], P[i2 + v]);
        }
        cache.set(ck, out);
        return out;
    }

    /** A carve changed a region: the records around it re-converge (the chunk itself was re-refined by onGeometry). */
    changed(box) { this.core.knockAround(box); }

    // ---- per frame --------------------------------------------------------------------

    /** Sun and sky for the rays, from the key light and the atmosphere's readbacks (DayCycle). */
    setLighting(sunDir, sunE, skyIrr, horizon) {
        // L(y) = Lz + (Lh - Lz)(1 - y)^3 above the horizon, whose cosine-weighted mean (Lz + 0.1 (Lh - Lz)) is the
        // atmosphere's hemisphere irradiance / pi
        let Lz = [0, 1, 2].map(i => Math.max(0, (skyIrr[i] - 0.1 * horizon[i]) / 0.9)), up = Math.max(0, sunDir[1]), g = 0.3 / Math.PI;
        this.uSun.value.set(sunDir[0], sunDir[1], sunDir[2], this.maxDistance);
        this.uSunE.value.set(sunE[0], sunE[1], sunE[2]);
        this.uSkyZ.value.set(Lz[0], Lz[1], Lz[2]);
        this.uSkyH.value.set(horizon[0], horizon[1], horizon[2]);
        this.uGround.value.set(...[0, 1, 2].map(i => g * (sunE[i] * up + Math.PI * skyIrr[i])));
        this.uE0.value.set(...[0, 1, 2].map(i => Math.PI * skyIrr[i] * 0.5));
    }

    /** Once per frame, after the day cycle: the sun, the sky and the probes' multiplier, then the work. */
    tick(world) {
        let sun = world.dirLight, d = sun.position.clone().normalize(), k = sun.intensity;
        let irr = G.skyIrradiance.value, hz = G.horizonColor.value;
        this.setLighting([d.x, d.y, d.z], [sun.color.r * k, sun.color.g * k, sun.color.b * k], [irr.r, irr.g, irr.b], [hz.r, hz.g, hz.b]);
        this.giScale.value = world.probes ? world.probes.ambient : 10;
        this.update(world.camera);
    }

    update(camera) {
        if(this.renderer.initialized === false) return;
        let now = performance.now(), core = this.core, R = core.records;
        // the packed BVH, at most once a second, once the chunks arriving in a burst have settled
        if(this.bvhDirty && this.proxies.size && now - this.bvhAt > 1000) {
            let t0 = performance.now();
            this.bvh.objects = [...this.proxies.values()];
            try {
                this.bvh.update();
                this.buildGather();
                this.bvhReady = true; this.bvhEpoch++;
                for(let key of this.pendingReady) { let ch = core.chunks.get(key); if(ch) ch.ready = true; }
                this.pendingReady.clear();
            } catch(e) { console.warn('TerrainGI: BVH update failed: ' + e.message); }
            this.bvhDirty = false; this.bvhAt = now;
            this.stats.bvhUpdates++; this.stats.bvhMs = performance.now() - t0;
        }
        // new records' positions and normals, then the ops (initialise, knock back), then the rays
        let dirty = R.takeDirty();
        if(dirty) {
            let [lo, hi] = dirty;
            let a = this.geoAttr; a.clearUpdateRanges(); a.addUpdateRange(lo * 8, (hi - lo + 1) * 8); a.needsUpdate = true;
        }
        let ops = R.takeOps();
        for(let at = 0; at < ops.length; at += this.maxOps * 4) {
            let part = ops.slice(at, at + this.maxOps * 4), n = part.length / 4;
            this.opsAttr.array.set(part);
            this.opsAttr.clearUpdateRanges(); this.opsAttr.addUpdateRange(0, part.length); this.opsAttr.needsUpdate = true;
            this.opCount.value = n;
            this.renderer.compute(this.opsKernel, n);
            this.stats.ops += n;
        }
        if(!this.bvhReady) return;
        let { count, staged } = core.schedule(this.jobsAttr.array, camera.position);
        for(let ch of staged) this.staged.push(ch);
        if(count > 0) {
            this.jobsAttr.clearUpdateRanges(); this.jobsAttr.addUpdateRange(0, count); this.jobsAttr.needsUpdate = true;
            this.jobCount.value = count;
            this.renderer.compute(this.gatherKernel, count);
            this.stats.jobs += count;
        }
        // adaptive splits need the sums: read them back now and then
        if(this.staged.length && !this.reading && now - this.readbackAt > 2000) this.readback();
    }

    async readback() {
        this.reading = true; this.readbackAt = performance.now();
        try {
            let buf = await this.renderer.getArrayBufferAsync(this.stateAttr);
            let state = new Float32Array(buf), list = this.staged; this.staged = [];
            this.stats.readbacks++;
            let redo = new Set();
            for(let ch of list) {
                if(this.core.chunks.get(ch.key) !== ch) continue; // replaced since
                for(let c of this.core.adapt(ch, state)) redo.add(c);
            }
            for(let c of redo) this.pushRender(c);
        } catch(e) { console.warn('TerrainGI: readback failed: ' + e.message); }
        this.reading = false;
    }

    /** Hand TerrainMirror a chunk's refined render geometry (after onGeometry, or an adaptive pass: same coarse geometry
     *  and corner records, more vertices). */
    pushRender(ch) {
        let n = ch.cls.length, col = new Float32Array(n * 3), slot = new Float32Array(n), tile = new Float32Array(n), rec = new Float32Array(n);
        for(let i = 0; i < n; i++) {
            let c = this.classList[ch.cls[i]];
            col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; slot[i] = c[3]; tile[i] = c[4]; rec[i] = ch.recOf[i];
        }
        let g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(ch.positions, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(ch.uvs, 2));
        g.setAttribute('slot', new THREE.BufferAttribute(slot, 1));
        g.setAttribute('tile', new THREE.BufferAttribute(tile, 1));
        g.setAttribute('normal', new THREE.BufferAttribute(ch.normals, 3));
        g.setAttribute('rec', new THREE.BufferAttribute(rec, 1));
        g.setIndex(new THREE.BufferAttribute(ch.index, 1));
        this.terrain.setRenderGeometry(ch.key, g);
    }

    info() {
        let c = this.core, n = 0, ready = 0, minS = Infinity;
        for(let ch of c.chunks.values()) { n += ch.recs.length; if(ch.ready) ready++; if(ch.recs.length) minS = Math.min(minS, ch.minSamples); }
        return { chunks: c.chunks.size, ready, records: c.records.size, refs: n, full: c.records.full, minSamples: minS, splits: c.splitEdges.size, ...this.stats, refineMs: Math.round(c.stats.refineMs) };
    }
}
