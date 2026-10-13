#!/usr/bin/env node
/**
 * Import arbitrary level geometry (GLB) as destructible terrain.
 *
 *   node tools/import-world.mjs model.glb --name castle [--size 30] [--edge 0.3] [--shell 0.2]
 *        [--mode shell|signed|both] [--scale S] [--offset x,y,z] [--no-center] [--no-floor] [--out assets/worlds/castle.json]
 *
 * The mesh is treated as a triangle soup: no watertightness, orientation or
 * manifoldness is assumed. A signed distance field is built from a BVH over the
 * soup and Manifold's level set marches it into one closed manifold, which is
 * then simplified and split into 10 m chunks by exact cube intersection, so
 * chunk faces coincide and the server's connectivity solver works unchanged.
 *
 * Modes:
 *   shell   (default) solid = within `shell` metres of any surface. Robust for
 *           anything; walls and floors get real thickness.
 *   winding solid = generalized winding number >= 0.5 (Jacobson 2013, with the
 *           far-field dipole approximation of Barill 2018). Fills closed-ish
 *           volumes even with holes, flipped faces and self-intersections;
 *           open sheets get nothing, so pair it with the shell (`both`).
 *   both    union of shell and winding.
 *   parity  solid = inside by ray-parity vote (3 directions). Needs closed input.
 *
 * Materials: every output triangle takes the palette colour nearest to the base
 * colour of the source material under its centroid (textured materials fall back
 * to the default). The result is a world manifest the client can upload to a
 * room (`main.importWorld(url)` or `?import=<url>`).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { M } from '../assets/manifold-3d/manifold.js';
import { encodeChunkMesh, hashBytes } from '../src/net/codec.js';
import { MATERIALS, DEFAULT_MATERIAL } from '../src/terrain/materials.js';
import { CHUNK_SIZE, key as chunkKey } from '../src/terrain/grid.js';

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const opt = (name, def) => { let i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);
if(!file) { console.error('usage: import-world.mjs model.glb --name <name> [options]'); process.exit(1); }
const name = opt('name', basename(file).replace(/\.(glb|gltf)$/i, ''));
const targetSize = +opt('size', 0);          // scale the model so its longest side is this (0 = keep units)
const scaleOpt = +opt('scale', 1);
const offset = (opt('offset', '0,0,0')).split(',').map(Number);
const edge = +opt('edge', 0.3);
const shell = +opt('shell', 0.2);
const mode = opt('mode', 'shell');
const floor = !flag('no-floor');            // implicit rock under the model
const center = !flag('no-center');          // put the model's footprint centre at the origin with its base at y=0
const out = opt('out', `assets/worlds/${name}.json`);

// ---- minimal GLB reader (geometry + base colours only) ----------------------
function readGLB(path) {
    let buf = readFileSync(path);
    let dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if(dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a GLB');
    let off = 12, json = null, bin = null;
    while(off < buf.byteLength) {
        let len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
        let chunk = buf.subarray(off + 8, off + 8 + len);
        if(type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
        else if(type === 0x004E4942) bin = chunk;
        off += 8 + len;
    }
    if(!json || !bin) throw new Error('GLB without JSON or BIN chunk (external buffers are not supported)');
    if(json.extensionsRequired && json.extensionsRequired.some(e => /draco|meshopt/i.test(e))) throw new Error('compressed meshes are not supported: ' + json.extensionsRequired.join(', '));
    const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
    const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    function accessor(i) {
        let a = json.accessors[i], bv = json.bufferViews[a.bufferView];
        let T = COMP[a.componentType], n = SIZE[a.type];
        let stride = bv.byteStride || n * T.BYTES_PER_ELEMENT;
        let base = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
        let outArr = new T(a.count * n);
        if(stride === n * T.BYTES_PER_ELEMENT) outArr.set(new T(bin.buffer, base, a.count * n));
        else for(let k = 0; k < a.count; k++) outArr.set(new T(bin.buffer, base + k * stride, n), k * n);
        return { array: outArr, n };
    }
    let positions = [], materials = [];
    let palette = (json.materials || []).map(m => {
        let pbr = m.pbrMetallicRoughness || {};
        let c = pbr.baseColorFactor || [1, 1, 1, 1];
        return pbr.baseColorTexture ? DEFAULT_MATERIAL : nearestMaterial(c[0], c[1], c[2]);
    });
    function walk(nodeIndex, parent) {
        let node = json.nodes[nodeIndex];
        let local = new THREE.Matrix4();
        if(node.matrix) local.fromArray(node.matrix);
        else local.compose(new THREE.Vector3(...(node.translation || [0, 0, 0])), new THREE.Quaternion(...(node.rotation || [0, 0, 0, 1])), new THREE.Vector3(...(node.scale || [1, 1, 1])));
        let world = parent.clone().multiply(local);
        if(node.mesh !== undefined) {
            for(let prim of json.meshes[node.mesh].primitives) {
                if((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
                let pos = accessor(prim.attributes.POSITION).array;
                let idx = prim.indices !== undefined ? accessor(prim.indices).array : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
                let mat = prim.material !== undefined ? palette[prim.material] : DEFAULT_MATERIAL;
                let v = new THREE.Vector3();
                for(let i = 0; i < idx.length; i += 3) {
                    for(let k = 0; k < 3; k++) {
                        let p = idx[i + k] * 3;
                        v.set(pos[p], pos[p + 1], pos[p + 2]).applyMatrix4(world);
                        positions.push(v.x, v.y, v.z);
                    }
                    materials.push(mat);
                }
            }
        }
        for(let c of node.children || []) walk(c, world);
    }
    let scene = json.scenes[json.scene || 0];
    for(let n of scene.nodes) walk(n, new THREE.Matrix4());
    return { positions: new Float32Array(positions), materials: new Uint8Array(materials) };
}

const srgbToLinear = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const paletteLinear = MATERIALS.map(m => [16, 8, 0].map(s => srgbToLinear(((m.color >> s) & 255) / 255)));
function nearestMaterial(r, g, b) {
    let best = DEFAULT_MATERIAL, bestD = Infinity;
    paletteLinear.forEach((c, i) => { let d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if(d < bestD) { bestD = d; best = i; } });
    return best;
}

// ---- generalized winding number over a triangle soup -------------------------
// Exact solid angles per triangle near the query point, a first-order dipole per cluster far
// from it (Barill et al. 2018). Clusters are a median-split tree over triangle centroids.
class WindingNumber {
    constructor(soup, leafSize = 16, beta = 2.0) {
        this.beta = beta;
        let n = soup.length / 9;
        this.soup = soup;
        this.cent = new Float64Array(n * 3);
        this.norm = new Float64Array(n * 3); // area-weighted normal (0.5 * cross)
        for(let t = 0; t < n; t++) {
            let o = t * 9;
            let ax = soup[o], ay = soup[o + 1], az = soup[o + 2], bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5], cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
            this.cent[t * 3] = (ax + bx + cx) / 3; this.cent[t * 3 + 1] = (ay + by + cy) / 3; this.cent[t * 3 + 2] = (az + bz + cz) / 3;
            let ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
            this.norm[t * 3] = 0.5 * (uy * vz - uz * vy); this.norm[t * 3 + 1] = 0.5 * (uz * vx - ux * vz); this.norm[t * 3 + 2] = 0.5 * (ux * vy - uy * vx);
        }
        let order = Uint32Array.from({ length: n }, (_, i) => i);
        this.root = this.build(order, 0, n, leafSize);
    }
    build(order, lo, hi, leafSize) {
        // aggregate: normal sum, area-weighted centre, radius from the centre to the farthest vertex
        let N = [0, 0, 0], C = [0, 0, 0], A = 0;
        for(let i = lo; i < hi; i++) {
            let t = order[i], a = Math.hypot(this.norm[t * 3], this.norm[t * 3 + 1], this.norm[t * 3 + 2]);
            N[0] += this.norm[t * 3]; N[1] += this.norm[t * 3 + 1]; N[2] += this.norm[t * 3 + 2];
            C[0] += a * this.cent[t * 3]; C[1] += a * this.cent[t * 3 + 1]; C[2] += a * this.cent[t * 3 + 2]; A += a;
        }
        if(A > 0) { C[0] /= A; C[1] /= A; C[2] /= A; } else { let t = order[lo]; C = [this.cent[t * 3], this.cent[t * 3 + 1], this.cent[t * 3 + 2]]; }
        let r2 = 0;
        for(let i = lo; i < hi; i++) for(let k = 0; k < 3; k++) {
            let o = order[i] * 9 + k * 3, dx = this.soup[o] - C[0], dy = this.soup[o + 1] - C[1], dz = this.soup[o + 2] - C[2];
            r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
        }
        let node = { N, C, r: Math.sqrt(r2), lo, hi, order, left: null, right: null };
        if(hi - lo <= leafSize) return node;
        // split on the widest axis at the median centroid
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for(let i = lo; i < hi; i++) for(let k = 0; k < 3; k++) { let v = this.cent[order[i] * 3 + k]; if(v < mn[k]) mn[k] = v; if(v > mx[k]) mx[k] = v; }
        let axis = 0; for(let k = 1; k < 3; k++) if(mx[k] - mn[k] > mx[axis] - mn[axis]) axis = k;
        let sub = order.subarray(lo, hi);
        sub.sort((a, b) => this.cent[a * 3 + axis] - this.cent[b * 3 + axis]);
        let mid = (lo + hi) >> 1;
        node.left = this.build(order, lo, mid, leafSize);
        node.right = this.build(order, mid, hi, leafSize);
        return node;
    }
    /** Exact solid angle of triangle t seen from p (Van Oosterom & Strackee 1983), /4pi. */
    triangle(t, px, py, pz) {
        let o = t * 9, s = this.soup;
        let ax = s[o] - px, ay = s[o + 1] - py, az = s[o + 2] - pz;
        let bx = s[o + 3] - px, by = s[o + 4] - py, bz = s[o + 5] - pz;
        let cx = s[o + 6] - px, cy = s[o + 7] - py, cz = s[o + 8] - pz;
        let la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
        let num = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
        let den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb;
        return Math.atan2(num, den) / (2 * Math.PI);
    }
    at(px, py, pz) { return this.node(this.root, px, py, pz); }
    node(nd, px, py, pz) {
        let dx = nd.C[0] - px, dy = nd.C[1] - py, dz = nd.C[2] - pz;
        let d2 = dx * dx + dy * dy + dz * dz;
        if(d2 > (this.beta * nd.r) ** 2) {
            // far field: the cluster acts as one dipole
            return (nd.N[0] * dx + nd.N[1] * dy + nd.N[2] * dz) / (4 * Math.PI * d2 * Math.sqrt(d2));
        }
        if(!nd.left) {
            let w = 0;
            for(let i = nd.lo; i < nd.hi; i++) w += this.triangle(nd.order[i], px, py, pz);
            return w;
        }
        return this.node(nd.left, px, py, pz) + this.node(nd.right, px, py, pz);
    }
}

