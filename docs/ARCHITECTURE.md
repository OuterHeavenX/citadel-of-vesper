# ARCHITECTURE — The Citadel of Vesper

> **Wave 0 contract document.** Every wave agent reads this before writing code.
> If two modules disagree, THIS document wins. If this document is wrong, fix
> the document first, then the code — never silently invent a parallel API.

**Stack:** Phaser 3.80 + Vite 5 + ES modules. Internal resolution 480×270,
scaled to viewport (`pixelArt: true`, integer-friendly). Target 60 FPS.

**Working title:** THE CITADEL OF VESPER · **Version:** v0.1.0 ALPHA
**Live URL (after Jimmy creates the repo + Pages):** https://outerheavenx.github.io/citadel-of-vesper/

---

## 0. Originality guardrail (non-negotiable)

This is an ORIGINAL game. It is inspired by the *design philosophy* of classic
32-bit gothic action-RPGs, never by their copyrighted content.

**Forbidden to copy from Castlevania or any commercial game:**
characters, character designs, sprites, animations, maps, room layouts,
dialogue, storylines, music, sound effects, logos, bosses, enemies, item
names, UI graphics, backgrounds, proprietary artwork.

**Rules for every wave:**
- All names are invented here (protagonist: **Lucien Vale**; regions:
  Moonlit Gate, Hollow Keep, …). When in doubt, invent — never borrow.
- All art is drawn/modelled for this project (Wave 5). No rips, no traces.
- All music is composed for this project or CC0 with attribution in
  `src/audio/index.js`. Never copyrighted Castlevania music.
- All dialogue, lore, and item descriptions are written fresh.
- Enemy/boss *archetypes* (skeleton, gargoyle, knight) are generic folklore —
  their designs, names, behaviors, and patterns must still be original.

---

## 1. Module map

```
src/
  main.js            boot: Phaser.Game, error surface, tab auto-pause
  config/          gameConfig.js · tuning.js (ALL feel numbers) · assets.js (packs)
  core/            EventBus · GameState · SaveManager · InputManager ·
                   AudioManager · AssetManager   (singletons, no game deps)
  player/          Player (facade) · PlayerMovement · PlayerCombat ·
                   PlayerStats · PlayerAnimation
  combat/          DamageSystem · HitboxSystem · ProjectileSystem · StatusEffects
  enemies/         Enemy (base) · EnemyFactory (registry)
  bosses/          Boss (base)
  weapons/         WeaponData (data access + compare)
  items/           ItemData (unified registry)
  abilities/       AbilityManager (traversal + spells)
  npcs/            Npc · Merchant
  world/           WorldGraph (validation: validateWorld/findPath/reachableFrom)
  rooms/           RoomManager (streaming + transitions) · Room (runtime)
  props/           Breakable · Pickup (candle/urn/crate/chandelier; coin/heart/mana/key)
  map/             MapModel (completion %, nodes)
  ui/              screens (title→credits), pause coordination, touch overlay
  scenes/          Boot · Title · Game · UI (keys in scenes/index.js)
  effects/         pooled juice, listens to 'combat:hitLanded'
  audio/           MusicTracks + AmbienceBeds registries (playback via AudioManager)
  utils/           math · format · Pool (pure, no Phaser)
  debug/           DebugOverlay, DEBUG_TOGGLE_KEY = Backquote, dev-only
data/              *.json content + schemas/*.schema.json (validated in CI)
```

**Dependency rules:**
- `core/` imports NOTHING except `./EventBus.js`. No exceptions.
- Gameplay modules may import `core/`, `config/`, `utils/`, `data` loaders.
- `player/`, `enemies/`, `bosses/` talk to each other ONLY through
  `combat/` (DamageSystem/HitboxSystem) and `eventBus` — never directly.
- Scenes compose modules; modules never import scenes.
- UI reads `GameState`/`MapModel`/data registries; it never mutates gameplay
  except through documented APIs (`gameState.equip()`, `merchant.buy()`, …).

---

## 2. EventBus — the nervous system

`src/core/EventBus.js` exports `eventBus` (singleton), `EventBus` (class),
and the frozen `Events` catalog.

- Names are `<domain>:<pastTenseVerb>`: `player:damaged`, `enemy:died`,
  `room:changed`, `game:saved`, …
- Payloads are plain objects with the documented shape. No positional args.
- Emitted on state transitions only — never per-frame.
- Handlers must not throw the bus: a throwing handler is logged, others run.
- **To add an event:** add it to the `Events` catalog AND document it here.

Full catalog (payload shapes) — see `Events` in `src/core/EventBus.js`:

