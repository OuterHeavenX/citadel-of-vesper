/**
 * PlayerStats — RPG stat computation (spec §18).
 *
 * CONTRACT:
 * - Base stats come from gameState.data.player.stats (+ per-level growth
 *   from data/progression.json applied on level-up). Equipment bonuses come
 *   from the ItemData registry (getItemData()) read over
 *   gameState.data.equipment, plus active timed buffs from
 *   gameState.data.buffs (consumables; Wave 4).
 * - DERIVED stats are COMPUTED by recalc()/getDerived() and never stored in
 *   GameState: physicalAttack, magicAttack, defense, magicDefense,
 *   critChance (0..1), attackSpeed (multiplier), moveSpeed (multiplier),
 *   maxHpBonus, maxMpBonus (equipment flat bonuses — applied on top of the
 *   stored natural max by Player.getEffectiveMaxHp/Mp),
 *   resistances: { physical, fire, ice, lightning, shadow, holy } (0..1 mitigation).
 * - XP: gainXp(amount) delegates the total to gameState.addXp() (which emits
 *   'player:xpGained'), then resolves level-ups (possibly multiple), each
 *   emitting 'player:leveledUp' { level, stats }.
 * - recalc() runs on construction and on every 'item:equipped' /
 *   'item:unequipped' / 'inventory:changed' (buffs and expiry arrive via
 *   gameState methods that emit 'inventory:changed'); it emits nothing
 *   itself.
 * - takeDamage is NOT here: DamageSystem calls Player.takeDamage; this module
 *   only supplies getDefense(type).
 *
 * Derived formulas (also documented in docs/PROGRESSION.md):
 *   physicalAttack = round(str * 1.2 + atkBonus)
 *   magicAttack    = round(int * 1.2 + matkBonus)
 *   defense        = round(con * 0.8 + defBonus)
 *   magicDefense   = round(int * 0.6 + mdefBonus)
 *   critChance     = clamp(0.05 + lck * 0.004 + critPts / 100, 0, 0.6)
 *   attackSpeed    = clamp(1 + dex * 0.006 + aspdPts / 100, 0.5, 2)
 *   moveSpeed      = clamp(1 + movePts / 100, 0.5, 1.6)
 *   resistances[t] = clamp(sum of item fractional resistances, 0, 0.75)
 * Mitigation (getDefense):
 *   physical  -> defense / (defense + 40)
 *   elemental -> magicDefense / (magicDefense + 40) + resistances[type]
 *   clamped to [0, 0.85].
 */
import { dataManager } from '../core/DataManager.js';
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { getItemData } from '../items/ItemData.js';

const DAMAGE_TYPES = Object.freeze([
  'physical', 'fire', 'ice', 'lightning', 'shadow', 'holy',
]);

/** Design choice: level-up grants a 30% max-HP "vigorous surge" — enough to
 *  keep exploring, never a full rest (full heal is the checkpoint's job). */
