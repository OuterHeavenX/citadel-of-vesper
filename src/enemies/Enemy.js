/**
 * Enemy — base class for all enemies (spec §34, §35, ARCHITECTURE.md §11).
 *
 * CONTRACT:
 * - Data-driven: constructed from data/enemies.json entries
 *   (see data/schemas/enemy.schema.json). No hardcoded enemy stats here;
 *   per-enemy tuning lives in src/enemies/variants.js as named constants.
 * - AI STATE MACHINE: idle | patrol | pursue | attack | stagger | dead.
 *   Behavior flags (data `behaviors`) enable: retreat | leap | dodge |
 *   block | teleport | fly | crawl | ambush | cast | summon | charge.
 * - EVERY attack is telegraphed: beginAttack() runs a windup phase from
 *   data `telegraphs` (flash + scale punch + anticipation pause + sound)
 *   before strike frames. Damage can only land during/after the windup.
 * - Damage in/out ONLY via DamageSystem (programmed against the §9
 *   interface: DamageSystem.applyDamage(source, target, opts)). The actual
 *   call is routed through `ctx.dealDamage` (defaults to
 *   DamageSystem.applyDamage) so tests can inject a fake without importing
 *   W2-COMBAT's in-progress module. Do NOT import Player/Enemy internals
 *   across modules — the player is reached only as a DamageSystem target
 *   ({ takeDamage, getDefense, isInvulnerable }) via ctx.getPlayer().
 * - Sleeping: update() early-outs when the enemy is outside the camera
 *   worldView (+ margin), per spec §56. With no scene (headless/tests) the
 *   enemy is always considered on-camera.
 * - Death: emits 'enemy:died' { enemyId, instanceId, roomId, drops },
 *   rolls drops from data `drops`, awards XP via ctx.addXp (defaults to
 *   gameState.addXp — the PlayerStats-agnostic path; PlayerStats listens
 *   for `player:xpGained`), marks the bestiary kill, spawns pickups via
 *   ctx.spawnPickup, and calls the optional ctx.onDeath(enemy) hook that
 *   RoomManager injects for room-level bookkeeping.
 *
 * Headless support: passing `scene = null` skips ALL Phaser object
 * creation (no sprite, no tweens). Position/velocity/state logic runs on
 * plain numbers, so the state machine, telegraph sequencing, and drop
 * rolls are unit-testable in vitest without Phaser.
 *
 * ctx contract (all optional unless noted):
 *   roomId            string — included in the enemy:died payload
 *   rng               () => number in [0,1) — default Math.random
 *   dealDamage        (source, target, opts) => { dealt, killed, critical }
 *                     default: DamageSystem.applyDamage
 *   getPlayer         () => player entity (DamageSystem target) | null
 *   getFloorY         (x) => number — ground plane; default () => spawnY
 *   projectileSystem  optional — { fire(spec) } for the `cast` behavior
 *   hitboxSystem      optional — reserved for Wave 3 melee hitbox wiring;
 *                     base melee uses direct range checks + DamageSystem
 *   spawnPickup       (x, y, pickupRef) => void — default no-op. pickupRef
 *                     is a Pickup kind ('coin'|'heart'|'mana') or an itemId
 *   onDeath           (enemy) => void — optional RoomManager hook
 *   playSfx           (id, opts) => void — default audioManager.playSfx
 *   addXp             (n) => void — default (n) => gameState.addXp(n)
 *   bestiarySeen      (id) => void — default gameState.markBestiarySeen
 *   bestiaryKill      (id) => void — default gameState.recordBestiaryKill
 *
 * Subclassing: override pickAttack(), strikeAttack(player), and any
 * update<State>() method. Tune via instance fields set in the subclass
 * constructor (see defaults below).
 */
import { DamageSystem } from '../combat/DamageSystem.js';
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { audioManager } from '../core/AudioManager.js';

const GRAVITY = 1400; // px/s^2 for grounded enemies
const SLEEP_MARGIN = 96; // px beyond the camera view before sleeping
const CONTACT_COOLDOWN = 0.8; // s between contact-damage ticks
const HIT_INVULN = 0.12; // s of i-frames after taking a hit
const STAGGER_TIME = 0.55; // s spent in stagger

