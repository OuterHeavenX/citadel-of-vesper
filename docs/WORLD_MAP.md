# WORLD MAP — The Citadel of Vesper

> Exploration map (spec §27). Model: `src/map/MapModel.js` (Phaser-free).
> Overlay: `src/map/MapOverlay.js` (functional; Wave 5 owns the restyle).
> Validation: `src/world/WorldGraph.js` + `scripts/validate.js`.

## Discovery

- Source of truth: `gameState.data.map.discovered` (room ids). The model
  never mutates it directly — `MapModel.discover(roomId)` routes through
  `gameState.discoverRoom(roomId, region)`, which emits `map:roomDiscovered`,
  then recomputes completion via `gameState.setMapCompletion()`.
- Rooms are discovered on entry (`RoomManager` calls `discoverRoom(to)` on
  `room:changed`; spec §8 transition protocol). Hidden rooms are discovered
  when their secret is found (`room:secretFound` reveals them).

## Map model API (`src/map/MapModel.js`)

Construct: `new MapModel(rooms, { bosses })` (`bosses` = `data/bosses.json`
defs; arena lookup by `arenaRoomId`). Shared singleton `mapModel` — call
`mapModel.init(rooms, { bosses })` once room data is loaded.

| Method | Returns |
|---|---|
| `discover(roomId)` | new completion %; idempotent |
| `getCompletion()` | % of **non-secret** rooms discovered, 0–100 (1 decimal) |
| `getRegionCompletion(region)` | same, per region; regions with no non-secret rooms → 100 |
| `getRoomNode(roomId)` | `{ roomId, name, region, x, y, discovered, isHidden, isSaveRoom, isTeleport, isBoss, hasUnexploredExit }` — `x/y` from room `map: {x, y}` |
| `getDiscoveredNodes()` | nodes for rendering; hidden rooms appear only after discovery |
| `getUnexploredDoors()` | exits from discovered rooms to undiscovered rooms: `{ from, exitId, dir, to, requires }` |
| `getMarkers()` | `{ save, teleport, boss }` — discovered-only node lists |
| `getSaveRooms()` / `getTeleportRooms()` / `getBossRooms()` | convenience marker lists |
| `getUndiscoveredNeighbors(roomId)` | undiscovered adjacent non-hidden rooms (fog hints; never leaks secrets) |
| `getRegions()` | region ids present in the loaded defs |

## Completion rules

- Denominator: rooms with `hidden !== true`. Secret rooms never render and
  never count until found.
- `100%` = every non-secret room discovered. (The "all secrets found"
  half of completion is tracked separately once `room:secretFound` state
  lands in GameState — a Wave 4+ addition; the model is ready via `discover()`.)
- Displayed prominently on the map overlay header (`MAP OF VESPER … 87.5%`).

## Overlay controls (`src/map/MapOverlay.js`)

Functional fullscreen overlay; Wave 5 restyles the visuals (gothic
cartography, region tints, fog over unexplored).

- **Open:** `map` action (`Tab` / `M` / gamepad View) — wired by the UI
  scene; **close:** `confirm` or `cancel` (`Enter`/`Space`/`J`, `Esc`/`K`,
  gamepad A/B).
- `show()` / `hide()` / `toggle()` / `isOpen()`; `setCurrentRoom(roomId)`
  highlights the player's room; `refresh()` rebuilds from discovery state;
  `update(delta)` — call from the owning scene, handles pan + close actions.
- Layout: fit-all zoom from discovered extents, then pan with the
  `move_x`/`move_y` axis (WASD/arrows/D-pad). Pan is clamped so the map
  can't be lost off-screen.
- Markers: discovered rooms as panels (current room = bright gold border),
  save rooms = lantern icon, teleport chambers = pale-blue diamond, boss
  arenas = blood-red diamond, unexplored doors = gold ticks on the room edge
  toward the exit `dir` (gray when ability-gated).
- Emits `ui:opened` / `ui:closed` with `{ screen: 'map' }`. Pause
  coordination (pausing GameScene while open) is owned by the UI scene in
  Wave 5.

## Validation (world graph)

`WorldGraph.validateWorld(rooms, { abilities, bosses })` runs in
`npm run validate` and in `test/worldGraph.test.js`. Errors fail the build:

- exit target room id does not exist; `requires` references an unknown ability
- room unreachable from `moonlit_gate_001` with no abilities, with the full
  ability set, or with fixpoint-collected abilities (boss/secret rewards
  treated as collected room-by-room — the real critical path)
- boss arena unreachable with all abilities
- duplicate `map: {x, y}` grid cells

Warnings (legal design, flagged for review):

- exit with no matching reverse exit (one-way passages are legal)
- room reachable only behind an ability gate (metroidvania shape — confirm intended)
- one-way trap / dead-end: no path back to start even with all abilities,
  unless a save room or teleport chamber (boss arenas exempt — exits unlock
  after the fight, Wave 4)
- boss `arenaRoomId` not in `rooms.json` yet (arena ships in a later wave)
- hidden rooms are never required for completion, but must still be
  reachable (findable) — unreachable secrets are errors
