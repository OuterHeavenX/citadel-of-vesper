# EQUIPMENT — The Citadel of Vesper

> Slots, comparison UI, special properties. Architecture supports 250–500
> items eventually (spec §20); we author a curated set per wave.

## Slots

`weapon, offhand, head, body, accessory1, accessory2` — fixed.
`gameState.equip(slot, itemId)` → `item:equipped` → `PlayerStats.recalc()`.

## Data

`data/weapons.json`, `armor.json`, `accessories.json`, `consumables.json`
→ unified via `ItemData`. Schemas in `data/schemas/`. Item data lives in
files, never in player logic.

## Comparison UI (spec §19)

```
MOONSTEEL SABRE            EQUIPPED: Recruit's Blade
ATK 34                     ATK +26
Speed: Fast                STR +2
STR +2                     (green = better, red = worse)
CRIT +4%
An old ceremonial blade whose edge glows beneath moonlight.
```

`WeaponData.compare(candidateId, equippedId)` supplies the deltas.

## Special properties (spec §21)

Data-driven `specials`: hold-attack charged slash, down+attack ground
wave, low-HP glow + reach, accessory combos, moonlit-room bonuses.
Encourage experimentation; document each special's behavior here as
Wave 4 implements them.

## Economy

Merchant buy/sell/compare (Wave 4). Sell rate and currency naming: TBD.
