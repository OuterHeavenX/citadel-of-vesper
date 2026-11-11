/**
 * Player — facade composing movement, combat, stats, animation (spec §11, §12).
 *
 * CONTRACT:
 * - The ONLY object scenes interact with: player.update(dt),
 *   player.getPosition(), player.takeDamage passthrough, etc.
 * - Owns the Phaser sprite + Arcade body; submodules receive `this`.
 *   Movement integrates its own gravity, so the body is created with
 *   allowGravity = false (see PlayerMovement).
 * - FEET-ANCHORED, like Enemy/Boss: sprite x/y (= getPosition()) is the
 *   point between Lucien's boots. The 64×64 art frames (assets/player/
 *   lucien.json) put the boots on row ART_FEET_ROW, so the origin sits
 *   there and the 12×22 Arcade body is centered above it — the drawn feet
 *   rest exactly on the floor the body collides with. setPosition() and the
 *   constructor lift the feet tuning.combat.spawnLift px above the requested
 *   y so a spawn/save point can never start the body inside a floor.
 * - Persists via GameState (position, hp, stats) — Player never touches
 *   SaveManager directly.
 * - Emits via eventBus: 'player:damaged' / 'player:died' from takeDamage();
 *   damage/heal/xp events otherwise come from PlayerStats / gameState.
 * - Attack input: update() turns a fresh 'attack' press (J / X / pad X /
 *   touch ATK) into combat.tryAttack() — PlayerCombat buffers and chains it.
 *   Ignored while dead, in hitstun or mid-backdash, and on frames the scene
 *   flags via update(dt, { attackInput: false }) (e.g. the frame a menu or
 *   dialogue closed on the same J/confirm press).
 *
 * INTEGRATION (W2-COMBAT): PlayerCombat and PlayerAnimation are owned by the
 * W2-COMBAT agent and land on the same branch. To keep every intermediate
 * commit buildable, Player does NOT construct them — GameScene (Wave 3)
 * attaches them after construction:
 *
 *   const player = new Player(scene, x, y);
 *   player.attachCombat(new PlayerCombat(player));
 *   player.attachAnimation(new PlayerAnimation(player.getSprite()));
 *
 * Until attached, getCombat() returns null and update() skips combat/
 * animation (guards are `?.`). Animation state is driven here from the
 * movement state when an animation module is attached.
 *
 * Wave 2 (W2-PLAYER) implements.
 */
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { tuning } from '../config/tuning.js';
import { getItemData } from '../items/ItemData.js';
import { PlayerMovement } from './PlayerMovement.js';
import { PlayerStats } from './PlayerStats.js';

/** Placeholder texture key until Wave 5 art lands (ARCHITECTURE.md §10). */
const PLACEHOLDER_TEXTURE = 'lucien';
const PLACEHOLDER_W = 16;
const PLACEHOLDER_H = 24;
/** First art frame; used as the initial texture when staged (no size swap). */
const ART_TEXTURE = 'lucien_idle';
/** Lucien art frame size + the row his boots end on (64×64 contract). */
const ART_FRAME = 64;
const ART_FEET_ROW = 62;
/** Arcade body (collision) size — unchanged from Wave 2 tuning. */
const BODY_W = PLACEHOLDER_W - 4;
const BODY_H = PLACEHOLDER_H - 2;

/** @returns {number} px the feet are placed above a requested spawn y */
function spawnLift() {
  return tuning.combat?.spawnLift ?? 10;
}

export class Player {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x spawn x (world px)
   * @param {number} y spawn y (world px)
   */
  constructor(scene, x, y) {
    this.scene = scene;
    this._spawn = { x, y };

    this.stats = new PlayerStats();
    this.movement = new PlayerMovement(this);
    /** @type {object|null} attached by GameScene (W2-COMBAT owns the class) */
    this.combat = null;
    /** @type {object|null} attached by GameScene (W2-COMBAT owns the class) */
    this.animation = null;

    /** @type {number} invulnerability timer (s) after taking damage */
    this._iframes = 0;

    this.sprite = this._createSprite(scene, x, y);
  }

