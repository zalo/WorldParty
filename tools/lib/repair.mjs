/**
 * Slicer-style mesh repair for one part of a level, in the order admesh and the
 * Cura mesh fixes apply them: weld vertices within a tolerance, drop degenerate
 * and duplicate triangles, orient faces consistently and outward, fill small
 * holes, and thicken what is still open into a closed shell. What comes out is
 * meant for Manifold; what cannot be made closed is reported so the caller can
 * fall back to a level set for that part only.
 *
 * A part is { positions: Float32Array soup (9 per tri), uvs: Float32Array (6 per tri), material: number }.
 */
import * as THREE from 'three';
import { MeshBVH, ExtendedTriangle } from 'three-mesh-bvh';

/** Weld positions within `tol`; returns an indexed mesh with per-corner property vertices
 *  (position + uv) and the position group of each property vertex. */
export function weld(part, tol) {
    let { positions, uvs } = part;
    let numTris = positions.length / 9;
    let q = 1 / Math.max(tol, 1e-9);
    let posKey = new Map();     // quantized position -> position index
    let propKey = new Map();    // position index + uv -> property vertex index
    let posOf = [];             // property vertex -> position index
    let props = [];             // property vertices: x y z u v
    let corner = new Uint32Array(numTris * 3); // property vertex per corner
    let posTri = new Uint32Array(numTris * 3); // position index per corner
    for(let c = 0; c < numTris * 3; c++) {
        let x = positions[c * 3], y = positions[c * 3 + 1], z = positions[c * 3 + 2];
        let u = uvs ? uvs[c * 2] : 0, v = uvs ? uvs[c * 2 + 1] : 0;
        let pk = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
        let pi = posKey.get(pk);
        if(pi === undefined) { pi = posKey.size; posKey.set(pk, pi); }
        let kk = `${pi}|${Math.round(u * 4096)},${Math.round(v * 4096)}`;
        let vi = propKey.get(kk);
        if(vi === undefined) { vi = props.length / 5; propKey.set(kk, vi); props.push(x, y, z, u, v); posOf.push(pi); }
        corner[c] = vi; posTri[c] = pi;
    }
    return { props: new Float32Array(props), posOf: Uint32Array.from(posOf), corner, posTri, numPos: posKey.size, material: part.material };
}

/** Drop triangles with a repeated position and exact duplicates (either winding). Returns kept triangle indices. */
export function dedupe(m) {
    let numTris = m.posTri.length / 3;
    let seen = new Set(), keep = [];
    for(let t = 0; t < numTris; t++) {
        let a = m.posTri[t * 3], b = m.posTri[t * 3 + 1], c = m.posTri[t * 3 + 2];
        if(a === b || b === c || a === c) continue;
        let key = [a, b, c].sort((x, y) => x - y).join(',');
        if(seen.has(key)) continue;
        seen.add(key); keep.push(t);
    }
    return keep;
}

/** Orient triangles consistently by flood fill across shared edges, then outward by signed volume.
 *  Returns { flipped: Uint8Array per triangle, nonManifoldEdges, components }. */
