/**
 * PlayerAnimation — sprite/animation state machine for Lucien Vale
 * (docs/ARCHITECTURE.md §10).
 *
 * CONTRACT:
 * - Owns ALL player animation keys: 'lucien_idle', 'lucien_walk',
 *   'lucien_run', 'lucien_crouch', 'lucien_jump', 'lucien_fall',
 *   'lucien_land', 'lucien_turn', 'lucien_dash', 'lucien_attack_<family>',
 *   'lucien_hurt', 'lucien_die'. <family> = weapon family from the equipped
 *   weapon (sword art exists now; other families land with their art —
 *   missing family clips fall back to 'lucien_attack_sword').
 * - createAnims(scene): builds the clips from the boot-pack spritesheets
 *   using the frame layout in assets/player/lucien.json
 *   ({frames, fps} per clip). Headless-safe: clips whose texture key is
 *   missing are skipped, and play() is guarded by anims.exists().
 * - Attack clip resolution (first staged clip wins):
 *     1. the equipped weapon's attackProfile.animationKey (data/weapons.json)
 *        — e.g. 'lucien_attack_quick' for the Pale Hour Blade, whose clip
 *        never draws the blade (its slash is a separate effect, SlashFx);
 *     2. 'lucien_attack_<family>';
 *     3. 'lucien_attack_sword' (always staged).
 * - Every swing restarts its clip: callers pass a per-swing `attackId`
 *   (PlayerCombat.getAttackSerial()), so chained/buffered attacks replay the
 *   windup instead of holding the previous swing's last frame.
 * - Driven by movement/combat STATE — never by input directly. Two wirings
 *   are supported (see CONSTRUCTION below):
 *     update(player)            — facade-driven (primary contract)
 *     setState(state, opts)     — explicit state driver; opts { facing,
 *                                 weaponFamily, attackKey, attackId }
 * - One-shot clips (land, turn, hurt, die, attack_*) play once and hold
 *   their last frame until the state changes; locomotion clips loop.
 * - Facing via sprite.flipX (art faces right by default).
 *
 * CONSTRUCTION — accepts either form:
 *   new PlayerAnimation(player)  — the Player facade (contract form).
 *       Uses player.getSprite()/getState()/isFacingRight()/getStats() and
 *       honors combat: when player.getCombat()?.isAttacking() is true the
 *       'attack' clip plays regardless of movement state.
 *   new PlayerAnimation(sprite)  — a Phaser sprite directly (as wired by
 *       Player.js in Wave 2). Drive with setState(state, opts); update(dt)
 *       is a harmless no-op that flushes any state set before the sprite
 *       existed.
 *
 * INTEGRATION NOTE: whichever wiring is used, the caller must surface the
 * attack — i.e. pass/state 'attack' while PlayerCombat.isAttacking() — or
 * the swing clip never plays. (In facade mode this is handled internally
 * via player.getCombat().)
 */
import lucienLayout from '../../assets/player/lucien.json';
import { gameState } from '../core/GameState.js';
import { dataManager } from '../core/DataManager.js';

/** Movement/combat state -> animation key. */
const STATE_ANIMS = Object.freeze({
  idle: 'lucien_idle',
  walk: 'lucien_walk',
  run: 'lucien_run',
  crouch: 'lucien_crouch',
  jump: 'lucien_jump',
  fall: 'lucien_fall',
  land: 'lucien_land',
  turn: 'lucien_turn',
  dash: 'lucien_dash',
  hitstun: 'lucien_hurt',
  hurt: 'lucien_hurt',
  dead: 'lucien_die',
  die: 'lucien_die',
});

/** Clips that loop; everything else plays once and holds. */
const LOOPING = new Set(['idle', 'walk', 'run']);

/** Fallback family clip when the equipped family's art isn't staged yet. */
const FALLBACK_ATTACK_ANIM = 'lucien_attack_sword';

function isFacade(obj) {
  return !!obj && typeof obj.getSprite === 'function';
}

export class PlayerAnimation {
  /**
   * @param {object} playerOrSprite the Player facade (contract) or a
   *   Phaser sprite directly
   */
  constructor(playerOrSprite) {
    if (isFacade(playerOrSprite)) {
      this.player = playerOrSprite;
      this._sprite = null;
    } else {
      this.player = null;
      this._sprite = playerOrSprite ?? null;
    }
    /** @type {Phaser.Scene|null} */
    this.scene = null;
    /** @type {string|null} currently playing key (avoids restarts) */
    this._currentKey = null;
    /** State set before a sprite/scene was available. */
    this._pending = null;
    /** attackId of the swing whose clip is playing (restart detection). */
    this._attackId = null;
  }

  /**
   * Build all animation clips from staged spritesheets + lucien.json layout.
   * Safe to call headless or before art lands: missing textures are skipped.
   * @param {Phaser.Scene} scene
   */
  createAnims(scene) {
    this.scene = scene;
    const anims = scene?.anims;
    const textures = scene?.textures;
    if (!anims || !textures) return; // headless / torn-down scene

    const layoutAnims = lucienLayout?.animations ?? {};
    for (const [name, layout] of Object.entries(layoutAnims)) {
      const texKey = `lucien_${name}`;
      const animKey = `lucien_${name}`;
      if (!textures.exists(texKey)) continue; // art not staged yet — skip
      if (anims.exists(animKey)) continue;
      const frames = Math.max(1, layout.frames ?? 1);
      anims.create({
        key: animKey,
        frames: anims.generateFrameNumbers(texKey, { start: 0, end: frames - 1 }),
        frameRate: layout.fps ?? 8,
        repeat: LOOPING.has(name) ? -1 : 0,
      });
    }
    this._flushPending();
  }