/**
 * Pure drop-roll: for each { itemId, chance, quantity }, push itemId
 * `quantity` times when rng() < chance. Exported for tests.
 * @param {Array<{itemId:string,chance:number,quantity?:number}>} drops
 * @param {() => number} rng
 * @returns {string[]} item ids (one entry per dropped unit)
 */
export function rollDrops(drops, rng) {
  const out = [];
  for (const d of drops ?? []) {
    if (rng() < d.chance) {
      const n = Math.max(1, d.quantity ?? 1);
      for (let i = 0; i < n; i++) out.push(d.itemId);
    }
  }
  return out;
}

export class Enemy {
  /**
   * @param {Phaser.Scene|null} scene null => headless (no Phaser objects)
   * @param {object} def enemy definition from data/enemies.json
   * @param {string} instanceId unique per spawn, e.g. `${roomId}:3`
   * @param {number} x @param {number} y spawn position (feet)
   * @param {object} [ctx] integration hooks (see contract above)
   */
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    if (!def || typeof def.id !== 'string') {
      throw new Error('[Enemy] constructed without a valid enemy definition.');
    }
    this.scene = scene;
    this.def = def;
    this.enemyId = def.id;
    this.instanceId = instanceId;
    this.ctx = {
      roomId: ctx.roomId ?? 'unknown_room',
      rng: ctx.rng ?? Math.random,
      dealDamage: ctx.dealDamage ?? ((s, t, o) => DamageSystem.applyDamage(s, t, o)),
      getPlayer: ctx.getPlayer ?? (() => null),
      getFloorY: ctx.getFloorY ?? (() => this.spawnY),
      projectileSystem: ctx.projectileSystem ?? null,
      hitboxSystem: ctx.hitboxSystem ?? null,
      spawnPickup: ctx.spawnPickup ?? (() => {}),
      onDeath: ctx.onDeath ?? null,
      playSfx: ctx.playSfx ?? ((id, opts) => audioManager.playSfx(id, opts)),
      addXp: ctx.addXp ?? ((n) => gameState.addXp(n)),
      bestiarySeen: ctx.bestiarySeen ?? ((id) => gameState.markBestiarySeen(id)),
      bestiaryKill: ctx.bestiaryKill ?? ((id) => gameState.recordBestiaryKill(id)),
    };

    // ---- position / velocity (feet-anchored; plain numbers, no Phaser) ----
    this.spawnX = x;
    this.spawnY = y;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1; // 1 = right, -1 = left
    this.grounded = true;
    this.airTime = 0;

    // ---- vitals ----
    this.maxHp = def.hp;
    this.hp = def.hp;
    this.maxPoise = 20 + (def.stats?.defense ?? 0) * 5;
    this.poise = 0;

    // ---- AI state ----
    this.state = 'idle';
    this.stateT = 0; // time in current state
    this.patrolDir = this.ctx.rng() < 0.5 ? -1 : 1;
    this.patrolT = 2 + this.ctx.rng() * 2;
    this.attackName = null;
    this.attackPhase = null; // windup | strike | recover
    this.attackT = 0;
    this.cooldownT = 0;
    this.contactT = 0;
    this.retreatT = 0;
    this.invulnT = 0;
    this.staggerT = 0;
    this.seenByBestiary = false;
    this.leapActive = false;
    this.destroyed = false;

    // ---- telegraph visuals ----
    this._flashT = 0;
    this._flashOn = false;
    this._warnedNoProjectiles = false;

    // ---- tuning defaults (subclasses override in constructor) ----
    this.aggroRange = 170;
    this.aggroDy = 80; // vertical aggro tolerance for grounded enemies
    this.attackRange = 42;
    this.patrolSpeed = 40;
    this.cooldown = 1.2;
    this.recoverTime = 0.45;
    this.strikeTime = 0.12;
    this.contactMult = 0.7;
    this.contactW = 16;
    this.contactH = 24;
    this.leapMult = 1.0;
    this.flashColor = 0xffffff;
    this.blockChance = 0; // >0 enables the `block` behavior in takeDamage