| Event | Payload |
|---|---|
| `game:booted` | `{ version }` |
| `game:autoPause` / `game:resumed` | `{ reason }` |
| `game:saved` | `{ slot, playTime }` |
| `game:error` | `{ message }` |
| `player:damaged` | `{ amount, source, hp, maxHp }` |
| `player:healed` | `{ amount, hp, maxHp }` |
| `player:died` | `{ roomId }` |
| `player:leveledUp` | `{ level, stats }` |
| `player:xpGained` | `{ amount, total }` |
| `player:abilityUnlocked` | `{ abilityId }` |
| `combat:hitLanded` | `{ attacker, target, amount, critical }` |
| `enemy:died` | `{ enemyId, instanceId, roomId, drops }` |
| `enemy:damaged` | `{ instanceId, amount, hp }` |
| `boss:encounterStarted` | `{ bossId, roomId }` |
| `boss:phaseChanged` | `{ bossId, phase }` |
| `boss:died` | `{ bossId, roomId, reward }` |
| `room:changed` | `{ from, to, via }` |
| `room:secretFound` | `{ roomId, secretId }` |
| `room:checkpointTouched` | `{ roomId, checkpointId }` |
| `item:pickedUp` / `item:equipped` / `item:unequipped` | `{ itemId, quantity? }` / `{ itemId, slot }` / `{ slot }` |
| `inventory:changed` | `{}` |
| `map:roomDiscovered` | `{ roomId, region, completion }` |
| `flag:set` | `{ flag, value }` |
| `quest:updated` | `{ questId, stage }` |
| `npc:dialogueOpened` | `{ npcId }` |
| `save:rested` | `{ roomId }` |
| `teleport:discovered` / `teleport:used` | `{ chamberId }` / `{ from, to }` |
| `input:deviceChanged` | `{ device }` |
| `audio:musicChanged` | `{ trackId, region }` |
| `ui:opened` / `ui:closed` | `{ screen }` |
| `debug:command` | `{ command, args }` |

---

## 3. GameState — single source of truth

`src/core/GameState.js` exports `gameState` (singleton), `createInitialState()`,
`SAVE_SCHEMA_VERSION` (currently `3`).

- Plain serializable data ONLY — no Phaser objects, no class instances, no
  functions. This is exactly what gets written to IndexedDB.
- Sections: `meta` (playTime, difficulty), `player` (level/xp/hp/mp/stats/
  position/abilities/spells), `inventory[]`, `equipment{}` (6 fixed slots),
  `currency`, `map{discovered[], completion}`, `flags{}`, `bossStates{}`,
  `chestStates{}`, `checkpoints{}`, `teleports[]`, `quests{}`, `bestiary{}`,
  `merchantStock{}` (finite merchant stock), `buffs[]` (active timed buffs),
  `settings{}`.
- Derived stats are COMPUTED by `PlayerStats` — never stored.
- Mutations go through methods (`addItem`, `equip`, `setFlag`, `discoverRoom`,
  …) which set `dirty = true` and emit the matching event.
- `toJSON()` returns a deep clone for `SaveManager.write()`; `hydrate()`
  replaces state on load.

## 4. SaveManager — IndexedDB persistence

`src/core/SaveManager.js` exports `saveManager` (singleton).

- DB `vesper-saves`, v1. Stores: `saves` (keyPath `slot`, slots 1–3),
  `settings` (keyPath `key`). **Never localStorage for saves.**
- Save object = `GameState.toJSON()` + `{ schemaVersion, slot, savedAt }`.
- `migrate(save)` is pure and upgrades any older schema to current — wave
  agents adding fields MUST add a migration step.
- Export format: `{ format:'vesper-save', game:'citadel-of-vesper',
  version, exportedAt, payload }` → downloadable JSON file; import validates
  before writing to a slot.
- `write()` resolves `{ ok, error? }` — gameplay never breaks on save failure.
  See `docs/SAVE_SYSTEM.md` for the full contract.

## 5. InputManager — actions, not buttons

`src/core/InputManager.js` exports `inputManager` (singleton), `Actions`,
`Devices`, `DEFAULT_KEYBOARD_BINDINGS`, `DEFAULT_GAMEPAD_BINDINGS`.

- Game code reads **actions** (`jump`, `attack`, `dash`, `map`, …) via
  `isDown / justPressed / justReleased / axis('move_x'|'move_y')`.
  Raw keys/pads/touch are NEVER read outside this module.
- Keyboard defaults: WASD/arrows move, `Space` jump, `J` attack, `K`
  secondary, `L`/`Shift` dash, `Esc` pause, `Tab` map. Full table:
  `docs/CONTROLS.md`.
