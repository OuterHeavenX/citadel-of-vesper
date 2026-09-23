/**
 * Boss — data-driven boss fights (spec §36, ARCHITECTURE.md §11).
 *
 * CONTRACT:
 * - Data-driven from data/bosses.json (schema: data/schemas/boss.schema.json).
 *   Attack patterns live in data/boss_attacks.json (schema:
 *   data/schemas/boss_attack.schema.json); bosses.json references them by id
 *   (base `attacks` + `phases[].addsAttacks`).
 * - Lifecycle: entrance (camera lock + name banner via ctx hooks, boss is
 *   invulnerable) -> 'boss:encounterStarted' -> fight loop -> phase changes
 *   at data `phases` hpThresholds ('boss:phaseChanged') -> death animation ->
 *   reward grant -> 'boss:died' { bossId, roomId, reward }.
 * - Attacks: telegraphed (windup flash + sfx), data-defined patterns per
 *   phase, executed through HitboxSystem / ProjectileSystem like enemies.
 * - Damage in/out ONLY via DamageSystem (ctx.dealDamage, default
 *   DamageSystem.applyDamage). The boss is a DamageSystem target
 *   (takeDamage / getDefense / isInvulnerable) with kind 'boss', so the
 *   GameScene boss bar feeds off the standard 'enemy:damaged' event
 *   (instanceId === bossId).
 * - Registers with EffectsManager as a victim (instanceId) and with
 *   HitboxSystem as a hurtbox — unregisters both on destroy/death.
 * - All bosses ORIGINAL (no Castlevania bosses, names, or patterns).
 *
 * Headless support: scene = null skips ALL Phaser object creation.
 * Position/AI/attack sequencing run on plain numbers, so the fight logic
 * is unit-testable in vitest without Phaser.
 *
 * ctx contract (all optional unless noted):
 *   roomId            string — arena room id (default def.arenaRoomId)
 *   rng               () => number in [0,1) — default Math.random
 *   eventBus          default the singleton
 *   gameState         default the singleton
 *   audioManager      default the singleton
 *   dealDamage        (source, target, opts) => result — default DamageSystem.applyDamage
 *   getPlayer         () => player DamageSystem target | null
 *   getFloorY         (x) => number — default () => spawnY
 *   hitboxSystem      optional — melee strikes fall back to direct range checks
 *   projectileSystem  optional — ring/volley/quake fall back to a warning
 *   effectsManager    optional — victim registration for hit flashes
 *   spawnMinion       (enemyId, x, y) => enemy | null — wired by GameScene to
 *                     RoomManager.spawnEnemy; required for 'summon' patterns
 *   playSfx           (id, opts) => void — default audioManager.playSfx
 *   addXp             (n) => void — default (n) => gameState.addXp(n)
 *   addItem           (itemId, qty) => void — default gameState.addItem
 *   onCameraLock      (locked) => void — GameScene camera hook
 *   onShowBanner      (name, title) => void — GameScene name-banner hook
 *   onLockExits       (locked) => void — GameScene -> RoomManager exit lock
 *   fx                { shake(trauma), hitPause(ms), landDust(x, y) } —
 *                     scripted-moment juice (GAME_FEEL.md allows these for
 *                     boss slams); all optional no-ops by default
 */
import { DamageSystem } from '../combat/DamageSystem.js';
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { audioManager } from '../core/AudioManager.js';
import { tuning } from '../config/tuning.js';
import bossAttacksData from '../../data/boss_attacks.json';

/** Boss tuning section (all locomotion/AI numbers live in tuning.js). */
const BT = () => tuning.bosses;

/** Pure: resolve the phase for an hp fraction from data `phases`. Exported for tests. */
export function phaseForFraction(phases, fraction) {
  let phase = 1;
  for (const p of phases ?? []) {
    if (p.phase > phase && fraction <= p.hpThreshold) phase = p.phase;
  }
  return phase;
}

/** Pure: floor Y under x from room geometry solids (fallback: room height). */
export function resolveFloorY(roomDef, x) {
  let floor = Infinity;
  for (const r of roomDef?.geometry?.solids ?? []) {
    if (x >= r.x && x <= r.x + r.w) floor = Math.min(floor, r.y);
  }
  return floor === Infinity ? (roomDef?.height ?? 270) : floor;
}