    this.sprite = null;
    if (scene && scene.add) this._createSprite();
  }

  // ------------------------------------------------------------------ helpers

  hasBehavior(flag) {
    return (this.def.behaviors ?? []).includes(flag);
  }

  get isFlying() {
    return this.hasBehavior('fly');
  }

  /** @returns {string} current AI state */
  getState() {
    return this.state;
  }

  /** @returns {boolean} */
  isAlive() {
    return this.state !== 'dead';
  }

  getTelegraph(attackName) {
    const found = (this.def.telegraphs ?? []).find((t) => t.attack === attackName);
    return found ?? { attack: attackName, windup: 0.5, flash: true, sound: 'enemy_hit' };
  }

  _playSfx(id, opts = {}) {
    try {
      this.ctx.playSfx(id, { channel: 'enemies', x: this.x, y: this.y, ...opts });
    } catch {
      /* audio is best-effort; never break AI on a sound failure */
    }
  }

  _setState(next) {
    if (this.state === next || this.state === 'dead') return;
    this.state = next;
    this.stateT = 0;
    if (next === 'pursue' && !this.seenByBestiary) {
      this.seenByBestiary = true;
      try {
        this.ctx.bestiarySeen(this.enemyId);
      } catch {
        /* bestiary is best-effort */
      }
    }
    if (next === 'idle' || next === 'patrol') this.playAnim(this._moveAnim());
  }

  _moveAnim() {
    return 'idle';
  }

  playAnim(kind) {
    if (!this.sprite || !this.scene) return;
    const key = `${this.def.sprite}_${kind}`;
    try {
      if (this.scene.anims && this.scene.anims.exists(key) && this.sprite.anims?.currentAnim?.key !== key) {
        this.sprite.play(key);
      }
    } catch {
      /* anims are best-effort */
    }
  }

  // ------------------------------------------------------------------ sprite

  _createSprite() {
    const key = `${this.def.sprite}_idle`;
    const scene = this.scene;
    try {
      const hasTex = scene.textures && scene.textures.exists(key);
      this.sprite = scene.add.sprite(this.x, this.y, hasTex ? key : undefined);
      this.sprite.setOrigin(0.5, 1); // x/y = feet
      this.sprite.setDepth(10);
      this.playAnim('idle');
    } catch {
      this.sprite = null;
    }
  }

  _syncSprite() {
    const s = this.sprite;
    if (!s) return;
    try {
      s.setPosition(this.x, this.y);
      s.setFlipX(this.facing < 0);
    } catch {
      /* ignore */
    }
  }

  _setFlash(on) {
    if (!this.sprite) return;
    try {
      if (on) this.sprite.setTintFill(this.flashColor);
      else this.sprite.clearTint();
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ update

  /**
   * @param {number} dt seconds
   * @param {object|null} [playerPos] { x, y } — convenience; falls back to ctx.getPlayer()
   */
  update(dt, playerPos = null) {
    if (this.destroyed) return;
    if (this.state === 'dead') {
      this._updateDead(dt);
      return;
    }
    // Sleeping: skip AI + physics entirely when off-camera (spec §56).
    if (!this.isOnCamera()) return;

    this.stateT += dt;
    this.cooldownT = Math.max(0, this.cooldownT - dt);
    this.contactT = Math.max(0, this.contactT - dt);
    this.invulnT = Math.max(0, this.invulnT - dt);
    this.retreatT = Math.max(0, this.retreatT - dt);

    const p = playerPos ?? this._playerPos();
    if (p && this.state !== 'attack' && this.state !== 'stagger') {
      const want = p.x >= this.x ? 1 : -1;
      if (this.state === 'pursue' || Math.abs(p.x - this.x) > 6) this.facing = want;
    }

    this._contactDamage(p);

    switch (this.state) {
      case 'idle': this.updateIdle(dt, p); break;
      case 'patrol': this.updatePatrol(dt, p); break;
      case 'pursue': this.updatePursue(dt, p); break;
      case 'attack': this.updateAttack(dt, p); break;
      case 'stagger': this.updateStagger(dt, p); break;
    }

    this._integrate(dt);
    this._syncSprite();
  }

  _playerPos() {
    try {
      const pl = this.ctx.getPlayer();
      if (pl && typeof pl.x === 'number') return { x: pl.x, y: pl.y ?? this.y, ref: pl };
    } catch {
      /* ignore */
    }
    return null;
  }

  isOnCamera() {
    const cams = this.scene && this.scene.cameras;
    if (!cams || !cams.main) return true; // headless/tests: always awake
    const v = cams.main.worldView;
    if (!v) return true;
    return (
      this.x > v.x - SLEEP_MARGIN &&
      this.x < v.x + v.width + SLEEP_MARGIN &&
      this.y > v.y - SLEEP_MARGIN &&
      this.y < v.y + v.height + SLEEP_MARGIN
    );
  }

  /** 2D distance to the player (or Infinity). */
  distTo(p) {
    if (!p) return Infinity;
    return Math.hypot(p.x - this.x, p.y - this.y);
  }

  inAggro(p) {
    if (!p) return false;
    if (this.isFlying) return this.distTo(p) < this.aggroRange;
    return Math.abs(p.x - this.x) < this.aggroRange && Math.abs(p.y - this.y) < this.aggroDy;
  }

  inAttackRange(p) {
    if (!p) return false;
    if (this.isFlying) return this.distTo(p) < this.attackRange;
    return Math.abs(p.x - this.x) < this.attackRange && Math.abs(p.y - this.y) < this.aggroDy;
  }

  // ------------------------------------------------------------ state updates

  updateIdle(dt, p) {
    this.vx = 0;
    if (!this.isFlying) this.vy = 0;
    if (this.inAggro(p)) {
      this._setState('pursue');
      return;
    }
    if (this.hasBehavior('patrol') && this.stateT > 1.2) {
      this._setState('patrol');
      this.patrolT = 2 + this.ctx.rng() * 2;
    }
  }

  updatePatrol(dt, p) {
    if (this.inAggro(p)) {
      this._setState('pursue');
      return;
    }
    const sp = this.patrolSpeed;
    this.vx = this.patrolDir * sp;
    if (this.isFlying) this.vy = Math.sin(this.stateT * 2.2) * 18;
    this.patrolT -= dt;
    // turn at leash range or when the timer expires
    if (this.patrolT <= 0 || Math.abs(this.x - this.spawnX) > 150) {
      this.patrolDir *= -1;
      this.facing = this.patrolDir;
      this.patrolT = 2 + this.ctx.rng() * 2;
      if (this.ctx.rng() < 0.35) this._setState('idle');
    }
    this.playAnim(this._moveAnim());
  }

  updatePursue(dt, p) {
    if (!p) {
      this._setState('idle');
      return;
    }
    if (this.distTo(p) > this.aggroRange * 1.6) {
      this._setState(this.hasBehavior('patrol') ? 'patrol' : 'idle');
      return;
    }
    if (this.cooldownT <= 0 && this.inAttackRange(p)) {
      this.beginAttack(this.pickAttack());
      return;
    }
    const speed = this.def.stats?.speed ?? 60;
    const dx = p.x - this.x;
    const dir = Math.sign(dx) || this.facing;
    if (this.retreatT > 0 && this.hasBehavior('retreat')) {
      // back off after a combo — the `retreat` behavior flag
      this.vx = -dir * speed * 0.55;
    } else {
      this.vx = dir * speed;
    }
    if (this.isFlying) {
      const dy = p.y - 40 - this.y;
      this.vy = Math.max(-90, Math.min(90, dy * 2)) + Math.sin(this.stateT * 3) * 12;
    }
    this.playAnim(this._moveAnim());
  }

  updateStagger(dt) {
    this.vx *= 1 - Math.min(1, dt * 8);
    this.staggerT -= dt;
    if (this.staggerT <= 0) {
      this.poise = 0;
      this._setState('pursue');
    }
  }

  // ------------------------------------------------------------------ attacks

  /** Choose which named attack to use. Subclasses override for combos. */
  pickAttack() {
    return (this.def.telegraphs ?? [])[0]?.attack ?? 'strike';
  }

  /**
   * Start a telegraphed attack: windup (flash + scale punch + anticipation
   * pause + sound) -> strikeAttack() -> recover. Pure sequencing, no Phaser
   * required — safe to drive from tests.
   * @param {string} attackName must match a data telegraph `attack`
   */
  beginAttack(attackName) {
    const t = this.getTelegraph(attackName);
    this._setState('attack');
    this.attackName = attackName;
    this.attackPhase = 'windup';
    this.attackT = Math.max(0.05, t.windup);
    // anticipation pause: freeze horizontal motion during the windup
    this.vx = 0;
    if (!this.isFlying) this.vy = 0;
    this._flashT = this.attackT;
    this._flashOn = false;
    if (this.sprite) {
      try {
        this.sprite.setScale(1.1, 0.92); // crouch/anticipation punch
      } catch {
        /* ignore */
      }
    }
    if (t.sound) this._playSfx(t.sound);
    this.playAnim('attack');
  }

  updateAttack(dt, p) {
    this.attackT -= dt;
    if (this.attackPhase === 'windup') {
      // flashing telegraph while the windup runs down
      this._flashT -= dt;
      if (this._flashT <= 0) {
        this._flashOn = !this._flashOn;
        this._setFlash(this._flashOn);
        this._flashT = 0.09;
      }
      if (this.attackT <= 0) {
        this._setFlash(false);
        if (this.sprite) {
          try {
            this.sprite.setScale(1, 1);
          } catch {
            /* ignore */
          }
        }
        this.attackPhase = 'strike';
        this.attackT = this.strikeTime;
        this.strikeAttack(p);
      }
    } else if (this.attackPhase === 'strike') {
      if (this.attackT <= 0) {
        this.attackPhase = 'recover';
        this.attackT = this.recoverTime;
        this.playAnim(this._moveAnim());
      }
    } else {
      // recover
      if (this.attackT <= 0) this._endAttack(p);
    }
  }

  /**
   * The damaging moment of the attack. Base implementation is a plain
   * frontal melee swing; subclasses override (leaps, casts, AoEs, charges).
   * @param {object|null} p player pos { x, y, ref? }
   */
  strikeAttack(p) {
    this.dealMelee(p, {
      range: this.attackRange + 14,
      arcH: 30,
      mult: 1.0,
      type: 'physical',
      knockback: { x: this.facing * 120, y: -40 },
      hitStun: 0.25,
    });
  }

  _endAttack(p) {
    this.attackName = null;
    this.attackPhase = null;
    this.cooldownT = this.cooldown;
    if (this.hasBehavior('retreat') && p) this.retreatT = 0.6;
    this._setState(p && this.inAggro(p) ? 'pursue' : 'idle');
  }

  // ------------------------------------------------------- damage primitives

  /**
   * Frontal melee hit vs the player. No hit = no damage (whiff is fair).
   * @param {object|null} p player pos { x, y, ref? }
   * @param {object} opts { range, arcH, mult, type, knockback, hitStun }
   * @returns {object|null} DamageSystem result or null on whiff
   */
  dealMelee(p, opts = {}) {
    const target = p?.ref ?? (p ? this.ctx.getPlayer() : null);
    if (!target) return null;
    const dx = (p?.x ?? target.x) - this.x;
    const dy = (p?.y ?? target.y) - this.y;
    const range = opts.range ?? this.attackRange;
    const arcH = opts.arcH ?? 30;
    if (this.facing * dx < -4) return null; // behind the enemy: clean miss
    if (Math.abs(dx) > range || Math.abs(dy) > arcH) return null;
    const amount = (this.def.stats?.attack ?? 5) * (opts.mult ?? 1);
    return this.ctx.dealDamage(
      { id: this.enemyId, kind: 'enemy' },
      target,
      {
        amount,
        type: opts.type ?? 'physical',
        knockback: opts.knockback ?? { x: this.facing * 100, y: -30 },
        hitStun: opts.hitStun ?? 0.25,
      },
    );
  }

  /**
   * Radial AoE hit vs the player (bell rings, shockwaves).
   * @param {object|null} p player pos
   * @param {object} opts { radius, mult, type, knockback, hitStun }
   */
  dealRadial(p, opts = {}) {
    const target = p?.ref ?? (p ? this.ctx.getPlayer() : null);
    if (!target) return null;
    const radius = opts.radius ?? 100;
    if (this.distTo(p ?? target) > radius) return null;
    const amount = (this.def.stats?.attack ?? 5) * (opts.mult ?? 1);
    const away = Math.sign((p?.x ?? target.x) - this.x) || 1;
    return this.ctx.dealDamage(
      { id: this.enemyId, kind: 'enemy' },
      target,
      {
        amount,
        type: opts.type ?? 'physical',
        knockback: opts.knockback ?? { x: away * 160, y: -80 },
        hitStun: opts.hitStun ?? 0.4,
      },
    );
  }

  /**
   * Fire a hostile projectile through the injected ProjectileSystem
   * (the `cast` behavior). Falls back to a warning when no system is
   * wired (headless/tests) — never throws.
   * @param {object} spec projectile fields; damage merged with enemy attack
   */
  castProjectile(spec = {}) {
    const ps = this.ctx.projectileSystem;
    if (!ps || typeof ps.fire !== 'function') {
      if (!this._warnedNoProjectiles) {
        this._warnedNoProjectiles = true;
        console.warn(`[Enemy:${this.enemyId}] castProjectile with no projectileSystem — skipped.`);
      }
      return null;
    }
    const atk = this.def.stats?.attack ?? 5;
    return ps.fire({
      x: this.x,
      y: this.y - 24,
      vx: this.facing * 150,
      vy: -120,
      w: 8,
      h: 8,
      texture: 'fx_hit_spark',
      life: 3,
      owner: 'enemy',
      ...spec,
      damage: {
        amount: atk * (spec.mult ?? 1),
        type: spec.type ?? 'fire',
        knockback: spec.knockback ?? { x: this.facing * 80, y: -40 },
        hitStun: spec.hitStun ?? 0.25,
        ...(spec.damage ?? {}),
      },
    });
  }

  /** Begin an arcing leap (the `leap` behavior). Landing ends it. */
  startLeap(vx, vy) {
    this.vx = vx;
    this.vy = vy;
    this.grounded = false;
    this.leapActive = true;
  }

  _onLandLeap() {
    this.leapActive = false;
  }

  // --------------------------------------------------------------- contact

  _contactDamage(p) {
    if (!p || this.state === 'dead') return;
    if (this.contactT > 0) return;
    const target = p.ref ?? this.ctx.getPlayer();
    if (!target) return;
    const dx = (p.x ?? target.x) - this.x;
    const dy = (p.y ?? target.y) - this.y;
    if (Math.abs(dx) > this.contactW || Math.abs(dy) > this.contactH) return;
    this.contactT = CONTACT_COOLDOWN;
    const mult = this.leapActive ? this.leapMult : this.contactMult;
    const away = Math.sign(dx) || 1;
    this.ctx.dealDamage(
      { id: this.enemyId, kind: 'enemy' },
      target,
      {
        amount: (this.def.stats?.attack ?? 5) * mult,
        type: 'physical',
        knockback: { x: away * 120, y: -60 },
        hitStun: 0.2,
      },
    );
  }

  // ---------------------------------------------------------------- physics

  _integrate(dt) {
    if (this.isFlying) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      return;
    }
    const wasAirborne = !this.grounded;
    this.vy += GRAVITY * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    let floor = this.spawnY;
    try {
      floor = this.ctx.getFloorY(this.x);
    } catch {
      /* keep spawn plane */
    }
    if (this.y >= floor) {
      this.y = floor;
      this.vy = 0;
      this.grounded = true;
      this.airTime = 0;
      if (wasAirborne && this.leapActive) this._onLandLeap();
    } else {
      this.grounded = false;
      this.airTime += dt;
    }
  }

  // ------------------------------------------------------------------ damage

  /**
   * DamageSystem target contract: takeDamage(amount, info).
   * `amount` is post-mitigation. Returns the amount actually applied.
   * @param {number} amount
   * @param {object} [info] { type, attackerX, attackerY, ... }
   */
  takeDamage(amount, info = {}) {
    if (this.state === 'dead' || this.destroyed) return 0;
    if (this.isInvulnerable()) return 0;
    if (this.tryBlock(amount, info)) return 0;

    this.hp -= amount;
    this.invulnT = HIT_INVULN;
    this.poise += amount;
    this._setFlash(true);
    try {
      eventBus.emit('enemy:damaged', {
        instanceId: this.instanceId,
        amount,
        hp: Math.max(0, this.hp),
      });
    } catch {
      /* bus is best-effort */
    }
    // hit flash clears next frame tick
    if (this.scene && this.scene.time) {
      try {
        this.scene.time.delayedCall(70, () => {
          if (this.attackPhase !== 'windup') this._setFlash(false);
        });
      } catch {
        /* ignore */
      }
    } else {
      this._setFlash(false);
    }

    if (this.hp <= 0) {
      this.die();
      return amount;
    }
    if (this.poise >= this.maxPoise && this.state !== 'stagger' && this.state !== 'attack') {
      this.enterStagger();
    } else if (this.state === 'idle' || this.state === 'patrol') {
      // getting hit is aggro
      this._setState('pursue');
    }
    return amount;
  }

  /**
   * The `block` behavior: frontal attacks are sometimes negated outright.
   * @returns {boolean} true when the hit was blocked
   */
  tryBlock(amount, info = {}) {
    if (!this.hasBehavior('block') || this.blockChance <= 0) return false;
    if (this.state === 'stagger' || this.state === 'dead') return false;
    const ax = info.attackerX;
    if (typeof ax === 'number' && Math.sign(ax - this.x) !== this.facing) return false; // not frontal
    if (this.ctx.rng() >= this.blockChance) return false;
    this._playSfx('blade_scrape', { volume: 0.7 });
    this._setFlash(true);
    if (this.scene && this.scene.time) {
      try {
        this.scene.time.delayedCall(90, () => this._setFlash(false));
      } catch {
        /* ignore */
      }
    } else {
      this._setFlash(false);
    }
    return true;
  }

  enterStagger() {
    this._setState('stagger');
    this.staggerT = STAGGER_TIME;
    this.poise = 0;
    this.vx = 0;
    this.playAnim('idle');
  }

  /**
   * DamageSystem target contract: mitigation query.
   * @param {'physical'|'fire'|'ice'|'lightning'|'shadow'|'holy'} type
   * @returns {{ flat:number, multiplier:number }} multiplier = 1 - resistance
   */
  getDefense(type) {
    const flat = this.def.stats?.defense ?? 0;
    const resist = this.def.resistances?.[type] ?? 0;
    return { flat, multiplier: Math.max(0, 1 - resist) };
  }

  /** DamageSystem target contract: i-frames / phase immunity. */
  isInvulnerable() {
    return this.state === 'dead' || this.invulnT > 0;
  }

  // ------------------------------------------------------------------- death

  die() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.attackPhase = null;
    this.vx = 0;
    this.vy = 0;
    this._setFlash(false);

    const drops = rollDrops(this.def.drops, this.ctx.rng);
    try {
      this.ctx.bestiaryKill(this.enemyId);
    } catch {
      /* ignore */
    }
    try {
      this.ctx.addXp(this.def.xp ?? 0);
    } catch {
      /* ignore */
    }
    this._playSfx('enemy_die');
    try {
      eventBus.emit('enemy:died', {
        enemyId: this.enemyId,
        instanceId: this.instanceId,
        roomId: this.ctx.roomId,
        drops,
      });
    } catch {
      /* ignore */
    }
    // scatter pickups for RoomManager to instantiate
    drops.forEach((itemId, i) => {
      const spread = (i - (drops.length - 1) / 2) * 14;
      try {
        this.ctx.spawnPickup(this.x + spread, this.y - 12, itemId);
      } catch {
        /* ignore */
      }
    });
    if (typeof this.ctx.onDeath === 'function') {
      try {
        this.ctx.onDeath(this);
      } catch {
        /* ignore */
      }
    }
    // death visual: tint + fade, then release the sprite
    const s = this.sprite;
    if (s && this.scene) {
      try {
        s.clearTint();
        s.setTint(0xff5544);
        this.playAnim('idle');
        if (this.scene.tweens) {
          this.scene.tweens.add({
            targets: s,
            alpha: 0,
            y: this.y - 8,
            duration: 450,
            onComplete: () => {
              try {
                s.destroy();
              } catch {
                /* ignore */
              }
            },
          });
        } else {
          s.destroy();
        }
      } catch {
        /* ignore */
      }
      this.sprite = null;
    }
  }

  _updateDead() {
    // corpse fade is tween-driven; nothing per-frame
  }

  destroy() {
    this.destroyed = true;
    if (this.sprite) {
      try {
        this.sprite.destroy();
      } catch {
        /* ignore */
      }
      this.sprite = null;
    }
  }
}
