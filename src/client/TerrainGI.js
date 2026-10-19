/** Vertex GI, the main thread's half: the GPU (buffers, passes, the packed BVH) and TerrainMirror. The CPU half
 *  (refinement, records, adaptive splits, scheduling, light seeding, crystal bookkeeping: giCore.js, read its comment
 *  first) runs in a worker (giHost.js / giWorker.js), or on this thread if a worker cannot start; they talk in messages.
 *  A chunk's refined mesh therefore arrives a frame or two after its coarse geometry: TerrainMirror keeps drawing what
 *  it drew before a carve until then (`deferDraw`), so a dig never flashes the probe grid's light.
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
import { BVHComputeData, rayStruct, rayIntersectionResultStruct, bvhNodeStruct, wgslTagFn } from 'three-mesh-bvh/webgpu';
import { GI_DEFAULTS, OP_INIT, NO_RECORD } from './giCore.js';
import { GIHost } from './giHost.js';
import { G } from '../sky/Globals.js';
import { CHUNK_SIZE, isRockKey } from '../terrain/grid.js';

export class TerrainGI {
    static supported(renderer) { return !!(renderer.backend && renderer.backend.isWebGPUBackend); }

    constructor(renderer, scene, terrain, materials, { mobile = false, jobs, layersOf = null } = {}) {
        this.renderer = renderer; this.scene = scene; this.terrain = terrain; this.materials = materials;
        this.layersOf = layersOf;                     // () => average linear colour per texture layer, or null
        // a phone gets half the records and a coarser base mesh (Twin Forts: ~97k records at 2 m, of 131k)
        let params = mobile ? { capacity: 1 << 17, maxEdge: 3 } : { capacity: 1 << 18 }, C = params.capacity;
        this.p = { ...GI_DEFAULTS, ...params };
        this.maxJobs = jobs || (mobile ? 4096 : 32768);
        this.maxOps = 16384;
        this.maxDistance = 120;
        // records: position and normal (written by the worker, mirrored here; two vec4s each), light (two vec4s: [sum of
        // the gathered irradiance, count], [the crystals' baked light, 0]) and sample sequence (GPU-written). The gather
        // pass may bind 8 storage buffers (WebGPU's default, and many phones' limit): these four, the jobs, and the
        // BVH's four; the sun and sky go in as uniforms.
        this.geoAttr = new THREE.StorageBufferAttribute(new Float32Array(C * 8), 4);
        this.stateAttr = new THREE.StorageBufferAttribute(new Float32Array(C * 8), 4);
        this.seqAttr = new THREE.StorageBufferAttribute(new Uint32Array(C), 1);
        this.jobsAttr = new THREE.StorageBufferAttribute(new Uint32Array(this.maxJobs), 1);
        this.opsAttr = new THREE.StorageBufferAttribute(new Uint32Array(this.maxOps * 4), 4);
        this.geo = storage(this.geoAttr, 'vec4', C * 2).toReadOnly();
        this.state = storage(this.stateAttr, 'vec4', C * 2);
        this.stateRead = storage(this.stateAttr, 'vec4', C * 2).toReadOnly(); // the vertex stage may only read
        this.seq = storage(this.seqAttr, 'uint', C);
        this.jobs = storage(this.jobsAttr, 'uint', this.maxJobs).toReadOnly();
        this.ops = storage(this.opsAttr, 'uvec4', this.maxOps).toReadOnly();
        // glow rocks ("crystals"): a light each, baked into the records within reach by the glow pass (see giHost)
        this.maxCrystals = 8192; this.maxGlowJobs = mobile ? 4096 : 16384;
        this.crystalsAttr = new THREE.StorageBufferAttribute(new Float32Array(this.maxCrystals * 8), 4); // [light position, reach], [colour * power, 0]
        this.glowJobsAttr = new THREE.StorageBufferAttribute(new Uint32Array(this.maxGlowJobs * 8), 4);  // [record, 3 crystals], [4 crystals]
        this.crystalsBuf = storage(this.crystalsAttr, 'vec4', this.maxCrystals * 2).toReadOnly();
        this.glowJobs = storage(this.glowJobsAttr, 'uvec4', this.maxGlowJobs * 2).toReadOnly();
        this.glowCount = uniform(0, 'uint');
        this.glowGain = 3.0;      // in records' units (the display multiplies by giScale, 10); 3.5 matched the glow volume's 35 but its pools read stronger
        this.uGlow = uniform(new THREE.Vector4(this.glowGain, 3.5, 1.4, 0)); // gain, reach, falloff distance
        this.uSun = uniform(new THREE.Vector4(0.3, 0.8, -0.5, this.maxDistance)); // direction to the sun, ray length
        this.uSunE = uniform(new THREE.Vector3(8, 8, 8));    // sun irradiance
        this.uSkyZ = uniform(new THREE.Vector3());           // sky radiance at the zenith ...
        this.uSkyH = uniform(new THREE.Vector3());           // ... and at the horizon
        this.uGround = uniform(new THREE.Vector3());         // the plain beyond the level
        this.uE0 = uniform(new THREE.Vector3());             // what an unsampled record stands in with
        this.jobCount = uniform(0, 'uint');
        this.opCount = uniform(0, 'uint');
        this.maxSamples = uniform(this.p.maxSamples);
        this.giScale = uniform(10);
        // the packed BVH: built by the worker (giHost.pack); this instance only provides the traversal functions, whose
        // storage proxies are pointed at the buffers the worker sends (applyBVH)
        this.bvh = new BVHComputeData([], { attributes: { position: 'vec4f', surface: 'vec4f' } });
        this.attributeStruct = new THREE.StructTypeNode({ position: 'vec4f', surface: 'vec4f' }, 'bvh_GeometryStruct');
        this.bvhReady = false; this.bvhEpoch = 0;
        this.giFallback = uniform(new THREE.Vector3());      // without probes: what an unsampled vertex stands in with
        this.classes = new Map();     // "r,g,b,slot,tile" -> material class (render vertices of different classes are not shared)
        this.classList = [];
        this.work = null;             // the worker's latest work package, not yet dispatched
        this.asked = false;           // a frame message is out
        this.readbackAt = 0; this.reading = false;
        this.hostStats = {};
        this.stats = { jobs: 0, ops: 0, bvhUpdates: 0, bvhMs: 0, readbacks: 0, glowJobs: 0, worker: false };
        this.buildOps();
        this.attachMaterials();
        this.startHost(params);
        terrain.deferDraw = true;
        terrain.onGeometry = (key, geometry) => this.onGeometry(key, geometry);
        for(let [key, mesh] of terrain.objects) this.onGeometry(key, mesh.geometry); // chunks that arrived before us
    }

    /** The CPU half in a worker (giWorker.js, a bundle next to this one); on this thread if that fails. */
    startHost(params) {
        let init = { t: 'init', params, maxJobs: this.maxJobs, maxGlowJobs: this.maxGlowJobs, maxCrystals: this.maxCrystals, reach: this.uGlow.value.y };
        try {
            let url = new URL('./giWorker.js' + new URL(import.meta.url).search, import.meta.url); // (the bundle's ?v= busts the cache)
            this.worker = new Worker(url, { type: 'module' });
            this.worker.onmessage = (e) => this.onHost(e.data);
            this.worker.onerror = (e) => { console.warn('TerrainGI worker failed (' + (e.message || 'error') + '); running on the main thread'); this.worker = null; this.localHost(init, true); };
            this.toHost = (m, transfer) => this.worker.postMessage(m, transfer || []);
            this.toHost(init);
            this.stats.worker = true;
        } catch(e) {
            console.warn('TerrainGI: no worker (' + e.message + '); running on the main thread');
            this.localHost(init, false);
        }
    }

    /** Run the host here (messages become calls; replies are delivered in a microtask, like the worker's would be). */
    localHost(init, replay) {
        let host = new GIHost((m) => queueMicrotask(() => this.onHost(m)));
        this.toHost = (m) => host.handle(m);
        this.stats.worker = false;
        host.handle(init);
        if(replay) { this.asked = false; for(let [key, mesh] of this.terrain.objects) this.onGeometry(key, mesh.geometry); }
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
                let s = ${ state }[ u32( r ) * 2u ];
                let glow = ${ state }[ u32( r ) * 2u + 1u ].xyz;
                if ( s.w < 1.0 ) { return e0 + glow; }
                return s.xyz / s.w + glow;
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
                const s = state.element(id.mul(uint(2))).toVar();
                s.addAssign(vec4(e, 1.0));
                If(s.w.greaterThan(maxS), () => { s.mulAssign(maxS.div(s.w)); });
                state.element(id.mul(uint(2))).assign(s);
            });
        })().compute(this.maxJobs).setName('TerrainGI gather');
        old?.dispose?.();
        this.buildGlow();
    }

    /** The glow pass: the crystals' light at a record, one shadow ray per crystal (they are small: a point light each,
     *  standing a little out of the wall, see setRock), with the glow volume's falloff. Run once per record whenever a
     *  crystal near it appears, changes or goes, or the terrain around changes; the gather then sees the crystals' light
     *  at its hits (giCached), so it bounces. Binds 8 storage buffers, like the gather: records, light, crystals, jobs,
     *  and the BVH's four. */
    buildGlow() {
        let { geo, state, crystalsBuf, glowJobs, bvh, glowCount } = this;
        let raycast = bvh.fns.raycastFirstHit;
        const glowFn = wgslTagFn/* wgsl */`
            // fn
            fn giGlow( j: u32, gp: vec4f ) -> vec3f {
                let A = ${ glowJobs }[ j * 2u ];
                let B = ${ glowJobs }[ j * 2u + 1u ];
                let P = ${ geo }[ A.x * 2u ].xyz;
                let n = normalize( ${ geo }[ A.x * 2u + 1u ].xyz );
                var slots = array<u32, 7>( A.y, A.z, A.w, B.x, B.y, B.z, B.w );
                var E = vec3f( 0.0 );
                for ( var i = 0u; i < 7u; i = i + 1u ) {
                    let c = slots[ i ];
                    if ( c == 0xffffffffu ) { continue; }
                    let C0 = ${ crystalsBuf }[ c * 2u ];
                    let C1 = ${ crystalsBuf }[ c * 2u + 1u ];
                    let L = C0.xyz - P;
                    let d = length( L );
                    if ( d >= C0.w || d < 1e-4 ) { continue; }
                    let l = L / d;
                    let cs = dot( n, l );
                    if ( cs <= 0.0 ) { continue; }
                    var ray: ${ rayStruct };
                    ray.origin = P + n * 0.004;
                    ray.direction = l;
                    ray.maxDist = max( d - 0.03, 0.001 );
                    var hit: ${ rayIntersectionResultStruct };
                    ${ raycast }( ray, &hit );
                    if ( hit.didHit ) { continue; }
                    let s = d / C0.w;
                    let t = 1.0 - s * s;
                    let q = d / gp.z;
                    E += C1.xyz * ( cs * t * t / ( 1.0 + q * q ) );
                }
                return E * gp.x;
            }
        `;
        let old = this.glowKernel;
        this.glowKernel = Fn(() => {
            If(instanceIndex.lessThan(glowCount), () => {
                const id = glowJobs.element(instanceIndex.mul(uint(2))).x.toVar();
                const e = glowFn(instanceIndex, this.uGlow).toVar();
                state.element(id.mul(uint(2)).add(uint(1))).assign(vec4(e, 0.0));
            });
        })().compute(this.maxGlowJobs).setName('TerrainGI glow');
        old?.dispose?.();
    }

    /** Initialise and knock back records (giCore's ops). */
    buildOps() {
        let { state, seq, ops, opCount } = this;
        this.opsKernel = Fn(() => {
            If(instanceIndex.lessThan(opCount), () => {
                const op = ops.element(instanceIndex).toVar();
                const id = op.y;
                // the first word: the type, the weight the record starts with, and a scale for copied light (giCore's seed)
                const w = float(op.x.shiftRight(uint(8)).bitAnd(uint(255)));
                const k = float(op.x.shiftRight(uint(16)).bitAnd(uint(255))).div(255.0);
                If(op.x.bitAnd(uint(255)).equal(uint(OP_INIT)), () => {
                    If(op.z.equal(uint(NO_RECORD)), () => {
                        state.element(id.mul(uint(2))).assign(vec4(0.0, 0.0, 0.0, w)); // empty (unknown, w 0) or dark (a carve with nothing in sight)
                    }).Else(() => {
                        // copied from two gathered records: their mean at weight w
                        const sa = state.element(op.z.mul(uint(2))).toVar(), sb = state.element(op.w.mul(uint(2))).toVar();
                        const mean = sa.xyz.div(max(sa.w, 1.0)).add(sb.xyz.div(max(sb.w, 1.0))).mul(k.mul(0.5));
                        state.element(id.mul(uint(2))).assign(vec4(mean.mul(w), w));
                    });
                    state.element(id.mul(uint(2)).add(uint(1))).assign(vec4(0.0)); // no crystal light until the glow pass says so
                    seq.element(id).assign(uint(0));
                }).Else(() => {
                    // keep at most n samples' worth: the mean stays, its weight drops
                    const s = state.element(id.mul(uint(2))).toVar(), n = float(op.z);
                    If(s.w.greaterThan(n), () => { state.element(id.mul(uint(2))).assign(s.mul(n.div(s.w))); });
                });
            });
        })().compute(this.maxOps).setName('TerrainGI ops');
    }

    /** The terrain materials read their vertices' records (per vertex, interpolated). */
    attachMaterials() {
        let rec = attribute('rec', 'float'), wAt = this.p.weightAt, valid = rec.greaterThanEqual(0.0), r2 = uint(max(rec, 0.0)).mul(uint(2));
        let st = this.stateRead.element(r2), gl = this.stateRead.element(r2.add(uint(1)));
        let giNode = varying(vec4(st.xyz.div(max(st.w, 1.0)), select(valid, min(st.w.div(wAt), 1.0), 0.0)), 'vTerrainGI');
        let glowNode = varying(select(valid, gl.xyz, vec3(0.0)), 'vTerrainGlow');
        for(let m of this.materials) {
            if(m.tridebug === 7) m.colorNode = giNode.xyz.mul(giNode.w).add(glowNode).mul(this.giScale).mul(0.25 / Math.PI);
            else if(m.tridebug === 8) m.colorNode = vec3(giNode.w);
            else if(m.tridebug >= 6) continue;
            else { m.giNode = giNode; m.glowNode = glowNode; m.giScale = this.giScale; m.giFallback = this.giFallback; }
            m.needsUpdate = true;
        }
    }

    // ---- chunks -----------------------------------------------------------------------

    classOf(r, g, b, slot, tile) {
        // a number, not a string (this runs per triangle of every chunk a carve touches): colour at 1/1000, the layer,
        // and the tiling at 1/1000 (a few metres per tile at most)
        let key = ((((Math.round(r * 1000) * 1024 + Math.round(g * 1000)) * 1024 + Math.round(b * 1000)) * 256 + (slot + 1)) * 4096) + Math.round(tile * 1000);
        let k = this.classes.get(key);
        if(k === undefined) { k = this.classList.length; this.classes.set(key, k); this.classList.push([r, g, b, slot, tile]); }
        return k;
    }

    /** A chunk's collision geometry changed (or went): the worker refines it (onHost 'chunk' brings the render mesh and
     *  each coarse corner's record, which go to TerrainMirror and into the BVH's `surface` attribute). */
    onGeometry(key, geometry) {
        if(!geometry) { this.toHost({ t: 'remove', key }); return; }
        let A = geometry.attributes, I = geometry.index.array, nt = geometry.index.count / 3;
        let P = A.position.array, Nn = A.normal.array, U = A.uv ? A.uv.array : null, Cc = A.color.array, S = A.slot.array, T = A.tile.array;
        let pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9), uv = U ? new Float32Array(nt * 6) : null, cls = new Uint16Array(nt), alb = new Float32Array(nt * 3);
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
        let carved = this.terrain.changing && this.terrain.changing.key === key ? this.terrain.changing.box : null;
        let msg = { t: 'chunk', key, version: geometry.uuid, pos, nrm, uv, cls, skip, alb, carved: carved ? { min: carved.min.clone(), max: carved.max.clone() } : null };
        this.toHost(msg, [pos.buffer, nrm.buffer, cls.buffer, skip.buffer, alb.buffer].concat(uv ? [uv.buffer] : []));
    }

    /** The worker's messages. Record uploads (new records' positions, init and knock ops) come first, always. */
    onHost(m) {
        if(m.geo) {
            this.geoAttr.array.set(m.geo, m.geoLo * 8);
            this.geoAttr.addUpdateRange(m.geoLo * 8, m.geo.length); this.geoAttr.needsUpdate = true;
        }
        if(m.ops) this.runOps(m.ops);
        if(m.t === 'chunk') this.onChunk(m);
        else if(m.t === 'bvh') this.applyBVH(m);
        else if(m.t === 'work') { this.work = m; this.asked = false; if(m.stats) this.hostStats = m.stats; }
    }

    /** A refined mesh: to TerrainMirror, if it is still of the chunk's current geometry. */
    onChunk(m) {
        let mesh = this.terrain.objects.get(m.key);
        if(mesh && mesh.geometry.uuid === m.version) { this.pushRender(m, mesh.geometry); this.terrain.setCoarseRecords(m.key, mesh.geometry, m.coarseRec); }
    }

    /** The worker's packed BVH. Its buffers are written into the ones the passes already bind when they fit (they are
     *  allocated with half again as much room, and the traversal only reads what the nodes point at), so a dig does not
     *  rebuild the passes: building them again (three's node building, even though the pipeline comes from the cache)
     *  cost ~14 ms on a 4x-throttled CPU, once a second while digging. When one does not fit, new buffers go behind the
     *  traversal functions' proxies (as BVHComputeData.update would set them) and the passes are rebuilt. */
    applyBVH(m) {
        let t0 = performance.now(), B = this.bvh, S = THREE.StorageBufferAttribute;
        let parts = [['nodes', m.nodes], ['transforms', m.transforms], ['index', m.index], ['attributes', m.attributes]];
        let fits = this.bvhAttrs && parts.every(([k, a]) => a.length <= this.bvhAttrs[k].array.length);
        if(fits) {
            for(let [k, a] of parts) { let at = this.bvhAttrs[k]; at.array.set(a); at.clearUpdateRanges(); at.addUpdateRange(0, a.length); at.needsUpdate = true; }
        } else {
            let room = (a, item) => { let n = Math.ceil(a.length * 1.5 / item) * item, b = new a.constructor(n); b.set(a); return b; };
            let stride = this.attributeStruct.getLength();
            this.bvhAttrs = { nodes: new S(room(m.nodes, 8), 1), transforms: new S(room(m.transforms, 1), 1), index: new S(room(m.index, 3), 1), attributes: new S(room(m.attributes, stride), stride) };
            B.dispose();
            B.storage.nodes = storage(this.bvhAttrs.nodes, bvhNodeStruct).toReadOnly().setName('bvh_nodes');
            B.storage.transforms = storage(this.bvhAttrs.transforms, B.structs.transform).toReadOnly().setName('bvh_transforms');
            B.storage.index = storage(this.bvhAttrs.index, 'uint').toReadOnly().setName('bvh_index');
            B.storage.attributes = storage(this.bvhAttrs.attributes, this.attributeStruct).toReadOnly().setName('bvh_attributes');
            B.structs.attributes = this.attributeStruct;
            this.buildGather();
            this.stats.bvhRebuilds = (this.stats.bvhRebuilds || 0) + 1;
        }
        this.bvhReady = true; this.bvhEpoch++;
        this.stats.bvhUpdates++; this.stats.bvhMs = performance.now() - t0;
    }

    runOps(ops) {
        for(let at = 0; at < ops.length; at += this.maxOps * 4) {
            let part = ops.subarray(at, at + this.maxOps * 4), n = part.length / 4;
            this.opsAttr.array.set(part);
            this.opsAttr.clearUpdateRanges(); this.opsAttr.addUpdateRange(0, part.length); this.opsAttr.needsUpdate = true;
            this.opCount.value = n;
            this.renderer.compute(this.opsKernel, n);
            this.stats.ops += n;
        }
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

    /** A carve changed a region (records around it re-converge; crystals reaching it are placed again: the worker). */
    changed(box) { this.toHost({ t: 'changed', box: { min: box.min.clone(), max: box.max.clone() } }); }

    /** Glow rocks (GlowRockRenderSystem, through GameClient's glowSink): their light is baked into the records. */
    setRock(id, x, y, z, radius, color, power) { this.toHost({ t: 'rock', id, x, y, z, radius, rgb: [color.r, color.g, color.b], power }); }
    removeRock(id) { this.toHost({ t: 'unrock', id }); }

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
        // with no probe grid (phones), an unsampled vertex stands in with half the open sky instead of the probes
        if(world.probes) this.giFallback.value.set(0, 0, 0); else this.giFallback.value.copy(this.uE0.value);
        this.update(world.camera);
    }

    update(camera) {
        if(this.renderer.initialized === false) return;
        let now = performance.now();
        // the worker's latest work package: crystal buffer writes, the glow pass, the rays
        let w = this.work;
        if(w && this.bvhReady) {
            this.work = null;
            for(let [slot, data] of w.crystals) { this.crystalsAttr.array.set(data, slot * 8); this.crystalsAttr.addUpdateRange(slot * 8, 8); this.crystalsAttr.needsUpdate = true; }
            if(w.glow) {
                let n = w.glow.length / 8;
                this.glowJobsAttr.array.set(w.glow);
                this.glowJobsAttr.clearUpdateRanges(); this.glowJobsAttr.addUpdateRange(0, w.glow.length); this.glowJobsAttr.needsUpdate = true;
                this.glowCount.value = n; this.uGlow.value.x = this.glowGain;
                this.renderer.compute(this.glowKernel, n);
                this.stats.glowJobs += n;
            }
            let count = w.jobs.length;
            if(count > 0) {
                this.jobsAttr.array.set(w.jobs);
                this.jobsAttr.clearUpdateRanges(); this.jobsAttr.addUpdateRange(0, count); this.jobsAttr.needsUpdate = true;
                this.jobCount.value = count;
                this.renderer.compute(this.gatherKernel, count);
                this.stats.jobs += count;
            }
            if(w.wantState && !this.reading && now - this.readbackAt > 1500) this.readback();
        } else if(w && !this.bvhReady) {
            // nothing to trace against yet: keep the crystal writes, drop the jobs (the worker counted them, harmlessly)
            for(let [slot, data] of w.crystals) { this.crystalsAttr.array.set(data, slot * 8); this.crystalsAttr.addUpdateRange(slot * 8, 8); this.crystalsAttr.needsUpdate = true; }
            this.work = null;
        }
        if(!this.asked) { this.asked = true; this.toHost({ t: 'frame', cam: [camera.position.x, camera.position.y, camera.position.z] }); }
    }

    /** The records' light, for the worker's adaptive splits (sent, not copied). */
    async readback() {
        this.reading = true; this.readbackAt = performance.now();
        try {
            let buf = await this.renderer.getArrayBufferAsync(this.stateAttr);
            this.toHost({ t: 'state', buf }, [buf]);
            this.stats.readbacks++;
        } catch(e) { console.warn('TerrainGI: readback failed: ' + e.message); }
        this.reading = false;
    }

    /** Hand TerrainMirror a chunk's refined render geometry (after onGeometry, or an adaptive pass: same coarse geometry
     *  and corner records, more vertices), for the coarse geometry it was refined from. */
    pushRender(ch, coarse) {
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
        this.terrain.setRenderGeometry(ch.key, g, coarse);
    }

    info() { return { ...this.hostStats, ...this.stats }; }
}
