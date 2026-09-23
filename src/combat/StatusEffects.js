/**
 * StatusEffects — buffs / debuffs / DoTs (docs/ARCHITECTURE.md §9).
 *
 * CONTRACT:
 * - apply(target, effectId, { duration?, tickMs?, power? }) -> instance
 * - remove(target, effectId)
 * - has(target, effectId) -> boolean
 * - update(dt): central ticking; iterates active effects, never allocates
 *   per tick beyond the damage call itself.
 * - clearTarget(target): drop all effects on a target (death / room teardown).
 * - clear(): drop everything.
 *
 * EFFECT DEFINITIONS live in the local EFFECT_DEFS table below — NOT in
 * data/abilities.json yet. data/abilities.json currently has NO
 * statusEffects section (it only defines traversal abilities + spells).
 *
 * >> WAVE 4 DATA MIGRATION NOTE <<
 * Move EFFECT_DEFS into data/abilities.json under a top-level
 * "statusEffects" section (one entry per effectId with kind/type/tickMs/
 * slow/shield/etc.), add a status-effect schema beside the ability schema,
 * and have this module read definitions via dataManager.getData('abilities')
 * (or a new dataset name). The apply/remove/has/update API stays identical;
 * only the definition source changes.
 *
 * TARGET HOOKS (all optional, duck-typed):
 * - addModifier(mod) / removeModifier(id): stat modifiers. mod =
 *   { id: 'status:<effectId>', kind, ...params } — e.g. chill passes
 *   { kind:'chill', moveSpeedMult: 0.5 }. PlayerStats/EnemyStats consume these.
 * - heal(amount, info): consumed by 'regen' HoT ticks.
 * - isDead(): when true, all effects on the target are dropped.
 *
 * DoT ticks route through DamageSystem with
 *   { ignoreIframes: true, canCrit: false, knockback: {x:0,y:0} }
 * and source { id: 'status:<effectId>', kind: 'environment' }.
 *
 * No Phaser imports — unit-testable in node with fake targets.
 */
import { DamageSystem } from './DamageSystem.js';

/**
 * Local effect definitions. Wave 4 migrates these to data/abilities.json
 * (see header note). Fields:
 *   kind: 'dot'|'hot'|'slow'|'stun'|'atkDown'|'atkSpeedUp'|'shield'
 *   type: damage type for 'dot'
 *   tickMs: default ms between dot/hot ticks
 *   power: default per-tick amount (overridable per apply())
 *   slow: chill speed multiplier (0.5 = half speed)
 *   factor: atkDown/atkSpeedUp multiplier
 *   refresh: re-applying refreshes duration (vs. ignoring while active)
 *   stacks: whether multiple stacks accumulate (barrier)
 *   maxStacks: cap when stacks is true
 */
const EFFECT_DEFS = Object.freeze({
  burn:   { label: 'Burn',   kind: 'dot',  type: 'fire',      tickMs: 500,  power: 2, refresh: true },
  poison: { label: 'Poison', kind: 'dot',  type: 'physical',  tickMs: 1000, power: 1, refresh: true },
  shock:  { label: 'Shock',  kind: 'dot',  type: 'lightning', tickMs: 400,  power: 1, refresh: true },
  chill:  { label: 'Chill',  kind: 'slow', slow: 0.5, refresh: true },
  stun:   { label: 'Stun',   kind: 'stun', refresh: false },
  regen:  { label: 'Regen',  kind: 'hot',  tickMs: 1000, power: 3, refresh: true },
  weaken: { label: 'Weaken', kind: 'atkDown', factor: 0.75, refresh: true },
  haste:  { label: 'Haste',  kind: 'atkSpeedUp', factor: 1.25, refresh: true },
  barrier:{ label: 'Barrier', kind: 'shield', stacks: true, maxStacks: 3, refresh: false },
});

/** Default effect lifetime (s) when apply() omits duration. */
const DEFAULT_DURATION = 3;

function modifierId(effectId) {
  return `status:${effectId}`;
}

export class StatusEffects {
  constructor() {
    /** @type {Map<object, Map<string, object>>} target -> (effectId -> instance) */
    this.active = new Map();
  }

  /** @returns {Readonly<object>} the local definition table (for UI/debug) */
  static get defs() {
    return EFFECT_DEFS;
  }

