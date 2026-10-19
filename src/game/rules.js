/** Fort War rules shared by client and server: weapons, supplies, match timing, and the sanitizer for the
 *  `world.game` config a level manifest carries (tools/gen-fortwar.mjs writes one).
 *
 *  Two teams storm each other's fort for its supplies. A supply is a physics crate; carry an enemy (or neutral)
 *  one into your vault and it is yours. Most supplies in your vault when time runs out wins. Everything is
 *  terrain: weapons carve it, the mason adds it, and whatever loses its support falls (see Connectivity). */

export const TEAMS = ['red', 'blue'];
export const MAX_HEALTH = 100;
export const RESPAWN_MS = 4000;
export const REGEN_DELAY_MS = 5000;   // no damage for this long ...
export const REGEN_PER_S = 15;        // ... then health comes back at this rate
export const MATCH_OVER_MS = 15000;   // results screen before the next round
export const PLAYER_KILL_Y = -70;     // fell out of the world

/** Weapons. Radii and speeds in metres; damage at the centre of a blast falls off linearly to zero at 1.6 radii. */
export const WEAPONS = {
    rocket:  { name: 'Rocket Launcher', icon: '🚀', key: '1', cooldownMs: 1100, speed: 46, gravity: 10, radius: 2.4, damage: 70, direct: 40, knock: 18, lifeMs: 6000 },
    grenade: { name: 'Grenade',         icon: '💣', key: '2', cooldownMs: 900,  minSpeed: 9, maxSpeed: 27, chargeMs: 1300, fuseMs: 2600, radius: 3.2, damage: 85, knock: 22 },
    buster:  { name: 'Bunker Buster',   icon: '☢️', key: '2', cooldownMs: 2000, speed: 11, fuseMs: 4200, radius: 5.6, damage: 150, knock: 30, perLife: 1 },
    drill:   { name: 'Drill',           icon: '⛏️', key: '3', cooldownMs: 420,  radius: 1.6, reach: 1.3, drop: 0.4 }, // a sphere ahead of the eye, big enough to walk through
    mason:   { name: 'Mason',           icon: '🧱', key: '4', cooldownMs: 300,  budget: 12, regenMs: 20000, stonePerDig: 1, maxDistance: 9, // stone comes from digging; the trickle only prevents a dead end
               shapes: { wall: [4, 2.6, 0.6], block: [2, 2, 2], plank: [4, 0.4, 1.4], pillar: [1, 4, 1] } },
    grapple: { name: 'Grapple',         icon: '🪝', key: '5', range: 48, pull: 190, maxSpeed: 30 }, // pull must beat PLAYER_GRAVITY (8 g) with room to spare
    physgun: { name: 'PhysGun',         icon: '🔫', key: '6', range: 20 },
};
export const SELF_DAMAGE_SCALE = 0.45;    // rocket jumping hurts, but not much

export const SUPPLY = {
    halfExtent: 0.45,
    pickupRadius: 1.7,
    dropReturnMs: 30000,            // a dropped supply nobody touches goes back where it came from
    undergroundDepth: 1.5,          // below surface - this counts as underground ...
    undergroundBonusS: 4.0,         // ... for this long while carrying (outside both vaults): the delivery earns a bonus crate
    senseRange: 40,                 // the treasure light starts blinking at neutral supplies this close
};

/** Votes on admin actions: a majority of the active players (AFK ones, without a heartbeat for activeMs, do not
 *  count) passes it, so a lone player's vote goes through at once. */
export const VOTE = {
    actions: { reset: 'Reset the map', end: 'End the round', swap: 'Swap teams' },
    expireMs: 60000,
    activeMs: 90000,
    heartbeatMs: 5000,
    idleMs: 60000,                  // no input for this long: the client stops sending heartbeats
};

export const RUBBLE = { minSpeed: 9, damagePerMps: 4, maxDamage: 70, pairCooldownMs: 600 };
export const FRAGMENT_FADE_MS = 40000;    // sleeping rubble fades after this ...
export const MAX_FRAGMENTS = 110;         // ... or sooner when there is this much of it
export const MAX_PLAYER_PROPS = 40;       // crates and barrels spawned from the menu, room-wide
export const GAME_PROPS = ['crate', 'barrel'];

/** Glow rocks: luminous pebbles sown through the ground below the surface. They are a virtual field, not a list: a
 *  jittered grid whose cells decide from a hash of their coordinates and the level's seed whether they hold a rock,
 *  where in the cell, how big and which colour, so every host agrees without shipping one entry per rock. The server
 *  materializes a rock as an entity once a dig or a blast (or an existing tunnel, found by a lazy scan near players)
 *  opens air onto it: embedded and static while part of it is still in the ground, shattered (gone, with a sparkle) once
 *  nothing holds it (`freeAt`). Only below `surfaceY - margin`: the forts, the grass skin and a crater on open ground stay dark. */
export const GLOW_ROCK = {
    margin: 0.9,                    // no rocks in the first metre under the surface
    minRadius: 0.06, maxRadius: 0.16,  // pebbles and crystal nodules, not boulders
    freeAt: 0.97,                   // exposure (fraction of the rock out of the ground) at which it shatters (glowpop)
    colors: ['#ffb020', '#1fd6c8', '#b05cff'],   // amber, teal, violet: saturated, so the glow stays coloured under ACES
    scanPerTick: 150,               // virtual rocks measured per tick by the lazy scan around players ...
    scanRange: 24,                  // ... in chunks this close to one
    emissive: 1.6,                  // emissive intensity of the rock material (ACES at exposure 0.42: higher washes the colour out)
    elongation: 1.8,                // a crystal is a stretched lump, not a ball
};
export const DEFAULT_GLOW_FIELD = { seed: 1, cell: 1.1, density: 0.55 };

