/**
 * test/effects.test.js — Wave 2 FX agent.
 *
 * Headless tests for the pure/testable parts of src/effects:
 * pool acquire/release caps, damage-number cap, hit-pause clamping,
 * trauma decay, settings gating, and event->effect mapping with injected
 * fakes (isolated EventBus, duck-typed scene, fake victim sprite).
 * No Phaser import — the effects module is Phaser-free at module scope.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/EventBus.js';
import {
  EffectBudgets,
  EffectsManager,
  HitPause,
  SlotPool,
  TraumaShaker,
} from '../src/effects/index.js';

// ---------------------------------------------------------------- fakes ----
function makeFakeText() {
  return {
    x: 0, y: 0, visible: false, alpha: 1, scale: 1, text: '', color: '#ffffff',
    setText(t) { this.text = t; return this; },
    setColor(c) { this.color = c; return this; },
    setScale(s) { this.scale = s; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setAlpha(a) { this.alpha = a; return this; },
    setVisible(v) { this.visible = v; return this; },
    setOrigin() { return this; },
    setDepth() { return this; },
    destroy() { this.destroyed = true; },
  };
}

function makeFakeImage() {
  return {
    x: 0, y: 0, visible: false, alpha: 1, scale: 1, tint: null, texture: null,
    setTexture(k) { this.texture = k; return this; },
    setTint(t) { this.tint = t; return this; },
    setScale(s) { this.scale = s; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setAlpha(a) { this.alpha = a; return this; },
    setVisible(v) { this.visible = v; return this; },
    setDepth() { return this; },
    destroy() { this.destroyed = true; },
  };
}

function makeFakeScene() {
  const scene = {
    texts: [],
    images: [],
    add: {
      text(x, y, str) {
        const t = makeFakeText();
        t.text = str;
        scene.texts.push(t);
        return t;
      },
      image(x, y, key) {
        const img = makeFakeImage();
        img.texture = key;
        scene.images.push(img);
        return img;
      },
    },
    cameras: {
      main: {
        shakeCalls: [],
        shake(duration, intensity) {
          this.shakeCalls.push({ duration, intensity });
        },
      },
    },
    time: { timeScale: 1 },
    physics: { world: { timeScale: 1, isPaused: false,
      pause() { this.isPaused = true; }, resume() { this.isPaused = false; } } },
    textures: { exists: () => true },
    make: {
      graphics() {
        return {
          fillStyle() {}, fillCircle() {}, generateTexture() {}, destroy() {},
        };
      },
    },
  };
  return scene;
}

function makeFakeVictim() {
  return {
    x: 100, y: 80, displayHeight: 32,
    tintFillCalls: [],
    clearTintCalls: 0,
    setTintFill(t) { this.tintFillCalls.push(t); },
    clearTint() { this.clearTintCalls++; },
  };
}

function makeState({ screenShake = true, damageNumbers = true } = {}) {
  return { data: { settings: { screenShake, damageNumbers } } };
}

/** Isolated manager: own bus, own state, own fake scene. */
function makeManager(stateOpts) {
  const bus = new EventBus();
  const mgr = new EffectsManager({ bus, state: makeState(stateOpts) });
  const scene = makeFakeScene();
  mgr.attachScene(scene);
  return { bus, mgr, scene };
}

// ------------------------------------------------------------ budgets ----
describe('EffectBudgets', () => {
  it('are frozen and match the architecture LAW', () => {
    expect(EffectBudgets.MAX_PARTICLES).toBe(400);
    expect(EffectBudgets.MAX_DAMAGE_NUMBERS).toBe(24);
    expect(EffectBudgets.MAX_HIT_PAUSE).toBe(0.09);
    expect(Object.isFrozen(EffectBudgets)).toBe(true);
  });
});

