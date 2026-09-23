/**
 * PlayerCombat — Lucien's attacks (docs/ARCHITECTURE.md §10).
 *
 * CONTRACT:
 * - Attacks are data-driven: the equipped weapon (gameState.equipment.weapon
 *   → data/weapons.json) selects an attackProfile
 *     { animationKey, reach, recovery, attackSpeed, knockback, soundId,
 *       anticipation, activeFrames, hitbox {w,h}, specials }.
 *   Weapon switching changes the profile live — it is re-resolved at every
 *   attack start (and getActiveProfile() always reflects the current weapon).
 * - Animation-driven phases: anticipation → active → recovery. A hitbox is
 *   spawned via HitboxSystem ONLY for the active window (activeFrom/To);
 *   anticipation and recovery never deal damage.
 * - tryAttack(): starts an attack, or buffers the input for
 *   tuning.combat.attackBuffer seconds when already attacking; the buffer is
 *   consumed when the current attack ends (combo chaining).
 * - takeDamage(amount, info): called ONLY by DamageSystem. Delegates to the
 *   Player facade (canonical damage target: HP, i-frames, knockback ->
 *   movement, player:damaged/died events) and cancels the current attack
 *   via cancelOnHit(). RoomManager must register the FACADE as the
 *   player's hurtbox target, not this module.
 * - DamageSystem target surface: id/kind ('player'), takeDamage,
 *   getDefense(type), isInvulnerable, isDead, getHp/getMaxHp.
 * - getDefense(type): prefers stats.resistances[type] (0..1 mitigation);
 *   falls back to a diminishing curve over flat defense/magicDefense so the
 *   system stays total even before PlayerStats is fully wired.
 *
 * FACADE USE (Player.js owns the facade; this module calls ONLY):
 *   player.getSprite(), player.isFacingRight(), player.getState(),
 *   player.getStats(), player.getPosition(), player.takeDamage(),
 *   player.isInvulnerable().
 * It never imports Player.js. Scene wiring:
 *   player.attachCombat(new PlayerCombat(player, { hitboxSystem }))
 *
 * INTEGRATION NOTES (Player.js / RoomManager, Wave 3):
 * - Player.update passes 'attack' to animation.setState while
 *   combat.isAttacking() so PlayerAnimation plays lucien_attack_<family>.
 * - Register the player's hurtbox with the HitboxSystem from Player.js
 *   (entity = the facade itself: takeDamage/getDefense/isInvulnerable).
 *   Enemy hitboxes then damage the player through the single DamageSystem
 *   path.
 *
 * trySecondary(): reserved for weapon specials (hold_attack / down_attack /
 * low_hp triggers, data/weapons.json `specials`). The special-move system
 * lands with AbilityManager in Wave 4; this returns false until then.
 */
import { tuning } from '../config/tuning.js';
import { gameState } from '../core/GameState.js';
import { dataManager } from '../core/DataManager.js';
import { eventBus } from '../core/EventBus.js';
import { audioManager } from '../core/AudioManager.js';

/**
 * Native fps of the attack animations. Source of truth:
 * assets/player/lucien.json (attack_sword.fps === 12); PlayerAnimation
 * builds the clips from the same file, so activeFrames stay in sync.
 */
const ATTACK_ANIM_FPS = 12;

/** Fallback weapon when none is equipped (first entry in weapons.json). */
function fallbackWeaponId() {
  const weapons = dataManager.getData('weapons');
  return weapons[0]?.id ?? null;
}

export class PlayerCombat {
  /**
   * @param {object} player the Player facade (see FACADE USE above)
   * @param {{hitboxSystem?: import('../combat/HitboxSystem.js').HitboxSystem}} [deps]
   */
  constructor(player, deps = {}) {
    this.player = player;
    this.hitboxSystem = deps.hitboxSystem ?? null;

    /** @type {'idle'|'anticipation'|'active'|'recovery'} */
    this.phase = 'idle';
    this.phaseT = 0;
    /** Resolved timing for the in-flight attack (seconds). */
    this._timing = null;
    /** Resolved attack profile for the in-flight attack. */
    this._profile = null;
    /** Buffered attack input timer (s). */
    this.bufferT = 0;
    /** Active hitbox id (for cancelOnHit). */
    this._hitboxId = null;
    /** weaponId -> resolved { profile, family, specials } cache */
    this._profileCache = new Map();
    this._lastWeaponId = undefined;
  }