export class Boss {
  /**
   * @param {Phaser.Scene|null} scene null => headless (no Phaser objects)
   * @param {object} def boss definition from data/bosses.json
   * @param {number} x @param {number} y arena spawn (feet)
   * @param {object} [ctx] integration hooks (see contract above)
   */
  constructor(scene, def, x, y, ctx = {}) {
    if (!def || typeof def.id !== 'string') {
      throw new Error('[Boss] constructed without a valid boss definition.');
    }
    this.scene = scene;
    this.def = def;
    this.bossId = def.id;
    // DamageSystem identity: id/instanceId === bossId feeds the GameScene
    // boss bar via the standard 'enemy:damaged' event; kind 'boss' routes
    // hostile projectiles correctly.
    this.id = def.id;
    this.instanceId = def.id;
    this.kind = 'boss';

    this.ctx = {
      roomId: ctx.roomId ?? def.arenaRoomId ?? 'unknown_room',
      rng: ctx.rng ?? Math.random,
      eventBus: ctx.eventBus ?? eventBus,
      gameState: ctx.gameState ?? gameState,
      audioManager: ctx.audioManager ?? audioManager,
      dealDamage:
        ctx.dealDamage ?? ((s, t, o) => DamageSystem.applyDamage(s, t, o)),
      getPlayer: ctx.getPlayer ?? (() => null),
      getFloorY: ctx.getFloorY ?? (() => this.spawnY),
      hitboxSystem: ctx.hitboxSystem ?? null,
      projectileSystem: ctx.projectileSystem ?? null,
      effectsManager: ctx.effectsManager ?? null,
      spawnMinion: ctx.spawnMinion ?? null,
      playSfx: ctx.playSfx ?? ((id, opts) => audioManager.playSfx(id, opts)),
      addXp: ctx.addXp ?? ((n) => gameState.addXp(n)),
      addItem: ctx.addItem ?? ((itemId, qty) => gameState.addItem(itemId, qty)),
      onCameraLock: ctx.onCameraLock ?? (() => {}),
      onShowBanner: ctx.onShowBanner ?? (() => {}),
      onLockExits: ctx.onLockExits ?? (() => {}),
      fx: {
        shake: ctx.fx?.shake ?? (() => {}),
        hitPause: ctx.fx?.hitPause ?? (() => {}),
        landDust: ctx.fx?.landDust ?? (() => {}),
      },
    };

    // ---- attack pattern table (data/boss_attacks.json) ----
    this.patterns = new Map();
    for (const a of bossAttacksData) {
      if (a.bossId === def.id) this.patterns.set(a.id, a);
    }
    const referenced = [
      ...(def.attacks ?? []).map((a) => a.id),
      ...(def.phases ?? []).flatMap((p) => p.addsAttacks ?? []),
    ];
    for (const ref of referenced) {
      if (!this.patterns.has(ref)) {
        throw new Error(
          `[Boss:${def.id}] attack pattern '${ref}' missing from data/boss_attacks.json`,
        );
      }
    }

    // ---- position / velocity (feet-anchored; plain numbers) ----
    this.spawnX = x;
    this.spawnY = y;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facing = x > 480 ? -1 : 1; // face arena center by default
    this._hurtbox = def.hurtbox ?? { w: 48, h: 80, offsetX: 0, offsetY: -40 };
    this._hoverT = 0;

    // ---- vitals ----
    this.maxHp = def.hp;
    this.hp = def.hp;

    // ---- fight state ----
    this.state = 'entrance';
    this.stateT = 0;
    this.entranceT = def.entrance?.duration ?? 2.0;
    this.phase = 1;
    this._attackIds = [...new Set((def.attacks ?? []).map((a) => a.id))];
    this._cooldowns = new Map(); // attack id -> seconds remaining
    this._gapT = 1.0; // global pause before the first attack
    this.attackId = null;
    this.attackPhase = null; // windup | strike | recover
    this.attackT = 0;
    this._pattern = null;
    this._waves = null; // scheduled quake waves during the strike phase
    this.phaseShiftT = 0;
    this.dieT = 0;
    this.contactT = 0;
    this.minions = [];
    this.destroyed = false;

    // ---- telegraph visuals ----
    this._flashT = 0;
    this._flashOn = false;
    this._warnedNoProjectiles = false;
    this._warnedNoMinions = false;

    this.sprite = null;
    if (scene && scene.add) this._createSprite();

    // Hurtbox so player attacks land; victim registry for hit flashes.
    try {
      this.ctx.hitboxSystem?.registerHurtbox?.(this, { ...this._hurtbox });
    } catch { /* optional */ }
    try {
      this.ctx.effectsManager?.registerVictim?.(this.instanceId, this.sprite);
    } catch { /* optional */ }

    // Entrance: camera lock + exit lock + name banner (GameScene hooks).
    // Exits seal the moment the boss spawns — the arena is locked for the
    // whole encounter, including the entrance cinematic.
    try {
      this.ctx.onCameraLock(true);
    } catch { /* hooks never break the fight */ }
    try {
      this.ctx.onLockExits(true);
    } catch { /* hooks never break the fight */ }
    try {
      this.ctx.onShowBanner(def.name, def.title ?? '');
    } catch { /* hooks never break the fight */ }
    try {
      this.ctx.playSfx('boss_roar', { channel: 'enemies', x: this.x, y: this.y });
    } catch { /* audio is best-effort */ }
  }