function hash32(x) { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0; }
/** The virtual rock of a field cell (null when the cell holds none): position, radius, colour index and spin. */
export function virtualRock(field, i, j, k) {
    let h = hash32(Math.imul(i, 0x9E3779B1) ^ Math.imul(j, 0x85EBCA77) ^ Math.imul(k, 0xC2B2AE3D) ^ (field.seed | 0));
    let u = () => { h = hash32(h + 0x9E3779B9); return h / 4294967296; };
    if(u() >= field.density) return null;
    let c = field.cell, r = GLOW_ROCK.minRadius + u() * (GLOW_ROCK.maxRadius - GLOW_ROCK.minRadius);
    let pad = r + 0.02, span = Math.max(0, c - 2 * pad); // a rock stays inside its cell, so rocks never overlap
    return { cell: `${i},${j},${k}`, x: i * c + pad + u() * span, y: j * c + pad + u() * span, z: k * c + pad + u() * span,
             radius: r, color: Math.floor(u() * GLOW_ROCK.colors.length), spin: u() * Math.PI * 2, axis: u() * 6 | 0 };
}
/** Highest cell row allowed under a surface: the whole cell lies below surfaceY - margin. */
export const glowRowMax = (field, surfaceY) => Math.floor((surfaceY - GLOW_ROCK.margin) / field.cell) - 1;
/** Every virtual rock whose cell overlaps the box (world units), below the surface. */
export function* virtualRocksIn(field, surfaceY, min, max) {
    let c = field.cell;
    let i0 = Math.floor(min.x / c), i1 = Math.floor(max.x / c), k0 = Math.floor(min.z / c), k1 = Math.floor(max.z / c);
    let j0 = Math.floor(min.y / c), j1 = Math.min(Math.floor(max.y / c), glowRowMax(field, surfaceY));
    for(let i = i0; i <= i1; i++) for(let j = j0; j <= j1; j++) for(let k = k0; k <= k1; k++) { let r = virtualRock(field, i, j, k); if(r) yield r; }
}

/** End-of-round awards: [title, Player field, higher is better, minimum to qualify] */
export const AWARDS = [
    ['Warlord', 'kills', 2], ['Mule', 'carries', 1], ['Tunnel Rat', 'smuggles', 1], ['Demolition', 'blasts', 10], ['Lemming', 'deaths', 3],
];

export const TEAM_DEFAULTS = {
    red:  { name: 'Red',  color: '#e03a2f' },
    blue: { name: 'Blue', color: '#3a7be0' },
};

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;
const vec = (a) => Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(v => Number.isFinite(+v)) ? a.slice(0, 3).map(v => +v) : null;
const vecs = (list, max = 64) => Array.isArray(list) ? list.slice(0, max).map(vec).filter(Boolean) : [];
const boxOf = (b) => {
    let min = b && vec(b.min), max = b && vec(b.max);
    if(!min || !max) return null;
    return { min: min.map((v, i) => Math.min(v, max[i])), max: max.map((v, i) => Math.max(v, min[i])) };
};

/** Validate a `world.game` config from the wire or storage; null if unusable. */
export function sanitizeGame(g) {
    if(!g || typeof g !== 'object' || g.mode !== 'fortwar' || !g.teams) return null;
    let teams = {};
    for(let t of TEAMS) {
        let src = g.teams[t];
        if(!src) return null;
        let spawns = vecs(src.spawns, 16), vault = boxOf(src.vault), slots = vecs(src.slots, 24);
        if(!spawns.length || !vault || !slots.length) return null;
        teams[t] = {
            name: String(src.name || TEAM_DEFAULTS[t].name).slice(0, 16),
            color: /^#[0-9a-fA-F]{6}$/.test(src.color || '') ? src.color : TEAM_DEFAULTS[t].color,
            material: Math.max(0, Math.min(254, num(src.material, 0) | 0)),
            spawns, vault, slots,
        };
    }
    return {
        mode: 'fortwar',
        surfaceY: num(g.surfaceY, 0),
        matchMinutes: Math.max(1, Math.min(60, num(g.matchMinutes, 10))),
        teams,
        caches: vecs(g.caches, 32),
        scatter: vecs(g.scatter, 32),
        glowRocks: g.glowRocks && typeof g.glowRocks === 'object' ? {
            seed: num(g.glowRocks.seed, DEFAULT_GLOW_FIELD.seed) | 0,
            cell: Math.max(0.6, Math.min(4, num(g.glowRocks.cell, DEFAULT_GLOW_FIELD.cell))),
            density: Math.max(0, Math.min(1, num(g.glowRocks.density, DEFAULT_GLOW_FIELD.density))),
        } : null,
        hints: Array.isArray(g.hints) ? g.hints.slice(0, 8).map(h => String(h).slice(0, 200)) : [],
    };
}

export function inBox(box, p) {
    return p.x >= box.min[0] && p.x <= box.max[0] && p.y >= box.min[1] && p.y <= box.max[1] && p.z >= box.min[2] && p.z <= box.max[2];
}
export const otherTeam = (t) => t === 'red' ? 'blue' : 'red';
