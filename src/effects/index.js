/**
 * src/effects — pooled juice: particles, hit pause, screen shake, hit flashes,
 * damage numbers (spec §17, ARCHITECTURE.md §9 feedback section).
 *
 * Public API surface:
 *
 *   class EffectsManager          // constructed with injectable deps for tests
 *   effectsManager                // singleton, wired to the global eventBus
 *   EffectBudgets                 // frozen budget constants (LAW)
 *
 *   effectsManager.attachScene(scene)        // GameScene binds once (Wave 3)
 *   effectsManager.detach()                  // unsubscribe + release views
 *   effectsManager.update(dtMs)              // GameScene calls per frame (real ms)
 *   effectsManager.registerVictim(id, sprite)   // Enemy/Player on spawn (Wave 3)
 *   effectsManager.unregisterVictim(id)         // Enemy/Player on destroy
 *   effectsManager.burst(x, y, kind)         // 'hit'|'crit'|'breakable'|'levelup'|'save'|'death'
 *   effectsManager.spawnLandDust(x, y)       // land-dust hook (Wave 3)
 *   effectsManager.spawnDamageNumber(x, y, amount, { critical })
 *   effectsManager.screenShake(intensity, ms)  // intensity 0..1, trauma-based
 *   effectsManager.hitPause(ms)              // clamped to EffectBudgets.MAX_HIT_PAUSE
 *   effectsManager.shouldFreeze()            // true while a hit pause is active
 *
 * CONTRACT:
 * - Listens to 'combat:hitLanded' — combat code NEVER calls effects directly.
 *   Payload gives string ids (attacker, target), NOT sprites, so the manager
 *   keeps a runtime victim registry: Enemy/Player MUST call
 *   registerVictim(id, sprite) on spawn and unregisterVictim(id) on destroy.
 *   Registration keys: enemy instanceId, 'player' for Lucien, boss instanceId.
 * - Budgets are LAW: <= 400 particles, <= 24 damage numbers, hit pause <= 90 ms.
 * - Object pools are preallocated; ZERO allocation in update() loops
 *   (fixed arrays, no closures, no per-frame object creation).
 * - Respects gameState.settings: screenShake off -> screenShake() no-ops;
 *   damageNumbers off -> spawnDamageNumber() no-ops.
 * - No Phaser import at module scope (headless-test safe). All Phaser
 *   interaction is duck-typed through the attached scene.
 * - Hit pause manipulates the bound scene's time.timeScale AND
 *   physics.world.timeScale for the duration, then restores previous values.
 *   update() receives REAL (unscaled) delta from GameScene so the countdown
 *   always completes even while the world is frozen.
 */