- Gamepad: standard mapping, Xbox-style default (A jump, X attack, Y
  secondary, B dash, LB/RB abilities, View map, Menu inventory).
- Device detection: last-used device tracked; `input:deviceChanged` emitted;
  UI picks prompt glyphs via `getPrompt(action)`. Devices: `keyboard`,
  `gamepad-xbox`, `gamepad-playstation`, `steamdeck`, `touch`.
- Touch overlay drives the SAME actions via `setTouchAction()` — no separate
  gameplay code paths for touch.

## 6. AudioManager — channels and crossfades

`src/core/AudioManager.js` exports `audioManager` (singleton), `Channels`.

- Channels: `music, ambience, player, enemies, weapons, environment, ui` —
  independent sliders in Settings, persisted via SaveManager.
- `playMusic(trackId, { fadeOut, fadeIn })` crossfades region/boss themes and
  emits `audio:musicChanged`. `setAmbience(id)` for looped beds.
- `playSfx(id, { channel, volume, rate, x, y })` — positional optional.
- AudioContext unlocks on first user gesture; earlier calls queue.
- Track registries live in `src/audio/index.js` (`MusicTracks`,
  `AmbienceBeds`) — this module does playback only.

## 7. AssetManager — staged loading

`src/core/AssetManager.js` exports `assetManager` (singleton), `Stages`.

- Stages: `boot → title → room:<region>`. Never load everything upfront.
- `loadStage(scene, stage, packIds)`; shows `LoadingIndicator` if > 400 ms.
- `preloadAdjacent(scene, roomId)` warms neighbor rooms' packs (called by
  RoomManager on entry).
- Missing OPTIONAL assets resolve `{ ok:false, missing:[...] }` → caller
  substitutes a fallback. Missing REQUIRED assets reject with a clear
  message → friendly error screen. (Crash protection, spec §59.)
- Pack manifests: `src/config/assets.js` (`AssetPacks`).

---

## 8. Rooms — data, streaming, transitions

Room JSON format: `docs/ROOM_FORMAT.md` + `data/schemas/room.schema.json`.

- `RoomManager.loadRoom(roomId, spawnHint?)` — tears down the old room
  (enemies, projectiles, particles, bodies), builds the new one, places the
  player. Only the CURRENT room is live (spec §10).
- **Transition protocol** (`transitionThrough(exit)`):
  1. Player crosses an exit trigger.
  2. Camera locks; fade/slide ≤ 300 ms; player keeps momentum.
  3. New room goes live → `room:changed { from, to, via }` emitted.
  4. `gameState.discoverRoom(to)` fires once per newly discovered room.
  5. No full loading screens between normal rooms.
- Exits carry the DESTINATION spawn: `{ target, spawn:{x,y,facing?} }`.
- `requires: ["ability_id"]` gates exits behind traversal abilities.
- `saveRoom: true` → rest sequence (`save:rested`); `teleport: true` →
  registers on first entry (`teleport:discovered`); `hidden: true` → secret
  rooms stay off the map until found.
- World validation (`src/world/WorldGraph.js` + `scripts/validate.js`):
  exit targets exist, BFS reachability from `moonlit_gate_001`, unique map
  cells, cross-reference checks. CI fails on errors.

---

## 9. Combat contracts

**DamageSystem** (`src/combat/DamageSystem.js`) — the ONLY damage path:
```js
DamageSystem.applyDamage(source, target, {
  amount,                       // raw, pre-mitigation
  type,                         // physical|fire|ice|lightning|shadow|holy
  knockback: {x, y}, critical, hitStun, canCrit, ignoreIframes,
});
// -> { dealt, killed, critical }
```
- `source = { id, kind: 'player'|'enemy'|'boss'|'environment' }`.
- `target` implements `takeDamage(amount, info)`, `getDefense(type)`,
  `isInvulnerable()`. The system never reaches into internals.
- Emits `combat:hitLanded` (+ `player:damaged` / `enemy:damaged`).

**HitboxSystem** — `spawnHitbox(owner, spec)` with
`{ w,h,offsetX,offsetY, duration, activeFrom, activeTo, damage, hitOnce }`.
Damage ONLY during active frames. `(hitboxId, targetId)` hits once per
attack. `registerHurtbox(entity, box)`. `drawDebug(graphics)` for dev
visualization (spec §16).

**ProjectileSystem** — pooled: `prewarm(n)`, `fire(spec)`, `update(dt)`,
`clear()`. Off-screen projectiles skip collision (spec §56).