  /** DamageSystem target identity. */
  get id() {
    return 'player';
  }

  /** DamageSystem target identity. */
  get kind() {
    return 'player';
  }

  // ---------------------------------------------------------- profile ----

  /** Resolve the current weapon's attack profile (live — reflects switching). */
  getActiveProfile() {
    const weaponId = gameState.data.equipment.weapon ?? fallbackWeaponId();
    if (weaponId !== this._lastWeaponId) {
      this._lastWeaponId = weaponId;
    }
    if (weaponId && !this._profileCache.has(weaponId)) {
      const weapons = dataManager.getData('weapons');
      const def = weapons.find((w) => w.id === weaponId) ?? weapons[0] ?? null;
      if (!def) throw new Error('[PlayerCombat] data/weapons.json has no weapons');
      this._profileCache.set(weaponId, {
        weaponId: def.id,
        family: def.family ?? 'sword',
        profile: { ...(def.attackProfile ?? {}) },
        specials: def.specials ?? [],
      });
    }
    return this._profileCache.get(weaponId) ?? null;
  }

  /** Combat speed multiplier: weapon attackSpeed × derived stat. */
  _attackSpeed(profile) {
    const stats = this._derivedStats();
    return (profile.attackSpeed ?? 1) * (stats.attackSpeed ?? 1);
  }

  /**
   * Derived stats object. The facade contract allows getStats() to return
   * either the derived-stats object or the PlayerStats instance (which
   * exposes getDerived()); both shapes are accepted.
   * @returns {object}
   */
  _derivedStats() {
    const s = this.player.getStats?.();
    if (!s) return {};
    if (typeof s.getDerived === 'function') return s.getDerived() ?? {};
    return s;
  }

  // ------------------------------------------------------------ attack ----

  /**
   * Attempt to start (or buffer) an attack.
   * @returns {boolean} true when the attack started immediately or was buffered
   */
  tryAttack() {
    if (this.phase === 'idle') {
      this._startAttack();
      return true;
    }
    // Buffer during anticipation/active/recovery — consumed on attack end.
    this.bufferT = tuning.combat.attackBuffer;
    return true;
  }

  /** Reserved for weapon specials (Wave 4 AbilityManager). @returns {false} */
  trySecondary() {
    return false;
  }

  /** @returns {boolean} */
  isAttacking() {
    return this.phase !== 'idle';
  }

  /** @returns {'idle'|'anticipation'|'active'|'recovery'} */
  getPhase() {
    return this.phase;
  }

  _startAttack() {
    const resolved = this.getActiveProfile();
    if (!resolved) return;
    const { profile } = resolved;
    const speed = Math.max(0.2, this._attackSpeed(profile));

    const anticipation = profile.anticipation ?? 0.06;
    const activeFrames = profile.activeFrames ?? 2;
    const active = activeFrames / (ATTACK_ANIM_FPS * speed);
    const recovery = (profile.recovery ?? 0.3) / speed;

    this._profile = resolved;
    this._timing = {
      anticipation,
      active,
      recovery,
      total: anticipation + active + recovery,
    };
    this.phase = 'anticipation';
    this.phaseT = 0;

    const soundId = profile.soundId ?? profile.sound;
    if (soundId && typeof audioManager?.playSfx === 'function') {
      audioManager.playSfx(soundId, { channel: 'weapons' });
    }
  }

  _beginActive() {
    this.phase = 'active';
    const { profile } = this._profile;
    const stats = this._derivedStats();
    const facing = this.player.isFacingRight() ? 1 : -1;
    const hb = profile.hitbox ?? { w: 36, h: 26 };
    const T = this._timing;

    if (this.hitboxSystem) {
      this._hitboxId = this.hitboxSystem.spawnHitbox(this.player, {
        w: hb.w,
        h: hb.h,
        // Hitbox rect is centered on this offset: half reach ahead of the
        // sprite center, mirrored automatically by HitboxSystem via facing.
        offsetX: (profile.reach ?? 34) * 0.5,
        offsetY: -6,
        duration: T.active + 0.02,
        activeFrom: 0,
        activeTo: T.active,
        hitOnce: true,
        source: { id: 'player', kind: 'player' },
        damage: {
          amount: stats.physicalAttack ?? 5,
          type: profile.damageType ?? 'physical',
          knockback: {
            x: facing * (profile.knockback ?? tuning.combat.knockbackBase),
            y: -20,
          },
          canCrit: true,
          critChance: stats.critChance ?? 0,
          hitStun: tuning.combat.hitStunLight,
        },
      });
    }
  }

