#!/usr/bin/env node
/**
 * Fort War level generator: "Twin Forts", a 2fort-style map built from CSG primitives with Manifold and
 * written as a world manifest (same format as tools/import-world.mjs) with the game rules embedded in
 * `world.game` (teams, spawns, vaults, supply slots, buried caches). Upload it to a room with
 * `?room=<name>&import=/assets/worlds/fortwar.json`.
 *
 *   node tools/gen-fortwar.mjs [--out assets/worlds/fortwar.json]
 *
 * Layout (x is the long axis, Red at -x and Blue at +x, y up, ground at y = 0):
 *   - Two mirrored forts 72 m apart: 6.5 m walls with crenellations and a walkway, four towers, a wooden
 *     front gate, a courtyard, and a vault 6 m underground reached by a ramp from the courtyard.
 *   - A 16 m wide, 6 m deep gorge between them with a stone bridge and a mid plaza (destructible: cut both
 *     ends and the whole deck drops into the gorge). Ramps out of the gorge at z = ±10..22.
 *   - Sewers: a tunnel from each vault to the gorge wall under the bridge (2fort's water route).
 *   - North: a rocky high road (ridge at y = 6) with a natural arch over the gorge and crags next to the
 *     forts' north walls from which a flanker can jump onto the walls.
 *   - South: a cave route inside a rocky bank, with a covered tube crossing the gorge and windows north.
 *   - Buried caches of neutral supplies (sealed pockets: cost nothing until dug into) under each courtyard,
 *     under the gorge banks and a deep hoard under the middle of the bridge.
 *   Everything is terrain, so any wall can be breached, any floor dug through, and anything built falls
 *   when unsupported.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { M } from '../assets/manifold-3d/manifold.js';
import { encodeChunkMesh, hashBytes } from '../src/net/codec.js';
import { MATERIALS, DEFAULT_MATERIAL, MAX_MATERIALS } from '../src/terrain/materials.js';
import { CHUNK_SIZE, key as chunkKey } from '../src/terrain/grid.js';

const argv = process.argv.slice(2);
const opt = (name, def) => { let i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const out = opt('out', 'assets/worlds/fortwar.json');

// ---- materials ----------------------------------------------------------------
const STONE = 0, DIRT = 1, GRASS = 2, SAND = 3;
const EXTRA = [ // textured triplanar (see src/terrain/materials.js); the team stones are one light block texture tinted.
    // The tint multiplies the texture in linear light, so a saturated colour makes the walls read as unlit whatever the
    // sun does (0x4d78c4 is 0.07/0.19/0.55 linear): keep the tints pale.
    // `hardness` (src/terrain/materials.js): a rocket gets 1/hardness as far into it as into dirt; the walls and the
    // vault's lining take several rockets, the wooden gate is the soft spot, the level's rock barely moves
    // `core`: what a blast or a dig into it exposes (Terrain.tagBrush). Cut blocks show broken rock in the same tint:
    // the block texture is mapped in world space, so a crater lined with it continued the wall's courses across the
    // hole and read as glass. The cobbles are paving on dirt (the courtyard, the bridge): a hole through them is dirt,
    // not a shaft of cobble all the way down. The broken kinds come last so the earlier ids (stored in the chunks) stay put.
    { name: 'Red Stone',  color: 0xe3a094, texture: 'assets/textures/large_sandstone_blocks.jpg', scale: 5, tint: true, hardness: 3, core: 13 },
    { name: 'Blue Stone', color: 0xa3bdea, texture: 'assets/textures/large_sandstone_blocks.jpg', scale: 5, tint: true, hardness: 3, core: 14 },
    { name: 'Wood',       color: 0x8a5a2b, texture: 'assets/textures/weathered_brown_planks.jpg', scale: 3, hardness: 1.5 },
    { name: 'Cobble',     color: 0x6f6f78, texture: 'assets/textures/cobblestone_floor_08.jpg', scale: 4, hardness: 3, core: DIRT },
    { name: 'Dark Rock',  color: 0xd8d0c8, texture: 'assets/textures/dark_rock.jpg', scale: 7, tint: true, hardness: 5 },
    { name: 'Red Stone (broken)',  color: 0xe8a898, texture: 'assets/textures/dark_rock.jpg', scale: 2.5, tint: true, hardness: 3 },
    { name: 'Blue Stone (broken)', color: 0xa8c0ec, texture: 'assets/textures/dark_rock.jpg', scale: 2.5, tint: true, hardness: 3 }, // the texture is lightened in the asset (README); it averaged 0.015 linear, and a tint only darkens, so the slabs at the level's edge were black in full sun
];
const RED_STONE = MATERIALS.length, BLUE_STONE = RED_STONE + 1, WOOD = RED_STONE + 2, COBBLE = RED_STONE + 3, DARK = RED_STONE + 4;
if(EXTRA[0].core !== RED_STONE + 5 || EXTRA[1].core !== RED_STONE + 6) throw new Error('core ids out of step with the material list');

// ---- manifold -----------------------------------------------------------------
const wasm = readFileSync(resolve(dirname(new URL(import.meta.url).pathname), '../assets/manifold-3d/manifold.wasm'));
const wasmModule = await WebAssembly.compile(wasm);
const manifold = await M({ instantiateWasm: (imports, cb) => { WebAssembly.instantiate(wasmModule, imports).then(i => cb(i)); return {}; } });
manifold.setup();
const { Manifold } = manifold;
const NUM_PROP = 5;
const materialBase = Manifold.reserveIDs(MAX_MATERIALS);

/** Tag a manifold with one material (5 properties per vertex, zero UVs, one run). Takes ownership. */
function withMat(src, material) {
    let m = src.getMesh();
    let np = m.numProp, nv = m.vertProperties.length / np;
    let props = new Float32Array(nv * NUM_PROP);
    for(let i = 0; i < nv; i++) { props[i * NUM_PROP] = m.vertProperties[i * np]; props[i * NUM_PROP + 1] = m.vertProperties[i * np + 1]; props[i * NUM_PROP + 2] = m.vertProperties[i * np + 2]; }
    let mesh = new manifold.Mesh({ numProp: NUM_PROP, vertProperties: props, triVerts: new Uint32Array(m.triVerts), runIndex: new Uint32Array([0, m.triVerts.length]), runOriginalID: new Uint32Array([materialBase + material]) });
    mesh.merge();
    src.delete();
    return new Manifold(mesh);
}