export function orient(m, tris) {
    let edges = new Map(); // "a,b" undirected -> [tri...]
    const ek = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
    for(let t of tris) for(let k = 0; k < 3; k++) {
        let a = m.posTri[t * 3 + k], b = m.posTri[t * 3 + (k + 1) % 3];
        let key = ek(a, b);
        let list = edges.get(key); if(!list) edges.set(key, list = []);
        list.push(t);
    }
    let nonManifoldEdges = 0;
    for(let list of edges.values()) if(list.length > 2) nonManifoldEdges++;
    let flipped = new Uint8Array(m.posTri.length / 3);
    let visited = new Uint8Array(m.posTri.length / 3);
    let compOf = new Int32Array(m.posTri.length / 3).fill(-1);
    let components = 0;
    const dir = (t, a, b) => { // +1 if edge a->b appears in t's (possibly flipped) winding
        let va = [m.posTri[t * 3], m.posTri[t * 3 + 1], m.posTri[t * 3 + 2]];
        if(flipped[t]) va.reverse();
        for(let k = 0; k < 3; k++) if(va[k] === a && va[(k + 1) % 3] === b) return 1;
        return -1;
    };
    for(let seed of tris) {
        if(visited[seed]) continue;
        let comp = components++;
        let stack = [seed]; visited[seed] = 1; compOf[seed] = comp;
        while(stack.length) {
            let t = stack.pop();
            for(let k = 0; k < 3; k++) {
                let a = m.posTri[t * 3 + k], b = m.posTri[t * 3 + (k + 1) % 3];
                let list = edges.get(ek(a, b));
                if(list.length !== 2) continue;
                let n = list[0] === t ? list[1] : list[0];
                if(visited[n]) continue;
                // consistent orientation: the shared edge runs opposite ways in the two triangles
                if(dir(t, a, b) === dir(n, a, b)) flipped[n] = 1;
                visited[n] = 1; compOf[n] = comp; stack.push(n);
            }
        }
    }
    // components touching a non-manifold edge cannot be closed by these tools
    let nonManifoldComps = new Set();
    for(let list of edges.values()) if(list.length > 2) for(let t of list) nonManifoldComps.add(compOf[t]);
    // outward: signed volume of each component's (possibly open) surface about the origin
    let vols = new Float64Array(components);
    for(let t of tris) {
        let i = [m.posTri[t * 3], m.posTri[t * 3 + 1], m.posTri[t * 3 + 2]];
        if(flipped[t]) i.reverse();
        let p = m.props, A = [p[m.corner[t * 3] * 5], p[m.corner[t * 3] * 5 + 1], p[m.corner[t * 3] * 5 + 2]];
        // positions by property vertex of each corner, in (possibly flipped) order
        let cs = [m.corner[t * 3], m.corner[t * 3 + 1], m.corner[t * 3 + 2]]; if(flipped[t]) cs.reverse();
        let a = [p[cs[0] * 5], p[cs[0] * 5 + 1], p[cs[0] * 5 + 2]], b = [p[cs[1] * 5], p[cs[1] * 5 + 1], p[cs[1] * 5 + 2]], c = [p[cs[2] * 5], p[cs[2] * 5 + 1], p[cs[2] * 5 + 2]];
        vols[compOf[t]] += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    for(let t of tris) if(vols[compOf[t]] < 0) flipped[t] ^= 1;
    return { flipped, nonManifoldEdges, components, compOf, nonManifoldComps, edges, ek };
}

/** Boundary loops (lists of position indices) of the oriented triangle set. */
export function boundaryLoops(m, tris, o) {
    let next = new Map(); // boundary directed edge a->b (as it appears in the oriented triangle) : for the loop we walk b->a
    for(let t of tris) {
        let i = [m.posTri[t * 3], m.posTri[t * 3 + 1], m.posTri[t * 3 + 2]];
        if(o.flipped[t]) i.reverse();
        for(let k = 0; k < 3; k++) {
            let a = i[k], b = i[(k + 1) % 3];
            if(o.edges.get(o.ek(a, b)).length === 1) next.set(a, b);
        }
    }
    let loops = [];
    let used = new Set();
    for(let [start] of next) {
        if(used.has(start)) continue;
        let loop = [], v = start;
        while(v !== undefined && !used.has(v)) { used.add(v); loop.push(v); v = next.get(v); }
        if(loop.length >= 3 && v === start) loops.push(loop);
    }
    return loops;
}

/** Position of a position index (first property vertex that maps to it). */
function posIndexToXYZ(m) {
    let xyz = new Float32Array(m.numPos * 3), done = new Uint8Array(m.numPos);
    for(let v = 0; v < m.posOf.length; v++) { let pi = m.posOf[v]; if(done[pi]) continue; done[pi] = 1; xyz[pi * 3] = m.props[v * 5]; xyz[pi * 3 + 1] = m.props[v * 5 + 1]; xyz[pi * 3 + 2] = m.props[v * 5 + 2]; }
    return xyz;
}

/** Fill a hole (loop of position indices) by ear clipping in its best-fit plane; returns triangles as position index triples (CCW seen from outside). */
export function fillLoop(loop, xyz) {
    let n = loop.length;
    let c = new THREE.Vector3();
    for(let i of loop) c.add(new THREE.Vector3(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]));
    c.multiplyScalar(1 / n);
    // normal from the loop's Newell polygon normal
    let nrm = new THREE.Vector3();
    for(let k = 0; k < n; k++) {
        let a = loop[k], b = loop[(k + 1) % n];
        nrm.x += (xyz[a * 3 + 1] - xyz[b * 3 + 1]) * (xyz[a * 3 + 2] + xyz[b * 3 + 2]);
        nrm.y += (xyz[a * 3 + 2] - xyz[b * 3 + 2]) * (xyz[a * 3] + xyz[b * 3]);
        nrm.z += (xyz[a * 3] - xyz[b * 3]) * (xyz[a * 3 + 1] + xyz[b * 3 + 1]);
    }
    if(nrm.lengthSq() < 1e-20) return [];
    nrm.normalize();
    let u = new THREE.Vector3(1, 0, 0); if(Math.abs(nrm.x) > 0.9) u.set(0, 1, 0);
    u.cross(nrm).normalize(); let v = new THREE.Vector3().crossVectors(nrm, u);
    let pts = loop.map(i => { let p = new THREE.Vector3(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]).sub(c); return new THREE.Vector2(p.dot(u), p.dot(v)); });
    let idx = THREE.ShapeUtils.triangulateShape(pts, []);
    // the boundary loop runs opposite to the missing triangles' winding: flip
    return idx.map(([a, b, d]) => [loop[a], loop[d], loop[b]]);
}