  _beginRecovery() {
    this.phase = 'recovery';
    this._hitboxId = null; // hitbox already expired past activeTo
  }

  _endAttack() {
    this.phase = 'idle';
    this.phaseT = 0;
    this._timing = null;
    this._profile = null;
    this._hitboxId = null;
  }

  /**
   * Interrupt the current attack (e.g. the player was hit). Despawns the
   * active hitbox and drops any buffered input.
   */
  cancelOnHit() {
    if (this._hitboxId && this.hitboxSystem) {
      this.hitboxSystem.despawnHitbox(this._hitboxId);
    }
    this.bufferT = 0;
    this._endAttack();
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (this.bufferT > 0) this.bufferT = Math.max(0, this.bufferT - dt);

    if (this.phase === 'idle') {
      // Consume buffered attack input (combo chaining).
      if (this.bufferT > 0) {
        this.bufferT = 0;
        this._startAttack();
      }
      return;
    }

    this.phaseT += dt;
    const T = this._timing;
    if (!T) {
      this._endAttack();
      return;
    }

    // Cascade: one large dt (e.g. a hitch) can cross several phase
    // boundaries; walk them all so timing never gets stuck mid-attack.
    let guard = 0;
    while (guard++ < 8) {
      if (this.phase === 'anticipation' && this.phaseT >= T.anticipation) {
        this._beginActive();
      } else if (this.phase === 'active' && this.phaseT >= T.anticipation + T.active) {
        this._beginRecovery();
      } else if (this.phase === 'recovery' && this.phaseT >= T.total) {
        this._endAttack();
        if (this.bufferT > 0) {
          // Chained attack starts immediately (phaseT reset in _startAttack).
          this.bufferT = 0;
          this._startAttack();
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  // ------------------------------------------------------------ damage ----

  /**
   * Damage entry point — called ONLY by DamageSystem.
   *
   * INTEGRATION DECISION (Wave 2 coordinator): the Player facade is the
   * canonical DamageSystem target (it owns HP, i-frames, knockback ->
   * movement, and player:damaged/died events). This method delegates to
   * `player.takeDamage()` and only adds the combat-specific reaction:
   * getting hit interrupts the swing. RoomManager must register the
   * FACADE (not this) as the player's hurtbox target.
   *
   * @param {number} amount post-mitigation damage
   * @param {object} [info]
   * @returns {{ killed:boolean }} (DamageSystem reads .killed)
   */
  takeDamage(amount, info = {}) {
    this.player.takeDamage(amount, info);
    // Getting hit interrupts the swing.
    this.cancelOnHit();
    return { killed: this.isDead() };
  }

  /**
   * @deprecated Hit reactions are applied directly by the Player facade
   * (knockback -> PlayerMovement inside takeDamage). Always returns null.
   * @returns {null}
   */
  drainHitReaction() {
    return null;
  }

  /** @returns {boolean} delegates to the facade (owns i-frames + dash) */
  isInvulnerable() {
    return this.player.isInvulnerable();
  }

  /** @returns {boolean} */
  isDead() {
    return (gameState.data.player.hp ?? 1) <= 0;
  }

  /** @returns {number} */
  getHp() {
    return gameState.data.player.hp ?? 0;
  }

  /** @returns {number} */
  getMaxHp() {
    return gameState.data.player.maxHp ?? 0;
  }

  /**
   * Mitigation 0..1 for a damage type. Prefers the canonical source —
   * PlayerStats.getDefense(type) via the facade — and falls back to
   * resistances / a diminishing flat curve so the math stays total even if
   * PlayerStats isn't fully wired yet.
   * @param {'physical'|'fire'|'ice'|'lightning'|'shadow'|'holy'} type
   * @returns {number}
   */
  getDefense(type) {
    const stats = this.player.getStats?.();
    if (stats && typeof stats.getDefense === 'function') {
      const d = stats.getDefense(type);
      if (typeof d === 'number' && Number.isFinite(d)) {
        return Math.min(Math.max(d, 0), 1);
      }
    }
    const s = this._derivedStats();
    const res = s.resistances?.[type];
    if (typeof res === 'number') return Math.min(Math.max(res, 0), 1);
    const flat = type === 'physical' ? (s.defense ?? 0) : (s.magicDefense ?? 0);
    return flat > 0 ? flat / (flat + 50) : 0;
  }
}
