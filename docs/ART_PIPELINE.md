# ART PIPELINE — The Citadel of Vesper (Wave 1)

> All artwork generated here is ORIGINAL, created for this project
> (docs/ARCHITECTURE.md §0 originality guardrail). No rips, no traces,
> no Castlevania-derived designs — every sprite is painted from scratch
> by `scripts/make_art.js`.

## What this is

`scripts/make_art.js` is a **procedural pixel-art stand-in** for hand-drawn
art. It paints every sprite with code — palette work, silhouette design,
dithering, rim lighting — and writes real PNGs into `assets/`. It is the
foundation Wave 5 will polish/replace with hand-drawn art; it is NOT the
final art pass. Be honest about that when showing it.

**Zero npm dependencies.** The script ships its own minimal PNG encoder
(RGBA8, filter-0 scanlines, zlib deflate via `node:zlib`) and a tiny PNG
decoder used only by the verification pass. Deterministic output: all
randomness is seeded (mulberry32), so re-runs are byte-identical.

## Regenerate

```sh
node scripts/make_art.js        # from the repo root
```

Runs in <2s. Writes ~52 PNGs + JSON frame indices, then self-verifies:
PNG magic + IHDR dimensions + per-file pixel stats (unique color count,
non-transparent coverage). Exits non-zero if any file fails.

## Extend

- **New animation for Lucien:** add a pose list to `LUCIEN_ANIMS`
  (pose params: `by/lean/stride/lift/phaseF/phaseB/armSwingF/armSwingB/
  swordA/swordLen/coatSway/coatLift/coatFlare/...`). `buildPlayer()`
  strips the frames automatically.
- **New enemy:** write a `function myEnemy(frame)` returning a `Px`
  (frame 0/1 for the 2-frame cycle), add a row to the `ENEMIES` table
  (`id` must match `data/enemies.json` when a data entry exists).
- **New tile:** add a `case` to `mgTile()` / `hkTile()` (keep the
  `*_TILE_NAMES` arrays in sync — index = tile id for maps).
- **New prop/item:** add a painter + a row in `buildProps()` / `buildItems()`.
- **New region backdrop:** add far/near painters + rows in `buildParallax()`.

## Palette

Moonlit Gate — moonlit blues/silvers:

| use | hex |
|---|---|
| night sky | `#070b14` `#0c1322` `#16233f` `#22345a` |
| stone | `#232a3e` `#39445e` `#525f82` `#8b98b8` |
| moon / silver | `#f2eedd` `#c7d2e8` |
| banner blue / moss | `#1d2a52` `#3d5a44` |

Hollow Keep — deep purples / ashen grays / ember oranges:

| use | hex |
|---|---|
| keep sky | `#0d0812` `#160e1e` `#241631` `#3a2347` |
| basalt | `#14101b` `#221a2c` `#352844` `#5b4c6e` |
| iron / rust | `#43434e` `#7d7d8f` `#8a4a2a` |
| ember / ash | `#ff7a2a` `#ffc46b` `#9a938c` `#57524b` |
| wood | `#4a3220` `#2c1e12` `#6e4c2e` |

Lucien Vale — disgraced knight-explorer:

| use | hex |
|---|---|
| greatcoat | `#252b40` `#141828` `#3d4563`, moon rim `#a9bce4` |
| lining | `#6e2a35` |
| silver-white hair | `#e6ebf7` `#a7b2cb` |
| skin / boots / blade | `#d9b48f` `#221a10` `#d7deee` |
| lantern-pendant | `#ffbe5a` glow `#ff9a3a` |

## File inventory (generated)

Frame contract follows `src/config/assets.js` + `assets/README.md`:
characters/enemies are 64×64 frames (art authored smaller, centered
bottom), icons are 32×32, tiles 16×16, parallax/title 480×270.

**Player** (`assets/player/`, side view, faces right — Lucien Vale,
disgraced knight-explorer: high-collared dark greatcoat, silver-white
swept-back hair, lantern-pendant, arming sword):
`lucien_idle` 2f · `lucien_walk` 4f · `lucien_run` 4f · `lucien_jump` 2f ·
`lucien_fall` 1f · `lucien_land` 1f · `lucien_turn` 2f · `lucien_crouch` 1f ·
`lucien_dash` 2f · `lucien_attack_sword` 3f (sword sweep + slash arc) ·
`lucien_hurt` 1f · `lucien_die` 3f (stagger → kneel → prone).
`player/lucien.json`: frame index (file, frameWidth/Height, frames, fps).

**Enemies** (`assets/enemies/`, `<id>_<anim>.png` 2-frame strips,
`enemies/enemies.json` index):

