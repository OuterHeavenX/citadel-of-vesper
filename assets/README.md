# assets/ — art + audio pipeline

> All artwork and audio in this project is ORIGINAL, created for
> The Citadel of Vesper (see docs/ARCHITECTURE.md §0 originality guardrail).
> No rips, no traces, no copyrighted material — ever.

## Two trees: authoring vs runtime

| Tree | Purpose |
|---|---|
| `assets/` (this dir) | **Authoring sources** — Aseprite/PNG originals, layered files, composition notes, `scripts/make_art.js` outputs staged here. NOT served to the browser. |
| `public/assets/` | **Game-ready runtime files** — what Phaser actually loads. Vite serves these in dev and copies them to `dist/assets/` on build. |

Both trees use **identical relative paths**: the runtime file for manifest
key `lucien_idle` is `public/assets/player/lucien_idle.png`, authored from
`assets/player/lucien_idle.*`. The manifest (`src/config/assets.js`) lists
urls as `assets/<path>` and `AssetManager` resolves them against the app
base path — see `docs/ASSET_PIPELINE.md` §5.

**`scripts/make_art.js` (art pipeline, Wave 5) MUST write its game-ready
exports to `public/assets/<path>` using the layout below.** Sources stay
in `assets/`.

## Directory layout

- `player/` — Lucien Vale sprite sheets. Keys: `lucien_*`.
- `enemies/` — per-enemy sheets, named by enemy id (`ash_hound_*`).
- `bosses/` — per-boss sheets, named by boss id (`chapel_warden_*`).
- `environments/` — parallax layers (`bg_<region>_<layer>.png`), title art.
- `tilesets/` — tileset PNGs (`<region>_tiles.png`). Per-room tilemap JSON is
  loaded per-room by RoomManager (Wave 3), not via asset packs.
- `weapons/` — weapon icons (match `icon` fields in `data/weapons.json`).
- `items/` — armor/accessory/consumable/ability icons (match `icon` fields
  in `data/armor.json`, `data/accessories.json`, `data/consumables.json`,
  `data/abilities.json`).
- `effects/` — hit sparks, slash arcs, dust, damage-number font.
- `ui/` — gothic UI chrome (original design) + game logo.
- `fonts/` — pixel fonts (licensed for game use; record license here).
- `music/` — original compositions or CC0 (attribution in
  `src/audio/index.js`).
- `sfx/` — synthesized or original recordings.

## Naming contract (art agent: follow exactly)

File names: `<entity>_<variant>.png`, **lowercase + underscores only**.
The manifest key is the file's base name — `assets/player/lucien_idle.png`
is loaded as key `lucien_idle`. Keep key, file name, and data `icon` /
`sprite` / `soundId` / `music` fields in sync.

### Spritesheets (characters, enemies, bosses)

- **One PNG per animation**, frames in a **single horizontal row**,
  left-to-right, no padding between frames.
- Frame size: **64×64 px** for Lucien and humanoid enemies;
  **128×128 px** for bosses. (Declared per entry as `frameWidth` /
  `frameHeight` in `src/config/assets.js` — update the manifest if a
  sprite needs a different size.)
- Animation name = file suffix, matching the manifest key suffix:
  `lucien_idle`, `lucien_walk`, `lucien_run`, `lucien_crouch`,
  `lucien_jump`, `lucien_fall`, `lucien_land`, `lucien_turn`,
  `lucien_dash`, `lucien_attack_<family>`, `lucien_hurt`, `lucien_die`;
  enemies `<id>_idle|_walk|_run|_attack|_die`;
  bosses `<id>_idle|_attack|_die`.
- PNG-32 RGBA, author at 1×, nearest-neighbor. No embedded color profile.

### Tilesets

- `<region>_tiles.png`, tiles **16×16 px**, manifest key `tiles_<region>`
  (e.g. `assets/tilesets/moonlit_gate_tiles.png` → `tiles_moonlit_gate`).

### Parallax backgrounds

