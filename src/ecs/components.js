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
 *   FragmentMesh { data }                      visual+collider: gzip+base64 tri soup, body-local
 *   Joint        { type:'rope'|'weld'|'hinge', bodyA, bodyB, localOffsetA, localOffsetB, axis }
 *   Grabbed      { by }                       physgun hold (target pose is transient: $GrabTarget)
 *   Player       { name, color }
 *   Model        { url, selectedBy }           legacy static GLB-by-url
 *
 * Transient (server):  $PxBody {actor}  $PxJoint {joint}  $Grab {anchor, joint}  $GrabTarget {pos, quat}  $PxKinematic {actor, prev}
 * Transient (client):  $Mesh {object}   $Snapshot {prev, target}  $Label {el}  $Line {line}
 */

export const Transform = ({ position = { x: 0, y: 0, z: 0 }, quaternion = { x: 0, y: 0, z: 0, w: 1 }, scale = { x: 1, y: 1, z: 1 } } = {}) =>
    ({ position: { ...position }, quaternion: { ...quaternion }, scale: { ...scale } });

export const RigidBody = ({ shape = 'box', halfExtent = 0.5, propId = null, kinematic = false, frozen = false, sleeping = false } = {}) =>
    ({ shape, halfExtent, propId, kinematic, frozen, sleeping });

export const Prop = ({ propId, url = null }) => ({ propId, url });

export const FragmentMesh = ({ data }) => ({ data });

export const Joint = ({ type, bodyA, bodyB, localOffsetA = { x: 0, y: 0, z: 0 }, localOffsetB = { x: 0, y: 0, z: 0 }, axis = null }) =>
    ({ type, bodyA, bodyB, localOffsetA, localOffsetB, axis });

export const Grabbed = ({ by }) => ({ by });

export const Player = ({ name = 'Player', color = '#ffffff' } = {}) => ({ name, color });

export const Model = ({ url, selectedBy = '' }) => ({ url, selectedBy });

/** Components that are persisted to durable storage (players and holds are session-only). */
export const PERSISTED = new Set(['Transform', 'RigidBody', 'Prop', 'FragmentMesh', 'Joint', 'Model']);
export const isPersistedComponent = (id, name) => PERSISTED.has(name);