  /**
   * @private create the physics sprite; generates a debug placeholder
   * texture when the Wave 5 'lucien' art is not yet loaded.
   */
  _createSprite(scene, x, y) {
    const hasArt = scene.textures.exists(ART_TEXTURE);
    if (!scene.textures.exists(PLACEHOLDER_TEXTURE)) {
      const gfx = scene.make.graphics({ x: 0, y: 0 }, false);
      gfx.fillStyle(0x2a2438, 1); // dark coat silhouette
      gfx.fillRect(0, 0, PLACEHOLDER_W, PLACEHOLDER_H);
      gfx.fillStyle(0x8a1f2d, 1); // pale-streak / headband accent
      gfx.fillRect(0, 2, PLACEHOLDER_W, 3);
      gfx.generateTexture(PLACEHOLDER_TEXTURE, PLACEHOLDER_W, PLACEHOLDER_H);
      gfx.destroy();
    }
    const sprite = scene.physics.add.sprite(
      x,
      y - spawnLift(),
      hasArt ? ART_TEXTURE : PLACEHOLDER_TEXTURE,
      hasArt ? 0 : undefined
    );
    // Movement integrates its own gravity (jump-cut/coyote math); Arcade
    // still resolves tile collisions and reports blocked/touching flags.
    sprite.body.setAllowGravity(false);
    sprite.body.setSize(BODY_W, BODY_H, false);
    // Room side edges are solid (Room sets left/right bounds collision only).
    sprite.body.setCollideWorldBounds?.(true);
    sprite.setDepth(10);
    this._bodyFrameW = 0;
    this._bodyFrameH = 0;
    this._syncBodyToFrame(sprite);
    return sprite;
  }

  /**
   * @private Keep the feet anchor + body aligned with the current frame
   * size (64×64 art, or the 16×24 placeholder when art is missing). Cheap
   * no-op unless the frame size changed. Body math (Arcade):
   *   body.top  = y + offset.y − displayOriginY = y − BODY_H   (feet on y)
   *   body.left = x + offset.x − displayOriginX = x − BODY_W/2 (centered)
   * @param {Phaser.GameObjects.Sprite} [sprite]
   */
  _syncBodyToFrame(sprite = this.sprite) {
    const frame = sprite?.frame;
    if (!frame || !sprite.body) return;
    const w = frame.width;
    const h = frame.height;
    if (!(w > 0 && h > 0)) return;
    if (w === this._bodyFrameW && h === this._bodyFrameH) return;
    this._bodyFrameW = w;
    this._bodyFrameH = h;
    const feetRow = w === ART_FRAME && h === ART_FRAME ? ART_FEET_ROW : h;
    sprite.setOrigin(0.5, feetRow / h);
    sprite.body.setOffset((w - BODY_W) / 2, feetRow - BODY_H);
  }

  // ------------------------------------------------------------ attach (W2)

  /**
   * Attach the combat submodule (called by GameScene; W2-COMBAT owns PlayerCombat).
   * @param {object} combat instance of PlayerCombat
   */
  attachCombat(combat) {
    this.combat = combat;
  }

  /**
   * Attach the animation submodule (called by GameScene; W2-COMBAT owns PlayerAnimation).
   * @param {object} anim instance of PlayerAnimation
   */
  attachAnimation(anim) {
    this.animation = anim;
  }

  // --------------------------------------------------------------- update

