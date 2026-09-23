/**
 * PauseMenuController — pause menu state machine (Wave 5, W5-UI).
 *
 * Headless-safe: no Phaser import. GameScene wraps open()/close() with
 * UiStack ({ screen:'pause' }) so the §14 pause ref-count freezes the world.
 *
 * Items: RESUME | INVENTORY | MAP | SETTINGS | SAVE | QUIT TO TITLE.
 * Actions are injected (GameScene implements them against the real scene);
 * the controller only tracks focus and dispatches.
 *
 * Navigation: move_up/move_down focus, confirm activates, cancel resumes.
 * Gamepad works through the same actions (d-pad/stick + A/B).
 */
import { inputManager } from '../../core/InputManager.js';
import { InkCss, drawGothicPanel, gothicText, panelHeader } from '../gothic.js';

export const PAUSE_ITEMS = Object.freeze([
  { id: 'resume', label: 'RESUME' },
  { id: 'inventory', label: 'INVENTORY' },
  { id: 'map', label: 'MAP' },
  { id: 'settings', label: 'SETTINGS' },
  { id: 'save', label: 'SAVE' },
  { id: 'quit', label: 'QUIT TO TITLE' },
]);

export class PauseMenuController {
  /**
   * @param {object} [deps]
   * @param {object} [deps.input] InputManager-like
   * @param {object} [deps.actions] { resume, openInventory, openMap,
   *   openSettings, openSave, quitToTitle } — each () -> void
   * @param {Function} [deps.onViewChanged] () -> void
   */
  constructor(deps = {}) {
    this.input = deps.input ?? inputManager;
    this.actions = {
      resume: () => {},
      openInventory: () => {},
      openMap: () => {},
      openSettings: () => {},
      openSave: () => {},
      quitToTitle: () => {},
      ...(deps.actions ?? {}),
    };
    this.onViewChanged = deps.onViewChanged ?? (() => {});
    this._open = false;
    this._focus = 0;
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  /** @returns {string} focused item id */
  get focus() {
    return PAUSE_ITEMS[this._focus].id;
  }

  /** @returns {boolean} false when already open */
  open() {
    if (this._open) return false;
    this._open = true;
    this._focus = 0;
    this._notify();
    return true;
  }

  /** @returns {boolean} */
  close() {
    if (!this._open) return false;
    this._open = false;
    return true;
  }

  /** Poll input. */
  update() {
    if (!this._open) return;
    const pressed = (a) => {
      try {
        return this.input.justPressed(a) === true;
      } catch {
        return false;
      }
    };
    if (pressed('cancel')) {
      this.actions.resume();
      return;
    }
    if (pressed('move_up')) {
      this._focus = (this._focus + PAUSE_ITEMS.length - 1) % PAUSE_ITEMS.length;
      this._notify();
    } else if (pressed('move_down')) {
      this._focus = (this._focus + 1) % PAUSE_ITEMS.length;
      this._notify();
    } else if (pressed('confirm')) {
      const id = PAUSE_ITEMS[this._focus].id;
      const fn = this.actions[id === 'quit' ? 'quitToTitle' : id];
      try {
        fn?.();
      } catch (err) {
        console.error(`[PauseMenu] action '${id}' threw:`, err);
      }
    }
  }

  /** @returns {object|null} view data for renderPauseMenu() */
  getView() {
    if (!this._open) return null;
    return {
      items: PAUSE_ITEMS.map((i) => i.label),
      focus: this._focus,
    };
  }

  /** @private */
  _notify() {
    try {
      this.onViewChanged();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Render the pause menu (duck-typed scene; no Phaser import).
 * @param {object} scene @param {object} view getView() output
 * @returns {object} container
 */
export function renderPauseMenu(scene, view) {
  const W = 480;
  const H = 270;
  const pw = 220;
  const ph = 24 + view.items.length * 22 + 30;
  const px = (W - pw) / 2;
  const py = (H - ph) / 2;
  const root = scene.add.container(0, 0).setDepth(1700).setScrollFactor(0);
  // dim the world behind the menu
  const shade = scene.add.graphics();
  shade.fillStyle(0x060409, 0.72);
  shade.fillRect(0, 0, W, H);
  root.add(shade);
  const g = scene.add.graphics();
  drawGothicPanel(g, px, py, pw, ph);
  root.add(g);
  let y = panelHeader(g, scene, px, py + 4, pw, 'VESPER');
  view.items.forEach((label, i) => {
    const focused = i === view.focus;
    if (focused) {
      const hg = scene.add.graphics();
      hg.fillStyle(0x2a2140, 0.95);
      hg.fillRect(px + 12, y - 2, pw - 24, 19);
      root.add(hg);
    }
    const t = gothicText(scene, px + pw / 2, y, `${focused ? '❖ ' : ''}${label}`, {
      size: '10px',
      color: focused ? InkCss.goldBright : InkCss.ink,
      spacing: 2,
    });
    t.setOrigin(0.5, 0);
    root.add(t);
    y += 22;
  });
  const hint = gothicText(scene, px + pw / 2, py + ph - 14, 'confirm choose · cancel resume', {
    size: '7px',
    color: InkCss.faint,
    mono: true,
  });
  hint.setOrigin(0.5, 0);
  root.add(hint);
  return root;
}