  // ------------------------------------------------------------------ query

  /** @returns {boolean} */
  isAlive() {
    return this.state !== 'dead' && this.state !== 'dying';
  }

  /** @returns {boolean} */
  isDead() {
    return this.state === 'dead';
  }

  /** @returns {number} current phase (1-based) */
  getPhase() {
    return this.phase;
  }

  /** @returns {number} */
  getHp() {
    return Math.max(0, this.hp);
  }

  /** @returns {number} */
  getMaxHp() {
    return this.maxHp;
  }

  /** @returns {string[]} attack ids available in the current phase */
  getAvailableAttacks() {
    return [...this._attackIds];
  }

  /** HitboxSystem owner contract: world position. */
  getPosition() {
    return { x: this.x, y: this.y };
  }

  /** HitboxSystem hurtbox contract. */
  getBounds() {
    const hb = this._hurtbox;
    return {
      x: this.x + (hb.offsetX ?? 0) - hb.w / 2,
      y: this.y + (hb.offsetY ?? 0) - hb.h / 2,
      width: hb.w,
      height: hb.h,
    };
  }

  // ------------------------------------------------------------------ sprite

  /** Sprite base key: explicit data sprite, else the boss id (tint fallback). */
  get spriteId() {
    return this.def.sprite ?? this.def.id;
  }

  _createSprite() {
    const scene = this.scene;
    try {
      const base = this.spriteId;
      const texKey = `${base}_idle`;
      if (scene.textures?.exists(texKey)) {
        this.sprite = scene.add.sprite(this.x, this.y, texKey);
        // Register every animation the Wave 5 art pass ships (best-effort).
        const animDefs = [
          { suffix: 'idle', fps: 6, repeat: -1 },
          { suffix: 'attack', fps: 8, repeat: -1 },
          { suffix: 'hurt', fps: 8, repeat: 0 },
          { suffix: 'die', fps: 5, repeat: 0 },
        ];
        for (const a of animDefs) {
          const key = `${base}_${a.suffix}`;
          try {
            if (scene.anims && !scene.anims.exists(key) && scene.textures.exists(key)) {
              scene.anims.create({
                key,
                frames: scene.anims.generateFrameNumbers(key, {}),
                frameRate: a.fps,
                repeat: a.repeat,
              });
            }
          } catch { /* one bad sheet never breaks the boss */ }
        }
        if (scene.anims?.exists(texKey)) {
          try { this.sprite.play(texKey); } catch { /* ignore */ }
        }
      } else {
        // Placeholder art until the Wave 5 art pass (tinted per boss).
        const hb = this._hurtbox;
        this.sprite = scene.add.rectangle(
          this.x, this.y, hb.w, hb.h, this.def.tint ?? 0x8a7bd8, 1,
        );
      }
      this.sprite.setOrigin(0.5, 1);
      this.sprite.setDepth(11);
    } catch {
      this.sprite = null;
    }
  }

  _syncSprite() {
    const s = this.sprite;
    if (!s) return;
    try {
      s.setPosition(this.x, this.y);
      if (typeof s.setFlipX === 'function') s.setFlipX(this.facing < 0);
    } catch { /* ignore */ }
  }

  _setFlash(on, color) {
    if (!this.sprite) return;
    try {
      if (on) this.sprite.setTintFill(color ?? 0xffffff);
      else this.sprite.clearTint();
    } catch { /* ignore */ }
  }

  playAnim(kind) {
    if (!this.sprite || !this.scene) return;
    const key = `${this.spriteId}_${kind}`;
    try {
      if (this.scene.anims?.exists(key) && this.sprite.anims?.currentAnim?.key !== key) {
        this.sprite.play(key);
      }
    } catch { /* anims are best-effort */ }
  }

