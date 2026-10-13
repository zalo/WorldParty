/** Terrain material palette shared by client and server. Material ids are
 *  stored per triangle; the server tags every brush and implicit chunk with
 *  a Manifold original ID per material so booleans preserve provenance. */
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
export function materialColor(id) { return (MATERIALS[id] || MATERIALS[DEFAULT_MATERIAL]).color; }
export function clampMaterial(id) { id = id | 0; return id >= 0 && id < MATERIALS.length ? id : DEFAULT_MATERIAL; }
