# COMBAT — The Citadel of Vesper

> Feel target: immediate, heavy, readable. Never visually chaotic.

## Core loop

Anticipation → active hit frames → recovery. Damage ONLY during active
frames (HitboxSystem). Hit pause ≤ 90 ms, trauma-based screenshake,
enemy flash, knockback, damage numbers, crit effects (spec §17).

## Weapon families

sword, greatsword, dagger, axe, spear, chain, fist, magic, relic.
Each family changes: animation key, reach, recovery, attack speed,
knockback, sound, visual effect, hitbox size, special move
(`attackProfile` in `data/weapons.json`).

## Damage pipeline

`DamageSystem.applyDamage(source, target, opts)` — the only damage path.
Types: physical, fire, ice, lightning, shadow, holy. Mitigation via
`getDefense(type)`; crits via `PlayerStats`. I-frames checked centrally.

## Player tools

- Primary / secondary attacks, backdash (B / Shift), weapon specials
  (hold attack, down+attack — data-driven `specials`).
- Magic (Wave 4): MP-based spells, mapped to LB/RB/LT/RT.

## Enemy combat rules

- Every enemy attack telegraphed (windup + flash + sound in data).
- Distinct AI per enemy (behaviors array); no palette-swap design.
- Bosses: multi-phase, arena lock, readable patterns, death → reward.

## Tuning home

Feel numbers: `src/config/tuning.js` (combat section). Damage numbers:
`data/*.json`. Formulas (Wave 2, implemented in `src/combat/`):

- **Damage** (`DamageSystem.applyDamage`, the only damage path):
  `dealt = round(amount × critMult × (1 − mitigation))`,
  `critMult = 1.5` when the hit crits (pre-mitigation),
  `mitigation = clamp(target.getDefense(type), 0, 0.9)`.
- **Crits:** an explicit `critical` flag wins (set by the caller, e.g. from
  `PlayerStats`); otherwise a crit is rolled when `canCrit` is true, using
  the caller-supplied `critChance` (0..1).
- **Mitigation** (`PlayerCombat.getDefense`, consumed by DamageSystem):
  `resistances[type]` (0..1) when the derived stats carry it; otherwise a
  diminishing fallback over flat stats — physical → `defense/(defense+50)`,
  elemental → `magicDefense/(magicDefense+50)`.
- **I-frames:** `tuning.combat.iframesAfterHit` (0.8 s) after taking damage,
  checked centrally by DamageSystem via `target.isInvulnerable()`.
  Status-effect DoTs bypass via `ignoreIframes: true`.
- **Hitstun/knockback:** passed through `takeDamage` info (`hitStun`,
  `knockback`); `PlayerCombat` queues them for `PlayerMovement` via
  `drainHitReaction()`. Light hitstun default `tuning.combat.hitStunLight`
  (0.18 s).
- **Attack timing** (`PlayerCombat`, data-driven per weapon):
  `anticipation` (data) + `activeFrames / (12 × attackSpeed)` +
  `recovery / attackSpeed`, where `attackSpeed = profile.attackSpeed ×
  stats.attackSpeed` and 12 fps is the native attack-clip rate
  (`assets/player/lucien.json`). Hitbox damage window = the active phase
  only. Attack input buffers for `tuning.combat.attackBuffer` (0.15 s).
- **Events:** every landed hit emits `combat:hitLanded { attacker, target,
  amount, critical }`, plus `player:damaged` / `enemy:damaged` per target
  kind. Hit pause / screenshake / damage numbers listen to
  `combat:hitLanded` in `src/effects` (budgets: hit pause ≤ 90 ms).
