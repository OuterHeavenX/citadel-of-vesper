/**
 * src/abilities — traversal + magic. Public API surface:
 *
 *   AbilityManager.js  class AbilityManager — get / has / isUnlocked / unlock /
 *                      getTraversalAbilities / getExtraJumps / learn / cast
 *   SaveSanctum / TeleportChamber live in src/rooms/ (W3-ABILITIES).
 *
 * Definitions: data/abilities.json (schema: data/schemas/ability.schema.json).
 *
 * `abilityManager` is the game-wide singleton (registry over
 * data/abilities.json, wired to the gameState/eventBus/audioManager
 * singletons). Tests construct their own AbilityManager instances with
 * injected deps instead.
 */
import abilitiesData from '../../data/abilities.json';
import {
  AbilityManager,
  MOONRISE_LEAP_ID,
  MOONRISE_LEAP_BOSS,
} from './AbilityManager.js';

export { AbilityManager, MOONRISE_LEAP_ID, MOONRISE_LEAP_BOSS };

/** Shared singleton for gameplay modules (Player, scenes, debug commands). */
export const abilityManager = new AbilityManager(abilitiesData);
