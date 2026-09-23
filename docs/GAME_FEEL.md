# GAME FEEL — feedback model (`src/effects`)

> Wave 2 (W2-FX). The single law of this module: **combat code never calls
> effects directly.** `DamageSystem` emits `combat:hitLanded`; `EffectsManager`
> listens and produces all hit feedback. Knockback is owned by DamageSystem,
> not by effects.

## The feedback model

One `combat:hitLanded { attacker, target, amount, critical }` produces, in
order, this stack:

| # | Effect | Normal hit | Critical hit |
|---|--------|-----------|--------------|
| 1 | Impact particles | 10 warm sparks | 16 brighter, faster sparks |
| 2 | Victim flash | red tint blink (90 ms) | white tint blink (90 ms) |
| 3 | Damage number | white, rises + fades (750 ms) | gold, 1.5×, with `!` |
| 4 | Hit pause | ~45 ms world freeze | ~70 ms world freeze |
| 5 | Screen shake | +0.28 trauma | +0.55 trauma |

Design intent: every hit is *felt* (pause + flash + spark), but no single
channel dominates. Crits escalate all five channels at once so they read as
"special" without any one effect getting gaudy.

Other feedback entry points (called directly, not via the bus):

- `burst(x, y, kind)` — `'breakable'` (amber shards), `'levelup'` (gold,
  rises), `'save'` (pale blue, drifts up), `'death'` (dark red burst).
- `spawnLandDust(x, y)` — landing puff; wired by Wave 3 (see checklist).
- `screenShake(intensity, ms)` / `hitPause(ms)` — also public for scripted
  moments (boss slams, explosions). Still clamped by the budgets below.

## Budgets (LAW — enforced in code, tested in CI)

- **≤ 400 live particles** (`EffectBudgets.MAX_PARTICLES`). Pool exhaustion
  silently drops new particles; never steals live ones.
- **≤ 24 live damage numbers** (`EffectBudgets.MAX_DAMAGE_NUMBERS`). The
  25th concurrent number is dropped.
- **Hit pause ≤ 90 ms** (`EffectBudgets.MAX_HIT_PAUSE`). `hitPause()` clamps;
  repeated hits *refresh* rather than stack the timer.
- **≤ 32 concurrent hit flashes** (fixed array; extras dropped).

Pools are preallocated on `attachScene()` (400 `Image` + 24 `Text` views,
all hidden). `update()` allocates nothing: fixed slot arrays, stable
per-slot callbacks, no closures in the hot path.

## Implementation notes

- **Manual particle integration, not Phaser emitters.** Each particle is a
  plain state record (`x, y, vx, vy, life, tint, gravity, drag`) integrated
  in `update()` and synced to a pooled `Image`. Deterministic, zero
  allocation, and headless-testable.
- **Damage numbers** are pooled world-space `Phaser.Text` (10 px monospace,
  dark stroke). They float up 26 px and fade over 750 ms. Bitmap-text can
  replace them later without changing the API.
- **Hit pause** zeroes the bound scene's `time.timeScale` and
  `physics.world.timeScale`, then restores the previous values when the
  timer elapses. `update()` receives **real (unscaled) delta** from GameScene,
  so the countdown always completes even while the world is frozen.
- **Screen shake** is trauma-based: `screenShake()` adds 0–1 trauma
  (saturating), trauma decays ~1.4/s, and while trauma > 0.02 the manager
  re-fires `camera.shake()` every ~90 ms with intensity ∝ trauma. Repeated
  hits feel continuous instead of restarting the shake.
- **Victim registry.** The event catalog carries string ids, not sprites, so
  `EffectsManager` keeps a runtime map: `registerVictim(id, sprite)` /
  `unregisterVictim(id)`. Registration keys: enemy `instanceId`, boss
  `instanceId`, `'player'` for Lucien. A missing/unknown id degrades
  gracefully (particles/number/shake/pause still fire; the flash is skipped).
- **Textures.** Particle kinds reference the boot fx pack
  (`fx_hit_spark`, `fx_slash_arc`, `fx_dust_puff`). At attach time, missing
  keys fall back to a generated 8 px dot (`__fx_dot`) via
  `assetManager.getTexture`-style existence checks — the game never breaks
  on a missing fx texture.
- **Settings.** `gameState.settings.screenShake === false` makes
  `screenShake()` a no-op and zeroes trauma; `damageNumbers === false`
  makes `spawnDamageNumber()` a no-op. Read live on every call (no caching).
- **Tuning.** Hit-pause length reads `tuning.combat.hitPauseMs` if a future
  tuning pass adds it (W2-PLAYER owns `tuning.js`); otherwise 45 ms normal /
  70 ms crit. All feel numbers live in `src/effects/index.js` next to
  `PARTICLE_KINDS` until the feel pass moves them into tuning.

## Wave 3 hookup checklist

GameScene / RoomManager / Enemy / Player must do these five things:

1. **`effectsManager.attachScene(scene)`** — once, in GameScene `create()`
   (before RoomManager loads the first room). Preallocates all views.
2. **`effectsManager.update(delta)`** — every frame in GameScene `update()`,
   passing the **raw, unscaled** `delta` (ms). Do not pass a scaled delta;
   hit-pause countdowns depend on real time.
3. **`registerVictim(id, sprite)` / `unregisterVictim(id)`**
   - `Enemy`: register on spawn with its `instanceId`, unregister on destroy.
   - `Player`: register on spawn with id `'player'`, unregister on destroy.
   - `Boss`: register on spawn with its `instanceId`.
   - The sprite must expose `x`, `y` (and ideally `displayHeight`) plus
     `setTintFill` / `clearTint` for the flash.
4. **Land dust** — in the movement/animation land hook
   (`PlayerMovement` land state or `PlayerAnimation` on land), call
   `effectsManager.spawnLandDust(playerX, playerY)` at the feet position.
5. **Room teardown** — on `RoomManager` room swap, call
   `effectsManager.detachViews()` to release all live particles/numbers and
   clear flashes (views are rebuilt on the next `attachScene`, or re-use
   `attachScene` — it detaches first).

Nothing else is required: `combat:hitLanded` → feedback is already wired
through the singleton's bus subscription. Do **not** call `burst`,
`hitPause`, or `screenShake` from combat code — that path belongs to the
event.

## Verification status

- ✅ Headless: 33 vitest tests pass (`test/effects.test.js`) — pool
  acquire/release caps, pool exhaustion behavior, damage-number cap (24),
  hit-pause clamp (≤ 90 ms) + freeze/restore of scene time scales, trauma
  add/decay/saturation, settings gating (both off-states), victim
  register/unregister, full `combat:hitLanded` → flash/number/shake/pause
  mapping on an isolated bus with fake scene + fake victim sprite, graceful
  degradation on unknown target ids and destroyed-mid-flash sprites.
- ⚠️ Needs eyes-on: actual visual feel (spark density vs. 480×270 playfield,
  flash color readability against enemy palettes, shake intensity at real
  frame rates, damage-number legibility at 10 px). The numbers above are
  starting points for the Wave 6 feel pass, not final art direction.
- ⚠️ Needs a browser run: `camera.shake()` behavior under the real camera
  follow, `time.timeScale = 0` interaction with active tweens/timers, and
  the generated `__fx_dot` fallback path when the boot fx pack is absent.