**StatusEffects** — `statusEffects.apply/remove/has(target, effectId, opts)`,
central `update(dt)`. Definitions in `data/abilities.json`. DoTs route
through DamageSystem with `ignoreIframes: true`.

**Feedback** (`src/effects/`) listens to `combat:hitLanded` — combat code
never calls effects directly. Budgets: ≤400 particles, ≤24 damage numbers,
hit pause ≤ 90 ms. Respects `screenShake` / `damageNumbers` settings.

---

## 10. Player contracts

`src/player/Player.js` is the facade — scenes touch ONLY this.

- **PlayerMovement** — states `idle|walk|run|crouch|jump|fall|land|turn|
  dash|hitstun|dead`; reads every constant from `src/config/tuning.js`
  (acceleration, maxSpeed, jumpVelocity, gravity, coyoteTime, jumpBuffer,
  dashSpeed, …). Variable jump height, coyote time, jump buffering,
  backdash, drop-through platforms, knockback takeover. **No magic numbers
  in player code — the game-feel pass tunes `tuning.js`, not logic.**
- **PlayerCombat** — data-driven attacks from `data/weapons.json`
  `attackProfile` (animation, reach, recovery, attack speed, knockback,
  sound, effect, hitbox, specials). Attack buffering from
  `tuning.combat.attackBuffer`. `takeDamage()` is called ONLY by
  DamageSystem; applies i-frames (`tuning.combat.iframesAfterHit`).
- **PlayerStats** — base stats from GameState + `data/progression.json`
  growth; equipment bonuses from data; `recalc()` computes DERIVED stats
  (`physicalAttack, magicAttack, defense, magicDefense, critChance,
  attackSpeed, moveSpeed, resistances{}`) — never stored. `gainXp()` emits
  `player:xpGained` / `player:leveledUp`.
- **PlayerAnimation** — owns keys `lucien_idle|walk|run|crouch|jump|fall|
  land|turn|dash|attack_<family>|hurt|die`; driven by movement/combat state,
  never by input directly.

---

## 11. Enemies, bosses, AI

- **Enemy** base (`src/enemies/Enemy.js`): data-driven from
  `data/enemies.json`. AI states `idle|patrol|pursue|attack|stagger|dead`;
  behavior flags enable `retreat|leap|dodge|block|teleport|fly|crawl|ambush|
  cast|summon|charge`. **Every attack telegraphed** (`telegraphs` in data:
  windup/flash/sound). Damage only via DamageSystem. Sleeping: `update()`
  early-outs off-camera. Death → `enemy:died { enemyId, instanceId, roomId,
  drops }`, drop rolls, bestiary update.
- **EnemyFactory** — `create(enemyId, scene, x, y, instanceId)`; subclass
  registry; unknown ids throw a clear error.
- **Boss** base (`src/bosses/Boss.js`): data from `data/bosses.json`.
  Lifecycle: entrance (camera lock + name banner) → phases at HP thresholds
  → death animation → reward → `boss:died`. Emits `boss:encounterStarted` /
  `boss:phaseChanged`. Exits lock during fights. `getHp()/getMaxHp()/
  getPhase()` feed the boss bar UI.
- Vertical slice: 8 enemies, 1 miniboss (Chapel Warden), 1 major boss
  (Sable Matriarch) — see `data/enemies.json`, `data/bosses.json`.

---

## 12. Items, equipment, abilities

- **ItemData** (`src/items/ItemData.js`) — unified registry over
  `weapons.json`, `armor.json`, `accessories.json`, `consumables.json`.
  Categories: `weapon|armor|accessory|consumable|quest|relic|key|material`.
- Equipment slots (fixed): `weapon, offhand, head, body, accessory1,
  accessory2`. `gameState.equip(slot, itemId)` → `item:equipped` →
  `PlayerStats.recalc()`.
- **WeaponData.compare(candidateId, equippedId)** → `{ atkDelta,
  statDeltas, speedDelta, critDelta }` for the EQUIPPED-vs-candidate UI
  (spec §19 format).
- Weapon `specials` (spec §21): `{ trigger, effect }` — `hold_attack`,
  `down_attack`, `low_hp`, `accessory_combo`, `moonlit_room`, … Data lives
  in `weapons.json`; behavior in PlayerCombat/abilities.
- **AbilityManager** (`src/abilities/AbilityManager.js`) — one registry for
  traversal (`moonrise_leap`, `gale_dash`, …) and spells (`cinder_wave`,
  `mending_pulse`, …) from `data/abilities.json`. `unlock()` →
  `player:abilityUnlocked`; `cast()` does MP check → DamageSystem/
  ProjectileSystem. Exit `requires` reference traversal ids.

