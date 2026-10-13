/** Chunk grid shared by server and client: a GRID^3 lattice of CHUNK_SIZE
 *  cubes centred on the origin, indexed x*100 + y*10 + z. Unmodified chunks
 *  are implicit: solid below SOLID_BELOW_Y, air above. */
export const GRID = 10;
export const CHUNK_SIZE = 10.0;
export const SOLID_BELOW_Y = 5;
export const CHUNK_COUNT = GRID * GRID * GRID;
export const HALF = CHUNK_SIZE / 2;

export function chunkCoords(index) {
    return { x: Math.floor(index / 100), y: Math.floor(index / 10) % 10, z: index % 10 };
}
export function chunkIndex(x, y, z) { return x * 100 + y * 10 + z; }
export function chunkCenter(index) {
    let c = chunkCoords(index);
    return { x: c.x * CHUNK_SIZE - 45.0, y: c.y * CHUNK_SIZE - 45.0, z: c.z * CHUNK_SIZE - 45.0 };
}
export function isDefaultSolid(index) { return chunkCoords(index).y < SOLID_BELOW_Y; }

/** The six chunk faces: axis (0=x,1=y,2=z) and direction. */
export const FACES = [
    { axis: 0, dir: -1 }, { axis: 0, dir: 1 },
    { axis: 1, dir: -1 }, { axis: 1, dir: 1 },
    { axis: 2, dir: -1 }, { axis: 2, dir: 1 },
];

/** Neighbouring chunk index across a face, or -1 outside the grid. */
export function neighbour(index, face) {
    let c = chunkCoords(index);
    let f = FACES[face];
    let k = f.axis === 0 ? 'x' : f.axis === 1 ? 'y' : 'z';
    c[k] += f.dir;
    if(c[k] < 0 || c[k] >= GRID) return -1;
    return chunkIndex(c.x, c.y, c.z);
}

/** Whether the space beyond a grid-boundary face counts as solid. Nothing can get
 *  under the world (players and bodies are reset at y=-100), so the underside is
 *  treated as solid; the sides and top are open. */
export function outsideIsSolid(face) { return face === 2; }

/**
 * Bitmask of faces of `index` that border something other than unmodified solid
 * rock. `defaultSolidAt(i)` reports whether chunk i is an unmodified solid chunk.
 * Bit f set => face f is exposed. A mask of 0 means the chunk is fully buried.
 */
export function exposedFaces(index, defaultSolidAt) {
    let mask = 0;
    for(let f = 0; f < 6; f++) {
        let n = neighbour(index, f);
        let solid = n < 0 ? outsideIsSolid(f) : defaultSolidAt(n);
        if(!solid) mask |= 1 << f;
    }
    return mask;
}