import { eventBus, EventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { tuning } from '../config/tuning.js';

/** Budget constants — enforced, not advisory. */
export const EffectBudgets = Object.freeze({
  MAX_PARTICLES: 400,
  MAX_DAMAGE_NUMBERS: 24,
  MAX_HIT_PAUSE: 0.09, // seconds — hit pause never exceeds 90 ms
  MAX_FLASH_SLOTS: 32,
});

// ---------------------------------------------------------------------------
// Tuning hooks (W2-PLAYER owns src/config/tuning.js — read-only here).
// tuning.combat.hitPauseMs does not exist yet; read it defensively so a
// future tuning pass can drive hit pause without touching this file.
// ---------------------------------------------------------------------------
const DEFAULT_HIT_PAUSE_MS = 45;
const DEFAULT_CRIT_PAUSE_MS = 70;
const SHAKE_DECAY_PER_S = 1.4; // trauma units drained per second
const SHAKE_REFIRE_MS = 90; // re-fire camera.shake this often while trauma lives
const MAX_SHAKE_INTENSITY = 0.006; // camera.shake intensity at trauma = 1
const FLASH_MS = 90;
const DMG_NUMBER_LIFE_MS = 750;
const DMG_NUMBER_RISE_PX = 26;

function readHitPauseMs(critical) {
  const fromTuning = tuning?.combat?.hitPauseMs;
  if (typeof fromTuning === 'number' && fromTuning > 0) return fromTuning;
  return critical ? DEFAULT_CRIT_PAUSE_MS : DEFAULT_HIT_PAUSE_MS;
}

// ---------------------------------------------------------------------------
// SlotPool — generic fixed-capacity pool. Pure, no Phaser, fully testable.
// acquire() returns a free slot or null when exhausted; release() returns it.
// ---------------------------------------------------------------------------
export class SlotPool {
  /**
   * @param {number} capacity
   * @param {(index: number) => object} factory creates the slot at index
   */
  constructor(capacity, factory) {
    this.capacity = capacity;
    this._slots = new Array(capacity);
    this._free = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const slot = factory(i);
      slot.__poolIndex = i;
      slot.__poolActive = false;
      this._slots[i] = slot;
      this._free[i] = slot;
    }
    this._freeCount = capacity;
    this._active = 0;
  }

  /** @returns {object|null} a free slot, or null when the pool is exhausted */
  acquire() {
    if (this._freeCount === 0) return null;
    const slot = this._free[--this._freeCount];
    slot.__poolActive = true;
    this._active++;
    return slot;
  }

  /** @param {object} slot previously returned by acquire() */
  release(slot) {
    if (!slot || !slot.__poolActive) return;
    slot.__poolActive = false;
    this._free[this._freeCount++] = slot;
    this._active--;
  }

  /** Number of currently-live slots. */
  get activeCount() {
    return this._active;
  }

  /**
   * Iterate live slots without allocating (callback style, no closures
   * created inside hot loops — the CALLER passes one stable function).
   * @param {(slot: object) => void} cb
   */
  forEachActive(cb) {
    for (let i = 0; i < this.capacity; i++) {
      const slot = this._slots[i];
      if (slot.__poolActive) cb(slot);
    }
  }

  /** Release every slot (room teardown). */
  releaseAll() {
    for (let i = 0; i < this.capacity; i++) {
      const slot = this._slots[i];
      slot.__poolActive = false;
      this._free[i] = slot;
    }
    this._freeCount = this.capacity;
    this._active = 0;
  }
}

// ---------------------------------------------------------------------------
// HitPause — pure countdown. freeze() clamps to the budget; tick() advances.
// ---------------------------------------------------------------------------
export class HitPause {
  constructor() {
    this.remainingMs = 0;
  }

  /** @param {number} ms requested pause length */
  freeze(ms) {
    const clamped = Math.max(0, Math.min(ms, EffectBudgets.MAX_HIT_PAUSE * 1000));
    // A new hit refreshes (does not stack) the pause — keeps feel tight.
    if (clamped > this.remainingMs) this.remainingMs = clamped;
  }

  /** @param {number} dtMs real milliseconds */
  tick(dtMs) {
    if (this.remainingMs > 0) {
      this.remainingMs -= dtMs;
      if (this.remainingMs <= 0) this.remainingMs = 0;
    }
  }

  get active() {
    return this.remainingMs > 0;
  }
}

// ---------------------------------------------------------------------------
// TraumaShaker — pure trauma model. add() saturates at 1; tick() decays.
// ---------------------------------------------------------------------------
export class TraumaShaker {
  constructor() {
    this.trauma = 0;
  }

  /** @param {number} intensity 0..1 */
  add(intensity) {
    this.trauma = Math.min(1, this.trauma + Math.max(0, intensity));
  }

  /** @param {number} dtMs real milliseconds */
  tick(dtMs) {
    if (this.trauma > 0) {
      this.trauma -= (dtMs / 1000) * SHAKE_DECAY_PER_S;
      if (this.trauma < 0) this.trauma = 0;
    }
  }

  get magnitude() {
    return this.trauma;
  }
}