const LEVEL_UP_HEAL_FRACTION = 0.3;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class PlayerStats {
  constructor() {
    const progression = dataManager.getData('progression');
    this._levelCap = progression.levelCap;
    this._growth = progression.statGrowth; // {hp, mp, str, con, dex, int, lck}
    this._xpCurve = progression.xpCurve; // {base, growth}
    /** @type {object|null} last computed derived stats */
    this.derived = null;

    this._unsubscribers = [
      eventBus.on('item:equipped', () => this.recalc()),
      eventBus.on('item:unequipped', () => this.recalc()),
      // Buffs (and their expiry) mutate gameState via methods that emit
      // 'inventory:changed'; recalc is O(slots) so staying fresh is cheap.
      eventBus.on('inventory:changed', () => this.recalc()),
    ];
    this.recalc();
  }

  /** Unsubscribe from eventBus (tests / teardown). */
  destroy() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  // ---------------------------------------------------------------- derived

  /**
   * Sum flat equipment bonuses across the six fixed slots, plus active
   * timed buffs (gameState.buffs — e.g. from consumables; Wave 4).
   * Unknown/missing item ids are skipped (data may load in later waves).
   * @private @returns {{bonus: Record<string, number>, resistances: Record<string, number>}}
   */
  _equipmentBonuses() {
    const bonus = {};
    const resistances = {};
    for (const t of DAMAGE_TYPES) resistances[t] = 0;
    const registry = getItemData();
    const equipment = gameState.data.equipment ?? {};
    for (const itemId of Object.values(equipment)) {
      if (!itemId || !registry.has(itemId)) continue;
      const item = registry.get(itemId);
      const stats = item.stats ?? {};
      for (const [k, v] of Object.entries(stats)) {
        if (typeof v === 'number') bonus[k] = (bonus[k] ?? 0) + v;
      }
      for (const [t, v] of Object.entries(item.resistances ?? {})) {
        if (DAMAGE_TYPES.includes(t) && typeof v === 'number') {
          resistances[t] += v;
        }
      }
    }
    // Timed buffs (consumables) add flat stat bonuses on top of equipment.
    for (const [k, v] of Object.entries(gameState.getBuffStatBonuses())) {
      bonus[k] = (bonus[k] ?? 0) + v;
    }
    for (const t of DAMAGE_TYPES) resistances[t] = clamp(resistances[t], 0, 0.75);
    return { bonus, resistances };
  }

  /** Recompute derived stats from GameState + equipment. Emits nothing. */
  recalc() {
    const base = gameState.data.player.stats;
    const { bonus, resistances } = this._equipmentBonuses();
    const b = (k) => bonus[k] ?? 0;

    const str = base.strength + b('str');
    const con = base.constitution + b('con');
    const dex = base.dexterity + b('dex');
    const int = base.intelligence + b('int');
    const lck = base.luck + b('lck');

    this.derived = {
      physicalAttack: Math.round(str * 1.2 + b('atk')),
      magicAttack: Math.round(int * 1.2 + b('matk')),
      defense: Math.round(con * 0.8 + b('def')),
      magicDefense: Math.round(int * 0.6 + b('mdef')),
      critChance: clamp(0.05 + lck * 0.004 + b('crit') / 100, 0, 0.6),
      attackSpeed: clamp(1 + dex * 0.006 + b('aspd') / 100, 0.5, 2),
      moveSpeed: clamp(1 + b('move') / 100, 0.5, 1.6),
      maxHpBonus: b('hp'),
      maxMpBonus: b('mp'),
      resistances,
    };
    return this.derived;
  }

  /** @returns {object} derived stats (recalcs if never computed) */
  getDerived() {
    if (!this.derived) this.recalc();
    return this.derived;
  }

  /** @returns {number} stored natural max HP + equipment bonus */
  getEffectiveMaxHp() {
    return gameState.data.player.maxHp + this.getDerived().maxHpBonus;
  }

  /** @returns {number} stored natural max MP + equipment bonus */
  getEffectiveMaxMp() {
    return gameState.data.player.maxMp + this.getDerived().maxMpBonus;
  }

  /**
   * Mitigation fraction for a damage type, consumed by DamageSystem.
   * @param {'physical'|'fire'|'ice'|'lightning'|'shadow'|'holy'} type
   * @returns {number} 0..0.85
   */
  getDefense(type) {
    const d = this.getDerived();
    if (type === 'physical') {
      return clamp(d.defense / (d.defense + 40), 0, 0.85);
    }
    const elemental = d.magicDefense / (d.magicDefense + 40);
    return clamp(elemental + (d.resistances[type] ?? 0), 0, 0.85);
  }

  // --------------------------------------------------------------------- xp

  /**
   * XP cost of a single level transition N -> N+1 (docs/PROGRESSION.md).
   * @param {number} [level] current level (defaults to the player's)
   * @returns {number}
   */
  xpForNextLevel(level = gameState.data.player.level) {
    const { base, growth } = this._xpCurve;
    return Math.floor(base * Math.pow(level, growth));
  }

  /**
   * Cumulative XP required to REACH a level (sum of single transitions).
   * @private
   */
  _cumulativeXpFor(level) {
    let total = 0;
    for (let n = 1; n < level; n++) total += this.xpForNextLevel(n);
    return total;
  }

  /**
   * Add XP and resolve level-ups (possibly several).
   * 'player:xpGained' is emitted by gameState.addXp(); each level-up emits
   * 'player:leveledUp' { level, stats } and applies growth + a 30% max-HP
   * surge heal (documented design choice).
   * @param {number} amount raw XP
   * @returns {number} levels gained (0+)
   */
  gainXp(amount) {
    if (!(amount > 0)) return 0;
    gameState.addXp(amount); // emits 'player:xpGained' { amount, total }

    const p = gameState.data.player;
    const g = this._growth;
    let levels = 0;
    // NOTE: GameState exposes no API for level-growth mutation; the player
    // domain owns this section, so PlayerStats writes it directly and marks
    // the state dirty (same pattern as a dedicated method would).
    while (p.level < this._levelCap && p.xp >= this._cumulativeXpFor(p.level + 1)) {
      p.level += 1;
      p.stats.strength += g.str;
      p.stats.constitution += g.con;
      p.stats.dexterity += g.dex;
      p.stats.intelligence += g.int;
      p.stats.luck += g.lck;
      p.maxHp += g.hp;
      p.maxMp += g.mp;
      levels += 1;
      gameState.dirty = true;

      this.recalc();
      const maxHp = this.getEffectiveMaxHp();
      p.hp = Math.min(maxHp, p.hp + Math.round(maxHp * LEVEL_UP_HEAL_FRACTION));
      gameState.dirty = true;

      eventBus.emit('player:leveledUp', {
        level: p.level,
        stats: { ...this.getDerived() },
      });
    }
    return levels;
  }
}