/** Axis-aligned box from two corners (either order on each axis). */
function box(x0, x1, y0, y1, z0, z1, mat) {
    let min = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
    return withMat(Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).translate(min), mat);
}
/** Vertical cylinder standing on y0. */
function cyl(cx, cz, y0, y1, r, mat, seg = 20) {
    return withMat(Manifold.cylinder(y1 - y0, r, r, seg).rotate([-90, 0, 0]).translate([cx, y0, cz]), mat);
}
/** Convex hull of points [[x,y,z], ...]. */
function hull(pts, mat) { return withMat(Manifold.hull(pts), mat); }
/** Union of a list (deletes the inputs). */
function union(list) { let r = Manifold.union(list); for(let m of list) m.delete(); return r; }
function sub(a, b) { let r = a.subtract(b); a.delete(); b.delete(); return r; }
function add(a, b) { let r = a.add(b); a.delete(); b.delete(); return r; }

/** Sloped tunnel (or ramp fill): hull of a rectangle at the near end and one at the far end.
 *  Each end is {x0,x1,y0,y1,z} for a run along z, or {z0,z1,y0,y1,x} for a run along x. */
function slopeZ(nearZ, farZ, x0, x1, nearY0, nearY1, farY0, farY1, mat) {
    return hull([[x0, nearY0, nearZ], [x1, nearY0, nearZ], [x0, nearY1, nearZ], [x1, nearY1, nearZ],
                 [x0, farY0, farZ], [x1, farY0, farZ], [x0, farY1, farZ], [x1, farY1, farZ]], mat);
}
function slopeX(nearX, farX, z0, z1, nearY0, nearY1, farY0, farY1, mat) {
    return hull([[nearX, nearY0, z0], [nearX, nearY0, z1], [nearX, nearY1, z0], [nearX, nearY1, z1],
                 [farX, farY0, z0], [farX, farY0, z1], [farX, farY1, z0], [farX, farY1, z1]], mat);
}
/** Solid wedge: floor from (nearX, yLow) rising to (farX, yHigh), filled down to yBase. */
function wedgeX(nearX, farX, z0, z1, yBase, yLow, yHigh, mat) {
    return hull([[nearX, yBase, z0], [nearX, yBase, z1], [nearX, yLow, z0], [nearX, yLow, z1], [farX, yBase, z0], [farX, yBase, z1], [farX, yHigh, z0], [farX, yHigh, z1]], mat);
}
function wedgeZ(nearZ, farZ, x0, x1, yBase, yLow, yHigh, mat) {
    return hull([[x0, yBase, nearZ], [x1, yBase, nearZ], [x0, yLow, nearZ], [x1, yLow, nearZ], [x0, yBase, farZ], [x1, yBase, farZ], [x0, yHigh, farZ], [x1, yHigh, farZ]], mat);
}