// ---------------------------------------------------------------------------
// Particle kind specs — count, speed/ life ranges, tint palette, physics.
// Textures reference the boot fx pack; missing keys fall back to a generated
// dot at attach time (see _ensureFallbackTexture).
// ---------------------------------------------------------------------------
const PARTICLE_KINDS = {
  hit: { texture: 'fx_hit_spark', count: 10, speed: [60, 220], life: [120, 260], size: [0.5, 1.0], tints: [0xfff2c0, 0xffd94a, 0xffffff], gravity: 500, drag: 0.98 },
  crit: { texture: 'fx_hit_spark', count: 16, speed: [120, 320], life: [160, 340], size: [0.7, 1.4], tints: [0xffd94a, 0xffffff, 0xffb52e], gravity: 500, drag: 0.97 },
  slash: { texture: 'fx_slash_arc', count: 1, speed: [0, 0], life: [110, 110], size: [1.0, 1.0], tints: [0xffffff], gravity: 0, drag: 1 },
  dust: { texture: 'fx_dust_puff', count: 6, speed: [20, 90], life: [240, 480], size: [0.6, 1.2], tints: [0x8a8a99, 0x6b6b78, 0xa9a9b8], gravity: -60, drag: 0.96 },
  breakable: { texture: 'fx_hit_spark', count: 12, speed: [80, 260], life: [200, 420], size: [0.5, 1.1], tints: [0xd8b25c, 0xa87f3d, 0x8a6a3a], gravity: 700, drag: 0.98 },
  levelup: { texture: 'fx_hit_spark', count: 24, speed: [40, 140], life: [400, 700], size: [0.6, 1.2], tints: [0xffd94a, 0xfff2c0, 0xffffff], gravity: -260, drag: 0.99 },
  save: { texture: 'fx_dust_puff', count: 16, speed: [30, 110], life: [400, 700], size: [0.5, 1.0], tints: [0x9fd8ff, 0xcfeeff, 0xffffff], gravity: -120, drag: 0.98 },
  death: { texture: 'fx_hit_spark', count: 20, speed: [60, 280], life: [260, 520], life2: 0, size: [0.6, 1.3], tints: [0x7a1f2b, 0xa8323f, 0x3a3a44], gravity: 420, drag: 0.97 },
};

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// EffectsManager
// ---------------------------------------------------------------------------
export class EffectsManager {
  /**
   * @param {object} [deps] injectable for tests
   * @param {EventBus} [deps.bus] defaults to the global eventBus
   * @param {object} [deps.state] defaults to the gameState singleton
   */
  constructor({ bus = eventBus, state = gameState } = {}) {
    this._bus = bus;
    this._state = state;

    this._scene = null;
    this._views = null; // { particles: Image[], numbers: Text[] } — built on attach
    this._fallbackKey = '__fx_dot';

    // Pools — pure state; views are bound to slots lazily on attach.
    this._particles = new SlotPool(EffectBudgets.MAX_PARTICLES, () => ({
      x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1,
      size: 1, tint: 0xffffff, gravity: 0, drag: 1, texture: null,
    }));
    this._numbers = new SlotPool(EffectBudgets.MAX_DAMAGE_NUMBERS, () => ({
      x: 0, y: 0, amount: 0, critical: false, life: 0,
    }));
    // Flash slots — fixed array, free-list via count (no allocation).
    this._flashes = new Array(EffectBudgets.MAX_FLASH_SLOTS);
    for (let i = 0; i < EffectBudgets.MAX_FLASH_SLOTS; i++) {
      this._flashes[i] = { sprite: null, remainingMs: 0, live: false };
    }
    this._flashCount = 0;

    this._hitPause = new HitPause();
    this._shaker = new TraumaShaker();
    this._shakeAccumMs = 0;
    this._pausePrev = null; // { timeScale, worldScale } saved on freeze
    this._lastDt = 0; // frame delta (ms) consumed by the slot callbacks

    // Victim registry: id (string) -> sprite. Filled by Enemy/Player.
    this._victims = new Map();

    // Stable callbacks (allocated once) for hot-path iteration.
    this._updateParticle = (p) => this._stepParticle(p);
    this._updateNumber = (n) => this._stepNumber(n);

    this._unsub = this._bus.on('combat:hitLanded', (payload) => this._onHitLanded(payload));
  }

