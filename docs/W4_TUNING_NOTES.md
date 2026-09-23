# W4 Content Tuning Notes — difficulty, economy, boss sanity

> The data changes described here (data/enemies.json, data/bosses.json,
> data/rooms.json, test/enemies.test.js, test/boss.test.js) were authored in
> the W4-CONTENT tuning pass and landed inside commit 54e466a
> ("feat(systems)"), which swept the staged index. This note documents the
> math and intent behind those changes.

## Damage model (from src/combat/DamageSystem.js, src/player/PlayerStats.js)

- Player -> enemy: `dealt = round((physicalAttack - enemyDefFlat) * (1 - enemyResist))`
- Enemy -> player: `dealt = round(enemyAtk * (1 - defense / (defense + 40)))`
- `physicalAttack = round(str * 1.2 + atkBonus)`, `defense = round(con * 0.8 + defBonus)`
- Base stats: str/con/dex/int/lck 8, maxHp 60. Per level: +12 hp, +2 str, +2 con,
  +1 dex/int/lck. XP to go 1->2 is `floor(80 * level^1.45)`.

## Simulated single-clear XP curve (new values)

| Point | Cumulative XP | Player level |
|---|---|---|
| Moonlit Gate cleared (pre-Warden) | ~955 | 4 |
| + Chapel Warden reward (500) | ~1455 | 5 |
| + mg003 backtrack | ~1585 | 5 |
| Hollow Keep cleared (pre-Matriarch) | ~3340 | 7 |
| + Sable Matriarch reward (1500) | ~4840 | 8 |

XP roughly doubled per enemy: hound 14->30, revenant 28->60, wisp 32->65,
swarm 30->60, phantom 46->95, sentinel 44->90, chimer 62->150, mastiff 95->240.

## Boss math

**Chapel Warden** (miniboss): hp 320->300, atk 18->17, def 8, reward xp 400->500.
- L4 player, Recruit's Blade: atk = round(16.8)+8 = 25 -> 17/hit vs def 8
  -> 300 hp = ~18 clean hits (~60-90 s with dodging, 2 phases).
- Boss: 17 atk vs L4 def 11 (mit 0.216) -> ~13/hit vs 96 hp = ~8 hits to kill.
  ~5 ember tonics reachable pre-fight -> effective ~346 hp = ~26 boss hits.
  Fair, telegraphed, no brick wall. Rushed L3 players must dodge or grind.

**Sable Matriarch** (final boss): kept 900 / 26 / 12 — the math was already fair.
- L7 player, Moonsteel Sabre (atk 34, str+2), signet, coat, hood:
  atk = round(27.6)+34 = 62 -> 50/hit vs def 12 -> 900 hp = ~18 hits.
- Boss: 26 atk vs def 26 (mit 0.394) -> ~16/hit vs 142 hp = ~9 hits.
- Fair 3-phase fight for L6-L10; grinding to L11-12 makes it easier (rewarded).

The old "level 6" / "level 12" labels were aspirational, not reachable in a
single clear; bosses are tuned to the actual curve above.

## Reconciliation: moonsteel_sabre from two sources (W3-ROOMS note)

- mg003 hidden-floor cache: moonsteel_sabre -> **dusk_hood** (rare accessory;
  overlook theme: "muffles sound, sharpens sight"). Secret renamed
  mg003_moonsteel_cache -> mg003_overlook_cache.
- cinder_mastiff 2% moonsteel_sabre drop -> vesper_draught x2 (8%).
- vesper_chimer 3% dusk_hood drop -> vesper_draught (25%) + ember_tonic x3 (10%).
- Sable Matriarch keeps moonsteel_sabre as the unique final-weapon reward.
- Note: W4-SYSTEMS's data/merchants.json also stocks moonsteel_sabre
  (post-Warden flag, price 850) — their call; price-gated, not progression.

## Room changes (data/rooms.json)

- hk001 "Threshold of Teeth": rustbound_revenant -> **cinder_mastiff** + ash_hound.
  The Keep opens with the pack-leader (thematic) at L5-with-sabre: 3 hits to
  kill it, ~7 of its hits to kill the player. Pressure without a wall.
- hk003 "The Gullet": was a copy-paste of mg008 (2x phantom + swarm at identical
  coords) -> wisp (top) + phantom (mid) + swarm (bottom); wisps-near-heights.
- Save rooms: added moonlit_gate_007 (teleport hub, pre-Warden) and
  hollow_keep_007 (pre-Matriarch). Critical-path save gaps: 1 / 3 / 3 / 4 rooms.
- Hidden rooms given real rewards: mg006 chest (ember_tonic x3), hk008 chest
  (ember_tonic x2, rewards the dead-end detour), mg011 + hk006 loose
  vesper_draught.
- Economy: breakables expanded (urns/crates + chandeliers in chapels, nave,
  choir, sanctum). Expected yield: ~164 currency Moonlit Gate, ~158 Hollow
  Keep (coin = 5). At merchant priceMult 1.0-1.15 (tonic 30, draught 45):
  3-5 meaningful consumable purchases per region, no grinding. Plus ~8 hearts
  of sustain per region from urns/crates.
- Hints added: mg004_gate ("A ward of cold moonlight seals the gate."),
  mg002_ledge (leap hint).
- Enemy roster usage: wisp 5, revenant 5, phantom 5, hound 4, sentinel 4,
  swarm 4, mastiff 3, chimer 2 — all 8 appear meaningfully.
- Stat trims: revenant hp 46->40 (5-hit grind as first tanky enemy);
  sentinel hp 72->64, def 8->6 (7-hit wall before the boss at L3).

## Gates

`npm run validate` (12 files, 20 rooms, 6 pre-existing one-way warnings),
`npx vitest run` (35 files / 356 tests), `npm run build` — all green.
Test fixtures updated for the stat changes (test/enemies.test.js,
test/boss.test.js).