// ---- main ------------------------------------------------------------------
let t0 = Date.now();
let { positions, materials } = readGLB(file);
let geom = new THREE.BufferGeometry();
geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geom.computeBoundingBox();
let size = geom.boundingBox.getSize(new THREE.Vector3());
let scale = scaleOpt * (targetSize > 0 ? targetSize / Math.max(size.x, size.y, size.z) : 1);
geom.scale(scale, scale, scale);
if(center) { geom.computeBoundingBox(); let c = geom.boundingBox.getCenter(new THREE.Vector3()); geom.translate(-c.x, -geom.boundingBox.min.y, -c.z); }
geom.translate(offset[0], offset[1], offset[2]);
geom.computeBoundingBox();
let bb = geom.boundingBox;
console.log(`model: ${positions.length / 9} triangles, scale ${scale.toFixed(4)}, bounds ${bb.min.toArray().map(v => v.toFixed(1))} .. ${bb.max.toArray().map(v => v.toFixed(1))}`);

let bvh = new MeshBVH(geom);
const winding = (mode === 'winding' || mode === 'both') ? new WindingNumber(positions) : null;
if(winding) {
    // self-test on a unit cube with outward faces
    let cube = new THREE.BoxGeometry(1, 1, 1).toNonIndexed().attributes.position.array;
    let wn = new WindingNumber(cube);
    console.log(`winding self-test: centre ${wn.at(0, 0, 0).toFixed(3)} (expect 1), outside ${wn.at(2, 0, 0).toFixed(3)} (expect 0)`);
}
const target = {}, pt = new THREE.Vector3(), ray = new THREE.Ray();
const dirs = [new THREE.Vector3(1, 0.13, 0.07).normalize(), new THREE.Vector3(-0.1, 1, 0.2).normalize(), new THREE.Vector3(0.2, -0.3, 1).normalize()];
function inside(p) {
    let votes = 0;
    for(let d of dirs) { ray.origin.copy(p); ray.direction.copy(d); if(bvh.raycast(ray, THREE.DoubleSide).length % 2 === 1) votes++; }
    return votes >= 2;
}
// With --floor (default) everything below the model's base is solid ground, so the lowest layer of
// stored chunks is rock up to the base and sits flush on the implicit rock below it.
const floorY = bb.min.y;
const lowestLayer = Math.floor((floorY - 1e-6) / CHUNK_SIZE);
let calls = 0;
function sdf([x, y, z]) {
    calls++;
    let fl = floor ? floorY - y : -Infinity;
    if(floor && y < floorY - shell - edge) return fl;   // far below the base: ground, no mesh query needed
    pt.set(x, y, z);
    bvh.closestPointToPoint(pt, target);
    let d = target.distance;
    let v;
    if(mode === 'shell') v = shell - d;
    else if(mode === 'parity') v = inside(pt) ? d : -d;
    else if(mode === 'winding') v = winding.at(x, y, z) >= 0.5 ? d : -d;
    else v = (d < shell) ? shell - d : (winding.at(x, y, z) >= 0.5 ? d : -d);
    return Math.max(v, fl);
}

