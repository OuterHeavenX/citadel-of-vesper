# The Citadel of Vesper

An **original** 32-bit gothic action-RPG / metroidvania for the browser —
built with **Phaser 3 + Vite + ES modules**. No installation, no executable:
open the URL and play.

**Play it:** https://outerheavenx.github.io/citadel-of-vesper/
**Version:** v0.1.0 ALPHA (Wave 0 — architecture scaffold; gameplay lands in Waves 1–7)

> **Originality:** everything here — characters, story, art, music, names —
> is created for this project. It is inspired by the *design philosophy* of
> classic 32-bit gothic action-RPGs, never by their copyrighted content.
> See `docs/ARCHITECTURE.md` §0.

## The game

Lucien Vale, disgraced scion of an ancient order, enters a fortress-city
that appeared during a celestial event — a place his bloodline is tied to.
Explore the interconnected Citadel, master responsive combat, experiment
with equipment, uncover secrets, and earn traversal abilities that reopen
old areas. Late game reveals the **Two Ages of Vesper**: the Living
Citadel and the Ruined Citadel.

## Controls

| Action | Keyboard | Gamepad (Xbox-style) |
|---|---|---|
| Move | WASD / Arrows | Left stick / D-pad |
| Jump | Space | A |
| Attack | J | X |
| Secondary | K | Y |
| Dash | Shift | B |
| Abilities | U / I | LB / RB |
| Map | Tab | View |
| Inventory | E | Menu |
| Pause | Esc | Menu |

Touch controls appear automatically on touch devices. Full details:
`docs/CONTROLS.md`.

## Browser requirements

Chrome, Edge, Firefox, Safari (modern versions). Desktop + controller is
the primary experience; Steam Deck browser supported at 1280×800.

## Local development

```bash
npm install
npm run dev      # → http://localhost:5173
npm run validate # data schemas + world connectivity
npm run test     # vitest suites
npm run build    # → dist/
```

The repo is usable immediately after cloning — no extra setup.

## Architecture

Modular ES modules under `src/` (see `docs/ARCHITECTURE.md` — the contract
bible for all wave agents):

- `core/` — EventBus, GameState, SaveManager (IndexedDB), InputManager,
  AudioManager, AssetManager
- `player/` — Lucien: movement, combat, stats, animation (facade: `Player`)
- `combat/` — DamageSystem (only damage path), HitboxSystem,
  ProjectileSystem, StatusEffects
- `rooms/` + `world/` — streaming RoomManager, world validation
- `data/` — JSON content with schemas (`data/schemas/`), validated in CI

Every push to `main` runs validate → test → build → GitHub Pages deploy
(`.github/workflows/deploy.yml`). Nothing deploys on red.

## Project status / roadmap

Wave 0 (this repo): scaffold, contracts, schemas, docs.
Waves 1–7 build the **Moonlit Gate → Hollow Keep** vertical slice
(15–25 rooms, 8 enemies, Chapel Warden miniboss, Sable Matriarch boss,
Moonrise Leap traversal ability). See `docs/ROADMAP.md` and
`docs/GAME_DESIGN.md`.

## Known limitations (Wave 0)

- No gameplay yet — this is the architecture milestone.
- Placeholder art/audio pipeline only (`assets/README.md`).
- Repo remote + Pages enablement are Jimmy's manual step (see
  `docs/DEPLOYMENT.md`).

## License

MIT — see `LICENSE`.
