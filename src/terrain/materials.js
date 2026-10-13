/** Terrain materials shared by client and server.
 *
 *  A world's material table is the built-in palette (flat colours, ids 0..7,
 *  the ones the CSG brush cycles through) followed by whatever an imported
 *  world brought along (textured slots with their own UVs). Material ids are
 *  stored per triangle; the server tags every brush and implicit chunk with a
 *  Manifold original ID per material so booleans preserve provenance, and
 *  per-vertex UVs ride through the booleans as Manifold properties. */
export const MATERIALS = [
    { id: 0, name: 'Stone', color: 0x8a8a8a },
    { id: 1, name: 'Dirt',  color: 0x6b4a2b },
    { id: 2, name: 'Grass', color: 0x4a8f3a },
    { id: 3, name: 'Sand',  color: 0xd8c27a },
    { id: 4, name: 'Snow',  color: 0xeef2f5 },
    { id: 5, name: 'Brick', color: 0x9b3f2f },
    { id: 6, name: 'Metal', color: 0x6c7a89 },
    { id: 7, name: 'Lava',  color: 0xff5a1f },
];
export const DEFAULT_MATERIAL = 0;
export const MAX_MATERIALS = 255;

/** Full material table for a world config: palette first, then the world's own entries. */
export function materialTable(world) {
    let extra = (world && world.materials) || [];
    return MATERIALS.concat(extra.map((m, i) => ({ id: MATERIALS.length + i, name: m.name || `material ${i}`, color: m.color ?? 0x808080, texture: m.texture || null })));
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
        out.push({ name: String(m.name || '').slice(0, 64), color, texture });
    }
    return out;
}
