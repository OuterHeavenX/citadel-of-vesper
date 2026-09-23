# SAVE SYSTEM — The Citadel of Vesper

> Contract for `src/core/SaveManager.js` + `src/core/GameState.js`.
> Spec §30 (IndexedDB), §31 (export/import), §32 (save rooms).

## Storage

- **Primary: IndexedDB** database `vesper-saves`, version 1.
- Object stores:
  - `saves` — `keyPath: 'slot'`. Slots `1, 2, 3`.
  - `settings` — `keyPath: 'key'`. Values: `{ key, value }` (volumes,
    bindings, language, last-used slot hint).
- **localStorage is NOT used for saves.** It may hold only the
  non-critical "last slot" hint.
- Service workers never touch save data (see `public/service-worker.js`).

## Save object shape (schema v1)

```js
{
  schemaVersion: 1,
  slot: 1,
  savedAt: 1695...,          // epoch ms
  playTime: 3723,            // seconds
  createdAt: 1695...,
  difficulty: 'normal',
  player: {
    name: 'Lucien Vale',
    level, xp, hp, maxHp, mp, maxMp,
    stats: { strength, constitution, dexterity, intelligence, luck },
    position: { roomId, x, y },
    abilities: ['moonrise_leap'],
    spells: ['cinder_wave'],
  },
  inventory: [{ itemId, quantity }],
  equipment: { weapon, offhand, head, body, accessory1, accessory2 }, // itemIds or null
  currency: 0,
  map: { discovered: ['moonlit_gate_001'], completion: 12 },
  flags: {},
  bossStates: { chapel_warden: 'defeated' },   // locked|unlocked|defeated
  chestStates: { mg003_cache_chest: true },
  checkpoints: {},
  teleports: ['vesper_gate_chamber'],
  quests: {},
  bestiary: {},
  settings: { musicVolume, sfxVolume, ambienceVolume, screenShake, damageNumbers, language },
}
```

Derived stats are recomputed on load (`PlayerStats.recalc()`), never stored.

## Versioning and migration

- Every save carries `schemaVersion`. On read, `SaveManager.migrate(save)`
  upgrades it to `SAVE_SCHEMA_VERSION` (currently 3).
- `migrate()` is **pure**: takes a save object, returns an upgraded clone.
- Rule: adding a field = add a migration step that backfills it; bumping
  the version without a step is a bug. Document each migration in
  `CHANGELOG.md`.
- Migration history:
  - v1 → v2 (Wave 4): backfill `merchantStock: {}` and `buffs: []`.

```js
// Signature every wave agent must preserve:
migrate(saveObject) => saveObject  // upgraded to current schemaVersion
```

## Save flow

1. Player enters a save room (`saveRoom: true`) → rest sequence plays
   (visual + audio, Wave 5) → HP/MP restored → `save:rested` emitted.
2. Save UI (slots 1–3, export/import) → `SaveManager.write(slot,
   gameState.toJSON())` → on success `game:saved { slot, playTime }`.
3. Continue → `SaveManager.read(slot)` → `migrate()` → `gameState.hydrate()`
   → `RoomManager.loadRoom(player.position.roomId, player.position)`.
4. Autosave: on `room:changed` into a save room only (no timer autosaves in
   the vertical slice — Wave 6 may add suspend-on-tab-hide save).

## Export / import

- Export: builds `{ format: 'vesper-save', game: 'citadel-of-vesper',
  version: <schemaVersion>, exportedAt, payload: <save object> }` and
  triggers a download named `vesper-save-slot<N>-<date>.json`.
- Import: file picker → parse → validate `format`/`game`/`version` →
  `migrate()` → write to chosen slot (confirm overwrite).
- Importing a *newer* schema version than the game supports is rejected
  with a clear message.

## Failure semantics

- `write()` / `read()` never throw into gameplay: they resolve
  `{ ok, error? }`. A failed save shows a non-blocking warning; the game
  continues.
- Quota errors: attempt slot compaction (delete oldest autosave equivalent)
  once, then surface the warning.
- Corrupt slot: `slotInfo()` reports `{ exists: false, corrupt: true }`;
  the slot UI offers delete — never auto-delete player data.
