/**
 * EndScreenController — game-over and victory screens (Wave 5, W5-UI).
 *
 * Headless-safe: no Phaser import. One state machine, two modes:
 *   - 'gameover': shown on `player:died`. The world is paused via UiStack
 *     ({ screen:'gameover' }). Options: RESPAWN AT LAST SAVE | RETURN TO
 *     TITLE. GameScene plays the 'gameover' stinger ("The Last Bell") on open.
 *   - 'victory': shown on `boss:died` for the Sable Matriarch (post-Matriarch).
 *     Options: CONTINUE THE HUNT | RETURN TO TITLE. GameScene plays the
 *     'victory' stinger ("Dawn After Vesper") on open.
 *
 * Respawn/continue/title are injected actions — the controller only tracks
 * focus and dispatches. Navigation: move_up/move_down + confirm; cancel
 * maps to the primary option (respawn / continue).
 */
import { inputManager } from '../../core/InputManager.js';
import { InkCss, drawGothicPanel, gothicText } from '../gothic.js';

const MODES = Object.freeze({
  gameover: {
    title: 'THE BELL TOLLS',
    subtitle: 'Lucien Vale has fallen. The Citadel keeps his echo.',
    options: [
      { id: 'respawn', label: 'RESPAWN AT LAST SAVE' },
      { id: 'title', label: 'RETURN TO TITLE' },
    ],
    accent: '#c0505c',
  },
  victory: {
    title: 'VESPER FALLS SILENT',
    subtitle: 'The Sable Matriarch is unmade. Dawn remembers your name.',
    options: [
      { id: 'continue', label: 'CONTINUE THE HUNT' },
      { id: 'title', label: 'RETURN TO TITLE' },
    ],
    accent: '#e8c95a',
  },
});

export class EndScreenController {
  /**
   * @param {object} [deps]
   * @param {object} [deps.input] InputManager-like
   * @param {object} [deps.actions] { respawn, continue, quitToTitle }
   * @param {Function} [deps.onViewChanged] () -> void
   */
  constructor(deps = {}) {
    this.input = deps.input ?? inputManager;
    this.actions = {
      respawn: () => {},
      continue: () => {},
      quitToTitle: () => {},
      ...(deps.actions ?? {}),
    };
    this.onViewChanged = deps.onViewChanged ?? (() => {});
    this._open = false;
    this._mode = null;
    this._focus = 0;
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  /** @returns {'gameover'|'victory'|null} */
  get mode() {
    return this._mode;
  }

  /**
   * @param {'gameover'|'victory'} mode
   * @returns {boolean} false when already open or mode unknown
   */
  open(mode) {
    if (this._open || !MODES[mode]) return false;
    this._open = true;
    this._mode = mode;
    this._focus = 0;
    this._notify();
    return true;
  }

  /** @returns {boolean} */
  close() {
    if (!this._open) return false;
    this._open = false;
    this._mode = null;
    return true;
  }

  /** Poll input. */
  update() {
    if (!this._open || !this._mode) return;
    const opts = MODES[this._mode].options;
    const pressed = (a) => {
      try {
        return this.input.justPressed(a) === true;
      } catch {
        return false;
      }
    };
    if (pressed('move_up')) {
      this._focus = (this._focus + opts.length - 1) % opts.length;
      this._notify();
    } else if (pressed('move_down')) {
      this._focus = (this._focus + 1) % opts.length;
      this._notify();
    } else if (pressed('confirm') || pressed('cancel')) {
      // cancel maps to the primary (first) option — no accidental quits
      const id = pressed('cancel') ? opts[0].id : opts[this._focus].id;
      const fn = this.actions[id === 'title' ? 'quitToTitle' : id];
      try {
        fn?.();
      } catch (err) {
        console.error(`[EndScreen] action '${id}' threw:`, err);
      }
    }
  }

  /** @returns {object|null} view data for renderEndScreen() */
  getView() {
    if (!this._open || !this._mode) return null;
    const m = MODES[this._mode];
    return {
      mode: this._mode,
      title: m.title,
      subtitle: m.subtitle,
      accent: m.accent,
      options: m.options.map((o) => o.label),
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
 * Render the end screen (duck-typed scene; no Phaser import).
 * @param {object} scene @param {object} view getView() output
 * @returns {object} container
 */
export function renderEndScreen(scene, view) {
  const W = 480;
  const H = 270;
  const root = scene.add.container(0, 0).setDepth(1800).setScrollFactor(0);
  const shade = scene.add.graphics();
  shade.fillStyle(view.mode === 'victory' ? 0x0a0805 : 0x0a0508, 0.88);
  shade.fillRect(0, 0, W, H);
  root.add(shade);

  const title = gothicText(scene, W / 2, 84, view.title, {
    size: '22px',
    color: view.accent,
    spacing: 6,
  });
  title.setOrigin(0.5, 0);
  root.add(title);
  const sub = gothicText(scene, W / 2, 122, view.subtitle, {
    size: '9px',
    color: InkCss.dim,
    wrap: 380,
    align: 'center',
  });
  sub.setOrigin(0.5, 0);
  root.add(sub);

  const pw = 300;
  const px = (W - pw) / 2;
  let y = 168;
  view.options.forEach((label, i) => {
    const focused = i === view.focus;
    if (focused) {
      const hg = scene.add.graphics();
      drawGothicPanel(hg, px, y - 4, pw, 22);
      root.add(hg);
    }
    const t = gothicText(scene, W / 2, y, `${focused ? '❖ ' : ''}${label}`, {
      size: '10px',
      color: focused ? InkCss.goldBright : InkCss.ink,
      spacing: 2,
    });
    t.setOrigin(0.5, 0);
    root.add(t);
    y += 28;
  });
  return root;
}