// deterministic "random" for rock lumps
let seed = 1337;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ---- the map -------------------------------------------------------------------
const X = 80, Z = 40;              // half extents (chunk aligned)
const SURFACE = 0, BOTTOM = -40;
const WALL_H = 6.5, MERLON_H = 7.6, WALK_Y = 5.5, TOWER_H = 9.5;
const GORGE_W = 8, GORGE_D = 6, BED = -GORGE_D - 0.6;
const NUDGE = 0.1;

let t0 = Date.now();
let adds = [], cuts = [], late = [], lateCuts = [], last = [];

// Ground: dirt with a grass skin
adds.push(box(-X - 1, X, BOTTOM - 1, SURFACE - 0.6, -Z - 1, Z, DIRT));
adds.push(box(-X - 1, X, SURFACE - 0.6, SURFACE, -Z - 1, Z, GRASS));
// Border rim behind the forts
adds.push(box(-X, -X + 2, 0, 4, -Z, Z, DARK));
adds.push(box(X - 2, X, 0, 4, -Z, Z, DARK));

/** One fort. s = -1 (Red, at negative x) or +1 (Blue). Coordinates below are written for Red and mirrored by s. */
function fort(s, mat) {
    const x = v => -s * v; // written for Red (negative x); Blue is the mirror
    const T = 2.5;
    // walls
    adds.push(box(x(-38.5), x(-36), 0, WALL_H, -13, 13, mat));          // front
    adds.push(box(x(-62), x(-59.5), 0, WALL_H, -13, 13, mat));          // back
    adds.push(box(x(-62), x(-36), 0, WALL_H, -13, -10.5, mat));         // south side
    adds.push(box(x(-62), x(-36), 0, WALL_H, 10.5, 13, mat));           // north side
    // merlons along every wall top
    for(let z = -12.4; z < 12.5; z += 2.2) { adds.push(box(x(-38.5), x(-36), WALL_H, MERLON_H, z, z + 1.1, mat)); adds.push(box(x(-62), x(-59.5), WALL_H, MERLON_H, z, z + 1.1, mat)); }
    for(let xx = -61; xx < -37; xx += 2.2) { adds.push(box(x(xx), x(xx + 1.1), WALL_H, MERLON_H, -13, -10.5, mat)); adds.push(box(x(xx), x(xx + 1.1), WALL_H, MERLON_H, 10.5, 13, mat)); }
    // towers (solid, parapet ring on top)
    for(let [tx, tz] of [[-36.5, 12.5], [-36.5, -12.5], [-61.5, 12.5], [-61.5, -12.5]]) {
        adds.push(box(x(tx - 2.5), x(tx + 2.5), 0, TOWER_H, tz - 2.5, tz + 2.5, mat));
        adds.push(box(x(tx - 2.5), x(tx + 2.5), TOWER_H, TOWER_H + 1, tz - 2.5, tz + 2.5, mat));
        lateCuts.push(box(x(tx - 2), x(tx + 2), TOWER_H, TOWER_H + 1.5, tz - 2, tz + 2, mat));
        // tower access: a 1 m step block from the walkway up onto the front towers
        if(tx > -40) adds.push(box(x(-41.5), x(-39), WALK_Y, WALK_Y + 2, tz > 0 ? 8 : -10, tz > 0 ? 10 : -8, mat));
    }
    // walkway behind the front wall, with ramps up from the courtyard along the side walls
    adds.push(box(x(-41.6), x(-38.4), WALK_Y - 0.5, WALK_Y, -10.6, 10.6, mat));
    adds.push(wedgeX(x(-53), x(-41.5), 8, 10.6, 0, 0, WALK_Y, mat));
    adds.push(wedgeX(x(-53), x(-41.5), -10.6, -8, 0, 0, WALK_Y, mat));
    // gate: opening in the front wall, closed by a wooden gate (destructible)
    lateCuts.push(box(x(-39), x(-35.5), 0, 4.5, -2.2, 2.2, mat));
    last.push(box(x(-37.6), x(-37), 0, 4.5, -2.2, 2.2, WOOD));
    // courtyard cobbles replace the grass inside the walls
    cuts.push(box(x(-59.5), x(-38.5), SURFACE - 0.6, SURFACE + 0.01, -10.5, 10.5, DIRT));
    late.push(box(x(-59.5), x(-38.5), SURFACE - 0.6, SURFACE, -10.5, 10.5, COBBLE));
    // vault: a room under the back of the fort, team coloured walls
    lateCuts.push(box(x(-60), x(-50), -6, -2.5, -5, 5, mat));
    // ramp down into the vault from the north side of the courtyard (26.6 degrees)
    lateCuts.push(slopeZ(10.5, -1.5, x(-56), x(-53), 0, 3.4, -6, -2.6, mat));
    // sewer: vault -> gorge wall, with a jog so there is no straight line of sight
    lateCuts.push(box(x(-50.5), x(-30), -6, -2.8, -1.5, 1.5, STONE));
    lateCuts.push(box(x(-32), x(-28), -6, -2.8, -1.5, 6.5, STONE));
    lateCuts.push(box(x(-30), x(-7), -6, -2.8, 3.5, 6.5, STONE));
    // crag beside the north wall: a jump onto the wall from the high road
    adds.push(box(x(-50), x(-34), 0, 7.5, 17, 22.5, DARK));
    adds.push(cyl(x(-46), 20, 0, 8.5, 3.5, DARK));
    // cave route entrance in the south bank, facing the fort
    lateCuts.push(box(x(-45), x(-41), 0, 3.2, -26, -19.5, STONE));
    // buried cache under the courtyard (sealed)
    lateCuts.push(box(x(-47.5), x(-44.5), -10, -7.5, 5, 8, DIRT));
    // buried cache under the gorge's south bank near the bridge
    lateCuts.push(box(x(-15.5), x(-12.5), -11, -8.5, -13, -10, DIRT));
}
fort(-1, RED_STONE);
fort(+1, BLUE_STONE);