// ------------------------------------------------------------ SlotPool ----
describe('SlotPool', () => {
  it('hands out slots up to capacity, then returns null', () => {
    const pool = new SlotPool(3, () => ({}));
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).toBeNull();
    expect(pool.activeCount).toBe(3);
  });

  it('release() returns a slot to the pool for reuse', () => {
    const pool = new SlotPool(2, () => ({}));
    const a = pool.acquire();
    pool.acquire();
    expect(pool.acquire()).toBeNull();
    pool.release(a);
    expect(pool.activeCount).toBe(1);
    const b = pool.acquire();
    expect(b).not.toBeNull();
    expect(b).toBe(a); // same object reused — no allocation
  });

  it('double release is harmless', () => {
    const pool = new SlotPool(1, () => ({}));
    const a = pool.acquire();
    pool.release(a);
    pool.release(a);
    expect(pool.activeCount).toBe(0);
    expect(pool.acquire()).toBe(a);
  });

  it('releaseAll() empties the pool', () => {
    const pool = new SlotPool(4, () => ({}));
    pool.acquire(); pool.acquire();
    pool.releaseAll();
    expect(pool.activeCount).toBe(0);
    expect(pool.acquire()).not.toBeNull();
  });

  it('forEachActive visits only live slots', () => {
    const pool = new SlotPool(4, () => ({}));
    const a = pool.acquire();
    pool.acquire();
    pool.release(a);
    let count = 0;
    pool.forEachActive(() => { count++; });
    expect(count).toBe(1);
  });
});

// ------------------------------------------------------------ HitPause ----
describe('HitPause', () => {
  it('clamps to the 90 ms budget', () => {
    const hp = new HitPause();
    hp.freeze(500);
    expect(hp.remainingMs).toBeLessThanOrEqual(90);
    expect(hp.remainingMs).toBe(90);
    expect(hp.active).toBe(true);
  });

  it('tick() counts down in real ms and deactivates', () => {
    const hp = new HitPause();
    hp.freeze(50);
    hp.tick(30);
    expect(hp.active).toBe(true);
    hp.tick(30);
    expect(hp.active).toBe(false);
    expect(hp.remainingMs).toBe(0);
  });

  it('a new hit refreshes but never stacks beyond the clamp', () => {
    const hp = new HitPause();
    hp.freeze(40);
    hp.tick(30); // 10 ms left
    hp.freeze(40); // refresh back to 40, not 50
    expect(hp.remainingMs).toBe(40);
    hp.freeze(1000);
    expect(hp.remainingMs).toBe(90);
  });

  it('negative/zero input is harmless', () => {
    const hp = new HitPause();
    hp.freeze(-5);
    expect(hp.active).toBe(false);
  });
});

// --------------------------------------------------------- TraumaShaker ----
describe('TraumaShaker', () => {
  it('saturates at 1', () => {
    const s = new TraumaShaker();
    s.add(0.7);
    s.add(0.7);
    expect(s.magnitude).toBe(1);
  });

  it('decays over time', () => {
    const s = new TraumaShaker();
    s.add(1);
    s.tick(500);
    expect(s.magnitude).toBeLessThan(1);
    expect(s.magnitude).toBeGreaterThan(0);
    s.tick(10_000);
    expect(s.magnitude).toBe(0);
  });
});

// ------------------------------------------------------- damage numbers ----
describe('damage numbers', () => {
  it('cap at 24 alive — the 25th spawn is dropped, not stolen', () => {
    const { mgr } = makeManager();
    for (let i = 0; i < 30; i++) mgr.spawnDamageNumber(10, 10, 5);
    expect(mgr._debug.numbers.activeCount).toBe(EffectBudgets.MAX_DAMAGE_NUMBERS);
  });

  it('float up and expire over their lifetime', () => {
    const { mgr, scene } = makeManager();
    mgr.spawnDamageNumber(50, 60, 12);
    // SlotPool is LIFO: the bound view is the one that became visible.
    const view = scene.texts.find((t) => t.visible);
    expect(view).toBeDefined();
    expect(view.text).toBe('12');
    const startY = view.y;
    mgr.update(400);
    expect(view.y).toBeLessThan(startY); // floated upward
    mgr.update(1000); // past lifetime
    expect(mgr._debug.numbers.activeCount).toBe(0);
    expect(view.visible).toBe(false);
  });

  it('crits render bigger and gold with an exclamation', () => {
    const { mgr, scene } = makeManager();
    mgr.spawnDamageNumber(10, 10, 25, { critical: true });
    const view = scene.texts.find((t) => t.visible);
    expect(view.text).toBe('25!');
    expect(view.color).toBe('#ffd94a');
    expect(view.scale).toBe(1.5);
  });

  it('no-op when the damageNumbers setting is off', () => {
    const { mgr } = makeManager({ damageNumbers: false });
    mgr.spawnDamageNumber(10, 10, 5);
    expect(mgr._debug.numbers.activeCount).toBe(0);
  });

  it('rounding: fractional amounts display as integers', () => {
    const { mgr, scene } = makeManager();
    mgr.spawnDamageNumber(10, 10, 7.6);
    expect(scene.texts.find((t) => t.visible).text).toBe('8');
  });
});