  /**
   * @param {number} dt seconds
   * @param {{attackInput?: boolean}} [opts] attackInput false = ignore the
   *   attack button this frame (a UI consumed the press)
   */
  update(dt, opts = {}) {
    if (dt <= 0) return;
    this._iframes = Math.max(0, this._iframes - dt);

    this.movement.update(dt);

    // Drop-through: one-way platforms ignore the body while the timer runs
    // (Wave 3 room code consults player.isDroppingThrough() in its
    // one-way collision callbacks as well).
    if (this.sprite?.body) {
      this.sprite.body.checkCollision.down = !this.movement.isDroppingThrough();
    }

    if (opts.attackInput !== false) this._pollAttackInput();
    this.combat?.update?.(dt);

    if (this.animation) {
      // Combat state wins while an attack is in flight so the swing clip
      // plays regardless of the movement state underneath.
      const attacking = !!this.combat?.isAttacking?.();
      const state = attacking ? 'attack' : this.movement.getState();
      this.animation.setState(state, {
        facing: this.movement.isFacingRight() ? 1 : -1,
        weaponFamily: this.getWeaponFamily(),
        // The weapon's own swing clip (e.g. the bladeless Pale Hour Blade
        // slash) + a per-swing id so chained attacks replay from frame 0.
        attackKey: attacking ? this.getAttackAnimKey() : null,
        attackId: attacking ? (this.combat?.getAttackSerial?.() ?? null) : null,
      });
      this.animation.update?.(dt);
    } else if (this.sprite) {
      // Minimal facing until the animation module lands.
      this.sprite.setFlipX(!this.movement.isFacingRight());
    }
    this._syncBodyToFrame();
  }

  /** @private fresh attack press -> PlayerCombat (buffers/chains itself) */
  _pollAttackInput() {
    if (!this.combat || typeof this.combat.tryAttack !== 'function') return;
    const input = this.movement.input;
    if (!input || typeof input.justPressed !== 'function' || !input.justPressed('attack')) return;
    const state = this.movement.getState();
    if (state === 'dead' || state === 'hitstun' || state === 'dash') return;
    this.combat.tryAttack();
  }

  /** @private weapon family of the equipped weapon ('sword' default) */
  getWeaponFamily() {
    return this._equippedWeaponDef()?.family ?? 'sword';
  }

  /**
   * The equipped weapon's preferred attack clip
   * (data/weapons.json attackProfile.animationKey), or null.
   * @returns {string|null}
   */
  getAttackAnimKey() {
    return this._equippedWeaponDef()?.attackProfile?.animationKey ?? null;
  }

  /** @private equipped weapon definition from the item registry, or null */
  _equippedWeaponDef() {
    const weaponId = gameState.data.equipment.weapon;
    const registry = getItemData();
    if (weaponId && registry.has(weaponId)) return registry.get(weaponId);
    return null;
  }

  // --------------------------------------------------------------- damage

  /**
   * Damage entry point — called ONLY by DamageSystem (ARCHITECTURE.md §9).
   * Applies i-frames from tuning.combat.iframesAfterHit, knockback takeover
   * via PlayerMovement, and emits 'player:damaged' / 'player:died'.
   * @param {number} amount post-mitigation damage
   * @param {object} [info] { source, type, knockback:{x,y}, hitStun, heavy }
   * @returns {number} damage actually applied (0 when ignored)
   */
  takeDamage(amount, info = {}) {
    if (this.isDead() || this.isInvulnerable() || !(amount > 0)) return 0;

    const p = gameState.data.player;
    const maxHp = this.stats.getEffectiveMaxHp();
    p.hp = Math.max(0, p.hp - amount);
    gameState.dirty = true;

    const kb = info.knockback ?? {
      // No data: shove away from facing, slightly upward.
      x: -this.movement.facing * tuning.knockback.takenKnockbackX,
      y: -tuning.knockback.takenKnockbackY,
    };
    const hitStun =
      info.hitStun ?? (info.heavy ? tuning.combat.hitStunHeavy : tuning.combat.hitStunLight);
    this.movement.applyKnockback(kb.x, kb.y, hitStun);
    this._iframes = tuning.combat.iframesAfterHit;

    const source = info.source;
    eventBus.emit('player:damaged', {
      amount,
      source: typeof source === 'string' ? source : (source?.id ?? 'unknown'),
      hp: p.hp,
      maxHp,
    });

    if (p.hp <= 0) {
      this.movement.setDead();
      eventBus.emit('player:died', { roomId: p.position.roomId });
    }
    return amount;
  }

