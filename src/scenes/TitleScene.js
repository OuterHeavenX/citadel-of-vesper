/**
 * TitleScene — original gothic title screen (text-based for Wave 1; the art
 * pass lands in Wave 5).
 *
 * Menu: NEW GAME / CONTINUE / LOAD (slots). Fully navigable with keyboard
 * AND gamepad through InputManager actions (move_up/move_down, confirm,
 * cancel). Prompt hints re-render on `input:deviceChanged`.
 *
 * Flows:
 * - NEW GAME  -> gameState.reset() -> Game scene (Moonlit Gate start)
 * - CONTINUE  -> read last-used slot -> hydrate -> Game scene
 * - LOAD      -> slot submenu (1-3 w/ summary) -> hydrate -> Game scene
 */
import Phaser from 'phaser';
import { gameState } from '../core/GameState.js';
import { saveManager } from '../core/SaveManager.js';
import { inputManager } from '../core/InputManager.js';
import { audioManager } from '../core/AudioManager.js';
import { eventBus } from '../core/EventBus.js';
import { SceneKeys } from './index.js';
import { GAME_VERSION } from '../config/gameConfig.js';

const INK = '#d8d4e8'; // pale lavender-gray
const GOLD = '#c9a227'; // vesper gold
const DIM = '#5c5878'; // muted slate
const BLOOD = '#8e2f3c'; // deep red accent

function formatPlayTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export class TitleScene extends Phaser.Scene {
  constructor() {
    super({ key: SceneKeys.TITLE });
    this._menu = ['new', 'continue', 'load'];
    this._index = 0;
    this._mode = 'main'; // 'main' | 'slots'
    this._slotIndex = 0;
    this._slotInfos = [];
    this._texts = [];
    this._hintText = null;
    this._continueAvailable = false;
  }

  create() {
    const { width, height } = this.scale;

    // --- backdrop: Wave 5 title art, gradient fallback ---
    this.cameras.main.setBackgroundColor('#0b0d1a');
    if (this.textures.exists('bg_title')) {
      this.add.image(0, 0, 'bg_title').setOrigin(0, 0).setDepth(-10);
      // readability scrim behind the title block + menu
      const scrim = this.add.graphics().setDepth(-9);
      scrim.fillGradientStyle(0x060814, 0x060814, 0x060814, 0x060814, 0.72, 0.72, 0.25, 0.25);
      scrim.fillRect(0, 0, width, height);
      // slow moon-glow pulse over the painted moon (right side)
      const glow = this.add.graphics().setDepth(-8);
      glow.fillStyle(0xdfe8ff, 0.10);
      glow.fillCircle(336, 60, 44);
      this.tweens.add({
        targets: glow, alpha: { from: 0.55, to: 1 },
        duration: 2600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
      // drifting ash motes
      try {
        if (!this.textures.exists('fx_title_ash')) {
          const g = this.make.graphics({ x: 0, y: 0, add: false });
          g.fillStyle(0xd8d4e8, 1);
          g.fillCircle(1, 1, 1);
          g.generateTexture('fx_title_ash', 2, 2);
          g.destroy();
        }
        const ash = this.add.particles(0, 0, 'fx_title_ash', {
          x: { min: 0, max: width },
          y: { min: -10, max: height },
          lifespan: { min: 5000, max: 9000 },
          speedY: { min: 4, max: 12 },
          speedX: { min: -10, max: -3 },
          alpha: { min: 0.1, max: 0.4 },
          scale: { min: 0.5, max: 1.2 },
          frequency: 500,
        });
        ash.setDepth(-8);
      } catch { /* ash is cosmetic */ }
    } else {
      const g = this.add.graphics();
      g.fillGradientStyle(0x141224, 0x141224, 0x0b0d1a, 0x0b0d1a, 1);
      g.fillRect(0, 0, width, height);
    }
    // thin gold rules above/below the title block
    const g = this.add.graphics();
    g.lineStyle(1, 0xc9a227, 0.35);
    g.lineBetween(70, 96, width - 70, 96);
    g.lineBetween(70, 118, width - 70, 118);

    // --- title block ---
    this.add.text(width / 2, 52, 'THE CITADEL OF VESPER', {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontSize: '30px',
      color: GOLD,
      letterSpacing: 4,
    }).setOrigin(0.5);
    this.add.text(width / 2, 78, '· ❖ ·', {
      fontFamily: 'Georgia, serif',
      fontSize: '12px',
      color: BLOOD,
    }).setOrigin(0.5);
    this.add.text(width / 2, 106, GAME_VERSION, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontSize: '11px',
      color: DIM,
      letterSpacing: 3,
    }).setOrigin(0.5);

    this._refreshSlots().then(() => this._renderMenu());

    this._hintText = this.add.text(width / 2, height - 18, '', {
      fontFamily: 'Georgia, serif',
      fontSize: '11px',
      color: DIM,
    }).setOrigin(0.5);
    this._renderHints();

    this._unsubDevice = eventBus.on('input:deviceChanged', () => this._renderHints());
    this.events.once('shutdown', () => this._unsubDevice?.());

    // Title theme (original composition; queued until first user gesture
    // unlocks the AudioContext).
    audioManager.playMusic('title_theme');
  }

  update() {
    inputManager.update();
    if (this._mode === 'main') this._updateMain();
    else this._updateSlots();
  }

  // ------------------------------------------------------------- data

  async _refreshSlots() {
    try {
      this._slotInfos = await saveManager.listSlots();
    } catch {
      this._slotInfos = [];
    }
    const last = saveManager.getLastSlot();
    this._continueAvailable = !!this._slotInfos.find((s) => s.slot === last && s.exists && !s.corrupt);
  }

  // ------------------------------------------------------------- render

  _clearMenuTexts() {
    for (const t of this._texts) t.destroy();
    this._texts = [];
  }

  _menuLabel(key) {
    if (key === 'new') return 'NEW GAME';
    if (key === 'continue') return this._continueAvailable ? 'CONTINUE' : 'CONTINUE';
    return 'LOAD GAME';
  }

  _renderMenu() {
    this._clearMenuTexts();
    const { width } = this.scale;
    const startY = 152;
    this._menu.forEach((key, i) => {
      const selected = i === this._index;
      const disabled = key === 'continue' && !this._continueAvailable;
      const label = (selected ? '❖ ' : '   ') + this._menuLabel(key);
      const t = this.add.text(width / 2, startY + i * 30, label, {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: '16px',
        color: disabled ? '#3a3850' : selected ? GOLD : INK,
        letterSpacing: 3,
      }).setOrigin(0.5);
      this._texts.push(t);
    });
    this._renderHints();
  }

  _renderSlots() {
    this._clearMenuTexts();
    const { width } = this.scale;
    const header = this.add.text(width / 2, 140, '— CHOOSE A SLOT —', {
      fontFamily: 'Georgia, serif', fontSize: '12px', color: DIM, letterSpacing: 3,
    }).setOrigin(0.5);
    this._texts.push(header);
    this._slotInfos.forEach((info, i) => {
      const selected = i === this._slotIndex;
      let detail;
      if (!info.exists) detail = 'empty';
      else if (info.corrupt) detail = 'corrupt';
      else detail = `${info.playerName ?? 'Lucien Vale'} · Lv ${info.level ?? 1} · ${formatPlayTime(info.playTime)}`;
      const label = `${selected ? '❖' : ' '} SLOT ${info.slot} — ${detail}`;
      const t = this.add.text(width / 2, 168 + i * 24, label, {
        fontFamily: 'Georgia, serif',
        fontSize: '13px',
        color: info.exists && !info.corrupt ? (selected ? GOLD : INK) : (selected ? '#8e2f3c' : DIM),
      }).setOrigin(0.5);
      this._texts.push(t);
    });
    this._renderHints();
  }

  _renderHints() {
    if (!this._hintText) return;
    const up = inputManager.getPrompt('move_up');
    const down = inputManager.getPrompt('move_down');
    const ok = inputManager.getPrompt('confirm');
    const back = inputManager.getPrompt('cancel');
    this._hintText.setText(`${up}${down} navigate · ${ok} select · ${back} back`);
  }

  // ------------------------------------------------------------- input

  _updateMain() {
    if (inputManager.justPressed('move_up')) {
      this._index = (this._index + this._menu.length - 1) % this._menu.length;
      this._renderMenu();
    } else if (inputManager.justPressed('move_down')) {
      this._index = (this._index + 1) % this._menu.length;
      this._renderMenu();
    } else if (inputManager.justPressed('confirm')) {
      this._activateMain(this._menu[this._index]);
    }
  }

  _activateMain(key) {
    if (key === 'new') {
      gameState.reset();
      this.scene.start(SceneKeys.GAME);
    } else if (key === 'continue') {
      if (!this._continueAvailable) return;
      this._loadSlot(saveManager.getLastSlot());
    } else if (key === 'load') {
      this._mode = 'slots';
      this._slotIndex = 0;
      this._renderSlots();
    }
  }

  _updateSlots() {
    if (inputManager.justPressed('move_up')) {
      this._slotIndex = (this._slotIndex + this._slotInfos.length - 1) % this._slotInfos.length;
      this._renderSlots();
    } else if (inputManager.justPressed('move_down')) {
      this._slotIndex = (this._slotIndex + 1) % this._slotInfos.length;
      this._renderSlots();
    } else if (inputManager.justPressed('cancel')) {
      this._mode = 'main';
      this._renderMenu();
    } else if (inputManager.justPressed('confirm')) {
      const info = this._slotInfos[this._slotIndex];
      if (info && info.exists && !info.corrupt) this._loadSlot(info.slot);
    }
  }

  async _loadSlot(slot) {
    const save = await saveManager.read(slot);
    if (!save) return; // slot vanished; stay on title
    gameState.hydrate(save);
    saveManager.setLastSlot(slot);
    this.scene.start(SceneKeys.GAME);
  }
}
