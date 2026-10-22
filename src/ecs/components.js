/**
 * Component catalogue. Components are plain JSON objects; these factories
 * only document the shape and fill defaults. Names starting with '$' are
 * transient runtime handles that never leave the host they were built on.
 *
 * Persistent (replicated + stored):
 *   Transform    { position:{x,y,z}, quaternion:{x,y,z,w}, scale:{x,y,z} }
 *   RigidBody    { shape:'box'|'sphere'|'capsule'|'hulls'|'trimesh', halfExtent,
 *                  propId, kinematic, frozen, sleeping }
 *   Prop         { propId, url }               visual: GLTF loaded by url
 *   FragmentMesh { data, mats, hulls, rebake, origin } visual: gzip+base64 tri soup (body-local) + material id per triangle;
 *                                             collider: hulls = encodeHulls() convex pieces (null on legacy fragments: SDF trimesh);
 *                                             rebake false: in Fort War it fades instead of going back into the terrain asleep;
 *                                             origin [x, y, z]: where it broke off (its texture is triplanar at local + origin, so it
 *                                             matched the terrain then; null on older fragments: local position alone)
 *   Joint        { type:'rope'|'weld'|'hinge', bodyA, bodyB, localOffsetA, localOffsetB, axis }
 *   Grabbed      { by }                       physgun hold (target pose is transient: $GrabTarget)
 *   Player       { name, color, team, health, dead, carrying, kills, deaths, score, respawnAt, build, buster }
 *                                             (the Fort War fields are null/zero in a sandbox room)
 *   Model        { url, selectedBy }           legacy static GLB-by-url
 *   Projectile   { kind, team, owner, vel, bornAt }   server-integrated rocket (no PhysX body; clients dead-reckon from vel)
 *   Fuse         { kind, team, owner, at }     a RigidBody prop that explodes at time `at` (grenade, bunker buster)
 *   Supply       { team, state, carriedBy, home, droppedAt }   Fort War loot: team = whose vault it belongs to (null = neutral),
 *                                             state 'home' | 'loose' | 'carried'; carried supplies have no RigidBody
 *   Match        { phase, remainingMs, scores, winner, round, overAt }   Fort War match state (entity id 'match')
 *   GlowRock     { cell, exposure, free }    Fort War glow rock materialized from the virtual field (src/game/rules.js
 *                                             virtualRock gives its radius and colour from `cell`): static and partly in the
 *                                             ground while exposure < 1; free ones carry a sphere RigidBody and roll
 *
 * Transient (server):  $PxBody {actor}  $PxJoint {joint}  $Grab {anchor, joint}  $GrabTarget {pos, quat}  $PxKinematic {actor, prev}
 *                      $Thrown {v, w, until} (a blast's shard: initial velocity, harmless until)  $Fade {since}  $Baking  $NoBake
 * Transient (client):  $Mesh {object}   $Snapshot {prev, target}  $Label {el}  $Line {line}
 */

export const Transform = ({ position = { x: 0, y: 0, z: 0 }, quaternion = { x: 0, y: 0, z: 0, w: 1 }, scale = { x: 1, y: 1, z: 1 } } = {}) =>
    ({ position: { ...position }, quaternion: { ...quaternion }, scale: { ...scale } });

export const RigidBody = ({ shape = 'box', halfExtent = 0.5, propId = null, kinematic = false, frozen = false, sleeping = false } = {}) =>
    ({ shape, halfExtent, propId, kinematic, frozen, sleeping });

export const Prop = ({ propId, url = null }) => ({ propId, url });

export const FragmentMesh = ({ data, mats = null, hulls = null, rebake = true, origin = null }) => ({ data, mats, hulls, rebake, origin });

export const Joint = ({ type, bodyA, bodyB, localOffsetA = { x: 0, y: 0, z: 0 }, localOffsetB = { x: 0, y: 0, z: 0 }, axis = null }) =>
    ({ type, bodyA, bodyB, localOffsetA, localOffsetB, axis });

export const Grabbed = ({ by }) => ({ by });

// Fort War: `score` is the units this player brought in this round (UNITS), `crystals` the crystals among them
export const Player = ({ name = 'Player', color = '#ffffff', team = null, health = 100, dead = false, carrying = null, kills = 0, deaths = 0, score = 0, respawnAt = 0, build = 0, buster = 0, carries = 0, smuggles = 0, blasts = 0, crystals = 0 } = {}) =>
    ({ name, color, team, health, dead, carrying, kills, deaths, score, respawnAt, build, buster, carries, smuggles, blasts, crystals });

export const Projectile = ({ kind, team = null, owner = null, vel = { x: 0, y: 0, z: 0 }, bornAt = 0 }) => ({ kind, team, owner, vel: { ...vel }, bornAt });

export const Fuse = ({ kind, team = null, owner = null, at }) => ({ kind, team, owner, at });

export const Supply = ({ team = null, state = 'home', carriedBy = null, home = { x: 0, y: 0, z: 0 }, droppedAt = 0, buried = false }) =>
    ({ team, state, carriedBy, home: { ...home }, droppedAt, buried });

// scores: each team's units (UNITS); crystals: the crystal units each team has banked this round
export const Match = ({ phase = 'live', remainingMs = 0, scores = { red: 0, blue: 0 }, crystals = { red: 0, blue: 0 }, winner = null, round = 1, overAt = 0, awards = [], vote = null } = {}) =>
    ({ phase, remainingMs, scores: { ...scores }, crystals: { ...crystals }, winner, round, overAt, awards: [...awards], vote });

export const GlowRock = ({ cell, exposure = 0, free = false }) => ({ cell, exposure, free });

export const Model = ({ url, selectedBy = '' }) => ({ url, selectedBy });

/** Components that are persisted to durable storage (players and holds are session-only). */
export const PERSISTED = new Set(['Transform', 'RigidBody', 'Prop', 'FragmentMesh', 'Joint', 'Model', 'Supply', 'Fuse', 'Match', 'GlowRock']);
export const isPersistedComponent = (id, name) => PERSISTED.has(name);
