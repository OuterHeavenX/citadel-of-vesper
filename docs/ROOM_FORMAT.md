# ROOM FORMAT — The Citadel of Vesper

> Contract for `data/rooms.json`. Schema: `data/schemas/room.schema.json`.
> Validated by `npm run validate`. Wave 3 (World Agent) authors rooms against
> this document — no ad-hoc fields.

## Example

```json
{
  "id": "moonlit_gate_006",
  "region": "moonlit_gate",
  "name": "Gatehouse Approach",
  "width": 960,
  "height": 270,
  "playerStart": { "x": 120, "y": 236, "facing": 1 },
  "geometry": {
    "solids": [{ "x": 0, "y": 240, "w": 960, "h": 30 }],
    "oneway": [{ "x": 420, "y": 170, "w": 120 }],
    "hazards": [{ "x": 700, "y": 224, "w": 64, "h": 16, "kind": "spikes", "damage": 10 }]
  },
  "map": { "x": 5, "y": 0 },
  "music": "moonlit_gate",
  "ambience": "wind_night",
  "exits": [
    {
      "id": "mg006_east",
      "dir": "east",
      "x": 948, "y": 180, "w": 12, "h": 70,
      "target": "moonlit_gate_007",
      "spawn": { "x": 30, "y": 210, "facing": 1 }
    },
    {
      "id": "mg006_gate",
      "dir": "east",
      "x": 944, "y": 150, "w": 16, "h": 100,
      "target": "moonlit_gate_009",
      "spawn": { "x": 30, "y": 236 },
      "requiresItem": "moonstone_charm",
      "hint": "A ward of cold moonlight seals the gate."
    }
  ],
  "enemies": [{ "id": "ash_hound", "x": 420, "y": 210 }],
  "pickups": [{ "itemId": "ember_tonic", "quantity": 1, "x": 200, "y": 190, "chest": true }],
  "breakables": [{ "kind": "candle", "x": 120, "y": 210 }],
  "secrets": [
    {
      "id": "mg006_cache", "kind": "breakable_wall",
      "x": 700, "y": 150, "w": 32, "h": 90,
      "reward": { "itemId": "moonstone_charm", "quantity": 1 }
    }
  ],
  "checkpoints": [{ "id": "mg006_bell", "x": 480, "y": 210 }],
  "npcs": [{ "id": "scholar_ives", "x": 600, "y": 210 }],
  "saveRoom": false,
  "teleport": false,
  "hidden": false
}
```

## Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✅ | `^[a-z0-9_]+$`, unique. Convention: `<region>_<nnn>`. |
| `region` | enum | ✅ | One of the 15 regions (schema lists them). |
| `name` | string | ✅ | Display name (map screen, room banner). |
| `width` / `height` | int | ✅ | Room size in world pixels. Height is usually 270 (one screen) for horizontal rooms; taller for vertical shafts. |
| `playerStart` | `{x,y,facing?}` | – | Initial spawn, used on first entry (room 001). Later entries use exit `spawn` points; RoomManager falls back to `{x:60, y:200}` when neither exists. |
| `geometry` | object | – | Collision geometry (see §Geometry). Absent = no authored collision (physics world bounds still apply). |
| `map` | `{x, y}` | ✅ | Exploration-map grid cell. Must be unique across all rooms (validated). |
| `music` / `ambience` | string | – | Track/bed ids from `src/audio/index.js` registries (`trackForRegion(region)` is the fallback when `music` is absent). |
| `exits[]` | array | ✅ | May be empty ONLY for dead-ends by design (flagged in review). |
| `enemies[]` | array | – | `{ id, x, y }` — `id` must exist in `enemies.json`. `x,y` = spawn position (feet). |
| `pickups[]` | array | – | `{ itemId, quantity?, x, y, chest? }` — `itemId` must exist in the item tables (weapons/armor/accessories/consumables). `chest: true` renders a chest and persists via `gameState.chestStates`. **Static pickups cannot be coins/hearts/mana** (those are currency kinds, not items) — currency drops come from breakables and enemy drop tables instead. |
| `breakables[]` | array | – | `{ kind, x, y }` — kind: `candle\|crate\|urn\|statue\|chandelier\|furniture`. Drops (coins etc.) roll from their drop tables at break time. |
| `secrets[]` | array | – | See §Secrets. |
| `checkpoints[]` | array | – | `{ id, x, y }` — respawn points; emit `room:checkpointTouched`. |
| `npcs[]` | array | – | `{ id, x, y }` — npc definitions resolve via flags/relocation. |
| `saveRoom` | bool | – | Save room: RoomManager hands off to SaveSanctum (`roomManager.onSaveRoom`); the rest sequence emits `save:rested`. |
| `teleport` | bool | – | Teleport chamber: registers on first entry (`teleport:discovered` + `gameState.discoverTeleport`). |
| `hidden` | bool | – | Secret room: off the map until discovered; excluded from completion %. |

