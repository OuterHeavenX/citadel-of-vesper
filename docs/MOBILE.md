# MOBILE — The Citadel of Vesper

> Desktop/controller is primary. Touch is optional but real (spec §41).

## Touch controls

- Shown only when `inputManager.device === 'touch'`.
- Left: virtual stick/d-pad. Right: Jump, Attack, Secondary, Dash, Ability.
- Virtual buttons drive the SAME action pipeline (`setTouchAction`).
- Layout respects safe areas (`viewport-fit=cover`, CSS env insets);
  no critical controls under browser chrome or notches.

## Responsive

- Internal 480×270; `Phaser.Scale.RESIZE` + integer zoom where practical.
- 16:9, 16:10, ultrawide, browser resize, fullscreen — pixel art never
  stretched or blurred (`pixelArt: true`, `roundPixels: true`).
- Primary desktop test: 1280×800 (Steam Deck).

## PWA

- `public/manifest.json` + `public/service-worker.js`: installable,
  launches like a standalone game, caches the app shell.
- Service worker NEVER caches or touches save data (IndexedDB).

## Open (Wave 5)

- Touch button sizing/positioning pass on real devices.
- iOS Safari audio-unlock and performance verification.
