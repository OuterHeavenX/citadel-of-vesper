# Asset Pipeline — staged loading & data access

> Wave 1 asset-pipeline contract. Implements `docs/ARCHITECTURE.md` §7
> (AssetManager) and §17 (data pipeline). If this doc disagrees with code,
> fix the code — this doc is the contract.

## 1. Overview

The game NEVER loads every asset upfront. Loading is staged:

```
boot → title → room:<region> → room:<region> → …
```

- **boot** — always-resident minimum: Lucien's spritesheets + shared combat
  FX (small payload, needed from the first GameScene frame).
- **title** — title screen art. Loaded by TitleScene (`title` + `ui` + `audio`
  packs, so the title theme can play immediately).
- **room:\<region\>** — region tiles, parallax, enemies, boss. Loaded on
  region entry; neighbor regions are pre-warmed in the background.

Content data (`data/*.json`) is NOT fetched at runtime — it is statically
imported by `DataManager` and bundled by Vite (works offline, no fetch
waterfall at boot).

## 2. Stages

`src/core/AssetManager.js` exports:

```js
import { Stages } from './core/AssetManager.js';
Stages.BOOT; // 'boot'
Stages.TITLE; // 'title'
Stages.ROOM('moonlit_gate'); // 'room:moonlit_gate'
```

## 3. Boot call sequence (for W1-CORE's BootScene)

Exact order — copy this into `BootScene.create()`:

```js
import { assetManager, Stages } from '../core/AssetManager.js';
import { dataManager } from '../core/DataManager.js';
import { AssetPacks } from '../config/assets.js';

async create() {
  try {
    // 1. Inject the pack manifest. core/ may import nothing except
    //    ./EventBus.js, so the manifest cannot be imported by AssetManager.
    assetManager.setPackManifest(AssetPacks);

    // 2. Touch the datasets — light validation throws on malformed data.
    dataManager.getData('progression');

    // 3. Load the boot stage (player sheets + shared FX).
    const boot = await assetManager.loadStage(this, Stages.BOOT, ['boot']);
    if (!boot.ok) console.warn('[Boot] missing boot assets:', boot.missing);

    // 4. Init other singletons: inputManager.init(this),
    //    audioManager.init(this), await saveManager.open(), ...

    // 5. Hand off.
    this.scene.start('Title');
  } catch (err) {
    // REQUIRED asset missing, or data malformed → friendly error screen.
    // Reuse the #boot-error surface from index.html (see main.js showBootError).
    console.error('[Boot] fatal:', err);
    const el = document.getElementById('boot-error');
    if (el) {
      el.style.display = 'block';
      const detail = el.querySelector('#boot-error-detail');
      if (detail) detail.textContent = String(err && err.message ? err.message : err);
    }
  }
}
```

TitleScene:

```js
async create() {
  const res = await assetManager.loadStage(this, Stages.TITLE, ['title', 'ui', 'audio']);
  // Build the screen with assetManager.getTexture(this, 'logo_vesper') etc.
  if (!res.ok) console.warn('[Title] missing assets, using fallbacks:', res.missing);
}
```

GameScene / RoomManager — wire once (e.g. `GameScene.create()`), then per room:

```js
// once:
assetManager.setRoomGraphProvider(
  (roomId) => dataManager.getRoom(roomId)?.exits.map((e) => e.target) ?? []
);
assetManager.setRoomRegionResolver(
  (roomId) => dataManager.getRoom(roomId)?.region ?? null
);

// on room entry (RoomManager.loadRoom):
const region = dataManager.getRoom(roomId).region;
const res = await assetManager.loadStage(this, Stages.ROOM(region), [`room_${region}`]);
// NOTE: room transitions must stay ≤300ms (ARCHITECTURE.md §8) — packs are
// small and usually already cached; never block a transition on a cold
// multi-MB download. If !res.ok, build the room with getTexture() fallbacks.
assetManager.preloadAdjacent(this, roomId); // fire-and-forget, never awaited
```

## 4. Pack manifest format (`src/config/assets.js`)

```js
{
  key: 'lucien_idle',                 // Phaser cache key
  type: 'image'|'spritesheet'|'atlas'|'audio'|'json',
  url: 'assets/player/lucien_idle.png', // repo-relative, under assets/
  required: false,                   // default TRUE; false => optional
  // spritesheet: frameWidth, frameHeight (+ margin, spacing)
  // atlas:       atlasURL  (the .json sidecar; url = texture png)
  // audio:       urls: ['x.webm', 'x.mp3'] (fallback chain)
}
```

Six packs: `boot`, `title`, `room_moonlit_gate`, `room_hollow_keep`,
`ui`, `audio`. Stages reference pack names, never file lists.