  /** Equipped weapon definition, or null (no weapon / data not loaded). */
  _weaponDef() {
    try {
      const weaponId = gameState.data.equipment.weapon;
      if (!weaponId) return null;
      return dataManager.getData('weapons').find((w) => w.id === weaponId) ?? null;
    } catch {
      return null;
    }
  }

  /** Weapon family of the currently equipped weapon (default 'sword'). */
  _family() {
    return this._weaponDef()?.family ?? 'sword';
  }

  /** The equipped weapon's preferred attack clip (attackProfile.animationKey). */
  _weaponAttackKey() {
    return this._weaponDef()?.attackProfile?.animationKey ?? null;
  }

  /**
   * Resolve the attack clip: the weapon's own animationKey when staged, then
   * the family clip, then the staged sword art.
   * @param {string} [family] weapon family
   * @param {string|null} [preferred] attackProfile.animationKey
   */
  _attackKey(family, preferred = null) {
    const familyKey = `lucien_attack_${family ?? this._family()}`;
    const anims = this.scene?.anims;
    if (!anims || typeof anims.exists !== 'function') {
      return preferred ?? familyKey; // no scene to check against — trust the caller
    }
    if (preferred && anims.exists(preferred)) return preferred;
    if (anims.exists(familyKey)) return familyKey;
    return FALLBACK_ATTACK_ANIM;
  }

  /** @returns {Phaser.GameObjects.Sprite|null} */
  _resolveSprite() {
    if (this.player) return this.player.getSprite?.() ?? null;
    return this._sprite;
  }

  /**
   * Explicit state driver (sprite wiring). Never reads input.
   * @param {string} state movement/combat state; 'attack' plays the
   *   weapon's attack clip (see "Attack clip resolution" above)
   * @param {{facing?: number, weaponFamily?: string, attackKey?: string|null,
   *   attackId?: number|null}} [opts] facing: 1|-1; attackKey: the weapon's
   *   attackProfile.animationKey; attackId: per-swing serial — a new id
   *   restarts the attack clip even when the key is unchanged
   */
  setState(state, opts = {}) {
    const sprite = this._resolveSprite();
    if (!sprite) {
      this._pending = { state, opts }; // sprite not ready yet — stash
      return;
    }
    this._pending = null;

    if (opts.facing !== undefined) {
      const flip = opts.facing < 0;
      if (typeof sprite.setFlipX === 'function') sprite.setFlipX(flip);
      else sprite.flipX = flip;
    }

    const attacking = state === 'attack';
    const key = attacking
      ? this._attackKey(opts.weaponFamily, opts.attackKey ?? null)
      : (STATE_ANIMS[state] ?? STATE_ANIMS.idle);

    // A chained swing keeps state 'attack' (and often the same key) — a new
    // attackId is what tells us to replay the clip from its first frame.
    const newSwing =
      attacking && opts.attackId !== undefined && opts.attackId !== null && opts.attackId !== this._attackId;
    if (attacking && opts.attackId !== undefined) this._attackId = opts.attackId;
    if (!attacking) this._attackId = null;

    if (key !== this._currentKey || newSwing) {
      this._currentKey = key;
      this._play(sprite, key);
    }
  }

  /**
   * Facade-driven update (contract wiring). Reads state from the player —
   * never input — and honors combat: 'attack' wins while
   * player.getCombat()?.isAttacking().
   * In sprite wiring this accepts the frame dt (or nothing) and only
   * flushes a pending setState.
   * @param {object|number} [playerOrDt] the Player facade, or dt in sprite mode
   */
  update(playerOrDt) {
    if (isFacade(playerOrDt)) {
      const player = playerOrDt;
      let state = player.getState?.() ?? 'idle';
      try {
        if (player.getCombat?.()?.isAttacking?.()) state = 'attack';
      } catch {
        /* combat optional — movement state stands */
      }
      const facing =
        typeof player.isFacingRight === 'function' ? (player.isFacingRight() ? 1 : -1) : 1;
      let attackId = null;
      try {
        attackId = player.getCombat?.()?.getAttackSerial?.() ?? null;
      } catch {
        attackId = null;
      }
      this.setState(state, {
        facing,
        weaponFamily: this._family(),
        attackKey: this._weaponAttackKey(),
        attackId,
      });
      return;
    }
    this._flushPending();
  }

  /** Apply a stashed setState now that a sprite/scene exists. */
  _flushPending() {
    if (this._pending) {
      const { state, opts } = this._pending;
      this._pending = null;
      this.setState(state, opts);
    }
  }

  /** Guarded play: no-ops headless or when the clip isn't staged. */
  _play(sprite, key) {
    if (!this.scene || typeof this.scene.anims?.exists !== 'function') return;
    if (!this.scene.anims.exists(key)) return;
    if (typeof sprite.play === 'function') sprite.play(key);
  }

  /**
   * Play a one-shot clip, then invoke onComplete. Used for cutscene beats;
   * normal gameplay flows through update()/setState() instead.
   * @param {string} key animation key
   * @param {Function} [onComplete]
   */
  playOneShot(key, onComplete) {
    const sprite = this._resolveSprite();
    if (!sprite) {
      if (typeof onComplete === 'function') onComplete();
      return;
    }
    this._currentKey = key;
    this._play(sprite, key);
    if (typeof onComplete === 'function') {
      if (typeof sprite.once === 'function') {
        sprite.once('animationcomplete', onComplete);
      } else {
        onComplete();
      }
    }
  }

  /** @returns {string|null} currently playing animation key */
  getCurrentKey() {
    return this._currentKey;
  }
}
