/**
 * DamageSystem — the ONLY path for dealing damage (docs/ARCHITECTURE.md §9).
 *
 * CONTRACT:
 *   DamageSystem.applyDamage(source, target, opts)
 *     source: { id: string, kind: 'player'|'enemy'|'boss'|'environment' }
 *     target: entity exposing:
 *       - takeDamage(amount, info)          // post-mitigation damage; SHOULD
 *                                          // return true (or { killed: true })
 *                                          // when the hit kills the target
 *       - getDefense(type) -> number       // mitigation 0..1 for damage type
 *       - isInvulnerable() -> boolean      // i-frames / dodge / phase shield
 *       - id / kind (optional but recommended) for event payloads
 *       - isDead() (optional) / getHp() / getMaxHp() (optional, for events)
 *     opts: {
 *       amount: number,            // pre-mitigation raw damage
 *       type: 'physical'|'fire'|'ice'|'lightning'|'shadow'|'holy',
 *       knockback?: { x: number, y: number },
 *       critical?: boolean,        // explicit crit flag (caller-computed, e.g. PlayerStats)
 *       canCrit?: boolean,         // default true — roll when `critical` not set
 *       critChance?: number,       // 0..1 chance used for the roll (default 0)
 *       hitStun?: number,          // seconds; passed through to takeDamage
 *       ignoreIframes?: boolean,   // default false — true for DoTs / scripted
 *     }
 *     -> { dealt: number, killed: boolean, critical: boolean }
 *
 * RULES:
 * - Damage is computed ONCE here. Mitigation comes only from
 *   target.getDefense(type); the system never reaches into entity internals.
 * - I-frames are checked centrally via target.isInvulnerable(), unless
 *   ignoreIframes is set (status DoTs, scripted damage).
 * - Crit: an explicit `critical` flag wins; otherwise a crit is rolled when
 *   canCrit is true, using critChance. Crits multiply pre-mitigation damage
 *   by CRIT_MULTIPLIER.
 * - Emits 'combat:hitLanded' always, plus 'player:damaged' when
 *   target.kind === 'player' and 'enemy:damaged' when target.kind is
 *   'enemy'|'boss'. Payload shapes match the EventBus catalog.
 * - Feedback (damage numbers, hit pause, screenshake) listens to
 *   'combat:hitLanded' in src/effects — never called from here.
 *
 * Formulas are documented in docs/COMBAT.md ("Formulas (Wave 2)").
 */
import { eventBus } from '../core/EventBus.js';

/** Crit damage multiplier applied to pre-mitigation damage. */
export const CRIT_MULTIPLIER = 1.5;

/**
 * Mitigation hard cap: getDefense() can never grant full immunity through
 * this path (a target at 1.0 would take 0 from everything, including DoTs).
 */
export const MAX_MITIGATION = 0.9;

function targetIdOf(target) {
  return target?.id ?? target?.instanceId ?? 'unknown';
}

export class DamageSystem {
  /**
   * Pure crit roll — isolated so tests can reason about it without mocks
   * (pass critChance 0 or 1 for determinism).
   * @param {number} chance 0..1
   * @returns {boolean}
   */
  static rollCrit(chance) {
    const c = typeof chance === 'number' ? chance : 0;
    if (c <= 0) return false;
    if (c >= 1) return true;
    return Math.random() < c;
  }

  /**
   * @param {{id?:string, kind?:string}} source
   * @param {object} target entity with takeDamage/getDefense/isInvulnerable
   * @param {object} [opts]
   * @returns {{dealt:number, killed:boolean, critical:boolean}}
   */
  static applyDamage(source, target, opts = {}) {
    const {
      amount = 0,
      type = 'physical',
      knockback = { x: 0, y: 0 },
      critical = null,
      hitStun = 0,
      canCrit = true,
      critChance = 0,
      ignoreIframes = false,
    } = opts;

    if (!target || typeof target.takeDamage !== 'function') {
      throw new Error('[DamageSystem] target must expose takeDamage(amount, info)');
    }

    // Non-positive damage is a no-op (but not an error — callers may pass
    // computed values that round to zero).
    if (!(amount > 0)) {
      return { dealt: 0, killed: false, critical: false };
    }

    // Central i-frame check.
    if (!ignoreIframes && typeof target.isInvulnerable === 'function' && target.isInvulnerable()) {
      return { dealt: 0, killed: false, critical: false };
    }

    // Never double-kill: a target that reports itself dead takes nothing.
    if (typeof target.isDead === 'function' && target.isDead()) {
      return { dealt: 0, killed: true, critical: false };
    }

    // Crit: explicit flag wins, else roll when allowed.
    let isCrit = false;
    if (critical === true || critical === false) {
      isCrit = critical;
    } else if (canCrit) {
      isCrit = DamageSystem.rollCrit(critChance);
    }

    const raw = isCrit ? Math.round(amount * CRIT_MULTIPLIER) : amount;

    // Mitigation — the ONLY reduction step, sourced from the target.
    // getDefense(type) may return:
    //   - a number: fractional mitigation 0..1 (player contract), or
    //   - { flat, multiplier }: flat points shaved off the raw amount first,
    //     then multiplier scales what remains (enemy contract).
    let mitigation = 0;
    let flat = 0;
    if (typeof target.getDefense === 'function') {
      const d = target.getDefense(type);
      if (typeof d === 'number' && Number.isFinite(d)) {
        mitigation = d;
      } else if (d && typeof d === 'object') {
        if (typeof d.flat === 'number' && Number.isFinite(d.flat)) {
          flat = Math.max(0, d.flat);
        }
        if (typeof d.multiplier === 'number' && Number.isFinite(d.multiplier)) {
          mitigation = 1 - d.multiplier;
        }
      }
    }
    mitigation = Math.min(Math.max(mitigation, 0), MAX_MITIGATION);
    const dealt = Math.max(0, Math.round((raw - flat) * (1 - mitigation)));

    const attacker = source?.id ?? 'unknown';
    const info = {
      source: { id: attacker, kind: source?.kind ?? 'environment' },
      type,
      knockback: knockback ?? { x: 0, y: 0 },
      critical: isCrit,
      hitStun,
      dealt,
    };

    const ret = target.takeDamage(dealt, info);

    const killed =
      ret === true ||
      (ret != null && typeof ret === 'object' && ret.killed === true) ||
      (typeof target.isDead === 'function' && target.isDead());

    // Events — state transitions only; applyDamage is never called per-frame.
    const targetId = targetIdOf(target);
    eventBus.emit('combat:hitLanded', {
      attacker,
      target: targetId,
      amount: dealt,
      critical: isCrit,
    });

    const kind = target?.kind ?? null;
    if (kind === 'player') {
      eventBus.emit('player:damaged', {
        amount: dealt,
        source: attacker,
        hp: typeof target.getHp === 'function' ? target.getHp() : 0,
        maxHp: typeof target.getMaxHp === 'function' ? target.getMaxHp() : 0,
      });
    } else if (kind === 'enemy' || kind === 'boss') {
      eventBus.emit('enemy:damaged', {
        instanceId: targetId,
        amount: dealt,
        hp: typeof target.getHp === 'function' ? target.getHp() : 0,
      });
    }

    return { dealt, killed: !!killed, critical: isCrit };
  }
}
