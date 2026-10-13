import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { M } from '/home/agent-untrusted/Desktop/WorldParty/assets/manifold-3d/manifold.js';
import { weld, dedupe, orient, boundaryLoops, fillLoop, toMeshInput, thicken, selfIntersections } from '/home/agent-untrusted/Desktop/WorldParty/tools/lib/repair.mjs';
const wasm = readFileSync('/home/agent-untrusted/Desktop/WorldParty/assets/manifold-3d/manifold.wasm');
const mod = await WebAssembly.compile(wasm);
const manifold = await M({ instantiateWasm: (imports, cb) => { WebAssembly.instantiate(mod, imports).then(i => cb(i)); return {}; } });
manifold.setup();
const { Manifold } = manifold;
const base = Manifold.reserveIDs(8);
function partFrom(geometry) {
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    return { positions: new Float32Array(g.attributes.position.array), uvs: new Float32Array(g.attributes.uv ? g.attributes.uv.array : g.attributes.position.count * 2), material: 0 };
}
function run(name, part, flipSome = false) {
    if(flipSome) for(let t = 0; t < part.positions.length / 9; t += 2) { let o = t * 9; for(let k = 0; k < 3; k++) { let tmp = part.positions[o + 3 + k]; part.positions[o + 3 + k] = part.positions[o + 6 + k]; part.positions[o + 6 + k] = tmp; } }
    let m = weld(part, 0.0005);
    let tris = dedupe(m);
    let o = orient(m, tris);
    let loops = boundaryLoops(m, tris, o);
    console.log(`== ${name}: tris ${tris.length}, positions ${m.numPos}, propVerts ${m.posOf.length}, comps ${o.components}, nonManifold ${o.nonManifoldEdges}, loops ${loops.map(l => l.length)}`);
    try {
        let mesh = toMeshInput(m, tris, o, [], manifold, base);
        let mf = new Manifold(mesh);
        console.log('  closed ok: vol', mf.volume().toFixed(3), 'tris', mf.numTri(), 'status', mf.status());
    } catch(e) { console.log('  closed failed:', e.message); }
    if(loops.length) {
        try {
            let th = thicken(m, tris, o, loops, 0.1);
            let first = new Map(), from = [], to = [];
            for(let v = 0; v < th.posOf.length; v++) { let f = first.get(th.posOf[v]); if(f === undefined) first.set(th.posOf[v], v); else { from.push(v); to.push(f); } }
            let mesh = new manifold.Mesh({ numProp: 5, vertProperties: th.props, triVerts: th.triVerts, mergeFromVert: new Uint32Array(from), mergeToVert: new Uint32Array(to), runIndex: new Uint32Array([0, th.triVerts.length]), runOriginalID: new Uint32Array([base]) });
            let mf = new Manifold(mesh);
            console.log('  thickened ok: vol', mf.volume().toFixed(3), 'tris', mf.numTri(), 'selfX', selfIntersections(soupOf(mf)));
        } catch(e) { console.log('  thickened failed:', e.message); }
    }
}
function soupOf(mf) { let mesh = mf.getMesh(); let np = mesh.numProp, s = new Float32Array(mesh.triVerts.length * 3); for(let i = 0; i < mesh.triVerts.length; i++) { let v = mesh.triVerts[i] * np; s[i*3]=mesh.vertProperties[v]; s[i*3+1]=mesh.vertProperties[v+1]; s[i*3+2]=mesh.vertProperties[v+2]; } return s; }
run('box', partFrom(new THREE.BoxGeometry(1, 1, 1)));
run('box flipped', partFrom(new THREE.BoxGeometry(1, 1, 1)), true);
run('sphere', partFrom(new THREE.SphereGeometry(1, 12, 8)));
run('plane', partFrom(new THREE.PlaneGeometry(2, 2, 2, 2)));
run('cylinder open', partFrom(new THREE.CylinderGeometry(1, 1, 2, 12, 1, true)));
