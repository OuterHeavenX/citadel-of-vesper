/**
 * AssetManager tests — staged loading against a duck-typed fake scene.
 * AssetManager never imports Phaser, so plain fakes are enough.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetManager,
  FALLBACK_TEXTURE_KEY,
  LOAD_INDICATOR_MS,
  Stages,
  assetManager,
} from '../src/core/AssetManager.js';
import { AssetPacks } from '../src/config/assets.js';

// ---------- fakes ----------

function chainable() {
  const o = { destroyed: false };
  o.setOrigin = () => o;
  o.setDepth = () => o;
  o.setScrollFactor = () => o;
  o.destroy = () => {
    o.destroyed = true;
  };
  return o;
}

class FakeLoader {
  constructor() {
    this.files = [];
    this.handlers = new Map();
    this.failKeys = new Set();
    this.autoComplete = true;
    this.startCount = 0;
  }
  _add(key) {
    this.files.push({ key });
  }
  image(key) {
    this._add(key);
  }
  spritesheet(key) {
    this._add(key);
  }
  atlas(key) {
    this._add(key);
  }
  audio(key) {
    this._add(key);
  }
  json(key) {
    this._add(key);
  }
  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev).add(fn);
    return this;
  }
  off(ev, fn) {
    this.handlers.get(ev)?.delete(fn);
    return this;
  }
  once(ev, fn) {
    const wrap = (...a) => {
      this.off(ev, wrap);
      fn(...a);
    };
    return this.on(ev, wrap);
  }
  emit(ev, ...a) {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...a);
  }
  start() {
    this.startCount += 1;
    if (this.autoComplete) {
      queueMicrotask(() => this.completeNow());
    }
  }
  completeNow() {
    for (const f of this.files) {
      if (this.failKeys.has(f.key)) this.emit('loaderror', { key: f.key });
    }
    this.files = [];
    this.emit('complete');
  }
}

function makeScene({ failKeys = [], autoComplete = true } = {}) {
  const load = new FakeLoader();
  load.failKeys = new Set(failKeys);
  load.autoComplete = autoComplete;
  const textureKeys = new Set();
  const added = [];
  const delayedCalls = [];
  const scene = {
    load,
    added,
    delayedCalls,
    textures: {
      exists: (k) => textureKeys.has(k),
      _add: (k) => textureKeys.add(k),
    },
    make: {
      graphics: () => ({
        fillStyle() {},
        fillRect() {},
        generateTexture: (key) => textureKeys.add(key),
        destroy() {},
      }),
    },
    cameras: { main: { width: 480, height: 270 } },
    time: {
      delayedCall: (ms, cb) => {
        const rec = { ms, cb, removed: false };
        delayedCalls.push(rec);
        return {
          remove: () => {
            rec.removed = true;
          },
        };
      },
    },
    add: {
      rectangle: (...a) => {
        const o = chainable();
        added.push({ kind: 'rectangle', args: a, obj: o });
        return o;
      },
      text: (...a) => {
        const o = chainable();
        added.push({ kind: 'text', args: a, obj: o });
        return o;
      },
      container: (...a) => {
        const o = chainable();
        added.push({ kind: 'container', args: a, obj: o });
        return o;
      },
    },
    tweens: { add: () => ({ stop() {} }) },
  };
  return scene;
}

const TEST_PACKS = {
  boot: [
    { key: 'logo', type: 'image', url: 'assets/ui/logo.png', required: true },
    { key: 'hero', type: 'spritesheet', url: 'assets/player/hero.png', frameWidth: 64, frameHeight: 64, required: false },
  ],
  room_moonlit_gate: [{ key: 'tiles_mg', type: 'image', url: 'assets/tilesets/mg.png', required: false }],
};

function freshManager() {
  const m = new AssetManager();
  m.setPackManifest(TEST_PACKS);
  return m;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('Stages', () => {
  it('defines boot/title and room:<region> stages', () => {
    expect(Stages.BOOT).toBe('boot');
    expect(Stages.TITLE).toBe('title');
    expect(Stages.ROOM('moonlit_gate')).toBe('room:moonlit_gate');
    expect(Stages.ROOM('hollow_keep')).toBe('room:hollow_keep');
  });
});

describe('AssetManager.loadStage', () => {
  let m;
  beforeEach(() => {
    m = freshManager();
  });

  it('rejects when no pack manifest was injected', async () => {
    const bare = new AssetManager();
    await expect(bare.loadStage(makeScene(), Stages.BOOT, ['boot'])).rejects.toThrow(/pack manifest not set/);
  });

  it('rejects on unknown pack id', async () => {
    await expect(m.loadStage(makeScene(), Stages.BOOT, ['nope'])).rejects.toThrow(/unknown pack 'nope'/);
  });

  it('resolves {ok:true} for empty packs without touching the loader', async () => {
    const scene = makeScene();
    const res = await m.loadStage(scene, Stages.BOOT, []);
    expect(res).toEqual({ ok: true, missing: [] });
    expect(scene.load.startCount).toBe(0);
  });

  it('loads packs, records keys, and is idempotent', async () => {
    const scene = makeScene();
    const res = await m.loadStage(scene, Stages.BOOT, ['boot']);
    expect(res).toEqual({ ok: true, missing: [] });
    expect(m.isLoaded('boot')).toBe(true);
    expect(m.has('logo')).toBe(true);
    expect(m.has('hero')).toBe(true);
    expect(scene.load.startCount).toBe(1);

    // second call skips the already-loaded pack entirely
    const res2 = await m.loadStage(scene, Stages.BOOT, ['boot']);
    expect(res2).toEqual({ ok: true, missing: [] });
    expect(scene.load.startCount).toBe(1);
  });

  it('resolves {ok:false, missing} for missing OPTIONAL assets', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = makeScene({ failKeys: ['hero'] }); // hero is optional
    const res = await m.loadStage(scene, Stages.BOOT, ['boot']);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['hero']);
    expect(m.isLoaded('boot')).toBe(true); // attempted packs are not retried
    expect(m.has('logo')).toBe(true);
    expect(m.has('hero')).toBe(false);
    warn.mockRestore();
  });

  it('rejects with a clear message for missing REQUIRED assets', async () => {
    const scene = makeScene({ failKeys: ['logo'] }); // logo is required
    await expect(m.loadStage(scene, Stages.BOOT, ['boot'])).rejects.toThrow(
      /REQUIRED asset\(s\) failed to load.*\blogo\b/
    );
  });

  it('rejects unknown entry types and bad spritesheets fast', async () => {
    const bad = new AssetManager();
    bad.setPackManifest({ x: [{ key: 'k', type: 'video', url: 'a' }] });
    await expect(bad.loadStage(makeScene(), 's', ['x'])).rejects.toThrow(/unknown type 'video'/);

    const badSheet = new AssetManager();
    badSheet.setPackManifest({ x: [{ key: 'k', type: 'spritesheet', url: 'a' }] });
    await expect(badSheet.loadStage(makeScene(), 's', ['x'])).rejects.toThrow(/frameWidth/);
  });

  it('serializes concurrent loadStage calls', async () => {
    const scene = makeScene();
    const [a, b] = await Promise.all([
      m.loadStage(scene, Stages.BOOT, ['boot']),
      m.loadStage(scene, Stages.ROOM('moonlit_gate'), ['room_moonlit_gate']),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(scene.load.startCount).toBe(2);
  });

  it('registers the loading indicator at 400ms on a slow load', async () => {
    const scene = makeScene({ autoComplete: false });
    const p = m.loadStage(scene, Stages.BOOT, ['boot']);
    await tick();
    expect(scene.delayedCalls.length).toBe(1);
    expect(scene.delayedCalls[0].ms).toBe(LOAD_INDICATOR_MS);

    // simulate the 400ms elapsing while the loader is still busy
    scene.delayedCalls[0].cb();
    expect(scene.added.some((a) => a.kind === 'container')).toBe(true);

    scene.load.completeNow();
    const res = await p;
    expect(res.ok).toBe(true);
    const container = scene.added.find((a) => a.kind === 'container');
    expect(container.obj.destroyed).toBe(true); // indicator hidden after load
  });

  it('does not show the indicator on a fast load', async () => {
    const scene = makeScene();
    await m.loadStage(scene, Stages.BOOT, ['boot']);
    expect(scene.delayedCalls[0].removed).toBe(true);
    expect(scene.added.some((a) => a.kind === 'container')).toBe(false);
  });
});

describe('AssetManager texture fallback', () => {
  it('getTexture returns the key when it exists, else generates a fallback', () => {
    const m = freshManager();
    const scene = makeScene();
    scene.textures._add('logo');
    expect(m.getTexture(scene, 'logo')).toBe('logo');

    const fb = m.getTexture(scene, 'missing_sprite');
    expect(fb).toBe(FALLBACK_TEXTURE_KEY);
    expect(scene.textures.exists(FALLBACK_TEXTURE_KEY)).toBe(true);
    // second call reuses the generated texture
    expect(m.getTexture(scene, 'missing_sprite')).toBe(FALLBACK_TEXTURE_KEY);
  });

  it('unloadPacks forgets packs and their keys', async () => {
    const m = freshManager();
    const scene = makeScene();
    await m.loadStage(scene, Stages.BOOT, ['boot']);
    m.unloadPacks(['boot']);
    expect(m.isLoaded('boot')).toBe(false);
    expect(m.has('logo')).toBe(false);
  });
});

describe('AssetManager.preloadAdjacent', () => {
  it('warms neighbor regions, skips unknown packs, never throws', async () => {
    const m = freshManager();
    m.setRoomGraphProvider((roomId) =>
      roomId === 'moonlit_gate_001' ? ['moonlit_gate_002', 'hollow_keep_001'] : []
    );
    m.setRoomRegionResolver((roomId) =>
      roomId.startsWith('moonlit_gate') ? 'moonlit_gate' : roomId.startsWith('hollow_keep') ? 'hollow_keep' : null
    );
    const scene = makeScene();
    await m.preloadAdjacent(scene, 'moonlit_gate_001');
    await tick(50); // fire-and-forget: let the queued loads run
    expect(m.isLoaded('room_moonlit_gate')).toBe(true);
    // 'room_hollow_keep' has no pack in TEST_PACKS — skipped silently
    expect(m.isLoaded('room_hollow_keep')).toBe(false);
  });

  it('is a safe no-op by default and on provider errors', async () => {
    const m = freshManager();
    await m.preloadAdjacent(makeScene(), 'anywhere'); // default providers
    m.setRoomGraphProvider(() => {
      throw new Error('boom');
    });
    await m.preloadAdjacent(makeScene(), 'anywhere'); // must not throw
  });
});

describe('AssetPacks manifest (src/config/assets.js)', () => {
  it('defines the six contract packs', () => {
    for (const p of ['boot', 'title', 'room_moonlit_gate', 'room_hollow_keep', 'ui', 'audio']) {
      expect(Array.isArray(AssetPacks[p]), p).toBe(true);
    }
  });

  it('every entry is well-formed', () => {
    const types = new Set(['image', 'spritesheet', 'atlas', 'audio', 'json']);
    const keys = new Set();
    for (const [packId, pack] of Object.entries(AssetPacks)) {
      for (const e of pack) {
        expect(typeof e.key, `${packId} key`).toBe('string');
        expect(e.key).toMatch(/^[a-z0-9_]+$/);
        expect(types.has(e.type), `${e.key} type`).toBe(true);
        expect(typeof e.required, `${e.key} required flag`).toBe('boolean');
        expect(keys.has(e.key), `duplicate key ${e.key}`).toBe(false);
        keys.add(e.key);
        if (e.type === 'spritesheet') {
          expect(e.frameWidth).toBeGreaterThan(0);
          expect(e.frameHeight).toBeGreaterThan(0);
        }
        if (e.type === 'audio') {
          const urls = e.urls ?? [e.url];
          expect(urls.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('icon keys match data icon fields 1:1', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const icons = new Set();
    for (const f of ['weapons', 'armor', 'accessories', 'consumables', 'abilities']) {
      for (const item of JSON.parse(readFileSync(path.join(root, `data/${f}.json`), 'utf8'))) {
        if (item.icon) icons.add(item.icon);
      }
    }
    const uiKeys = new Set(AssetPacks.ui.map((e) => e.key));
    for (const icon of icons) expect(uiKeys.has(icon), `icon ${icon}`).toBe(true);
  });

  it('audio keys cover every music/sfx id referenced by data', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const ids = new Set(['title_theme']);
    for (const f of ['rooms', 'bosses', 'weapons', 'enemies']) {
      for (const item of JSON.parse(readFileSync(path.join(root, `data/${f}.json`), 'utf8'))) {
        if (item.music) ids.add(item.music);
        if (item.attackProfile?.soundId) ids.add(item.attackProfile.soundId);
        for (const t of item.telegraphs ?? []) if (t.sound) ids.add(t.sound);
      }
    }
    const audioKeys = new Set(AssetPacks.audio.map((e) => e.key));
    for (const id of ids) expect(audioKeys.has(id), `audio ${id}`).toBe(true);
  });
});

describe('assetManager singleton', () => {
  it('is an AssetManager with a clean initial state', () => {
    assetManager.reset();
    expect(assetManager).toBeInstanceOf(AssetManager);
    expect(assetManager.isLoaded('boot')).toBe(false);
    expect(assetManager.has('logo_vesper')).toBe(false);
  });
});