  _playSfx(id, opts = {}) {
    if (!id) return;
    try {
      this.ctx.playSfx(id, { channel: 'enemies', x: this.x, y: this.y, ...opts });
    } catch { /* audio never breaks the fight */ }
  }

  _playerPos() {
    try {
      const pl = this.ctx.getPlayer();
      if (pl && typeof pl.x === 'number') return { x: pl.x, y: pl.y ?? this.y, ref: pl };
    } catch { /* ignore */ }
    return null;
  }

  // ------------------------------------------------------------------ update

  /**
   * @param {number} dt seconds
   * @param {object|null} [playerPos] { x, y, ref? } — convenience
   */
  update(dt, playerPos = null) {
    if (this.destroyed || this.state === 'dead') return;
    if (this.state === 'dying') {
      this._updateDying(dt);
      return;
    }

    this.stateT += dt;
    for (const [id, t] of this._cooldowns) {
      if (t <= 0) this._cooldowns.delete(id);
      else this._cooldowns.set(id, t - dt);
    }
    this._gapT = Math.max(0, this._gapT - dt);
    this.contactT = Math.max(0, this.contactT - dt);

    const p = playerPos ?? this._playerPos();
    if (p && this.state !== 'entrance' && this.state !== 'phaseShift') {
      this.facing = p.x >= this.x ? 1 : -1;
    }

    switch (this.state) {
      case 'entrance': this._updateEntrance(dt); break;
      case 'combat': this._updateCombat(dt, p); break;
      case 'attack': this._updateAttack(dt, p); break;
      case 'phaseShift': this._updatePhaseShift(dt); break;
    }

    this._contactDamage(p);
    this._integrate(dt);
    this._syncSprite();
  }

  _updateEntrance(dt) {
    this.vx = 0;
    this.vy = 0;
    this.entranceT -= dt;
    if (this.entranceT > 0) return;
    // The fight begins: unlock the camera. Boss music is owned by the
    // MusicDirector (src/audio/musicDirector.js), which switches on the
    // boss:encounterStarted event emitted below. (Exits were already
    // sealed when the boss spawned.)
    try { this.ctx.onCameraLock(false); } catch { /* ignore */ }
    try {
      this.ctx.gameState.setBossState?.(this.bossId, 'unlocked');
    } catch { /* persistence is best-effort */ }
    try {
      this.ctx.eventBus.emit('boss:encounterStarted', {
        bossId: this.bossId,
        roomId: this.ctx.roomId,
      });
    } catch { /* bus is best-effort */ }
    this.state = 'combat';
    this.stateT = 0;
  }

  _updateCombat(dt, p) {
    const b = BT();
    // Locomotion: warden advances; matriarch hovers at preferred range.
    if (this.def.locomotion === 'hover') {
      this._hoverT += dt;
      const want = p ? Math.sign(this.x - p.x) || 0 : 0; // +1: boss right of player
      const dist = p ? Math.abs(p.x - this.x) : Infinity;
      if (p && dist > b.hoverRange + 30) this.vx = -want * b.driftSpeed; // approach
      else if (p && dist < b.hoverRange - 60) this.vx = want * b.driftSpeed; // back off
      else this.vx *= 1 - Math.min(1, dt * 4);
      // hover bob around the spawn plane
      const floorY = this.ctx.getFloorY(this.x);
      this.y += ((floorY - 30 + Math.sin(this._hoverT * b.hoverFreq) * b.hoverAmp) - this.y)
        * Math.min(1, dt * 5);
      this.vy = 0;
    } else {
      const melee = this._patternFor('melee');
      const dist = p ? Math.abs(p.x - this.x) : Infinity;
      if (p && dist > (melee?.range ?? 150) * 0.7) {
        this.vx = Math.sign(p.x - this.x) * b.walkSpeed;
      } else {
        this.vx *= 1 - Math.min(1, dt * 6);
      }
    }

    if (this._gapT <= 0 && p) {
      const next = this._pickAttack(p);
      if (next) this.beginAttack(next);
    }
  }

  _patternFor(kind) {
    for (const id of this._attackIds) {
      const pat = this.patterns.get(id);
      if (pat?.kind === kind) return pat;
    }
    return null;
  }