| file | design | data id? |
|---|---|---|
| `ash_hound_idle/run/attack` | ashen quadruped, ember flank-cracks; attack = lunging jaw | ✅ `ash_hound` |
| `rustbound_revenant_idle/walk/attack` | rusted plate soldier, heater shield; attack = overhead cleave | ✅ `rustbound_revenant` |
| `cinder_wisp_idle` | floating ember-spirit, flicker | provisional |
| `hollow_sentinel_idle` | headless animated armor, violet hollow | provisional |
| `vesper_chimer_idle` | bronze bell construct, swinging | provisional |
| `mote_swarm_idle` | dust-mote cloud w/ ember eyes, drift | provisional |
| `vellum_phantom_idle` | tattered manuscript ghost | provisional |
| `cinder_mastiff_idle` | bulkier ember-maned hound, trot | provisional |

The six provisional ids are original names for the ENEMIES.md
vertical-slice concepts (wisp, animated armor, bell-ringer construct,
dust-mote swarm, archive spirit, keep hound variant). Wave 4 should adopt
or rename them when writing the `data/enemies.json` entries.
Bosses (`chapel_warden_*`, `sable_matriarch_*`) are NOT covered — Wave 5 /
boss art scope; their manifest entries remain `required: false`.

**Tilesets** (`assets/tilesets/`, 16×16 tiles, 8×4 sheets + JSON tile-name
→ index maps): `moonlit_gate_tiles.png` (32 tiles: brick variants,
platform top/edge/bottom, arch jambs + crown, moonlit chapel window,
pillar set, Pale Hour banner, steps, rubble, grass tuft, wall bracket,
flagstones, rose window), `hollow_keep_tiles.png` (32 tiles: basalt
variants, riveted iron plate, iron-trimmed platform set, wood beams,
broken arches, grate, chains, carved rune slab, tattered banner, ash
pile, bones, ember sconce, basalt floors, collapsed pillar).

**Props** (`assets/environments/props/` + `props.json`): `candle.png` 2f,
`urn.png`, `chandelier.png`, `brazier.png` 2f, `door.png` 2f
(closed/open), `crate.png`, `barrel.png`, `signpost.png`,
`teleport_dais.png` 2f (rune pulse).

**Pickups** (`assets/items/`, 32×32 + `items.json`): `coin.png` 2f (spin),
`heart.png`, `mana_shard.png`, `key.png`, `ember_tonic.png`,
`vesper_draught.png` (flasks) — plus original icons for every other data
`icon` field: `wayfarer_coat`, `dusk_hood`, `moonstone_charm`,
`iron_signet`, `moonrise_leap`, `gale_dash`, `cinder_wave`,
`mending_pulse`.

**Weapons** (`assets/weapons/`, 32×32 + `weapons.json`): `recruit_blade.png`,
`moonsteel_sabre.png` (match `icon` fields in `data/weapons.json`).

**Parallax** (`assets/environments/bg_<region>_<far|near>.png`, 480×270 +
`parallax.json`): moonlit gate (veiled moon, citadel silhouette w/ lit
windows, gatehouse + chapel + bare trees, fog bands), hollow keep (ember
horizon, jagged ruined towers, fallen dome, hanging chains, dust shafts).
Near layers are transparent in the sky region for compositing.

**Title** (`assets/environments/bg_title.png` 480×270 + `title/title.json`):
citadel silhouette under a veiled moon, ruined foreground framing,
vignette. `assets/ui/logo_vesper.png`: original emblem mark (crescent +
keep tower; no wordmark — typography is Wave 5's call).

**Effects** (`assets/effects/` + `effects.json`): `fx_hit_spark.png`,
`fx_slash_arc.png`, `fx_dust_puff.png`.

**UI** (`assets/ui/` + `ui.json`): 9-slice gothic panel
(`panel_corner_*`/`edge_h`/`edge_v`/`center`, dark stone + silver trim),
`button_normal/hover/pressed` (64×20), `cursor.png` (12×12).

## Naming contract (for `src/config/assets.js`)

`<entity>_<variant>.png`, lowercase + underscores. Horizontal strips,
one animation per file; companion `*.json` gives
`{ file, frameWidth, frameHeight, frames, fps }`. Tileset JSONs map
tile names → sheet index. See `assets/README.md` for the directory map.

## Quality limits (honest)

- Procedural, not hand-drawn: silhouettes and motion are parametric.
  Small sprites (wisps, motes) read well; Lucien's walk cycle is
  serviceable but not beautiful — Wave 5 should redraw him first.
- No anti-aliasing beyond dithering; edges are hard (fits `pixelArt: true`).
- Parallax layers are painterly gradients + silhouettes — good enough for
  depth, not showcase pieces.
- Enemy roster: only 2 of 8 have data entries; the rest are art-first.
