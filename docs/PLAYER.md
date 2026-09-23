# PLAYER — Lucien Vale

> Protagonist contract. Original visual design (Wave 5 art).

## Who he is

Lucien Vale — disgraced member of the Order of the Pale Hour, bloodline
tied to the Citadel. Strong recognizable silhouette (long coat, pale
streak in dark hair — Wave 5 refines; silhouette must read at 480×270).

## Capabilities (Wave 2 → 4)

- Move: idle, walk, run, crouch, jump (variable height), fall, land, turn,
  backdash, drop-through platforms, moving-platform carry, knockback,
  hitstun. Stairs = slope tiles (no special state).
- Fight: family-driven attacks, secondary, weapon specials, spells (Wave 4).
- Grow: XP levels, equipment, traversal abilities (`moonrise_leap`,
  `gale_dash`, …) that reopen old areas.

## Module contract

Facade: `src/player/Player.js` (only thing scenes touch).
Submodules: `PlayerMovement` (tuning.js only), `PlayerCombat`
(data-driven), `PlayerStats` (derived stats computed, never stored),
`PlayerAnimation` (keys `lucien_*`, driven by state not input).

**Integration:** Player never constructs PlayerCombat/PlayerAnimation —
GameScene (Wave 3) attaches them via
`player.attachCombat(new PlayerCombat(player))` and
`player.attachAnimation(new PlayerAnimation(player.getSprite()))`
(see `src/player/Player.js`). Until attached, `getCombat()` returns null
and combat/animation updates are skipped.

## Feel priorities (spec §12, §67)

1. Responsiveness (coyote time, jump buffering, attack buffering).
2. Weight (gravity, landing, hit pause) without floatiness.
3. Readability (telegraphs, animation-driven hit frames).
