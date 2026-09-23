/**
 * AssetManager — staged asset loading (docs/ARCHITECTURE.md §7).
 *
 * CONTRACT:
 * - Stages: 'boot' -> 'title' -> 'room:<region>' -> 'room:<region>' ...
 *   NEVER download every game asset before the title screen.
 * - `loadStage(scene, stage, packIds)` loads only the listed packs and
 *   resolves `{ ok, missing }`. A `LoadingIndicator` overlay appears if the
 *   load takes longer than `LOAD_INDICATOR_MS` (400 ms).
 * - `preloadAdjacent(scene, roomId)` warms neighbor rooms' region packs
 *   (non-blocking). Room-graph knowledge is INJECTED — see
 *   `setRoomGraphProvider()` / `setRoomRegionResolver()` — so this module
 *   stays decoupled from rooms.json (RoomManager wires the real providers).
 * - Missing OPTIONAL assets: resolve `{ ok: false, missing: [...] }` — the
 *   caller substitutes a fallback (spec §59 crash protection).
 * - Missing REQUIRED assets: REJECT with a clear message naming the asset —
 *   BootScene catches this and shows the friendly error screen.
 * - Pack manifests live in `src/config/assets.js` (`AssetPacks`) and are
 *   INJECTED via `setPackManifest()` — core/ may import nothing except
 *   ./EventBus.js, so the manifest cannot be imported here.
 * - Entry: `{ key, type, url, required?, ... }` where type is
 *   'image' | 'spritesheet' | 'atlas' | 'audio' | 'json'.
 *   `required` defaults to TRUE (an asset the game asks for is required
 *   unless explicitly marked optional).
 * - `getTexture(scene, key)` returns `key` when the texture exists, else a
 *   generated magenta/black fallback texture — callers never crash on a
 *   missing sprite. `has(key)` reports manager-side load state.
 * - Loads are serialized through an internal queue: concurrent
 *   `loadStage()` calls never race the Phaser Loader.
 *
 * URL resolution: manifest `url`s are repo-relative paths under `assets/`
 * (e.g. 'assets/player/lucien_idle.png'). They are resolved against
 * `import.meta.env.BASE_URL`, so they work in dev (`/assets/...` served
 * from `public/`) and on GitHub Pages (`/citadel-of-vesper/assets/...`).
 * Game-ready runtime files live in `public/assets/`; authoring sources
 * live in `assets/`. See assets/README.md.
 */
export const Stages = Object.freeze({
  BOOT: 'boot',
  TITLE: 'title',
  /** Room stage for a region id, e.g. Stages.ROOM('moonlit_gate') === 'room:moonlit_gate'. */
  ROOM: (region) => `room:${region}`,
});

/** Loading overlay appears only if a stage load exceeds this. */
export const LOAD_INDICATOR_MS = 400;

/** Hard timeout per loadStage() — a stuck loader must never hang boot. */
export const LOAD_TIMEOUT_MS = 30_000;

/** Texture key of the generated missing-asset fallback. */
export const FALLBACK_TEXTURE_KEY = '__vesper_missing';

const FALLBACK_TEXTURE_SIZE = 16;

/**
 * LoadingIndicator — simple Phaser text/graphic overlay.
 * Shown by AssetManager when a stage load exceeds LOAD_INDICATOR_MS.
 * Duck-typed on the scene: uses scene.add / scene.tweens / scene.cameras.
 */