// North ridge: the high road
adds.push(box(-X, X, 0, 6, 22, Z, DARK));
for(let i = 0; i < 26; i++) {
    let cx = -78 + i * 6.2 + rnd() * 2, cz = 25 + rnd() * 13, r = 2.5 + rnd() * 3.5, h = 6.5 + rnd() * 3;
    if(Math.abs(cx) < 11) continue; // keep the canyon clear for the arch
    adds.push(cyl(cx, cz, 0, h, r, DARK, 10));
}
adds.push(box(-X, X, 0, 9, 37, Z, DARK)); // back wall of the ridge
// ramps onto the ridge (28 degrees)
for(let s of [-1, 1]) for(let rx of [14, 44]) adds.push(wedgeZ(11, 22.2, s * rx - 2, s * rx + 2, 0, 0, 6, DIRT));

// South bank: the cave route
adds.push(box(-X, X, 0, 5, -Z, -20, DARK));
for(let i = 0; i < 20; i++) {
    let cx = -78 + i * 8 + rnd() * 3, cz = -38 + rnd() * 6, r = 3 + rnd() * 3, h = 5.5 + rnd() * 3;
    adds.push(cyl(cx, cz, 0, h, r, DARK, 10));
}

let S = union(adds);
// Gorge (walls dirt), its bed, and ramps out of it
cuts.push(box(-GORGE_W, GORGE_W, BED, SURFACE + 0.01, -Z, Z, DIRT));
S = sub(S, union(cuts));
late.push(box(-GORGE_W, GORGE_W, BED, BED + 0.6, -Z, Z, SAND));
late.push(wedgeZ(10, 22, -GORGE_W, GORGE_W, BED, BED + 0.6, 0, DIRT));
late.push(wedgeZ(-10, -22, -GORGE_W, GORGE_W, BED, BED + 0.6, 0, DIRT));
// Bridge: deck, parapets, mid plaza with a ruined tower stump
late.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, -1, 0, -4, 4, COBBLE));
late.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, 0, 1.1, -4.5, -4, COBBLE));
late.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, 0, 1.1, 4, 4.5, COBBLE));
late.push(box(-6, 6, -1, 0, -9, 9, COBBLE));
late.push(cyl(0, 6.5, 0, 3, 2.4, STONE, 16));
lateCuts.push(cyl(0, 6.5, 0.6, 3.5, 1.7, STONE, 16));
lateCuts.push(box(-1, 1, 0.6, 2.4, 3.5, 6.5, STONE)); // doorway in the stump
// Natural arch over the gorge on the high road
late.push(box(-GORGE_W - 1.5, GORGE_W + 1.5, 3.5, 7, 29, 35, DARK));
// Covered tube over the gorge on the cave route
late.push(box(-GORGE_W - 1.5, GORGE_W + 1.5, -0.8, 4, -30, -25, DARK));
S = add(S, union(late));
// Cave tunnel through the south bank (and the tube), windows facing north
lateCuts.push(box(-44, 44, 0, 3.2, -29, -26, STONE));
for(let wx of [-28, -12, 12, 28]) lateCuts.push(box(wx - 1, wx + 1, 1, 3, -26.5, -19.5, STONE));
// The deep hoard under the middle of the bridge
lateCuts.push(box(-2, 2, -15, -12, -2, 2, STONE));
S = sub(S, union(lateCuts));
S = add(S, union(last));

