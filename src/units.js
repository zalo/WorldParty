/** World units, shared by client and server.
 *
 *  Geometry is authored in abstract units (10-unit chunks, 1-unit props, a 2-unit player capsule) and the
 *  player controller was tuned for a fall of about 80 units/s². That feel is kept and taken as the definition
 *  of the unit: 1 g is 80 units/s², so one unit is an eighth of a metre and the server physics uses the same
 *  gravity, which is what makes rubble fall at the same rate the player does. Anything that converts to real
 *  metres (PhysX tolerances, the sky's camera altitude) goes through UNITS_PER_METRE. */
export const UNITS_PER_METRE = 8;
export const GRAVITY = 9.81 * UNITS_PER_METRE; // units/s², one g