/** Build the Manifold Mesh input for a set of triangles (property vertices + merge vectors). */
export function toMeshInput(m, tris, o, extraTris, manifoldModule, originalID, numProp = 5) {
    let triVerts = [];
    for(let t of tris) {
        let cs = [m.corner[t * 3], m.corner[t * 3 + 1], m.corner[t * 3 + 2]];
        if(o && o.flipped[t]) cs.reverse();
        triVerts.push(cs[0], cs[1], cs[2]);
    }
    let props = Array.from(m.props), posOf = Array.from(m.posOf);
    if(extraTris) {
        // extra triangles come as position-index triples: give them property vertices with the uv of any existing vertex at that position
        let firstProp = new Map();
        for(let v = 0; v < posOf.length; v++) if(!firstProp.has(posOf[v])) firstProp.set(posOf[v], v);
        for(let [a, b, c] of extraTris) triVerts.push(firstProp.get(a), firstProp.get(b), firstProp.get(c));
    }
    // merge vectors: every property vertex merges to the first property vertex of its position
    let first = new Map(), from = [], to = [];
    for(let v = 0; v < posOf.length; v++) { let f = first.get(posOf[v]); if(f === undefined) first.set(posOf[v], v); else { from.push(v); to.push(f); } }
    return new manifoldModule.Mesh({
        numProp, vertProperties: new Float32Array(props), triVerts: new Uint32Array(triVerts),
        mergeFromVert: new Uint32Array(from), mergeToVert: new Uint32Array(to),
        runIndex: new Uint32Array([0, triVerts.length]), runOriginalID: new Uint32Array([originalID]),
    });
}

/** Thicken an open (or any) oriented surface into a closed shell of thickness t: the surface, an
 *  inward offset copy with reversed winding, and side walls along every boundary loop. */