  /**
   * Choose an attack: prefer ranged kinds at distance, melee up close,
   * summon when minions are below cap. Pure selection; tests drive it.
   * @param {object} p player pos
   * @returns {string|null} attack id
   */
  _pickAttack(p) {
    const dist = Math.abs(p.x - this.x);
    const ready = this._attackIds.filter((id) => (this._cooldowns.get(id) ?? 0) <= 0);
    if (ready.length === 0) return null;
    const byKind = (kinds) => ready.filter((id) => kinds.includes(this.patterns.get(id)?.kind));
    const ranged = byKind(['radial_ring', 'volley', 'quake']);
    const melee = byKind(['melee']).filter((id) => dist <= (this.patterns.get(id)?.range ?? 0));
    const summon = byKind(['summon']).filter((id) => {
      const s = this.patterns.get(id)?.summon;
      return s && this._aliveMinions().length < (s.maxAlive ?? tuning.bosses.minionCap);
    });

    let pool = [];
    if (summon.length > 0 && this.ctx.rng() < 0.35) pool = summon;
    else if (dist > 220 && ranged.length > 0) pool = ranged;
    else if (melee.length > 0 && (ranged.length === 0 || this.ctx.rng() < 0.7)) pool = melee;
    else pool = [...ranged, ...melee, ...summon];

    if (pool.length === 0) pool = ready;
    return pool[Math.floor(this.ctx.rng() * pool.length)];
  }

  /**
   * Start a telegraphed attack: windup (flash + sfx) -> strike -> recover.
   * @param {string} attackId pattern id from data/boss_attacks.json
   */
  beginAttack(attackId) {
    const pattern = this.patterns.get(attackId);
    if (!pattern) throw new Error(`[Boss:${this.bossId}] unknown attack '${attackId}'`);
    this.state = 'attack';
    this.stateT = 0;
    this.attackId = attackId;
    this._pattern = pattern;
    this.attackPhase = 'windup';
    this.attackT = Math.max(0.05, pattern.windup);
    this.vx = 0;
    if (this.def.locomotion !== 'hover') this.vy = 0;
    this._flashT = this.attackT;
    this._flashOn = false;
    this._playSfx(pattern.sfxWindup);
    this.playAnim('attack');
  }

  _updateAttack(dt, p) {
    const pattern = this._pattern;
    this.attackT -= dt;
    if (this.attackPhase === 'windup') {
      this._flashT -= dt;
      if (this._flashT <= 0) {
        this._flashOn = !this._flashOn;
        this._setFlash(this._flashOn, pattern.flashColor);
        this._flashT = 0.09;
      }
      if (this.attackT <= 0) {
        this._setFlash(false);
        this.attackPhase = 'strike';
        this.attackT = Math.max(0.05, pattern.strikeTime);
        this._strike(pattern, p);
        this._playSfx(pattern.sfxStrike);
        if (pattern.shake > 0) {
          try { this.ctx.fx.shake(pattern.shake); } catch { /* ignore */ }
        }
        if (pattern.hitPauseMs > 0) {
          try { this.ctx.fx.hitPause(pattern.hitPauseMs); } catch { /* ignore */ }
        }
        // Schedule quake waves across the strike window.
        const w = pattern.waves;
        if (pattern.kind === 'quake' && w && w.count > 1) {
          this._waves = { left: w.count - 1, nextT: w.interval ?? 0.45, pattern };
        }
      }
    } else if (this.attackPhase === 'strike') {
      if (this._waves) {
        this._waves.nextT -= dt;
        if (this._waves.nextT <= 0) {
          this._fireQuakeWave(this._waves.pattern, p);
          this._waves.left -= 1;
          this._waves.nextT = this._waves.pattern.waves.interval ?? 0.45;
          if (this._waves.left <= 0) this._waves = null;
        }
      }
      if (this.attackT <= 0) {
        this._waves = null;
        this.attackPhase = 'recover';
        this.attackT = Math.max(0.05, pattern.recover);
        this.playAnim('idle');
      }
    } else {
      // recover
      if (this.attackT <= 0) this._endAttack();
    }
  }

  _endAttack() {
    const b = BT();
    if (this._pattern) this._cooldowns.set(this.attackId, this._pattern.cooldown);
    this._gapT = b.attackGap + this.ctx.rng() * b.gapJitter;
    this.attackId = null;
    this._pattern = null;
    this.attackPhase = null;
    this._waves = null;
    this.state = 'combat';
    this.stateT = 0;
  }

  /** Dispatch the strike moment by pattern kind. */
  _strike(pattern, p) {
    switch (pattern.kind) {
      case 'melee': this._strikeMelee(pattern, p); break;
      case 'radial_ring': this._strikeRing(pattern); break;
      case 'volley': this._strikeVolley(pattern, p); break;
      case 'summon': this._strikeSummon(pattern); break;
      case 'quake': this._fireQuakeWave(pattern, p); break;
    }
  }