export class LoadingIndicator {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this._scene = scene;
    this._container = null;
    this._tween = null;
  }

  get visible() {
    return this._container !== null;
  }

  /**
   * Show the overlay (idempotent — re-showing rebuilds it).
   * @param {string} [label='LOADING']
   */
  show(label = 'LOADING') {
    this.hide();
    const scene = this._scene;
    const cam = scene.cameras.main;
    const w = cam.width;
    const h = cam.height;
    const gold = 0xc9b37e;

    const bg = scene.add.rectangle(0, 0, w, h, 0x06060c, 0.85).setOrigin(0, 0);
    const text = scene.add
      .text(w / 2, h / 2 - 10, label, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#c9b37e',
      })
      .setOrigin(0.5);
    const barBg = scene.add.rectangle(w / 2, h / 2 + 14, 120, 6, 0x2a2a35).setOrigin(0.5);
    const bar = scene.add.rectangle(w / 2 - 52, h / 2 + 14, 16, 6, gold).setOrigin(0.5);

    this._container = scene.add
      .container(0, 0, [bg, text, barBg, bar])
      .setDepth(10000)
      .setScrollFactor(0);
    this._tween = scene.tweens.add({
      targets: bar,
      x: '+=104',
      duration: 650,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  /** Hide and destroy the overlay (safe to call when hidden). */
  hide() {
    if (this._tween) {
      this._tween.stop();
      this._tween = null;
    }
    if (this._container) {
      this._container.destroy();
      this._container = null;
    }
  }
}

export class AssetManager {
  constructor() {
    /** @type {Set<string>} pack ids whose load has been attempted */
    this.loadedPacks = new Set();
    /** @type {object|null} injected AssetPacks manifest */
    this._packs = null;
    /** @type {Set<string>} keys successfully loaded by this manager */
    this._loadedKeys = new Set();
    /** @type {Map<string, Set<string>>} packId -> keys loaded for it */
    this._packKeys = new Map();
    /** Serial chain: loadStage calls never overlap on the Phaser Loader. */
    this._tail = Promise.resolve();
    /** (roomId) => string[] — injected by RoomManager; default no-op. */
    this._roomGraphProvider = () => [];
    /** (roomId) => regionId|null — injected by RoomManager; default no-op. */
    this._roomRegionResolver = () => null;
    /** @type {LoadingIndicator|null} */
    this._indicator = null;
  }

  /**
   * Inject the pack manifest (from src/config/assets.js). Must be called
   * once during boot before any loadStage() — core/ cannot import config/.
   * @param {object} packs the AssetPacks manifest
   */
  setPackManifest(packs) {
    this._packs = packs;
  }

  /**
   * Inject the room-graph accessor used by preloadAdjacent().
   * @param {(roomId: string) => string[]} provider returns adjacent room ids
   *   (e.g. `(roomId) => dataManager.getRoom(roomId)?.exits.map(e => e.target) ?? []`)
   */
  setRoomGraphProvider(provider) {
    this._roomGraphProvider = provider;
  }

  /**
   * Inject the room -> region resolver used by preloadAdjacent().
   * @param {(roomId: string) => string|null} resolver
   *   (e.g. `(roomId) => dataManager.getRoom(roomId)?.region ?? null`)
   */
  setRoomRegionResolver(resolver) {
    this._roomRegionResolver = resolver;
  }

  /**
   * Resolve a manifest `url` (repo-relative 'assets/...') against the app
   * base path. Absolute URLs and data:/blob: URIs pass through untouched.
   * @param {string} url
   * @returns {string}
   */
  resolveUrl(url) {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('[AssetManager] manifest entry has an empty url.');
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url)) return url;
    const env = import.meta.env;
    const base = (env && env.BASE_URL) || '/';
    return `${base}${url.replace(/^\.\//, '')}`;
  }

  /**
   * Load asset packs for a stage. Idempotent per pack id — already-loaded
   * packs are skipped. Calls are serialized internally.
   *
   * @param {Phaser.Scene} scene
   * @param {string} stage e.g. Stages.TITLE or Stages.ROOM('moonlit_gate')
   * @param {string[]} packIds
   * @returns {Promise<{ok: boolean, missing: string[]}>}
   *   ok=false + missing keys when OPTIONAL assets failed (substitute
   *   fallbacks via getTexture()). Rejects when a REQUIRED asset failed.
   */
  loadStage(scene, stage, packIds) {
    return this._enqueue(() => this._loadStageNow(scene, stage, packIds));
  }

  /**
   * Warm the cache for rooms adjacent to `roomId` (non-blocking).
   * Resolves each adjacent room -> region -> `room_<region>` pack and loads
   * packs not already loaded. Failures only warn — preloading must never
   * break gameplay.
   * @param {Phaser.Scene} scene
   * @param {string} roomId
   * @returns {Promise<void>} resolves once preloads are QUEUED, not finished
   */
  async preloadAdjacent(scene, roomId) {
    let adjacent = [];
    try {
      adjacent = this._roomGraphProvider(roomId) ?? [];
    } catch (err) {
      console.warn(`[AssetManager] room graph provider threw for '${roomId}':`, err);
      return;
    }
    for (const nextId of adjacent) {
      let region = null;
      try {
        region = this._roomRegionResolver(nextId);
      } catch {
        region = null;
      }
      if (!region) continue;
      const packId = `room_${region}`;
      if (this.loadedPacks.has(packId)) continue;
      if (!this._packs || !this._packs[packId]) continue; // no art pack for region yet
      this.loadStage(scene, Stages.ROOM(region), [packId]).catch((err) => {
        console.warn(`[AssetManager] adjacent preload failed for room '${nextId}':`, err.message);
      });
    }
  }

  /**
   * Texture key safe to pass to scene.add.image/sprite: returns `key` when
   * the texture exists, otherwise generates (once) and returns a
   * magenta/black fallback texture key.
   * @param {Phaser.Scene} scene
   * @param {string} key
   * @returns {string}
   */
  getTexture(scene, key) {
    if (scene && scene.textures && scene.textures.exists(key)) return key;
    if (this._loadedKeys.has(key)) return key;
    if (!scene) return FALLBACK_TEXTURE_KEY;
    return this.ensureFallbackTexture(scene);
  }

  /**
   * Generate the fallback texture if absent; returns its key.
   * @param {Phaser.Scene} scene
   * @returns {string} FALLBACK_TEXTURE_KEY
   */
  ensureFallbackTexture(scene) {
    if (!scene.textures.exists(FALLBACK_TEXTURE_KEY)) {
      const g = scene.make.graphics({ x: 0, y: 0, add: false });
      const s = FALLBACK_TEXTURE_SIZE;
      const half = s / 2;
      g.fillStyle(0xff00ff, 1);
      g.fillRect(0, 0, s, s);
      g.fillStyle(0x1a1a1a, 1);
      g.fillRect(0, 0, half, half);
      g.fillRect(half, half, half, half);
      g.generateTexture(FALLBACK_TEXTURE_KEY, s, s);
      g.destroy();
    }
    return FALLBACK_TEXTURE_KEY;
  }

  /** @param {string} key @returns {boolean} true if this manager loaded it */
  has(key) {
    return this._loadedKeys.has(key);
  }

  /** @param {string} packId @returns {boolean} */
  isLoaded(packId) {
    return this.loadedPacks.has(packId);
  }

  /**
   * Forget packs (called on region change). Drops bookkeeping; Phaser
   * texture/cache removal stays with the scene that owns the assets.
   * @param {string[]} packIds
   */
  unloadPacks(packIds) {
    for (const id of packIds ?? []) {
      this.loadedPacks.delete(id);
      const keys = this._packKeys.get(id);
      if (keys) for (const k of keys) this._loadedKeys.delete(k);
      this._packKeys.delete(id);
    }
  }

  /**
   * Reset load bookkeeping (tests / dev). Providers and the injected
   * manifest are kept.
   */
  reset() {
    this.loadedPacks.clear();
    this._loadedKeys.clear();
    this._packKeys.clear();
    this._hideIndicator();
  }

  // ---- internals ----

  /** @private serialize async work */
  _enqueue(fn) {
    const p = this._tail.then(fn, fn);
    this._tail = p.catch(() => {});
    return p;
  }

  /** @private */
  async _loadStageNow(scene, stage, packIds) {
    if (!this._packs) {
      throw new Error(
        '[AssetManager] pack manifest not set — call assetManager.setPackManifest(AssetPacks) once during boot (see docs/ASSET_PIPELINE.md).'
      );
    }
    const uniquePacks = [...new Set(packIds ?? [])];
    const seenKeys = new Set();
    const entries = [];
    const attemptedPacks = [];
    for (const packId of uniquePacks) {
      const pack = this._packs[packId];
      if (!pack) {
        throw new Error(
          `[AssetManager] unknown pack '${packId}' requested for stage '${stage}'. Known packs: ${Object.keys(this._packs).join(', ')}.`
        );
      }
      if (this.loadedPacks.has(packId)) continue;
      attemptedPacks.push(packId);
      for (const entry of pack) {
        if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) {
          throw new Error(`[AssetManager] pack '${packId}' contains an entry without a string 'key'.`);
        }
        if (seenKeys.has(entry.key) || this._loadedKeys.has(entry.key)) continue;
        seenKeys.add(entry.key);
        entries.push({ packId, ...entry });
      }
    }
    if (entries.length === 0) {
      for (const p of attemptedPacks) this.loadedPacks.add(p);
      return { ok: true, missing: [] };
    }

    for (const entry of entries) this._queueFile(scene, entry);
    const failedKeys = await this._runLoader(scene, stage, uniquePacks, entries.length);

    const missing = [];
    const missingRequired = [];
    for (const entry of entries) {
      const required = entry.required !== false; // required unless explicitly optional
      if (failedKeys.has(entry.key)) {
        missing.push(entry.key);
        if (required) {
          missingRequired.push(entry.key);
        } else {
          console.warn(
            `[AssetManager] optional asset missing: '${entry.key}' (${entry.url}) — callers should substitute a fallback via getTexture().`
          );
        }
      } else {
        this._loadedKeys.add(entry.key);
        let set = this._packKeys.get(entry.packId);
        if (!set) {
          set = new Set();
          this._packKeys.set(entry.packId, set);
        }
        set.add(entry.key);
      }
    }
    for (const p of attemptedPacks) this.loadedPacks.add(p);

    if (missingRequired.length > 0) {
      throw new Error(
        `[AssetManager] REQUIRED asset(s) failed to load for stage '${stage}': ${missingRequired.join(', ')}. ` +
          'The game cannot continue — BootScene must show the friendly error screen (docs/ASSET_PIPELINE.md §8).'
      );
    }
    return { ok: missing.length === 0, missing };
  }

  /** @private queue one manifest entry on the Phaser Loader */
  _queueFile(scene, entry) {
    const load = scene.load;
    switch (entry.type) {
      case 'image':
        load.image(entry.key, this.resolveUrl(entry.url));
        break;
      case 'spritesheet':
        if (!entry.frameWidth || !entry.frameHeight) {
          throw new Error(
            `[AssetManager] spritesheet '${entry.key}' needs frameWidth + frameHeight (see assets/README.md).`
          );
        }
        load.spritesheet(entry.key, this.resolveUrl(entry.url), {
          frameWidth: entry.frameWidth,
          frameHeight: entry.frameHeight,
          ...(entry.margin != null ? { margin: entry.margin } : {}),
          ...(entry.spacing != null ? { spacing: entry.spacing } : {}),
        });
        break;
      case 'atlas':
        if (!entry.atlasURL) {
          throw new Error(`[AssetManager] atlas '${entry.key}' needs atlasURL (the .json sidecar).`);
        }
        load.atlas(entry.key, this.resolveUrl(entry.url), this.resolveUrl(entry.atlasURL));
        break;
      case 'audio':
        load.audio(
          entry.key,
          (entry.urls ?? [entry.url]).map((u) => this.resolveUrl(u))
        );
        break;
      case 'json':
        load.json(entry.key, this.resolveUrl(entry.url));
        break;
      default:
        throw new Error(
          `[AssetManager] entry '${entry.key}' has unknown type '${entry.type}' — expected image|spritesheet|atlas|audio|json.`
        );
    }
  }

  /** @private run the Phaser Loader; resolves the set of failed keys */
  _runLoader(scene, stage, packIds, entryCount) {
    return new Promise((resolve, reject) => {
      const loader = scene.load;
      const failedKeys = new Set();
      let settled = false;
      let indicatorEvent = null;

      const timeoutId = setTimeout(() => {
        finish(
          new Error(
            `[AssetManager] timed out after ${LOAD_TIMEOUT_MS}ms loading packs [${packIds.join(', ')}] ` +
              `for stage '${stage}' (${entryCount} files queued). Check that the files exist under public/assets/.`
          )
        );
      }, LOAD_TIMEOUT_MS);

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (indicatorEvent) {
          indicatorEvent.remove();
          indicatorEvent = null;
        }
        loader.off('loaderror', onFileError);
        this._hideIndicator();
        if (err) reject(err);
        else resolve(failedKeys);
      };

      const onFileError = (file) => {
        if (file && typeof file.key === 'string') failedKeys.add(file.key);
      };

      loader.on('loaderror', onFileError);
      loader.once('complete', () => finish());
      indicatorEvent = scene.time.delayedCall(LOAD_INDICATOR_MS, () => {
        indicatorEvent = null;
        this._showIndicator(scene, `LOADING ${String(stage).toUpperCase()}`);
      });
      loader.start();
    });
  }

  /** @private */
  _showIndicator(scene, label) {
    if (!this._indicator || this._indicator._scene !== scene) {
      this._indicator = new LoadingIndicator(scene);
    }
    this._indicator.show(label);
  }

  /** @private */
  _hideIndicator() {
    if (this._indicator) this._indicator.hide();
  }
}

/** Shared singleton. */
export const assetManager = new AssetManager();
