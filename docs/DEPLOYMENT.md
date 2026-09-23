# DEPLOYMENT — The Citadel of Vesper

> GitHub Pages via GitHub Actions (spec §4).

## Pipeline

`.github/workflows/deploy.yml` — on push to `main` (or manual dispatch):

1. `npm ci`
2. `npm run validate` — data schemas, cross-refs, world connectivity
3. `npm run test` — vitest suites
4. `npm run build` — (also runs validate first; fails the build on red)
5. Upload `dist/` → deploy to GitHub Pages (official `deploy-pages` action)

Concurrency: one deploy at a time (`group: pages`, cancel in-progress).

## Configuration

- `vite.config.js`: `base: '/citadel-of-vesper/'` (project Pages site),
  `dist/` output, Phaser split into its own chunk.
- Live URL: https://outerheavenx.github.io/citadel-of-vesper/
- Version shown on title screen; `CHANGELOG.md` tracks releases.

## Repo setup (Jimmy — human step)

The automation token cannot create repos or enable Pages. Jimmy must:

1. Create repo `citadel-of-vesper` under `OuterHeavenX` on GitHub.
2. Push the Wave 0 local repo: `git remote add origin … && git push -u origin main`.
3. Settings → Pages → Deploy from **GitHub Actions** (the workflow uses
   the official Pages deployment, not branch publishing).
4. Confirm the live URL loads.

## Local verification

```
npm install
npm run dev      # http://localhost:5173
npm run validate # data + world checks
npm run test     # vitest
npm run build    # → dist/
```
