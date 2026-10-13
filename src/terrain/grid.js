/** Sparse chunk grid shared by server and client. Chunk (x, y, z) covers
 *  [x*CHUNK_SIZE, (x+1)*CHUNK_SIZE) on each axis and is addressed by the
 *  string key "x,y,z". A world config bounds the grid and names the box of
 *  implicit rock; everything else unstored is air. Outside the bounds the
 *  underside is solid and the sides and top are open sky. */
export const CHUNK_SIZE = 10.0;
export const HALF = CHUNK_SIZE / 2;

/** The sandbox default: a 100 m cube centred on the origin, solid below y=0. */
export const DEFAULT_WORLD = Object.freeze({
    bounds: { min: [-5, -5, -5], max: [4, 4, 4] },   // inclusive chunk coords
    rock:   { min: [-5, -5, -5], max: [4, -1, 4] },  // implicit solid chunks (null = none)
});

export const key = (x, y, z) => `${x},${y},${z}`;
const parsed = new Map();
/** [x, y, z] of a key (cached). */
export function coords(k) {
    let c = parsed.get(k);
    if(!c) { c = k.split(',').map(Number); parsed.set(k, c); }
    return c;
}
export function isValidKey(k) { return typeof k === 'string' && /^-?\d{1,6},-?\d{1,6},-?\d{1,6}$/.test(k); }

export function chunkMin(k) { let [x, y, z] = coords(k); return { x: x * CHUNK_SIZE, y: y * CHUNK_SIZE, z: z * CHUNK_SIZE }; }
export function chunkCenter(k) { let [x, y, z] = coords(k); return { x: x * CHUNK_SIZE + HALF, y: y * CHUNK_SIZE + HALF, z: z * CHUNK_SIZE + HALF }; }

const inBox = (box, x, y, z) => !!box && x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2];
export function inBounds(world, x, y, z) { return inBox(world.bounds, x, y, z); }
export function isRock(world, x, y, z) { return inBox(world.rock, x, y, z); }
export function isRockKey(world, k) { let [x, y, z] = coords(k); return isRock(world, x, y, z); }

/** Key of the chunk containing a world position, or null outside the bounds. */
export function chunkAt(world, p) {
    let x = Math.floor(p.x / CHUNK_SIZE), y = Math.floor(p.y / CHUNK_SIZE), z = Math.floor(p.z / CHUNK_SIZE);
    return inBounds(world, x, y, z) ? key(x, y, z) : null;
}

/** Keys of every in-bounds chunk whose box intersects [min, max] (world units). */
export function chunksInBox(world, min, max) {
    let out = [];
    let b = world.bounds;
    let x0 = Math.max(b.min[0], Math.floor(min.x / CHUNK_SIZE)), x1 = Math.min(b.max[0], Math.floor(max.x / CHUNK_SIZE));
    let y0 = Math.max(b.min[1], Math.floor(min.y / CHUNK_SIZE)), y1 = Math.min(b.max[1], Math.floor(max.y / CHUNK_SIZE));
    let z0 = Math.max(b.min[2], Math.floor(min.z / CHUNK_SIZE)), z1 = Math.min(b.max[2], Math.floor(max.z / CHUNK_SIZE));
    for(let x = x0; x <= x1; x++) for(let y = y0; y <= y1; y++) for(let z = z0; z <= z1; z++) out.push(key(x, y, z));
    return out;
}

/** Keys of every implicit rock chunk. */
export function rockChunks(world) {
    let out = [];
    let r = world.rock;
    if(!r) return out;
    for(let x = r.min[0]; x <= r.max[0]; x++) for(let y = r.min[1]; y <= r.max[1]; y++) for(let z = r.min[2]; z <= r.max[2]; z++) out.push(key(x, y, z));
    return out;
}

/** The six chunk faces: axis (0=x,1=y,2=z) and direction. Opposite face of f is f ^ 1. */
export const FACES = [
    { axis: 0, dir: -1 }, { axis: 0, dir: 1 },
    { axis: 1, dir: -1 }, { axis: 1, dir: 1 },
    { axis: 2, dir: -1 }, { axis: 2, dir: 1 },
];

/** Neighbouring chunk key across a face, or null outside the bounds. */
export function neighbour(world, k, face) {
    let c = coords(k).slice();
    let f = FACES[face];
    c[f.axis] += f.dir;
    return inBounds(world, c[0], c[1], c[2]) ? key(c[0], c[1], c[2]) : null;
}

/** Whether the space beyond a boundary face counts as solid: only the underside. */
export function outsideIsSolid(face) { return face === 2; }

/** Validate a world config from the wire or storage; returns a clean copy or null. */
export function sanitizeWorld(w) {
    const box = (b) => {
        if(!b || !Array.isArray(b.min) || !Array.isArray(b.max)) return null;
        let min = b.min.slice(0, 3).map(v => Math.trunc(+v)), max = b.max.slice(0, 3).map(v => Math.trunc(+v));
        if(min.length < 3 || max.length < 3 || [...min, ...max].some(v => !Number.isFinite(v) || Math.abs(v) > 100000)) return null;
        for(let i = 0; i < 3; i++) if(max[i] < min[i]) return null;
        return { min, max };
    };
    let bounds = box(w && w.bounds);
    if(!bounds) return null;
    return { bounds, rock: box(w.rock) };
}
