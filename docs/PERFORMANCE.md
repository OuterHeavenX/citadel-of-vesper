# PERFORMANCE — The Citadel of Vesper

> Target: 60 FPS on modest hardware (spec §10). Steam Deck at 1280×800.

## Budgets (Wave 0 — refine with profiler data)

- Active enemies: ≤ 12 per room. Projectiles pooled (≤ 64). Particles ≤ 400.
- Texture memory: atlases per region; drop unused packs on region change.
- Draw calls: tilemap layers + entities; parallax ≤ 4 layers.

## Rules

- Only the current room is live; neighbors = metadata + preload.
- Object pooling: projectiles, particles, damage numbers, hit sparks.
- No allocation in `update()` loops (no `new Vector`, no closures per frame
  in hot paths).
- Off-camera: enemies sleep (no AI/collision), animations pause,
  projectiles skip collision.
- Efficient collision: Arcade Physics with tight body sizes; spatial
  partitioning if rooms grow dense (Wave 3 measures first).
- DebugOverlay profiler (FPS, frame time, active counts, texture estimate,
  audio sources) is the early-warning system — check it every wave.

## Measurement

- `npm run dev` + Backquote overlay. Record FPS in the QA report (Wave 6).
- Browser pass: Chrome, Edge, Firefox; fullscreen; resize; tab switch.
