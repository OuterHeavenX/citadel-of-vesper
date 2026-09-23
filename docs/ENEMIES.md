# ENEMIES — The Citadel of Vesper

> ~70–100 original enemies eventually (spec §34); 8 in the vertical slice.
> Every design must be original — never recreate Castlevania enemies.

## Design rules

- Data-driven: `data/enemies.json` (stats, behaviors, telegraphs, drops,
  lore). No hardcoded enemies.
- AI states: `idle|patrol|pursue|attack|stagger|dead`; behavior flags add
  `retreat|leap|dodge|block|teleport|fly|crawl|ambush|cast|summon|charge`.
- Every attack telegraphed (windup, flash, sound in data).
- Distinct behavior per enemy — never recolor-only variants.
- Bestiary: discovered enemies show name, sprite, level, HP, weaknesses,
  resistances, known drops (hidden until acquired), lore.

## Vertical slice roster (Wave 2)

| Enemy | Region | Behaviors |
|---|---|---|
| Ash Hound | Moonlit Gate | patrol, pursue, leap |
| Rustbound Revenant | Moonlit Gate | patrol, pursue, block |
| Cinder Wisp | Hollow Keep | fly, cast |
| Hollow Sentinel | Hollow Keep | patrol, pursue |
| Vellum Phantom | Hollow Keep | fly, teleport, ambush, cast |
| Vesper Chimer | Hollow Keep | cast |
| Mote Swarm | Hollow Keep | crawl, leap |
| Cinder Mastiff (elite) | Hollow Keep | pursue, charge, retreat |

All 8 are implemented in `src/enemies/variants.js`, data-driven from
`data/enemies.json`. Every attack is telegraphed (windup/flash/sound in
the data `telegraphs`).

## Open (Wave 4)

- Drop tables and spawn pacing per room (room-by-room tuning).
- Additional Hollow Keep run/attack art sheets (idle sheets exist for all
  8; only ash_hound + rustbound_revenant have run/attack sheets so far).
