/** Gravity, shared by client and server.
 *
 *  World units are metres (10 m chunks, 1 m props, a 2 m player capsule) but nothing falls at 1 g: at this scale
 *  real gravity reads as slow motion, which is why games run heavier (Source's default is 1.55 g). The player
 *  controller is tuned arcade-fast at PLAYER_GRAVITY, and a metre-sized block falling that fast looks like a toy,
 *  so rigid bodies get their own DEFAULT_BODY_GRAVITY. A room can override the body gravity: `world.gravity`
 *  (persisted with the world config, replaced by an import), set from the client with `?gravity=<m/s²>`. */
export const G = 9.81;
export const PLAYER_GRAVITY = 8 * G;
export const DEFAULT_BODY_GRAVITY = 2 * G;
export const MIN_GRAVITY = 0.5, MAX_GRAVITY = 200;
/** A body gravity from the wire or storage, or null if unusable. */
export function clampGravity(g) { g = +g; return Number.isFinite(g) ? Math.min(MAX_GRAVITY, Math.max(MIN_GRAVITY, g)) : null; }