// ---- treasure ----------------------------------------------------------------
// Neutral supplies scattered over the level (the vaults start empty): the stump on the bridge plaza, the gorge bed
// beside the plaza, the arch, inside the tube, each crag, each sewer jog, each cave entrance, and each fort's
// front tower top. Coordinates before the nudge; each spot must be open with a floor right under it.
const scatter = [[0, 1.1, 6.5], [3, -5.5, 9.5], [-3, -5.5, -9.5], [0, 7.5, 32], [0, 0.5, -27.5]];
for(let s of [-1, 1]) scatter.push([s * 38, 8.0, 19.5], [s * 30, -5.5, 5], [s * 43, 0.5, -22], [s * 36.5, 10.0, 12.5]);
function clearSpot(p) {
    let probe = Manifold.cube([0.9, 0.9, 0.9], true).translate(p), hit = S.intersect(probe), v = hit.volume(); hit.delete(); probe.delete();
    let under = Manifold.cube([0.9, 0.6, 0.9], true).translate([p[0], p[1] - 0.8, p[2]]), floor = S.intersect(under), vf = floor.volume(); floor.delete(); under.delete();
    return v < 1e-6 && vf > 0.05;
}
for(let p of scatter) if(!clearSpot(p)) throw new Error(`supply spot ${p} is blocked or has no floor`);
// Nothing may lie exactly on a chunk plane: where a solid only touches a chunk face from outside (the ground's top
// under the chunk above, a wall face on x = -50), Manifold's chunk intersection leaves a zero-thickness sheet that
// later carves retriangulate into slivers across the hole. Shifting the whole design by NUDGE takes every designed
// floor, wall and ceiling off the multiples of 10 (the generator's numbers stay round; config coordinates shift too).
S = S.translate([NUDGE, NUDGE, NUDGE]);
console.log(`solid: ${S.numTri()} triangles, ${S.volume().toFixed(0)} m³, ${Date.now() - t0} ms`);