  // -------------------------------------------------- scene binding ----
  /**
   * Bind to a Phaser Scene (called once by GameScene — Wave 3).
   * Preallocates all pooled views: 400 particle Images + 24 damage-number
   * Texts, all hidden. Safe to call with a duck-typed fake in tests.
   * @param {object} scene
   */
  attachScene(scene) {
    this.detachViews();
    this._scene = scene;
    this._ensureFallbackTexture(scene);

    const particleViews = new Array(EffectBudgets.MAX_PARTICLES);
    for (let i = 0; i < EffectBudgets.MAX_PARTICLES; i++) {
      const img = scene.add.image(-1000, -1000, this._fallbackKey);
      img.setDepth(900).setVisible(false);
      particleViews[i] = img;
    }
    const numberViews = new Array(EffectBudgets.MAX_DAMAGE_NUMBERS);
    for (let i = 0; i < EffectBudgets.MAX_DAMAGE_NUMBERS; i++) {
      const txt = scene.add.text(-1000, -1000, '', {
        fontFamily: 'monospace', fontSize: '10px', color: '#ffffff',
        stroke: '#1a1426', strokeThickness: 2,
      });
      txt.setOrigin(0.5, 0.5).setDepth(950).setVisible(false);
      numberViews[i] = txt;
    }
    // Bind views to pool slots by index (stable mapping, no lookups).
    this._views = { particleViews, numberViews };
    this._syncAllViewsHidden();
  }