  /** @param {'physical'|'fire'|'ice'|'lightning'|'shadow'|'holy'} type @returns {number} mitigation 0..0.85 */
  getDefense(type) {
    return this.stats.getDefense(type);
  }

  /** @returns {boolean} damage-immune right now (i-frames, dash, or dead) */
  isInvulnerable() {
    return this._iframes > 0 || this.movement.isDashInvulnerable() || this.isDead();
  }

  /** @returns {boolean} */
  isDead() {
    return gameState.data.player.hp <= 0;
  }

  // ------------------------------------------------------------------ misc

  /**
   * Heal, clamped to the effective max HP. Emits 'player:healed'.
   * @param {number} amount @returns {number} HP actually restored
   */
  heal(amount) {
    if (!(amount > 0) || this.isDead()) return 0;
    const p = gameState.data.player;
    const maxHp = this.stats.getEffectiveMaxHp();
    const actual = Math.min(amount, maxHp - p.hp);
    if (actual <= 0) return 0;
    p.hp += actual;
    gameState.dirty = true;
    eventBus.emit('player:healed', { amount: actual, hp: p.hp, maxHp });
    return actual;
  }

  /**
   * @param {number} amount raw XP
   * @returns {number} levels gained (0+)
   */
  addXp(amount) {
    return this.stats.gainXp(amount);
  }

  /** @returns {Phaser.GameObjects.Sprite} */
  getSprite() {
    return this.sprite;
  }

  /** @returns {string} movement state */
  getState() {
    return this.movement.getState();
  }

  /** @returns {boolean} */
  isFacingRight() {
    return this.movement.isFacingRight();
  }

  /** @returns {PlayerStats} */
  getStats() {
    return this.stats;
  }

  /** @returns {object|null} PlayerCombat once attached, else null */
  getCombat() {
    return this.combat;
  }

  /** @returns {PlayerMovement} */
  getMovement() {
    return this.movement;
  }

  /**
   * Teleport the player to a room spawn point (Wave 3 RoomManager).
   * Zeroes velocity and resets the movement state machine to neutral so no
   * stale jump/dash/hitstun state leaks across rooms. Callers that want to
   * preserve momentum re-apply velocity afterwards.
   * `y` is a ground-level point (room spawn / saved feet position); the feet
   * are placed tuning.combat.spawnLift px above it and settle onto the floor.
   * @param {number} x @param {number} y @param {number} [facing] 1 = right, -1 = left
   */
  setPosition(x, y, facing = 1) {
    this._spawn = { x, y };
    const s = this.sprite;
    if (!s) return;
    const feetY = y - spawnLift();
    s.setPosition(x, feetY);
    try {
      s.body?.setVelocity(0, 0);
      s.body?.reset?.(x, feetY);
    } catch { /* body may be mid-teardown */ }
    s.setFlipX(facing < 0);
    try {
      if (this.movement && this.movement.state !== 'dead') {
        this.movement.state = 'idle';
      }
    } catch { /* movement internals are W2-owned */ }
  }

  /** @returns {{x:number,y:number}} feet position (world px) */
  getPosition() {
    if (this.sprite) return { x: this.sprite.x, y: this.sprite.y };
    return { ...this._spawn };
  }

  /** Arcade body (used by PlayerMovement). @returns {object|null} */
  get body() {
    return this.sprite?.body ?? null;
  }

  destroy() {
    this.stats.destroy();
    this.combat = null;
    this.animation = null;
    this.sprite?.destroy();
    this.sprite = null;
  }
}
