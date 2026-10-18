/** Terrain materials shared by client and server.
 *
 *  A world's material table is the built-in palette (flat colours, ids 0..7,
 *  the ones the CSG brush cycles through) followed by whatever an imported
 *  world brought along (textured slots with their own UVs). Material ids are
 *  stored per triangle; the server tags every brush and implicit chunk with a
 *  Manifold original ID per material so booleans preserve provenance, and
 *  per-vertex UVs ride through the booleans as Manifold properties. */
/** Palette textures are CC0 from Poly Haven (assets/textures/README.md) and are mapped triplanar in world space,
 *  `scale` metres per tile, so carved faces (which have no UVs) look right too. Imported worlds' own materials
 *  (`scale` 0 or absent) sample by the mesh UVs instead. `tint` multiplies the texture by the colour. */
export const TEXTURES = 'assets/textures/';
// `smooth`: the client blends vertex normals across adjacent faces of smooth materials (within SMOOTH_ANGLE), so
// carved craters and tunnels read as curved; built stone keeps its hard edges.
export const MATERIALS = [
    { id: 0, name: 'Stone', color: 0x8a8a8a, texture: TEXTURES + 'cliff_side.jpg', scale: 6 },
    { id: 1, name: 'Dirt',  color: 0x6b4a2b, texture: TEXTURES + 'brown_mud_dry.jpg', scale: 4, smooth: true },
    { id: 2, name: 'Grass', color: 0x4a8f3a, texture: TEXTURES + 'leafy_grass.jpg', scale: 4, smooth: true },
    { id: 3, name: 'Sand',  color: 0xd8c27a, texture: TEXTURES + 'coast_sand_01.jpg', scale: 4, smooth: true },
    { id: 4, name: 'Snow',  color: 0xeef2f5, texture: TEXTURES + 'snow_02.jpg', scale: 4, smooth: true },
    { id: 5, name: 'Brick', color: 0x9b3f2f, texture: TEXTURES + 'brick_wall_02.jpg', scale: 3 },
    { id: 6, name: 'Metal', color: 0x6c7a89, texture: TEXTURES + 'metal_plate.jpg', scale: 2 },
    { id: 7, name: 'Lava',  color: 0xff5a1f },
];
export const DEFAULT_MATERIAL = 0;
export const MAX_MATERIALS = 255;

/** Full material table for a world config: palette first, then the world's own entries. */
export function materialTable(world) {
    let extra = (world && world.materials) || [];
    return MATERIALS.concat(extra.map((m, i) => ({ id: MATERIALS.length + i, name: m.name || `material ${i}`, color: m.color ?? 0x808080, texture: m.texture || null, scale: m.scale || 0, tint: !!m.tint, smooth: !!m.smooth })));
}
export function materialColor(id, table = MATERIALS) { return (table[id] || table[DEFAULT_MATERIAL]).color; }
export function clampMaterial(id, count = MATERIALS.length) { id = id | 0; return id >= 0 && id < count ? id : DEFAULT_MATERIAL; }

/** Validate an imported material list (world config). */
export function sanitizeMaterials(list) {
    if(!Array.isArray(list)) return [];
    let out = [];
    for(let m of list.slice(0, MAX_MATERIALS - MATERIALS.length)) {
        if(!m || typeof m !== 'object') continue;
        let color = Number.isInteger(m.color) ? (m.color & 0xffffff) : 0x808080;
        let texture = typeof m.texture === 'string' && m.texture.length <= 300 ? m.texture : null;
        let entry = { name: String(m.name || '').slice(0, 64), color, texture };
        if(texture && typeof m.scale === 'number' && m.scale > 0 && m.scale <= 1000) entry.scale = m.scale; // world-space triplanar tiling
        if(texture && m.tint) entry.tint = true;
        if(m.smooth) entry.smooth = true;
        out.push(entry);
    }
    return out;
}