  /**
   * @param {object} target
   * @param {string} effectId e.g. 'burn'
   * @param {{duration?:number, tickMs?:number, power?:number}} [opts]
   *   duration in seconds; tickMs overrides the def's tick interval;
   *   power overrides the def's per-tick amount.
   * @returns {object} the effect instance
   */
  apply(target, effectId, opts = {}) {
    const def = EFFECT_DEFS[effectId];
    if (!def) throw new Error(`[StatusEffects] unknown effect '${effectId}'`);
    if (!target) throw new Error('[StatusEffects] apply requires a target');

    const duration = opts.duration ?? DEFAULT_DURATION;
    if (!(duration > 0)) throw new Error('[StatusEffects] duration must be positive');

    let fx = this.active.get(target);
    if (!fx) {
      fx = new Map();
      this.active.set(target, fx);
    }

    const existing = fx.get(effectId);
    if (existing) {
      // Refresh semantics: duration refreshes (or extends for stacks),
      // power keeps the stronger of the two.
      if (def.stacks) {
        existing.stacks = Math.min((existing.stacks ?? 1) + 1, def.maxStacks ?? 99);
        existing.remaining = Math.max(existing.remaining, duration);
      } else if (def.refresh) {
        existing.remaining = duration;
      }
      if (opts.power !== undefined) existing.power = Math.max(existing.power, opts.power);
      return existing;
    }

    const inst = {
      effectId,
      def,
      target,
      remaining: duration,
      tickAcc: 0,
      tickMs: opts.tickMs ?? def.tickMs ?? 1000,
      power: opts.power ?? def.power ?? 0,
      stacks: 1,
    };
    fx.set(effectId, inst);
    this._onApply(target, inst);
    return inst;
  }

  /** @param {object} target @param {string} effectId */
  remove(target, effectId) {
    const fx = this.active.get(target);
    if (!fx) return;
    const inst = fx.get(effectId);
    if (!inst) return;
    this._onRemove(target, inst);
    fx.delete(effectId);
    if (fx.size === 0) this.active.delete(target);
  }

  /** @param {object} target @param {string} effectId @returns {boolean} */
  has(target, effectId) {
    return this.active.get(target)?.has(effectId) ?? false;
  }

  /**
   * @param {object} target @param {string} effectId
   * @returns {number} seconds remaining, or 0 when absent
   */
  getRemaining(target, effectId) {
    return this.active.get(target)?.get(effectId)?.remaining ?? 0;
  }

  /** Drop every effect on one target (death, room teardown). */
  clearTarget(target) {
    const fx = this.active.get(target);
    if (!fx) return;
    for (const inst of fx.values()) this._onRemove(target, inst);
    this.active.delete(target);
  }

  /** Drop everything. */
  clear() {
    for (const [target, fx] of this.active) {
      for (const inst of fx.values()) this._onRemove(target, inst);
    }
    this.active.clear();
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (this.active.size === 0) return;
    for (const [target, fx] of this.active) {
      if (typeof target.isDead === 'function' && target.isDead()) {
        this.clearTarget(target);
        continue;
      }
      for (const [effectId, inst] of fx) {
        // Ticks accrue only for the portion of dt the effect was alive, so a
        // frame that crosses the expiry boundary still deals its final ticks.
        const alive = Math.min(dt, inst.remaining);
        inst.remaining -= dt;
        const kind = inst.def.kind;
        if ((kind === 'dot' || kind === 'hot') && alive > 0) {
          inst.tickAcc += alive * 1000;
          // Catch-up loop: a long frame still deals every missed tick.
          let guard = 0;
          while (inst.tickAcc >= inst.tickMs && guard++ < 64) {
            inst.tickAcc -= inst.tickMs;
            this._tick(inst);
          }
        }
        if (inst.remaining <= 0) {
          this._onRemove(target, inst);
          fx.delete(effectId);
        }
      }
      if (fx.size === 0) this.active.delete(target);
    }
  }

  /** Apply-time side effects (stat modifiers). */
  _onApply(target, inst) {
    const add = target.addModifier;
    if (typeof add !== 'function') return;
    const id = modifierId(inst.effectId);
    const def = inst.def;
    switch (def.kind) {
      case 'slow':
        add.call(target, { id, kind: 'chill', moveSpeedMult: def.slow });
        break;
      case 'stun':
        add.call(target, { id, kind: 'stun', stunned: true });
        break;
      case 'atkDown':
        add.call(target, { id, kind: 'weaken', attackMult: def.factor });
        break;
      case 'atkSpeedUp':
        add.call(target, { id, kind: 'haste', attackSpeedMult: def.factor });
        break;
      case 'shield':
        add.call(target, { id, kind: 'barrier', shield: inst.power, stacks: inst.stacks });
        break;
      default:
        break; // dot/hot carry no modifier
    }
  }

  /** Remove-time side effects. */
  _onRemove(target, inst) {
    if (typeof target.removeModifier === 'function') {
      target.removeModifier(modifierId(inst.effectId));
    }
  }

  /** One dot/hot tick. */
  _tick(inst) {
    const { target, def, effectId, power } = inst;
    if (def.kind === 'dot') {
      DamageSystem.applyDamage(
        { id: `status:${effectId}`, kind: 'environment' },
        target,
        {
          amount: power,
          type: def.type ?? 'physical',
          knockback: { x: 0, y: 0 },
          canCrit: false,
          hitStun: 0,
          ignoreIframes: true,
        },
      );
    } else if (def.kind === 'hot') {
      if (typeof target.heal === 'function') {
        target.heal(power, { source: `status:${effectId}` });
      }
    }
  }
}

/** Shared singleton — one timeline for all effects. */
export const statusEffects = new StatusEffects();