  _damageOpts(pattern, knockX) {
    const kb = pattern.knockback ?? { x: 120, y: -60 };
    return {
      amount: (this.def.stats?.attack ?? 10) * (pattern.damageMult ?? 1),
      type: pattern.type ?? 'physical',
      knockback: { x: (knockX ?? kb.x) * this.facing, y: kb.y ?? -60 },
      hitStun: pattern.hitStun ?? 0.25,
    };
  }

  _source() {
    return { id: this.bossId, kind: 'boss' };
  }

  _strikeMelee(pattern, p) {
    const hb = pattern.hitbox ?? { w: 100, h: 60, offsetX: 50, offsetY: -24 };
    if (this.ctx.hitboxSystem?.spawnHitbox) {
      this.ctx.hitboxSystem.spawnHitbox(this, {
        w: hb.w,
        h: hb.h,
        offsetX: hb.offsetX ?? 0,
        offsetY: hb.offsetY ?? 0,
        duration: pattern.strikeTime + 0.05,
        activeFrom: 0,
        damage: this._damageOpts(pattern),
        source: this._source(),
      });
      return;
    }
    // Headless fallback: direct frontal check + DamageSystem.
    const target = p?.ref ?? this.ctx.getPlayer();
    if (!target) return;
    const dx = (p?.x ?? target.x) - this.x;
    const dy = (p?.y ?? target.y) - this.y;
    if (this.facing * dx < -4) return;
    if (Math.abs(dx) > hb.w / 2 + (hb.offsetX ?? 0) || Math.abs(dy) > hb.h) return;
    this.ctx.dealDamage(this._source(), target, this._damageOpts(pattern));
  }