- `bg_<region>_far.png`, `bg_<region>_near.png` (+ `bg_title.png`),
  **480×270 px** (internal resolution), manifest keys `bg_<region>_<layer>`.

### Icons

- **32×32 px** PNG. Weapon icons → `weapons/<icon>.png`;
  everything else → `items/<icon>.png`. Key = the `icon` field in data,
  e.g. `moonsteel_sabre`, `ember_tonic`, `moonrise_leap`.

### Effects / UI / fonts

- `effects/<name>.png` (e.g. `fx_hit_spark.png`), sized to the effect.
- `ui/<name>.png` — chrome pieces + `logo_vesper.png` (keep the logo
  ≤ 320 px wide; it renders on the 480×270 title screen).
- `fonts/<name>.png` (+ `.fnt`/`.json` sidecar for bitmap fonts).

### Audio

- **Pairs**: `music/<track>.webm` + `music/<track>.mp3`;
  `sfx/<id>.webm` + `sfx/<id>.mp3`. Phaser plays the first supported
  format. Manifest key = track/sfx id (`moonlit_gate`, `swing_sword`).
- Track ids must match `data/*.json` `music` fields; sfx ids must match
  `soundId` / `sound` fields. Ambience beds use the `amb_<name>` prefix.

## Pipeline

1. Author at 1× in the project's palette; export PNG (pairs for audio).
2. Write game-ready files to `public/assets/<path>` (keep sources here).
3. Register/verify the entry in `src/config/assets.js` packs
   (`boot`, `title`, `room_<region>`, `ui`, `audio`) — key, type, url,
   frame size.
4. **Flip `required: false` → `true`** for each landed file (until then the
   game boots on generated fallbacks — see `docs/ASSET_PIPELINE.md` §7).
5. Staged loading via AssetManager — never bundle everything upfront.

## Placeholder policy (Waves 1–4)

Wave 1 art has landed (see "Wave 1 art drop" below); entries not yet
covered keep `required: false` and the game runs on generated fallbacks
(`AssetManager.getTexture()` magenta/black checker) for those.

## Wave 1 art drop (2026-09-23, W1-ART)

Generated by `scripts/make_art.js` (deterministic, zero dependencies;
re-run with `node scripts/make_art.js`). All original art per the §0
guardrail. Pipeline, palette, and extend instructions:
`docs/ART_PIPELINE.md`.

Landed (71 PNGs, all manifest URLs below exist on disk):
- `player/lucien_*.png` — all 12 boot-pack Lucien anims, 64×64 frames
  (art authored ~32×48, centered bottom).
- `enemies/<id>_<anim>.png` — ash_hound (idle/run/attack),
  rustbound_revenant (idle/walk/attack), + 6 provisional Hollow Keep
  designs (`*_idle`). Boss sheets are NOT covered (Wave 5 scope).
- `tilesets/moonlit_gate_tiles.png`, `tilesets/hollow_keep_tiles.png`
  (32 tiles each, 16×16) + tile-name JSON sidecars.
- `environments/bg_moonlit_gate_far/near.png`,
  `bg_hollow_keep_far/near.png`, `bg_title.png` (480×270).
- `environments/props/*.png` — candle, urn, chandelier, brazier, door,
  crate, barrel, signpost, teleport_dais.
- `items/*.png` — all 14 data `icon` fields covered (32×32).
- `weapons/recruit_blade.png`, `weapons/moonsteel_sabre.png` (32×32).
- `effects/fx_hit_spark.png`, `fx_slash_arc.png`, `fx_dust_puff.png`.
- `ui/` — 9-slice panel set, 3 button states, cursor, `logo_vesper.png`
  (emblem mark; UI chrome keys not yet in `src/config/assets.js` —
  Wave 5 appends them).

JSON sidecars (`lucien.json`, `enemies.json`, `*_tiles.json`,
`parallax.json`, `props.json`, `items.json`, `weapons.json`,
`effects.json`, `ui.json`, `title.json`) sit next to the PNGs with
frame sizes / tile maps for the manifest author.
