/**
 * src/npcs — NPCs + merchant. Public API surface:
 *
 *   Npc.js       class Npc — interact / update / destroy; relocation via flags
 *   Merchant.js  class Merchant — getStock / buy / sell
 *
 * All NPC names, dialogue, and quest outcomes are ORIGINAL.
 */
export { Npc } from './Npc.js';
export { Merchant } from './Merchant.js';