---

## 13. Map, NPCs, merchant

- **MapModel** (`src/map/MapModel.js`) — `getCompletion()` (% of
  non-secret rooms discovered), `getRoomNode(roomId)`, region completion.
  Secret rooms never render/count until discovered. Rendering is `src/ui`
  (MapScreen); the model is Phaser-free.
- **Npc** — data-driven dialogue trees; `interact()` opens dialogue UI;
  relocation resolved via GameState flags (`getLocation(npcId)`).
- **Merchant** — `getStock()` (base + progression/secret unlocks),
  `buy(itemId)` / `sell(itemId)` against `gameState.data.currency`;
  compare via `WeaponData.compare()`.

---

## 14. UI contract

Screens (`src/ui/index.js` → `UiScreens`): title, hud, pause, inventory
(STATUS|ITEMS|EQUIP|MAGIC|MAP|BESTIARY|SAVE|CONFIG tabs), map, dialogue,
shop, save, settings, controls, credits, touch.

- Controller-complete: focus navigation via `move_up/down`,
  `confirm/cancel`, `menu_tab_next/prev` actions.
- Pause coordination: opening a full screen pauses GameScene; closing
  resumes ONLY when no other screen is open (pause ref-count). Emits
  `ui:opened`/`ui:closed`.
- Responsive + safe-area aware; touch overlay hidden unless
  `device === 'touch'`.
- ORIGINAL gothic visual design. Version `v0.1.0 ALPHA` on the title screen
  (spec §61).

---

## 15. Scenes and boot

Scene keys: `Boot → Title → Game (+ UI overlay)`. `GameScene` is persistent —
RoomManager swaps room content inside it (no scene restart per room).
Scenes communicate via `eventBus`, never direct references.
`main.js`: Phaser.Game, friendly error surface, `game:autoPause` on
`visibilitychange` (tab-hide auto-pause, spec §58).

---

## 16. Debug and profiling

`src/debug/index.js`: toggle with **Backquote** (dev builds only — never
in production). Readout: FPS, frame time, room id, player x/y/state,
active enemies/projectiles, particles, texture memory estimate, audio
sources. Toggles: draw collision, draw hitboxes. Commands (via
`debug:command`): `godmode, teleport <roomId>, give <itemId> [n], xp <n>,
unlock <abilityId>, spawn <enemyId>, boss <bossId>, revealmap, heal, mana,
save` — all routed through real public APIs, never backdoors.

---

## 17. Data pipeline and validation

- Content lives in `data/*.json`, validated against
  `data/schemas/*.schema.json` by `npm run validate` (`scripts/validate.js`,
  ajv) — schema errors, duplicate ids, broken cross-references, dangling
  exit targets, unreachable rooms, map-cell collisions.
- `npm test` (vitest): one suite per schema over the example data + world
  connectivity tests.
- **CI gate:** `.github/workflows/deploy.yml` runs
  `npm ci → validate → test → build → deploy`. `npm run build` itself runs
  validate first. Nothing deploys on red.
- Asset art/audio land in `assets/` in later waves (see
  `assets/README.md`); data JSON references them by path.

---

## 18. Performance rules (spec §10, §56)

- Only the current room is live; neighbors contribute metadata + preload.
- Object pooling for projectiles/particles/damage numbers; no allocation
  in `update()` loops.
- Off-camera entities sleep (no AI, no collision, animations paused).
- Texture atlases; visibility checks before expensive logic.
- DebugOverlay profiler is the early-warning system — watch FPS, frame
  time, active enemies/projectiles/particles.

---

## 19. Wave plan (master prompt §65)

- **Wave 0** (this doc): repo, contracts, schemas, validation, docs. ✅
- **Wave 1 — Foundation:** Phaser boot, core singletons, save system,
  data loaders, staged asset loading, utils, debug shell.
- **Wave 2 — Gameplay:** player, movement feel, combat systems, 8 enemies,
  weapons, damage, leveling.
- **Wave 3 — World:** Moonlit Gate + Hollow Keep rooms, RoomManager,
  map, secrets, traversal ability.
- **Wave 4 — Content:** enemy set, equipment, miniboss, boss, NPCs, merchant.
- **Wave 5 — Presentation:** UI screens, effects, music, parallax, art pass.
- **Wave 6 — QA:** full test pass, feel pass, browser pass.
- **Wave 7 — Deploy:** main merge, production build, Pages verify.

Multi-agent rule (§64): contracts FIRST (done here) — agents implement
against these interfaces and may not invent incompatible APIs.
