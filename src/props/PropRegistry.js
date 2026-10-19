/** Single source of truth for spawnable props (server collider + client menu + spawn placement).
 *  shape: 'box'|'sphere'|'capsule'|'hulls' — analytic shapes are faster and more accurate;
 *  'hulls' uses the precomputed CoACD convex decomposition in PropHulls.js.
 *  Models are from Kenney (CC0) via pmndrs/market-assets. */
const MARKET = "https://raw.githubusercontent.com/pmndrs/market-assets/main/files/models/";

export const PROPS = [
    { id: "cube",     name: "Physics Cube", icon: "📦",  mass: 20,  halfExtent: 0.5,  shape: 'box',    url: null, color: 0xdd8844 },
    { id: "barrel",   name: "Barrel",       icon: "🛢️",  mass: 20,  halfExtent: 0.5,  shape: 'hulls',  url: MARKET + "barrel/model.gltf",        color: 0x8B4513 },
    { id: "crate",    name: "Crate",        icon: "📦",  mass: 15,  halfExtent: 0.5,  shape: 'box',    url: MARKET + "sci-fi-crate/model.gltf",  color: 0xDEB887 },
    { id: "chest",    name: "Chest",        icon: "🗃️",  mass: 18,  halfExtent: 0.4,  shape: 'box',    url: MARKET + "chest/model.gltf",         color: 0xdd8844 },
    { id: "bench",    name: "Bench",        icon: "🪑",  mass: 12,  halfExtent: 0.5,  shape: 'hulls',  url: MARKET + "bench/model.gltf",         color: 0xdd8844 },
    { id: "ball",     name: "Cannonball",   icon: "⚽",  mass: 25,  halfExtent: 0.3,  shape: 'sphere', url: MARKET + "cannon-ball/model.gltf",   color: 0x444444 },
    { id: "can",      name: "Soda Can",     icon: "🥫",  mass: 2,   halfExtent: 0.15, shape: 'hulls',  url: MARKET + "soda-can/model.gltf",      color: 0xdd8844 },
    { id: "pot",      name: "Pot",          icon: "🍯",  mass: 8,   halfExtent: 0.3,  shape: 'hulls',  url: MARKET + "pot/model.gltf",           color: 0xdd8844 },
    { id: "tower",    name: "Tower",        icon: "🏰",  mass: 30,  halfExtent: 0.6,  shape: 'hulls',  url: MARKET + "tower/model.gltf",         color: 0xdd8844 },
    { id: "board",    name: "Board",        icon: "🪵",  mass: 5,   halfExtent: 0.3,  shape: 'box',    url: MARKET + "cutting-board/model.gltf", color: 0xCD853F },
    { id: "sword",    name: "Sword",        icon: "⚔️",  mass: 4,   halfExtent: 0.2,  shape: 'hulls',  url: MARKET + "sword/model.gltf",         color: 0xdd8844 },
    // Fort War (src/game/rules.js): not in the spawn menu
    { id: "supply",   name: "Supply",       icon: "💰",  mass: 30,  halfExtent: 0.45, shape: 'box',    url: null, color: 0xffc830, hidden: true },
    { id: "grenade",  name: "Grenade",      icon: "💣",  mass: 3,   halfExtent: 0.22, shape: 'sphere', url: null, color: 0x3d5a2a, hidden: true },
    { id: "buster",   name: "Bunker Buster", icon: "☢️", mass: 60,  halfExtent: 0.42, shape: 'sphere', url: null, color: 0x202020, hidden: true },
    { id: "glowrock", name: "Glow Rock",    icon: "💎",  mass: 10,  halfExtent: 0.25, shape: 'sphere', url: null, color: 0xffb24a, hidden: true }, // glow rocks used to become bodies when dug out; they shatter now (src/server/GlowRocks.js). Kept so old rooms load
];

/** @type {Record<string, typeof PROPS[0]>} */
export const PROP_DEFS = Object.fromEntries(PROPS.map(p => [p.id, p]));

export const DEFAULT_PROP = { id: "cube", name: "Cube", icon: "📦", mass: 20, halfExtent: 0.5, shape: 'box', url: null, color: 0xdd8844 };

export function getPropDef(propId) { return PROP_DEFS[propId] || DEFAULT_PROP; }