export function thicken(m, tris, o, loops, t) {
    let xyz = posIndexToXYZ(m);
    // angle-weighted vertex normals over positions
    let nrm = new Float32Array(m.numPos * 3);
    for(let tr of tris) {
        let i = [m.posTri[tr * 3], m.posTri[tr * 3 + 1], m.posTri[tr * 3 + 2]];
        if(o.flipped[tr]) i.reverse();
        let a = new THREE.Vector3(xyz[i[0] * 3], xyz[i[0] * 3 + 1], xyz[i[0] * 3 + 2]), b = new THREE.Vector3(xyz[i[1] * 3], xyz[i[1] * 3 + 1], xyz[i[1] * 3 + 2]), c = new THREE.Vector3(xyz[i[2] * 3], xyz[i[2] * 3 + 1], xyz[i[2] * 3 + 2]);
        let fn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
        for(let k = 0; k < 3; k++) {
            let p = [a, b, c][k], q = [a, b, c][(k + 1) % 3], r = [a, b, c][(k + 2) % 3];
            let ang = new THREE.Vector3().subVectors(q, p).angleTo(new THREE.Vector3().subVectors(r, p));
            nrm[i[k] * 3] += fn.x * ang; nrm[i[k] * 3 + 1] += fn.y * ang; nrm[i[k] * 3 + 2] += fn.z * ang;
        }
    }
    // new property vertices for the inner surface (same uv), offset along -normal
    let props = Array.from(m.props), posOf = Array.from(m.posOf);
    let numPos = m.numPos;
    let innerProp = new Uint32Array(m.posOf.length);
    for(let v = 0; v < m.posOf.length; v++) {
        let pi = m.posOf[v];
        let n = new THREE.Vector3(nrm[pi * 3], nrm[pi * 3 + 1], nrm[pi * 3 + 2]); if(n.lengthSq() > 0) n.normalize();
        innerProp[v] = props.length / 5;
        props.push(m.props[v * 5] - n.x * t, m.props[v * 5 + 1] - n.y * t, m.props[v * 5 + 2] - n.z * t, m.props[v * 5 + 3], m.props[v * 5 + 4]);
        posOf.push(numPos + pi);
    }
    let triVerts = [];
    for(let tr of tris) {
        let cs = [m.corner[tr * 3], m.corner[tr * 3 + 1], m.corner[tr * 3 + 2]];
        if(o.flipped[tr]) cs.reverse();
        triVerts.push(cs[0], cs[1], cs[2]);
        triVerts.push(innerProp[cs[0]], innerProp[cs[2]], innerProp[cs[1]]);
    }
    // side walls along boundary loops: outer edge a->b (as the triangle has it) pairs with inner b'->a'
    let firstProp = new Map();
    for(let v = 0; v < m.posOf.length; v++) if(!firstProp.has(m.posOf[v])) firstProp.set(m.posOf[v], v);
    for(let loop of loops) {
        let n = loop.length;
        for(let k = 0; k < n; k++) {
            let a = loop[k], b = loop[(k + 1) % n];
            let pa = firstProp.get(a), pb = firstProp.get(b), ia = innerProp[pa], ib = innerProp[pb];
            // the loop runs b->a relative to the triangle winding (see boundaryLoops); build the quad outward
            triVerts.push(pb, pa, ia, pb, ia, ib);
        }
    }
    return { props: new Float32Array(props), posOf: Uint32Array.from(posOf), triVerts: new Uint32Array(triVerts) };
}

/** Count pairs of non-adjacent triangles that intersect (self-intersection test). */
export function selfIntersections(soup, limit = 1) {
    let geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(soup, 3));
    let bvh = new MeshBVH(geom);
    let count = 0;
    let matrix = new THREE.Matrix4();
    const s1 = new ExtendedTriangle(), s2 = new ExtendedTriangle(), c = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
    const shrink = (t, out) => { // pull corners 0.2% toward the centroid so touching is not crossing
        t.getMidpoint(c);
        out.a.copy(t.a).lerp(c, 0.002); out.b.copy(t.b).lerp(c, 0.002); out.c.copy(t.c).lerp(c, 0.002);
        out.needsUpdate = true;
        return out;
    };
    bvh.bvhcast(bvh, matrix, {
        intersectsTriangles(t1, t2, i1, i2) {
            if(i1 >= i2) return false;
            // skip triangles sharing a vertex position
            for(let a = 0; a < 3; a++) for(let b = 0; b < 3; b++) if(t1[['a', 'b', 'c'][a]].distanceToSquared(t2[['a', 'b', 'c'][b]]) < 1e-12) return false;
            // coplanar pairs (overlapping decals, T-junction neighbours) are left to the union
            t1.getNormal(n1); t2.getNormal(n2);
            if(Math.abs(n1.dot(n2)) > 0.9999 && Math.abs(n1.dot(c.subVectors(t2.a, t1.a))) < 1e-5) return false;
            if(shrink(t1, s1).intersectsTriangle(shrink(t2, s2))) { count++; return count >= limit; }
            return false;
        }
    });
    return count;
}