// ---- chunks -------------------------------------------------------------------
const bounds = { min: [-X / CHUNK_SIZE, BOTTOM / CHUNK_SIZE, -Z / CHUNK_SIZE], max: [X / CHUNK_SIZE - 1, 3, Z / CHUNK_SIZE - 1] };
const rock = { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [bounds.max[0], -1, bounds.max[2]] };
let chunks = {}, totalTris = 0, maxTris = 0, totalBytes = 0, skipped = 0;
for(let x = bounds.min[0]; x <= bounds.max[0]; x++) for(let y = bounds.min[1]; y <= bounds.max[1]; y++) for(let z = bounds.min[2]; z <= bounds.max[2]; z++) {
    let cube = withMat(Manifold.cube([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE]).translate(x * CHUNK_SIZE, y * CHUNK_SIZE, z * CHUNK_SIZE), DEFAULT_MATERIAL);
    let part = S.intersect(cube);
    cube.delete();
    if(part.isEmpty()) { part.delete(); if(y <= rock.max[1]) throw new Error(`chunk ${x},${y},${z} is in the rock box but fully hollow`); continue; }
    let inRock = y <= rock.max[1];
    // Untouched rock below the surface row stays implicit (free); the surface row is stored for its grass skin
    if(inRock && y < -1 && Math.abs(part.volume() - CHUNK_SIZE ** 3) < 1e-3) { part.delete(); skipped++; continue; }
    let mesh = part.getMesh();
    let np = mesh.numProp, props = mesh.vertProperties, tri = mesh.triVerts;
    let numTris = tri.length / 3, numVerts = props.length / np;
    let v = new Float32Array(numVerts * 3);
    for(let i = 0; i < numVerts; i++) { v[i * 3] = props[i * np]; v[i * 3 + 1] = props[i * np + 1]; v[i * 3 + 2] = props[i * np + 2]; }
    let mats = new Uint8Array(numTris);
    for(let r = 0; r < mesh.runOriginalID.length; r++) {
        let idm = mesh.runOriginalID[r] - materialBase; if(idm < 0 || idm >= MAX_MATERIALS) idm = DEFAULT_MATERIAL;
        let start = mesh.runIndex[r] / 3, end = (r + 1 < mesh.runIndex.length ? mesh.runIndex[r + 1] : tri.length) / 3;
        mats.fill(idm, start, end);
    }
    let bytes = encodeChunkMesh(v, new Uint32Array(tri), mats, null);
    chunks[chunkKey(x, y, z)] = { version: hashBytes(bytes), bytes: Buffer.from(bytes).toString('base64') };
    totalTris += numTris; maxTris = Math.max(maxTris, numTris); totalBytes += bytes.length;
    part.delete();
}
S.delete();

// ---- game rules ----------------------------------------------------------------
const nudge = p => p.map(v => v + NUDGE);
const team = (s, name, color, material) => ({
    name, color, material,
    spawns: [-6, -2, 2, 6].map(z => nudge([s * 57, 0.6, z])),
    vault: { min: nudge([Math.min(s * 60, s * 50), -7, -5]), max: nudge([Math.max(s * 60, s * 50), -1.5, 5]) },
    slots: [[57.5, -2], [55, -2], [52.5, -2], [57.5, 2], [55, 2], [52.5, 2]].map(([x, z]) => nudge([s * x, -5.5, z])),
});
const game = {
    mode: 'fortwar',
    surfaceY: SURFACE + NUDGE,
    matchMinutes: 10,
    teams: { red: team(-1, 'Red', '#e03a2f', RED_STONE), blue: team(+1, 'Blue', '#3a7be0', BLUE_STONE) },
    // neutral supplies in the open (the vaults start empty) and in sealed pockets found by digging
    scatter: scatter.map(nudge),
    caches: [[-46, -9.5, 6.5], [46, -9.5, 6.5], [-14, -10.5, -11.5], [14, -10.5, -11.5], [-0.8, -14.5, 0.8], [0.8, -14.5, -0.8]].map(nudge),
    // glow rocks: a virtual field through the ground under the surface (one pebble per ~1.3 m³ cell, in just over half the
    // cells), materialized by the server wherever a tunnel wall passes through one (src/game/rules.js GLOW_ROCK, src/server/GlowRocks.js)
    glowRocks: { seed: 1337, cell: 1.1, density: 0.55 },
    hints: ['Find the Treasure.'],
};

mkdirSync(dirname(out), { recursive: true });
let manifest = { name: 'fortwar', world: { bounds, rock, materials: EXTRA, game }, source: 'tools/gen-fortwar.mjs', chunks, entities: [] };
writeFileSync(out, JSON.stringify(manifest));
console.log(`chunks: ${Object.keys(chunks).length} stored (${skipped} implicit rock), ${totalTris} triangles (max ${maxTris} per chunk), ${(totalBytes / 1024).toFixed(0)} KB`);
console.log(`world: bounds ${JSON.stringify(bounds)} rock ${JSON.stringify(rock)}`);
console.log(`wrote ${out} in ${Date.now() - t0} ms`);