  /** Release views and unsubscribe. The manager can be re-attached after. */
  detach() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this.detachViews();
    this._scene = null;
    this._victims.clear();
  }

  /** Destroy pooled views (room teardown / scene shutdown). Pools reset. */
  detachViews() {
    if (this._views) {
      for (const v of this._views.particleViews) v.destroy();
      for (const v of this._views.numberViews) v.destroy();
      this._views = null;
    }
    this._particles.releaseAll();
    this._numbers.releaseAll();
    this._clearFlashes(true);
    this._hitPause.remainingMs = 0;
    this._pausePrev = null;
    this._shaker.trauma = 0;
  }

  _ensureFallbackTexture(scene) {
    try {
      if (scene.textures && scene.textures.exists(this._fallbackKey)) return;
      if (scene.textures && scene.textures.exists('fx_hit_spark')) {
        this._fallbackKey = 'fx_hit_spark';
        return;
      }
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(4, 4, 4);
      g.generateTexture(this._fallbackKey, 8, 8);
      g.destroy();
    } catch {
      // Headless fakes may not implement graphics — views still work,
      // they just render whatever texture key the fake accepts.
    }
  }

  _resolveTexture(kindTexture) {
    const scene = this._scene;
    if (!scene || !scene.textures || typeof scene.textures.exists !== 'function') {
      return kindTexture;
    }
    try {
      return scene.textures.exists(kindTexture) ? kindTexture : this._fallbackKey;
    } catch {
      return this._fallbackKey;
    }
  }

  // -------------------------------------------------- victim registry ----
  /**
   * Register a damageable entity's sprite so 'combat:hitLanded' (which only
   * carries string ids) can flash the right victim. Called by Enemy/Player
   * on spawn; Wave 3 hookup.
   * @param {string} id enemy instanceId, boss instanceId, or 'player'
   * @param {object} sprite Phaser sprite (must expose x, y, setTintFill, clearTint)
   */
  registerVictim(id, sprite) {
    if (id != null && sprite) this._victims.set(id, sprite);
  }

  /** @param {string} id */
  unregisterVictim(id) {
    this._victims.delete(id);
  }

  // -------------------------------------------------- event handling ----
  _onHitLanded(payload = {}) {
    const { target, amount = 0, critical = false } = payload;
    const sprite = this._victims.get(target);

    let x = 0;
    let y = 0;
    if (sprite && typeof sprite.x === 'number') {
      x = sprite.x;
      y = sprite.y - (sprite.displayHeight ? sprite.displayHeight * 0.4 : 12);
    }

    this.burst(x, y, critical ? 'crit' : 'hit');
    if (sprite) this._flashVictim(sprite, critical);
    this.spawnDamageNumber(x, y - 10, amount, { critical });
    this.hitPause(readHitPauseMs(critical));
    this.screenShake(critical ? 0.55 : 0.28, 140);
  }

  _flashVictim(sprite, critical) {
    if (typeof sprite.setTintFill !== 'function') return;
    // Find a free flash slot (fixed array — no allocation).
    let slot = null;
    for (let i = 0; i < EffectBudgets.MAX_FLASH_SLOTS; i++) {
      if (!this._flashes[i].live) {
        slot = this._flashes[i];
        break;
      }
    }
    if (!slot) return; // all flash slots busy — drop the flash, keep the game smooth
    try {
      sprite.setTintFill(critical ? 0xffffff : 0xff5544);
    } catch {
      return;
    }
    slot.sprite = sprite;
    slot.remainingMs = FLASH_MS;
    slot.live = true;
    this._flashCount++;
  }

  _clearFlashes(restoreTint) {
    for (let i = 0; i < EffectBudgets.MAX_FLASH_SLOTS; i++) {
      const f = this._flashes[i];
      if (f.live && restoreTint && f.sprite && typeof f.sprite.clearTint === 'function') {
        try {
          f.sprite.clearTint();
        } catch { /* sprite may be destroyed — ignore */ }
      }
      f.live = false;
      f.sprite = null;
      f.remainingMs = 0;
    }
    this._flashCount = 0;
  }

  // -------------------------------------------------- public spawners ----
  /**
   * Spawn a particle burst. Kinds: 'hit' 'crit' 'slash' 'dust' 'breakable'
   * 'levelup' 'save' 'death'. Unknown kinds fall back to 'hit'.
   * Excess particles are silently dropped (budget LAW).
   */
  burst(x, y, kind = 'hit') {
    const spec = PARTICLE_KINDS[kind] || PARTICLE_KINDS.hit;
    const texture = this._resolveTexture(spec.texture);
    for (let n = 0; n < spec.count; n++) {
      const p = this._particles.acquire();
      if (!p) return; // pool exhausted — drop the rest
      const angle = Math.random() * Math.PI * 2;
      const speed = randRange(spec.speed[0], spec.speed[1]);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.maxLife = randRange(spec.life[0], spec.life[1]);
      p.life = p.maxLife;
      p.size = randRange(spec.size[0], spec.size[1]);
      p.tint = spec.tints[(Math.random() * spec.tints.length) | 0];
      p.gravity = spec.gravity;
      p.drag = spec.drag;
      p.texture = texture;
      this._showParticle(p);
    }
  }

  /** Dust puff where the player lands — Wave 3 calls from the land hook. */
  spawnLandDust(x, y) {
    this.burst(x, y, 'dust');
  }

  /**
   * Pooled world-space damage number. Floats up and fades. Crits render
   * bigger and gold. No-op when settings.damageNumbers is off, or when the
   * pool is exhausted (cap LAW: 24 alive).
   */
  spawnDamageNumber(x, y, amount, { critical = false } = {}) {
    if (!this._damageNumbersEnabled()) return;
    const n = this._numbers.acquire();
    if (!n) return; // cap reached — drop, never steal a live number
    n.x = x;
    n.y = y;
    n.amount = amount;
    n.critical = critical;
    n.life = DMG_NUMBER_LIFE_MS;
    this._showNumber(n);
  }

  /**
   * Trauma-based screen shake. intensity 0..1 accumulates; the camera shake
   * itself is re-fired at short intervals while trauma decays, so repeated
   * hits feel continuous rather than restarting. No-op when
   * settings.screenShake is off.
   */
  screenShake(intensity, ms = 120) {
    if (!this._screenShakeEnabled()) return;
    void ms; // duration is trauma-driven; kept for API stability
    this._shaker.add(intensity);
  }

  /**
   * Freeze the world for up to 90 ms (budget LAW — clamped). Implemented by
   * zeroing the bound scene's time.timeScale and PAUSING the arcade physics
   * world, restoring previous values when the timer elapses in update().
   *
   * NOTE: the physics world is paused, never given timeScale 0 — a zero
   * world timeScale makes Phaser's Arcade World.update spin forever in its
   * fixed-step catch-up loop (`while (_elapsed >= 0)`), permanently hanging
   * the renderer on the frame after any hit. world.pause() early-returns
   * instead, which is starvation-free.
   */
  hitPause(ms) {
    if (!this._scene) {
      // Headless / pre-attach: still track the timer so shouldFreeze() is
      // meaningful in tests; no scene to freeze.
      this._hitPause.freeze(ms);
      return;
    }
    this._hitPause.freeze(ms);
    if (this._hitPause.active && !this._pausePrev) {
      const scene = this._scene;
      const world = scene.physics?.world;
      this._pausePrev = {
        timeScale: scene.time ? scene.time.timeScale : 1,
        worldWasPaused: world ? !!world.isPaused : true,
      };
      try {
        if (scene.time) scene.time.timeScale = 0;
        // Pause (never timeScale=0 — see NOTE above). If the world has no
        // pause() (minimal fake), leave it alone: shouldFreeze() already
        // stops gameplay updates while frozen.
        if (world && typeof world.pause === 'function') world.pause();
      } catch { /* duck-typed fakes may be partial — timer still runs */ }
    }
  }

  /** True while a hit pause is freezing the world. */
  shouldFreeze() {
    return this._hitPause.active;
  }

  // -------------------------------------------------- per-frame update ----
  /**
   * Advance all effects. Called once per frame by GameScene with REAL
   * (unscaled) delta milliseconds — never scaled, so hit-pause countdowns
   * and flash timers complete even while the world is frozen.
   * Zero allocation: fixed pools, stable callbacks.
   * @param {number} dtMs
   */
  update(dtMs) {
    const dt = Math.max(0, dtMs);
    this._lastDt = dt; // frame delta for the allocation-free slot callbacks

    // Hit pause countdown → restore time scales when it elapses.
    const wasFrozen = this._hitPause.active;
    this._hitPause.tick(dt);
    if (wasFrozen && !this._hitPause.active) this._restoreTimeScales();

    // Trauma decay + camera shake application.
    this._shaker.tick(dt);
    this._applyCameraShake(dt);

    // Particles.
    this._particles.forEachActive(this._updateParticle);

    // Damage numbers.
    this._numbers.forEachActive(this._updateNumber);

    // Hit flashes.
    if (this._flashCount > 0) {
      for (let i = 0; i < EffectBudgets.MAX_FLASH_SLOTS; i++) {
        const f = this._flashes[i];
        if (!f.live) continue;
        f.remainingMs -= dt;
        if (f.remainingMs <= 0) {
          if (f.sprite && typeof f.sprite.clearTint === 'function') {
            try {
              f.sprite.clearTint();
            } catch { /* destroyed mid-flash — ignore */ }
          }
          f.live = false;
          f.sprite = null;
          this._flashCount--;
        }
      }
    }
  }

  _restoreTimeScales() {
    if (!this._pausePrev || !this._scene) {
      this._pausePrev = null;
      return;
    }
    try {
      if (this._scene.time) this._scene.time.timeScale = this._pausePrev.timeScale;
      const world = this._scene.physics?.world;
      // Resume unless the world was already paused before our freeze.
      if (world && !this._pausePrev.worldWasPaused) {
        if (typeof world.resume === 'function') world.resume();
        else world.timeScale = 1;
      }
    } catch { /* ignore */ }
    this._pausePrev = null;
  }

  _applyCameraShake(dt) {
    if (!this._scene || !this._screenShakeEnabled()) {
      if (!this._screenShakeEnabled()) this._shaker.trauma = 0;
      return;
    }
    const cam = this._scene.cameras ? this._scene.cameras.main : null;
    if (!cam || typeof cam.shake !== 'function') return;
    if (this._shaker.magnitude < 0.02) {
      this._shakeAccumMs = 0;
      return;
    }
    this._shakeAccumMs += dt;
    if (this._shakeAccumMs >= SHAKE_REFIRE_MS) {
      this._shakeAccumMs = 0;
      try {
        cam.shake(SHAKE_REFIRE_MS + 20, this._shaker.magnitude * MAX_SHAKE_INTENSITY);
      } catch { /* ignore */ }
    }
  }

  _stepParticle(p) {
    p.life -= this._lastDt;
    if (p.life <= 0) {
      this._hideParticle(p);
      this._particles.release(p);
      return;
    }
    const dtS = this._lastDt / 1000;
    p.vy += p.gravity * dtS;
    const dragF = Math.pow(p.drag, dtS * 60);
    p.vx *= dragF;
    p.vy *= dragF;
    p.x += p.vx * dtS;
    p.y += p.vy * dtS;
    this._syncParticle(p);
  }

  _stepNumber(n) {
    n.life -= this._lastDt;
    if (n.life <= 0) {
      this._hideNumber(n);
      this._numbers.release(n);
      return;
    }
    const t = 1 - n.life / DMG_NUMBER_LIFE_MS; // 0 → 1
    this._syncNumber(n, t);
  }

  // -------------------------------------------------- view sync ----
  _viewForParticle(p) {
    return this._views ? this._views.particleViews[p.__poolIndex] : null;
  }

  _viewForNumber(n) {
    return this._views ? this._views.numberViews[n.__poolIndex] : null;
  }

  _showParticle(p) {
    const v = this._viewForParticle(p);
    if (!v) return;
    if (v.setTexture) {
      try {
        v.setTexture(p.texture);
      } catch { /* ignore */ }
    }
    v.setPosition(p.x, p.y);
    if (v.setTint) v.setTint(p.tint);
    if (v.setScale) v.setScale(p.size);
    if (v.setAlpha) v.setAlpha(1);
    v.setVisible(true);
  }

  _syncParticle(p) {
    const v = this._viewForParticle(p);
    if (!v) return;
    v.setPosition(p.x, p.y);
    if (v.setAlpha) v.setAlpha(Math.max(0, Math.min(1, (p.life / p.maxLife) * 1.5)));
  }

  _hideParticle(p) {
    const v = this._viewForParticle(p);
    if (v) v.setVisible(false);
  }

  _showNumber(n) {
    const v = this._viewForNumber(n);
    if (!v) return;
    const label = n.critical ? `${Math.round(n.amount)}!` : `${Math.round(n.amount)}`;
    if (v.setText) v.setText(label);
    else if ('text' in v) v.text = label;
    if (v.setColor) v.setColor(n.critical ? '#ffd94a' : '#ffffff');
    if (v.setScale) v.setScale(n.critical ? 1.5 : 1.0);
    v.setPosition(n.x, n.y);
    if (v.setAlpha) v.setAlpha(1);
    v.setVisible(true);
  }

  _syncNumber(n, t) {
    const v = this._viewForNumber(n);
    if (!v) return;
    v.setPosition(n.x, n.y - t * DMG_NUMBER_RISE_PX);
    if (v.setAlpha) v.setAlpha(t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45);
  }

  _hideNumber(n) {
    const v = this._viewForNumber(n);
    if (v) v.setVisible(false);
  }

  _syncAllViewsHidden() {
    if (!this._views) return;
    for (const v of this._views.particleViews) v.setVisible(false).setPosition(-1000, -1000);
    for (const v of this._views.numberViews) v.setVisible(false).setPosition(-1000, -1000);
  }

  // -------------------------------------------------- settings ----
  _screenShakeEnabled() {
    try {
      return this._state?.data?.settings?.screenShake !== false;
    } catch {
      return true;
    }
  }

  _damageNumbersEnabled() {
    try {
      return this._state?.data?.settings?.damageNumbers !== false;
    } catch {
      return true;
    }
  }

  // -------------------------------------------------- test seam ----
  /**
   * Exposed for tests: pool/pause/shaker/victim internals without Phaser.
   * Not part of the game API.
   */
  get _debug() {
    return {
      particles: this._particles,
      numbers: this._numbers,
      hitPause: this._hitPause,
      shaker: this._shaker,
      victims: this._victims,
      flashCount: () => this._flashCount,
    };
  }
}

/**
 * Singleton wired to the global eventBus. Game code uses this; tests
 * construct their own EffectsManager with an isolated bus.
 */
export const effectsManager = new EffectsManager();
