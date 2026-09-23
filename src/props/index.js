/**
 * src/props — breakables + pickups (room dressing with gameplay effects).
 *
 *   Breakable.js  class Breakable + BREAKABLE_DEFS (candle/urn/crate/chandelier)
 *   Pickup.js     class Pickup + PICKUP_KINDS + resolvePickupRef
 *                 (coin/heart/mana/key/item)
 *
 * Breakables are NOT DamageSystem targets — one hit destroys them via
 * Breakable.hit() (Wave 3 wires HitboxSystem hurtboxes to that). Pickups
 * magnet to the player and apply effects through GameState.
 */
export { Breakable, BREAKABLE_DEFS } from './Breakable.js';
export { Pickup, PICKUP_KINDS, resolvePickupRef } from './Pickup.js';