  _strikeRing(pattern) {
    const ps = this.ctx.projectileSystem;
    if (!ps || typeof ps.fire !== 'function') {
      this._warnProjectiles();
      return;
    }
    const pr = pattern.projectiles ?? {};
    const n = pr.count ?? 8;
    const speed = pr.speed ?? 130;
    const size = pr.size ?? 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ps.fire({
        x: this.x,
        y: this.y - 50,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        w: size,
        h: size,
        gravity: 0,
        texture: 'fx_hit_spark',
        lifeMs: pr.lifeMs ?? 2600,
        fromPlayer: false,
        source: this._source(),
        damage: this._damageOpts(pattern, 0),
      });
    }
  }

  _strikeVolley(pattern, p) {
    const ps = this.ctx.projectileSystem;
    if (!ps || typeof ps.fire !== 'function') {
      this._warnProjectiles();
      return;
    }
    const pr = pattern.projectiles ?? {};
    const n = pr.count ?? 3;
    const speed = pr.speed ?? 170;
    const size = pr.size ?? 8;
    const spread = ((pr.spreadDeg ?? 0) * Math.PI) / 180;
    const tx = p?.x ?? this.x + this.facing * 120;
    const ty = (p?.y ?? this.y) - 20;
    const base = Math.atan2(ty - (this.y - 40), tx - this.x);
    for (let i = 0; i < n; i++) {
      const a = n === 1 ? base : base + (i / (n - 1) - 0.5) * spread;
      ps.fire({
        x: this.x + this.facing * 10,
        y: this.y - 40,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        w: size,
        h: size,
        gravity: 0,
        texture: 'fx_hit_spark',
        lifeMs: pr.lifeMs ?? 3000,
        fromPlayer: false,
        source: this._source(),
        damage: this._damageOpts(pattern, 0),
      });
    }
  }

  _strikeSummon(pattern) {
    const s = pattern.summon;
    if (!s) return;
    this._pruneMinions();
    if (this._aliveMinions().length >= (s.maxAlive ?? tuning.bosses.minionCap)) return;
    const spawnMinion = this.ctx.spawnMinion;
    if (typeof spawnMinion !== 'function') {
      if (!this._warnedNoMinions) {
        this._warnedNoMinions = true;
        console.warn(`[Boss:${this.bossId}] summon with no ctx.spawnMinion — skipped.`);
      }
      return;
    }
    for (let i = 0; i < (s.count ?? 1); i++) {
      const ox = (i - ((s.count ?? 1) - 1) / 2) * (s.radius ?? 60);
      const mx = this.x + ox;
      let m = null;
      try {
        m = spawnMinion(s.enemyId, mx, this.ctx.getFloorY(mx));
      } catch { /* summon is best-effort */ }
      if (m) this.minions.push(m);
    }
    try {
      this.ctx.fx.landDust(this.x, this.y);
    } catch { /* ignore */ }
  }

  _fireQuakeWave(pattern, p) {
    const ps = this.ctx.projectileSystem;
    if (!ps || typeof ps.fire !== 'function') {
      this._warnProjectiles();
      return;
    }
    const w = pattern.waves ?? {};
    const dir = p ? Math.sign(p.x - this.x) || this.facing : this.facing;
    const floorY = this.ctx.getFloorY(this.x + dir * 40);
    ps.fire({
      x: this.x + dir * 30,
      y: floorY - (w.h ?? 20) / 2,
      vx: dir * (w.speed ?? 150),
      vy: 0,
      w: w.w ?? 26,
      h: w.h ?? 20,
      gravity: 0,
      texture: 'fx_dust_puff',
      lifeMs: 4000,
      fromPlayer: false,
      source: this._source(),
      damage: this._damageOpts(pattern, 0),
    });
    try {
      this.ctx.fx.shake(0.25);
    } catch { /* ignore */ }
  }

  _warnProjectiles() {
    if (!this._warnedNoProjectiles) {
      this._warnedNoProjectiles = true;
      console.warn(`[Boss:${this.bossId}] projectile attack with no projectileSystem — skipped.`);
    }
  }

  /** @returns {object[]} summoned minions believed alive */
  _aliveMinions() {
    this._pruneMinions();
    return this.minions;
  }

  _pruneMinions() {
    this.minions = this.minions.filter((m) => {
      try {
        return typeof m.isAlive === 'function' ? m.isAlive() : true;
      } catch {
        return false;
      }
    });
  }

  // --------------------------------------------------------------- contact

  _contactDamage(p) {
    if (!p || this.state === 'dying' || this.state === 'entrance') return;
    if (this.contactT > 0) return;
    const b = BT();
    const target = p.ref ?? this.ctx.getPlayer();
    if (!target) return;
    const dx = (p.x ?? target.x) - this.x;
    const dy = (p.y ?? target.y) - this.y;
    if (Math.abs(dx) > b.contactW || dy < -b.contactH || dy > 10) return;
    this.contactT = b.contactCooldown;
    const away = Math.sign(dx) || 1;
    this.ctx.dealDamage(this._source(), target, {
      amount: (this.def.stats?.attack ?? 10) * b.contactMult,
      type: 'physical',
      knockback: { x: away * 140, y: -80 },
      hitStun: 0.2,
    });
  }

  // ---------------------------------------------------------------- physics

  _integrate(dt) {
    if (this.def.locomotion === 'hover') {
      // Hover: x drifts via vx; y is steered in _updateCombat (no gravity).
      this.x += this.vx * dt;
      return;
    }
    this.vy += BT().gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    let floor = this.spawnY;
    try {
      floor = this.ctx.getFloorY(this.x);
    } catch { /* keep spawn plane */ }
    if (this.y >= floor) {
      this.y = floor;
      this.vy = 0;
    }
  }

  // ------------------------------------------------------------------ damage

  /**
   * DamageSystem target contract: takeDamage(amount, info).
   * `amount` is post-mitigation. Emits nothing itself — DamageSystem emits
   * 'enemy:damaged' (kind 'boss'), which feeds the GameScene boss bar.
   * @param {number} amount
   * @param {object} [info]
   * @returns {number} amount applied
   */
  takeDamage(amount, info = {}) {
    if (this.state === 'dead' || this.state === 'dying' || this.destroyed) return 0;
    if (this.isInvulnerable()) return 0;
    this.hp -= amount;
    this._setFlash(true, 0xffffff);
    this.playAnim('hurt');
    if (this.scene?.time?.delayedCall) {
      try {
        this.scene.time.delayedCall(220, () => {
          if (this.attackPhase !== 'windup' && this.state !== 'dying') {
            this._setFlash(false);
            // Return to idle unless mid-attack (attack anims drive themselves).
            if (!this.attackId) this.playAnim('idle');
          }
        });
      } catch { /* ignore */ }
    } else {
      this._setFlash(false);
    }
    if (this.hp <= 0) {
      this.die();
      return amount;
    }
    this._checkPhase();
    return amount;
  }

  /** DamageSystem target contract: mitigation query. */
  getDefense(type) {
    const flat = this.def.stats?.defense ?? 0;
    const resist = this.def.resistances?.[type] ?? 0;
    return { flat, multiplier: Math.max(0, 1 - resist) };
  }

  /** DamageSystem target contract: entrance/dying/phase-shift immunity. */
  isInvulnerable() {
    return (
      this.state === 'entrance' ||
      this.state === 'dying' ||
      this.state === 'dead' ||
      this.phaseShiftT > 0
    );
  }

  /** Recompute the phase from current HP; on change: roar + invuln window. */
  _checkPhase() {
    const next = phaseForFraction(this.def.phases, this.hp / this.maxHp);
    if (next === this.phase) return;
    this.phase = next;
    // New attacks unlock for this and all lower phases.
    const seen = new Set(this._attackIds);
    for (const ph of this.def.phases ?? []) {
      if (ph.phase <= next) {
        for (const id of ph.addsAttacks ?? []) {
          if (!seen.has(id)) {
            seen.add(id);
            this._attackIds.push(id);
          }
        }
      }
    }
    try {
      this.ctx.eventBus.emit('boss:phaseChanged', { bossId: this.bossId, phase: next });
    } catch { /* bus is best-effort */ }
    // Interrupt the current attack: the phase roar is the new tell.
    this._setFlash(false);
    this.attackId = null;
    this._pattern = null;
    this.attackPhase = null;
    this._waves = null;
    this.state = 'phaseShift';
    this.stateT = 0;
    this.phaseShiftT = BT().phaseShiftTime;
    this._setFlash(true, 0xffffff);
    this._playSfx('boss_roar');
  }

  _updatePhaseShift(dt) {
    this.vx = 0;
    this.phaseShiftT -= dt;
    if (this.phaseShiftT <= 0) {
      this._setFlash(false);
      this.state = 'combat';
      this.stateT = 0;
      this._gapT = Math.max(this._gapT, 0.4);
    }
  }

  // ------------------------------------------------------------------- death

  die() {
    if (this.state === 'dying' || this.state === 'dead') return;
    this.state = 'dying';
    this.stateT = 0;
    this.dieT = BT().deathTime;
    this.vx = 0;
    this.attackId = null;
    this._pattern = null;
    this.attackPhase = null;
    this._waves = null;
    this._setFlash(false);
    this._playSfx('enemy_die');
    const s = this.sprite;
    if (s && this.scene) {
      try {
        s.clearTint?.();
        // Play the authored death animation when the art exists; otherwise
        // fall back to the old fade-and-sink.
        const dieKey = `${this.spriteId}_die`;
        if (this.scene.anims?.exists(dieKey)) {
          try { s.play(dieKey); } catch { /* ignore */ }
        } else {
          s.setTint?.(0x881111);
          if (this.scene.tweens) {
            this.scene.tweens.add({
              targets: s,
              alpha: 0,
              y: this.y - 14,
              duration: BT().deathTime * 1000,
            });
          }
        }
      } catch { /* cosmetic */ }
    }
  }

  _updateDying(dt) {
    this.dieT -= dt;
    if (this.dieT <= 0) this._finishDeath();
  }

  _finishDeath() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    const reward = this.def.reward ?? {};
    const rewardStr = reward.abilityId ?? reward.itemId ?? null;
    try {
      this.ctx.gameState.setBossState?.(this.bossId, 'defeated');
    } catch { /* persistence is best-effort */ }
    try {
      this.ctx.addXp(reward.xp ?? 0);
    } catch { /* ignore */ }
    if (reward.itemId) {
      try {
        this.ctx.addItem(reward.itemId, 1);
      } catch { /* ignore */ }
    }
    try {
      this.ctx.onLockExits(false);
    } catch { /* ignore */ }
    this._unregister();
    try {
      this.ctx.eventBus.emit('boss:died', {
        bossId: this.bossId,
        roomId: this.ctx.roomId,
        reward: rewardStr,
      });
    } catch { /* bus is best-effort */ }
    if (this.sprite) {
      try {
        this.sprite.destroy();
      } catch { /* ignore */ }
      this.sprite = null;
    }
  }

  _unregister() {
    try {
      this.ctx.effectsManager?.unregisterVictim?.(this.instanceId);
    } catch { /* optional */ }
    try {
      this.ctx.hitboxSystem?.unregisterHurtbox?.(this);
    } catch { /* optional */ }
  }

  /** Tear down: unregister, release camera/exit locks, destroy sprite. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.ctx.onLockExits(false); } catch { /* ignore */ }
    try { this.ctx.onCameraLock(false); } catch { /* ignore */ }
    this._unregister();
    if (this.sprite) {
      try {
        this.sprite.destroy();
      } catch { /* ignore */ }
      this.sprite = null;
    }
  }
}

export default Boss;
