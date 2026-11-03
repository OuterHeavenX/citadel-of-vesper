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

## Anchoring (sprite ↔ physics)

Lucien is **feet-anchored**, like enemies and bosses: `player.getPosition()`
is the point between his boots. The 64×64 frames put the boots on row 62, so
the sprite origin sits there and the 12×22 Arcade body is centered above it
(`Player._syncBodyToFrame()`); the drawn feet rest on the floor the body
collides with. Spawns/teleports place the feet `tuning.combat.spawnLift` px
above the requested y so a spawn or save point can never start inside a
floor. Swing hitboxes are centered `tuning.combat.attackHitboxOffsetY`
above the feet (chest height).

## Attacking

`Player.update()` turns a fresh `attack` press (J / X / pad X / touch ATK)
into `PlayerCombat.tryAttack()`; ignored while dead, in hitstun or
mid-backdash, and on the frame a menu/dialogue closed on the same press.

## Feel priorities (spec §12, §67)

1. Responsiveness (coyote time, jump buffering, attack buffering).
2. Weight (gravity, landing, hit pause) without floatiness.
3. Readability (telegraphs, animation-driven hit frames).