const wasm = readFileSync(resolve(dirname(new URL(import.meta.url).pathname), '../assets/manifold-3d/manifold.wasm'));
const wasmModule = await WebAssembly.compile(wasm);
const manifold = await M({ instantiateWasm: (imports, cb) => { WebAssembly.instantiate(wasmModule, imports).then(i => cb(i)); return {}; } });
manifold.setup();
const { Manifold } = manifold;

let pad = edge + shell;
let box = { min: [bb.min.x - pad, floor ? lowestLayer * CHUNK_SIZE - pad : bb.min.y - pad, bb.min.z - pad], max: [bb.max.x + pad, bb.max.y + pad, bb.max.z + pad] };
let t1 = Date.now();
let whole = Manifold.levelSet(sdf, box, edge);
console.log(`level set (${mode}): ${whole.numTri()} triangles, ${whole.decompose().length} components, ${calls} sdf calls, ${Date.now() - t1} ms`);
let simp = whole.simplify(edge * 0.2);
whole.delete();
console.log(`simplified: ${simp.numTri()} triangles, volume ${simp.volume().toFixed(1)} m³`);

// Split into chunks
let cmin = [Math.floor(box.min[0] / CHUNK_SIZE), Math.floor(box.min[1] / CHUNK_SIZE), Math.floor(box.min[2] / CHUNK_SIZE)];
if(floor) cmin[1] = lowestLayer; // below the floor layer everything is implicit rock; storing the level set's closing slab there would float it
let cmax = [Math.floor(box.max[0] / CHUNK_SIZE), Math.floor(box.max[1] / CHUNK_SIZE), Math.floor(box.max[2] / CHUNK_SIZE)];
let chunks = {};
let totalTris = 0, maxTris = 0, totalBytes = 0;
let centroid = new THREE.Vector3();
for(let x = cmin[0]; x <= cmax[0]; x++) for(let y = cmin[1]; y <= cmax[1]; y++) for(let z = cmin[2]; z <= cmax[2]; z++) {
    let cube = Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE]).translate(x * CHUNK_SIZE, y * CHUNK_SIZE, z * CHUNK_SIZE);
    let part = simp.intersect(cube);
    cube.delete();
    if(part.isEmpty()) { part.delete(); continue; }
    let mesh = part.getMesh();
    let v = mesh.vertProperties, tri = mesh.triVerts;
    let numTris = tri.length / 3;
    let mats = new Uint8Array(numTris);
    for(let t = 0; t < numTris; t++) {
        centroid.set(0, 0, 0);
        for(let k = 0; k < 3; k++) { let i = tri[t * 3 + k] * 3; centroid.x += v[i]; centroid.y += v[i + 1]; centroid.z += v[i + 2]; }
        centroid.multiplyScalar(1 / 3);
        bvh.closestPointToPoint(centroid, target);
        mats[t] = materials[target.faceIndex] ?? DEFAULT_MATERIAL;
    }
    let bytes = encodeChunkMesh(new Float32Array(v), new Uint32Array(tri), mats);
    chunks[chunkKey(x, y, z)] = { version: hashBytes(bytes), bytes: Buffer.from(bytes).toString('base64') };
    totalTris += numTris; maxTris = Math.max(maxTris, numTris); totalBytes += bytes.length;
    part.delete();
}
simp.delete();

// World config: the model's chunk range plus a margin; with --floor, implicit rock fills every
// in-bounds chunk up to the model's lowest layer (stored chunks override it under the model).
let margin = 1;
let bounds = { min: [cmin[0] - margin, cmin[1] - (floor ? 2 : margin), cmin[2] - margin], max: [cmax[0] + margin, cmax[1] + 3, cmax[2] + margin] };
let rock = floor ? { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], lowestLayer, bounds.max[2]] } : null;
let manifest = { name, world: { bounds, rock }, source: basename(file), options: { edge, shell, mode, scale, offset }, chunks, entities: [] };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(manifest));
console.log(`chunks: ${Object.keys(chunks).length}, ${totalTris} triangles (max ${maxTris} per chunk), ${(totalBytes / 1024).toFixed(0)} KB of chunk bytes`);
console.log(`world: bounds ${JSON.stringify(bounds)} rock ${JSON.stringify(rock)}`);
console.log(`wrote ${out} in ${Date.now() - t0} ms`);