## Geometry

Collision is authored as **rect lists in room-local pixels** (origin top-left,
y grows downward), not ASCII tilemaps — rects stay compact for hand-authored
rooms and map 1:1 onto Arcade static bodies and tile painting.

- `geometry.solids[]` — `{x, y, w, h}` full-collision rects: floors, walls,
  ceilings. RoomManager paints these into the tilemap collision layer AND
  uses them as the collision source of truth.
- `geometry.oneway[]` — `{x, y, w}` jump-through platforms, 8px thick at `y`,
  solid from above only (Arcade `collideUp`-only tiles; drop-through via the
  standard down+jump input).
- `geometry.hazards[]` — `{x, y, w, h, kind, damage?}` environment damage
  rects. `kind` is currently only `"spikes"`. Damage routes through
  DamageSystem with `source = { id: 'environment', kind: 'environment' }`.
  Keep hazards minimal.

**Authoring guidance:** align rects to the 16px tile grid (x/y/w/h multiples
of 16) so tile painting is clean. Standard floor top is `y = 240` with
`h = 30` (floors sit at the bottom of a 270px-tall room). RoomManager sets the
Arcade world bounds to the room rect, so perimeter walls are unnecessary —
the player cannot leave the room except through exits.

### Tile visuals (how rects become tiles)

RoomManager builds a Phaser tilemap from the region tileset
(`assets/tilesets/<region>_tiles.png`, key `tiles_<region>`) plus its
name→index map (`assets/tilesets/<region>_tiles.json`, bundled statically).
Mapping is deterministic:

| Geometry | Tiles used |
|---|---|
| `solids` top row | `plat_top` (spanning `plat_top_left` / `plat_top_right` at ends) |
| `solids` interior | `stone_inner` (edges: `stone_brick_a` variants) |
| `oneway` | `plat_top` row |
| secret walls (pre-discovery) | `stone_brick_cracked` (the visual tell) |
| secret floors (pre-discovery) | `floor_slab_a` like the rest of the floor |

All collision comes from the painted tile layers (Arcade). If the tileset
texture is missing, RoomManager falls back to invisible static rect bodies —
collision still works, visuals degrade (spec §59 crash protection).

## Exits

- `dir`: `north|south|east|west|up|down` — the direction the player travels.
- `x, y, w, h`: trigger rectangle in room-local pixels (overlap with the
  player sprite fires the transition).
- `target`: destination room id — **must exist** (CI error otherwise).
- `spawn`: player spawn point **in the destination room**; `facing` is
  optional (1 = right, -1 = left; defaults to travel direction).
- `requires`: traversal ability ids (from `abilities.json`) needed to use
  the exit. Every id must exist (CI error otherwise). The reverse exit
  need not require the same ability (one-way drops are legal design), but
  `scripts/validate.js` reachability ignores `requires` — the World Agent
  must ALSO verify ability-gated critical paths by hand in Wave 3+.
- `requiresItem`: an item id the player must **carry** (inventory) to use the
  exit — the key-item gate (e.g. a moonlight-warded gate opened by a
  moonstone charm). Cross-checked against the item tables (CI error on
  unknown ids). Unlike `requires`, this is checked against inventory, not
  abilities.
- `secretId`: the exit stays **inactive** until the named secret (a `secrets[]`
  entry in the SAME room) is discovered — used for hidden doorways whose
  trigger sits behind a secret wall/floor. CI errors when the secret id has
  no matching entry.