Key naming (must match game code 1:1):
- `lucien_<anim>` — player (ARCHITECTURE.md §10 animation keys)
- `<enemyId>_<anim>` / `<bossId>_<anim>` — enemies/bosses
- `tiles_<region>`, `bg_<region>_<layer>` — tiles + parallax
- `<icon>` — item/ability icons, matching `data/*.json` `icon` fields
- `<trackId>` — music, matching `data` `music` fields (so
  `AudioManager.playMusic(id)` maps directly to cache keys)
- `<sfxId>` — sfx, matching `data` `soundId`/`sound` fields

## 5. URL resolution

Manifest `url`s are repo-relative paths under `assets/`. `AssetManager`
resolves them against `import.meta.env.BASE_URL`:

| env | manifest url | resolved |
|---|---|---|
| `vite dev` | `assets/player/lucien_idle.png` | `/assets/player/lucien_idle.png` |
| `vite build` (Pages) | same | `/citadel-of-vesper/assets/player/lucien_idle.png` |

Game-ready runtime files live in **`public/assets/`** (Vite serves/copies
them automatically). Authoring sources (Aseprite files, layered originals,
composition notes) live in **`assets/`**. Both trees use identical relative
paths. Full naming contract: `assets/README.md`.

## 6. LoadingIndicator

`loadStage()` shows a `LoadingIndicator` overlay (dark veil + "LOADING …" +
animated gold bar, depth 10000, `setScrollFactor(0)`) **only if the load
exceeds 400 ms** (`LOAD_INDICATOR_MS`). Fast loads never flash it.
A 30 s hard timeout (`LOAD_TIMEOUT_MS`) rejects instead of hanging boot.

## 7. Missing assets (§59 crash protection)

- **Optional** (`required: false`): `loadStage()` resolves
  `{ ok: false, missing: ['key', ...] }`. The caller substitutes fallbacks —
  for textures, `assetManager.getTexture(scene, key)` returns the key when
  present, otherwise a generated magenta/black `__vesper_missing` texture.
  `assetManager.has(key)` reports manager-side load state.
- **Required** (default): `loadStage()` **rejects** with
  `[AssetManager] REQUIRED asset(s) failed to load for stage '<stage>': <keys>`.
  BootScene/TitleScene catch this and show the friendly error screen (§3).
  Never let a rejection become an unhandled promise.

While art/audio is pending (Waves 1–4) every manifest entry is
`required: false`, so the game boots on fallbacks. **Wave 5 art pass: flip
`required` to `true` as each file lands in `public/assets/`.**

## 8. preloadAdjacent

Called by RoomManager on room entry. Reads neighbor room ids through the
injected `roomGraphProvider`, maps them to regions through the injected
`roomRegionResolver`, and loads each neighbor's `room_<region>` pack that
isn't loaded yet. It is **fire-and-forget** (returns once preloads are
queued) and **never throws** — preload failures only `console.warn`.

Pack ids are derived as `` `room_${region}` `` — the same names used in
`src/config/assets.js`. Regions without a pack are skipped silently.

## 9. DataManager (`src/core/DataManager.js`)

```js
import { dataManager, DATASET_NAMES } from './core/DataManager.js';

dataManager.getData('weapons');      // bundled JSON array (read-only!)
dataManager.getData('progression');  // bundled JSON object
dataManager.getRoom('moonlit_gate_001'); // room object or null
```

- Datasets: `weapons armor accessories consumables enemies bosses
  abilities rooms progression`.
- Light validation on first access per dataset (array + non-empty + string
  `id`s; progression needs `levelCap`/`statGrowth`/`xpCurve`). Full schema
  validation stays in `scripts/validate.js` (`npm run validate`, CI gate).
- Returned objects are **read-only** — never mutate; mutable state lives in
  GameState.
- Dependency note: DataManager statically imports the JSON datasets. JSON
  imports are inlined data, not code dependencies — this keeps the
  `core/` rule intact in spirit (no runtime imports of game modules) while
  letting Vite bundle content for offline play.

## 10. Art naming contract

Defined in `assets/README.md` (the art agent's build target):
`<entity>_<variant>.png`, lowercase + underscores; characters 64×64
single-row PNG sheets; enemies 64×64; bosses 128×128; tilesets 16×16;
parallax 480×270; icons 32×32; music/SFX as `.webm` + `.mp3` pairs.

## 11. Wave-5 checklist (art pass)

1. Export game-ready files to `public/assets/<path>` per `assets/README.md`.
2. In `src/config/assets.js`, flip each landed entry `required: false` →
   `true` (delete the `...OPT` spread on that entry).
3. Run `npm run build`; confirm no `optional asset missing` warnings for
   the flipped entries.
4. New enemies/bosses: append `<id>_<anim>` sheets to the region pack.
5. New UI chrome: append keys to the `ui` pack; new tracks/SFX to `audio`.
