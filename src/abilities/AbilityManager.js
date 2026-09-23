/**
 * AbilityManager — traversal abilities + magic (spec §22, §23).
 *
 * CONTRACT:
 * - One registry over data/abilities.json (schema ability.schema.json):
 *   traversal: { id, kind:'traversal', name, description, icon, effect }
 *     e.g. 'moonrise_leap' { extraJumps: 1 } — gates world edges via room
 *     exit `requires` (see ROOM_FORMAT.md).
 *   spells: { id, kind:'spell', name, mpCost, element, description, effect }
 *     e.g. 'cinder_wave', 'mending_pulse' — Wave 4 expands effects.
 * - unlock(abilityId): adds to gameState.data.player.abilities via
 *   gameState.unlockAbility() — which emits 'player:abilityUnlocked' —
 *   then plays the 'secret' sfx. Idempotent.
 * - Spells: learn(spellId) adds to gameState.data.player.spells; cast(spellId)
 *   performs the MP check and deducts MP (Wave 4 routes damage/FX).
 * - Listens for 'boss:died': chapel_warden's death unlocks 'moonrise_leap'
 *   (the reward trigger; Wave 4 emits the event, this listener makes it real).
 * - has(id) is the read path movement/gating code uses.
 *
 * All names/effects ORIGINAL (no Castlevania spells).
 */
import abilitiesData from '../../data/abilities.json';
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { audioManager } from '../core/AudioManager.js';

/** Boss id whose death grants Moonrise Leap (see unlockSource in data). */
export const MOONRISE_LEAP_BOSS = 'chapel_warden';
export const MOONRISE_LEAP_ID = 'moonrise_leap';

export class AbilityManager {
  /**
   * @param {object[]} [abilitiesArray] parsed data/abilities.json
   * @param {object} [deps] injectable singletons (tests): { gameState, eventBus, audioManager }
   */
  constructor(abilitiesArray = abilitiesData, deps = {}) {
    this.byId = new Map(abilitiesArray.map((a) => [a.id, a]));
    this.gameState = deps.gameState ?? gameState;
    this.events = deps.eventBus ?? eventBus;
    this.audio = deps.audioManager ?? audioManager;

    this._onBossDied = ({ bossId } = {}) => {
      if (bossId === MOONRISE_LEAP_BOSS) this.unlock(MOONRISE_LEAP_ID);
    };
    this.events.on('boss:died', this._onBossDied);
  }

  /** @param {string} id @returns {object} throws on unknown id */
  get(id) {
    const a = this.byId.get(id);
    if (!a) throw new Error(`unknown ability id '${id}'`);
    return a;
  }

  /** @param {string} id @returns {boolean} is the traversal ability unlocked? */
  has(id) {
    return this.gameState.data.player.abilities.includes(id);
  }

  /** Alias kept for the Wave 0 stub contract. @param {string} id */
  isUnlocked(id) {
    return this.has(id);
  }

  /**
   * Grant a traversal ability or spell.
   * gameState.unlockAbility() emits 'player:abilityUnlocked'; we add the
   * 'secret' sfx on first unlock. Idempotent.
   * @param {string} id @returns {boolean} true if newly unlocked
   */
  unlock(id) {
    this.get(id); // throws on unknown id
    if (this.has(id)) return false;
    this.gameState.unlockAbility(id);
    this.audio.playSfx('secret');
    return true;
  }

  /** @returns {object[]} all traversal ability definitions */
  getTraversalAbilities() {
    return [...this.byId.values()].filter((a) => a.kind === 'traversal');
  }

  /** @returns {object[]} all spell definitions */
  getSpells() {
    return [...this.byId.values()].filter((a) => a.kind === 'spell');
  }

  /**
   * @returns {number} total bonus mid-air jumps granted by unlocked traversal
   * abilities (moonrise_leap grants 1).
   */
  getExtraJumps() {
    return this.getTraversalAbilities()
      .filter((a) => this.has(a.id))
      .reduce((n, a) => n + (a.effect?.extraJumps ?? 0), 0);
  }

  /** @param {string} spellId @returns {boolean} is the spell learned? */
  hasSpell(spellId) {
    return this.gameState.data.player.spells.includes(spellId);
  }

  /**
   * Learn a spell. Emits 'player:abilityUnlocked' via gameState.learnSpell().
   * @param {string} spellId @returns {boolean} true if newly learned
   */
  learn(spellId) {
    const def = this.get(spellId);
    if (def.kind !== 'spell') throw new Error(`'${spellId}' is not a spell`);
    if (this.hasSpell(spellId)) return false;
    this.gameState.learnSpell(spellId);
    this.audio.playSfx('secret');
    return true;
  }

  /**
   * Cast a learned spell: MP check + deduct. Wave 4 routes damage/FX through
   * DamageSystem / ProjectileSystem; this Wave 3 version only pays the cost.
   * @param {string} spellId @returns {boolean} true if the cast went off
   */
  cast(spellId) {
    const def = this.get(spellId);
    if (def.kind !== 'spell') throw new Error(`'${spellId}' is not a spell`);
    if (!this.hasSpell(spellId)) return false;
    const mp = this.gameState.data.player.mp;
    const cost = def.mpCost ?? 0;
    if (mp < cost) return false;
    this.gameState.setMp(mp - cost);
    return true;
  }

  /** Detach the boss:died listener (tests / teardown). */
  destroy() {
    this.events.off('boss:died', this._onBossDied);
  }
}