- `hint`: text shown with the blocked shimmer when a gate (`requires` /
  `requiresItem`) is unmet. When absent, RoomManager uses a generic message.

Blocked exits never hard-fail: RoomManager plays a subtle shimmer at the
exit rect plus the hint text, and the player stays in the room.

Bidirectional pairing is conventional but not mandatory; mismatches are
warnings, missing targets are errors.

## Secrets

`kind`: `breakable_wall | hidden_floor | false_ceiling | invisible_passage |
secret_switch`. The `x/y/w/h` rect is the trigger/interaction zone.
`reward`: `{ itemId?, abilityId?, quantity? }` — at least one of itemId /
abilityId when present. Finding one emits `room:secretFound { roomId,
secretId }`, sets a `gameState` flag (`secret:<secretId>`, one-time), spawns
the reward as a pickup, and reveals the room on the map if it was hidden.

Physical behavior by kind (RoomManager):
- `breakable_wall`: at build, the rect is painted as cracked blocking tiles
  (see visual-tell table above); on discovery the tiles are removed, opening
  the passage. Trigger: player overlap with the rect.
- `hidden_floor`: at build, the rect is painted as normal floor; on
  discovery the floor tiles are removed (the floor crumbles). Trigger: player
  overlap while standing on it.
- `false_ceiling` / `invisible_passage` / `secret_switch`: overlap trigger;
  no geometry change (passage was always open, just unmarked).

Secrets are the mechanism for hidden-room doorways: pair a `secrets[]` entry
with an `exits[]` entry carrying the same `secretId`. The exit is inert until
the secret is found.

## Rooms and regions (vertical slice)

Wave 3 builds **20 rooms** across `moonlit_gate` → `hollow_keep`:

**Moonlit Gate** (11): `moonlit_gate_001` Moonlit Threshold (start, safe) →
`002` Lantern Court (save room; `recruit_blade` chest; north ledge gated by
`moonrise_leap`) → `004` Warded Passage (moonlight gate needs
`moonstone_charm`; south to the cloister) → `005` Ashen Cloister (hidden
cellar → `006` Ember Hollow, hidden, holds the charm) → `007` Sunken Chapel
(teleport chamber; drop shaft south; north to `014` Warden's Chapel,
miniboss arena) → `008` Weeping Gallery (vertical shaft, one-way drop) →
`009` Sunless Nave (east to Hollow Keep; hidden cellar → `011` The Reliquary,
hidden, holds `iron_signet`). `003` Starlit Overlook is the early backtrack
ledge above `002` (needs `moonrise_leap`, earned from the Chapel Warden);
its hidden floor cache holds `moonsteel_sabre`, and it shortcuts east to
`005`.

**Hollow Keep** (9): `hollow_keep_001` Threshold of Teeth → `002` Hollowed
Gallery (save room) → `003` The Gullet (vertical shaft) → `004` Sunken
Refectory (breakable wall south → `006` The Moth Vault, hidden, holds
`wayfarer_coat` = +10 max HP) → `005` Choir of Rust (south → `008` The
Undercroft) → `007` Matriarch's Antechamber → `010` Sable Sanctum (boss
arena).

Progression spine: start → save → (gate locked: detour cloister → hidden
cellar → charm) → gate → teleport chapel → miniboss (earns `moonrise_leap`)
→ backtrack to the `002` ledge (`moonsteel_sabre` + shortcut) → shaft drop →
Sunless Nave → Hollow Keep → … → Sable Sanctum.

## Authoring rules for the World Agent

1. Never invent fields — propose schema changes in `ARCHITECTURE.md` first.
2. Every room reachable from `moonlit_gate_001` (CI-enforced BFS).
3. Secret rooms must be *findable*: visual tells, suspicious architecture,
   environmental clues (spec §29) — not pixel-hunt exits. Cracked tiles mark
   breakable walls; misaligned floor slabs mark hidden floors.
4. Keep rooms out of `assets/` — tilemap JSON paths only; art lands in Wave 5.
5. `validate.js` reachability ignores `requires`/`requiresItem`/`secretId` —
   verify gated critical paths by hand (see spine above).
