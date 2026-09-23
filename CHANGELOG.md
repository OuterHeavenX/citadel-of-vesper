# CHANGELOG — The Citadel of Vesper

Semantic versioning. The title screen shows the current version.

## [Unreleased] — Wave 5 (UI)

### Added
- Full-screen character menu (`src/ui/screens/InventoryController.js` +
  `renderInventory()`): STATUS, ITEMS, EQUIP, MAGIC, MAP, BESTIARY, SAVE,
  CONFIG tabs — consumable use/equip spells, equipment changes with stat
  comparison, spell selection, save slots, audio/config controls.
- Pause menu (`PauseMenuController` + `renderPauseMenu()`): resume,
  inventory, map, settings, save, quit-to-title.
- Dialogue UI (`DialogueController` + `renderDialogue()`): typewriter flow,
  name plate, choice navigation; merchants chain into their shop.
- Shop UI (`ShopController` + `renderShop()`): buy/sell tabs, finite stock,
  locked-item silhouettes, weapon stat comparisons.
- Bestiary wired into the character menu; `bestiary.init()` + story flags
  registered in GameScene boot.
- NPC room presence (`src/ui/npc/NpcDirector.js`): world-space NPC figures,
  non-blocking TALK prompt (confirm only — gameplay never freezes), unlock
  and boss-defeated variants.
- Game-over and post-Matriarch victory screens (`EndScreenController`);
  respawn from last save (safe new-game fallback), victory continues after
  the credits, quit-to-title from pause/end screens.
- Headless UI open/close stack (`src/ui/UiStack.js`); original plum/gold
  gothic visual helpers (`src/ui/gothic.js`).
- Touch overlay (`src/ui/touch/TouchOverlay.js`): virtual joystick, attack/
  jump/dash/TALK buttons, pause/map/bag buttons; `quick_use` action
  (F / RT) drinks the configured consumable with a HUD count indicator.
- HUD: XP bar + level, quick-use indicator, animated room-name banner.
- `test/ui.test.js`: 35 headless UI tests.

### Changed
- **Save schema v2 → v3**: GameState gains `settings.quickUseItemId`
  (default `ember_tonic`); `SaveManager.migrate()` backfills it on older
  saves.

## [Unreleased] — Wave 4 (systems)

### Added
- Inventory/equipment/merchant/NPC/dialogue/bestiary systems
  (`src/systems/`: InventoryManager, EquipmentManager, DialogueManager,
  Bestiary, storyFlags).
- `data/merchants.json` + `data/npcs.json` (6 NPCs, data-driven dialogue
  trees with post-boss variants) and their JSON schemas.
- Timed consumable buffs (`ashward_draught` +12 def for 60s) and
  combat-restricted `waybread`.
- Economy tuning: `tuning.economy.sellRate = 0.5`, `minBuyPrice = 1`.
- `WeaponData.compare()` stat comparison helper.

### Changed
- **Save schema v1 → v2**: GameState gains serializable `merchantStock {}`
  and `buffs []`; `SaveManager.migrate()` backfills both on v1 saves.
- `PlayerStats` now includes active timed-buff bonuses and recalculates on
  `inventory:changed`.
- `Pickup.collect()` no longer double-emits `item:pickedUp`
  (`GameState.addItem()` is the single emitter).

## [0.1.0] — 2026-09-23 — ALPHA (Wave 0)

Architecture and contracts milestone — no gameplay yet.

### Added
- Project scaffold: Phaser 3 + Vite 5 + ES modules, `npm install/dev/build`
  working out of the box; GitHub Pages base path configured.
- `src/` module tree with contract stubs + JSDoc: core (EventBus, GameState,
  SaveManager, InputManager, AudioManager, AssetManager), player, combat,
  enemies, bosses, weapons, items, abilities, npcs, world, rooms, map, ui,
  scenes, effects, audio, utils, debug.
- `src/config/tuning.js`: all movement/combat/camera constants in one place.
- `data/` + `data/schemas/`: 9 JSON schemas; example entries with original
  names (Lucien Vale, Moonlit Gate, Chapel Warden, Sable Matriarch…).
- `scripts/validate.js`: schema validation, cross-reference checks, exit
  connectivity, BFS reachability, map-cell uniqueness. Wired into
  `npm run validate` and the deploy workflow (build fails on red).
- vitest: one suite per schema + world connectivity tests.
- PWA shell: `manifest.json`, `service-worker.js` (never touches saves),
  original gothic sigil icons.
- Docs: ARCHITECTURE (contracts), ROOM_FORMAT, SAVE_SYSTEM, CONTROLS
  (substantive) + 13 outline docs for later waves.
- `.github/workflows/deploy.yml`: validate → test → build → Pages on push
  to main.

### Notes
- Repo creation + Pages enablement are manual (Jimmy): see
  `docs/DEPLOYMENT.md`.