// ------------------------------------------------------------- particles ----
describe('particles', () => {
  it('never exceed the 400-particle budget; overflow is dropped', () => {
    const { mgr } = makeManager();
    for (let i = 0; i < 100; i++) mgr.burst(10, 10, 'hit'); // 10 each
    expect(mgr._debug.particles.activeCount).toBeLessThanOrEqual(
      EffectBudgets.MAX_PARTICLES,
    );
    expect(mgr._debug.particles.activeCount).toBe(EffectBudgets.MAX_PARTICLES);
  });

  it('particles integrate and die over their lifespan', () => {
    const { mgr, scene } = makeManager();
    mgr.burst(100, 100, 'dust');
    const before = mgr._debug.particles.activeCount;
    expect(before).toBeGreaterThan(0);
    const view = scene.images.find((i) => i.visible);
    expect(view).toBeDefined();
    mgr.update(2000); // longer than any dust life
    expect(mgr._debug.particles.activeCount).toBe(0);
  });

  it('unknown burst kinds fall back to the hit spec', () => {
    const { mgr } = makeManager();
    expect(() => mgr.burst(10, 10, 'nope')).not.toThrow();
    expect(mgr._debug.particles.activeCount).toBeGreaterThan(0);
  });

  it('spawnLandDust emits a dust puff', () => {
    const { mgr } = makeManager();
    mgr.spawnLandDust(40, 120);
    expect(mgr._debug.particles.activeCount).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------- hit pause ----
describe('hitPause', () => {
  it('freezes scene time + pauses the physics world, then restores them', () => {
    const { mgr, scene } = makeManager();
    expect(mgr.shouldFreeze()).toBe(false);
    mgr.hitPause(50);
    expect(mgr.shouldFreeze()).toBe(true);
    expect(scene.time.timeScale).toBe(0);
    // The world is PAUSED, never given timeScale 0: a zero world timeScale
    // hangs Phaser's Arcade World.update in its fixed-step catch-up loop.
    expect(scene.physics.world.isPaused).toBe(true);
    mgr.update(60); // countdown runs on real delta
    expect(mgr.shouldFreeze()).toBe(false);
    expect(scene.time.timeScale).toBe(1);
    expect(scene.physics.world.isPaused).toBe(false);
  });

  it('clamps requests above the budget to 90 ms', () => {
    const { mgr } = makeManager();
    mgr.hitPause(1000);
    expect(mgr._debug.hitPause.remainingMs).toBeLessThanOrEqual(90);
  });

  it('works headless (no scene attached) without throwing', () => {
    const bus = new EventBus();
    const mgr = new EffectsManager({ bus, state: makeState() });
    expect(() => mgr.hitPause(50)).not.toThrow();
    expect(mgr.shouldFreeze()).toBe(true);
    mgr.update(60);
    expect(mgr.shouldFreeze()).toBe(false);
  });
});

// ---------------------------------------------------------- screen shake ----
describe('screenShake', () => {
  it('drives camera.shake while trauma lives', () => {
    const { mgr, scene } = makeManager();
    mgr.screenShake(1, 200);
    mgr.update(100); // past the 90 ms refire window
    expect(scene.cameras.main.shakeCalls.length).toBeGreaterThan(0);
    const call = scene.cameras.main.shakeCalls[0];
    expect(call.intensity).toBeGreaterThan(0);
    expect(call.intensity).toBeLessThanOrEqual(0.006);
  });

  it('no-op when the screenShake setting is off', () => {
    const { mgr, scene } = makeManager({ screenShake: false });
    mgr.screenShake(1, 200);
    mgr.update(200);
    expect(scene.cameras.main.shakeCalls.length).toBe(0);
    expect(mgr._debug.shaker.magnitude).toBe(0);
  });

  it('trauma decays so shaking stops on its own', () => {
    const { mgr, scene } = makeManager();
    mgr.screenShake(0.3, 100);
    mgr.update(5000);
    const calls = scene.cameras.main.shakeCalls.length;
    mgr.update(5000);
    expect(scene.cameras.main.shakeCalls.length).toBe(calls); // no new shakes
  });
});

// -------------------------------------------------------- victim registry ----
describe('victim registry', () => {
  it('register/unregister round-trips ids to sprites', () => {
    const { mgr } = makeManager();
    const sprite = makeFakeVictim();
    mgr.registerVictim('e-1', sprite);
    expect(mgr._debug.victims.get('e-1')).toBe(sprite);
    mgr.unregisterVictim('e-1');
    expect(mgr._debug.victims.has('e-1')).toBe(false);
  });
});

// ---------------------------------------------------- event -> effect map ----
describe('combat:hitLanded mapping', () => {
  it('a normal hit flashes the victim red, spawns a number, shakes, pauses', () => {
    const { bus, mgr, scene } = makeManager();
    const victim = makeFakeVictim();
    mgr.registerVictim('goblin-1', victim);

    bus.emit('combat:hitLanded', {
      attacker: 'player', target: 'goblin-1', amount: 12, critical: false,
    });

    expect(victim.tintFillCalls).toEqual([0xff5544]); // red flash
    expect(mgr._debug.numbers.activeCount).toBe(1);
    expect(mgr.shouldFreeze()).toBe(true);
    expect(mgr._debug.shaker.magnitude).toBeGreaterThan(0);
    expect(scene.time.timeScale).toBe(0);

    mgr.update(500); // everything elapses
    expect(victim.clearTintCalls).toBe(1);
    expect(mgr.shouldFreeze()).toBe(false);
    expect(scene.time.timeScale).toBe(1);
  });

  it('a crit flashes white and pauses longer', () => {
    const { bus, mgr } = makeManager();
    const victim = makeFakeVictim();
    mgr.registerVictim('goblin-2', victim);

    bus.emit('combat:hitLanded', {
      attacker: 'player', target: 'goblin-2', amount: 30, critical: true,
    });

    expect(victim.tintFillCalls).toEqual([0xffffff]); // white flash
    expect(mgr._debug.hitPause.remainingMs).toBeGreaterThan(45);
    expect(mgr._debug.hitPause.remainingMs).toBeLessThanOrEqual(90);
  });

  it('an unregistered target id degrades gracefully (no throw)', () => {
    const { bus, mgr } = makeManager();
    expect(() =>
      bus.emit('combat:hitLanded', {
        attacker: 'player', target: 'ghost-id', amount: 5, critical: false,
      }),
    ).not.toThrow();
    // number/shake/pause still fire at the origin fallback
    expect(mgr._debug.numbers.activeCount).toBe(1);
    expect(mgr.shouldFreeze()).toBe(true);
  });

  it('combat code never calls effects directly — only the bus subscription', () => {
    const bus = new EventBus();
    const mgr = new EffectsManager({ bus, state: makeState() });
    mgr.attachScene(makeFakeScene());
    // no listeners on the manager itself besides the one bus subscription
    expect(bus._listeners.get('combat:hitLanded').size).toBe(1);
    mgr.detach();
    expect(bus._listeners.has('combat:hitLanded')).toBe(true); // set remains
    expect(bus._listeners.get('combat:hitLanded').size).toBe(0);
  });

  it('a destroyed-mid-flash sprite does not break update()', () => {
    const { bus, mgr } = makeManager();
    const victim = makeFakeVictim();
    victim.clearTint = () => { throw new Error('destroyed'); };
    mgr.registerVictim('e-x', victim);
    bus.emit('combat:hitLanded', {
      attacker: 'player', target: 'e-x', amount: 3, critical: false,
    });
    expect(() => mgr.update(500)).not.toThrow();
  });
});
