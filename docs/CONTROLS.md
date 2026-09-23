# CONTROLS — The Citadel of Vesper

> Contract for `src/core/InputManager.js`. Game code reads ACTIONS, never
> raw inputs. Prompts are device-aware via `inputManager.getPrompt(action)`.

## Actions

`move_left, move_right, move_up, move_down, crouch, jump, attack, secondary,
dash, ability, ability2, map, inventory, pause, confirm, cancel,
menu_tab_next, menu_tab_prev, quick_use`

## Keyboard (defaults, remappable in Wave 5+)

| Action | Keys |
|---|---|
| Move | WASD / Arrow keys |
| Crouch | S / ↓ |
| Jump | Space (alt: Z) |
| Attack | J (alt: X) |
| Secondary attack | K (alt: C) |
| Dash (backdash) | Shift (alt: L) |
| Ability / Ability 2 | U / I (alts: V / B) |
| Map | Tab (alt: M) |
| Inventory | E (alt: I — context: menus vs gameplay) |
| Quick use | F (drinks `settings.quickUseItemId`, default Ember Tonic) |
| Pause | Esc (alt: P) |
| Confirm / Cancel | Enter · Space · J / Esc · K |
| Menu tab next / prev | E / Q (alts: ] / [) |

Notes:
- `Tab` is captured with `preventDefault` (focus would otherwise leave the canvas).
- Debug overlay toggle: Backquote (dev builds only).
- Bindings are data (`DEFAULT_KEYBOARD_BINDINGS`); remapping persists via
  SaveManager settings store.

## Gamepad (standard mapping, Xbox-style default)

| Action | Input |
|---|---|
| Move | Left stick / D-pad |
| Jump | A (button 0) |
| Attack | X (button 2) |
| Secondary attack | Y (button 3) |
| Dash | B (button 1) |
| Ability / Ability 2 | LB / RB (buttons 4 / 5) |
| Special abilities | LT (button 6) |
| Map | View (button 8) |
| Inventory / Pause | Menu (button 9) |
| Quick use | RT (button 7) |
| Menu confirm / cancel | A / B |
| Menu tabs | RB / LB |

- Poll every frame in `InputManager.update()`; handle
  `gamepadconnected` / `gamepaddisconnected`.
- PlayStation controllers: same mapping, PlayStation glyphs in prompts
  (device id `gamepad-playstation` distinguishes ✕/○/□/△).
- Steam Deck: browser exposes it as a standard gamepad; device id
  `steamdeck` is detected via UA + gamepad id heuristics. **No keyboard
  or mouse required after launch** (spec §69).

## Device detection (spec §14)

- `inputManager.device` tracks the most recently used device:
  `keyboard | gamepad-xbox | gamepad-playstation | steamdeck | touch`.
- Changes emit `input:deviceChanged { device }`; UI re-renders prompts.
- Detection: any keydown → keyboard; any gamepad button/axis activity →
  gamepad-*; first touchstart → touch.

## Touch (spec §41, mobile-first but secondary)

- Shown ONLY when `device === 'touch'` (never alongside keyboard/gamepad).
- Layout: left virtual stick/d-pad; right buttons: Jump, Attack, Secondary,
  Dash, Ability.
- Virtual buttons call `inputManager.setTouchAction(action, down)` — the
  SAME action pipeline as physical inputs.
- Respect mobile safe areas (`viewport-fit=cover` + CSS env insets); no
  critical controls under browser chrome.

## Menu navigation (controller-complete, spec §13)

All screens: `move_up/down` move focus, `confirm` activates, `cancel`
backs out, `menu_tab_next/prev` switch tabs. Focus must always be visible
(high-contrast focus ring — accessibility requirement for Wave 5 UI).
