# PROGRESSION — The Citadel of Vesper

> XP, levels, stats. Formulas landed in Wave 2 (below).

## Curve (data/progression.json)

- XP for level N → N+1: `floor(80 * N^1.45)`.
- XP is cumulative: reaching level L requires the sum of all transitions
  1→2 … (L-1)→L. One large gain can trigger several level-ups, each
  emitting its own `player:leveledUp`.
- Level cap: 60.
- Per-level growth: HP +12, MP +4, STR +2, CON +2, DEX +1, INT +1, LCK +1.

## Stats

Base: Level, XP, HP, MP, Strength, Constitution, Dexterity, Intelligence,
Luck (spec §18). Derived (computed by `PlayerStats`, never stored):
Physical Attack, Magic Attack, Defense, Magic Defense, Critical Chance,
Attack Speed, Movement Speed, elemental resistances.

## Derived formulas (Wave 2, `src/player/PlayerStats.js`)

Item `stats` keys are flat bonuses; `resistances` are fractional (0..1).

- `physicalAttack = round(str * 1.2 + atk)`
- `magicAttack    = round(int * 1.2 + matk)`
- `defense        = round(con * 0.8 + def)`
- `magicDefense   = round(int * 0.6 + mdef)`
- `critChance     = clamp(0.05 + lck * 0.004 + crit/100, 0, 0.6)`
- `attackSpeed    = clamp(1 + dex * 0.006 + aspd/100, 0.5, 2)`
- `moveSpeed      = clamp(1 + move/100, 0.5, 1.6)` (multiplies tuning speeds)
- `resistances[t] = clamp(sum of item fractions, 0, 0.75)`
- Equipment `hp`/`mp` are flat bonuses applied on top of the stored
  natural max (`PlayerStats.getEffectiveMaxHp/Mp`).

## Rules

- Level-up: emits `player:leveledUp { level, stats }` per level gained, and
  grants a **30% max-HP surge heal** (design choice: keeps exploration
  momentum; full heal is the checkpoint/rest's job — `save:rested`).
- Equipment bonuses apply immediately via `PlayerStats.recalc()`, which
  also re-runs on every `item:equipped` / `item:unequipped`.
- Permanent stat upgrades can hide in secrets (spec §29 rewards).

## Open

- Death penalty decision (see GAME_DESIGN.md).
