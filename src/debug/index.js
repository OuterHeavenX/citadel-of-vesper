/**
 * DebugOverlay — dev-only overlay + commands (ARCHITECTURE §16, spec §53/§55).
 *
 * CONTRACT:
 * - Toggle: Backquote (`) in DEV builds only. Never compiled into production
 *   (main.js only imports this module when import.meta.env.DEV).
 * - Readout: FPS, frame time, room id, player x/y, active enemies/projectiles/
 *   particles, texture memory estimate, audio sources.
 * - Toggles: draw collision (arcade physics debug), draw hitboxes.
 * - Commands emit 'debug:command' { command, args }; the built-ins below are
 *   routed through REAL public APIs (gameState / saveManager) — never
 *   backdoors. Commands whose systems don't exist yet (Wave 2/3) report
 *   "no handler yet" instead of faking it.
 */
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { saveManager } from '../core/SaveManager.js';

export const DebugCommands = Object.freeze([
  'godmode', 'teleport', 'give', 'xp', 'unlock',
  'spawn', 'boss', 'revealmap', 'heal', 'mana', 'save',
]);

export const DEBUG_TOGGLE_KEY = 'Backquote';

const PENDING = {
  godmode: 'Player lands in Wave 2',
  xp: 'PlayerStats lands in Wave 2',
  spawn: 'EnemyFactory lands in Wave 2',
  revealmap: 'MapModel lands in Wave 3',
  // NOTE: 'boss' and 'teleport' are handled by GameScene via the 'debug:command'
  // bus event (W4-BOSS / W6-QA): `boss <bossId>` loads the boss arena through
  // the real room pipeline; `teleport <roomId>` loads any room the same way.
  // The cases below just acknowledge the handoff.
};

export class DebugOverlay {
  /** @param {Phaser.Game} game */
  constructor(game) {
    if (!import.meta.env.DEV) return; // never wire in production
    this.game = game;
    this.visible = false;
    this.collisionDebug = false;
    this.hitboxDebug = false;
    this._panel = null;
    this._readout = null;
    this._log = null;
    this._input = null;
    this._timer = null;

    window.addEventListener('keydown', (e) => {
      if (e.code !== DEBUG_TOGGLE_KEY) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // typing a command
      e.preventDefault();
      this.toggle();
    });
  }

  toggle() {
    this.visible = !this.visible;
    if (this.visible) {
      this._build();
      this._refresh();
      this._timer = setInterval(() => this._refresh(), 250);
    } else {
      clearInterval(this._timer);
      this._timer = null;
      this._panel?.remove();
      this._panel = null;
    }
  }

  // ------------------------------------------------------------------ panel

  _build() {
    const panel = document.createElement('div');
    panel.id = 'vesper-debug';
    panel.style.cssText = [
      'position:fixed', 'top:8px', 'left:8px', 'z-index:9999',
      'width:300px', 'max-height:70vh', 'overflow:auto',
      'background:rgba(10,8,20,.92)', 'border:1px solid #c9a227',
      'border-radius:4px', 'padding:8px 10px',
      'font:11px/1.5 monospace', 'color:#d8d4e8',
      'pointer-events:auto', 'user-select:text',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '❖ VESPER DEBUG (` to close)';
    title.style.cssText = 'color:#c9a227;margin-bottom:6px;letter-spacing:1px';
    panel.appendChild(title);

    this._readout = document.createElement('pre');
    this._readout.style.cssText = 'margin:0 0 6px;white-space:pre-wrap';
    panel.appendChild(this._readout);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
    const btnCollision = this._mkButton('collision: off', () => {
      this.collisionDebug = !this.collisionDebug;
      btnCollision.textContent = `collision: ${this.collisionDebug ? 'on' : 'off'}`;
      this._setPhysicsDebug(this.collisionDebug);
      this._logLine(`collision debug ${this.collisionDebug ? 'ON' : 'OFF'}`);
    });
    const btnHitboxes = this._mkButton('hitboxes: off', () => {
      this.hitboxDebug = !this.hitboxDebug;
      btnHitboxes.textContent = `hitboxes: ${this.hitboxDebug ? 'on' : 'off'}`;
      // HitboxSystem.drawDebug lands in Wave 2; the toggle state is kept so
      // it lights up the moment the system exists.
      this._logLine(this.hitboxDebug
        ? 'hitbox debug armed (HitboxSystem lands in Wave 2)'
        : 'hitbox debug OFF');
    });
    row.append(btnCollision, btnHitboxes);
    panel.appendChild(row);

    this._input = document.createElement('input');
    this._input.placeholder = 'command… (give potion 3 · heal · save)';
    this._input.setAttribute('list', 'vesper-debug-commands');
    this._input.style.cssText = [
      'width:100%', 'box-sizing:border-box', 'background:#141224',
      'border:1px solid #5c5878', 'color:#d8d4e8',
      'font:11px monospace', 'padding:4px 6px', 'margin-bottom:6px',
    ].join(';');
    const datalist = document.createElement('datalist');
    datalist.id = 'vesper-debug-commands';
    for (const c of DebugCommands) {
      const opt = document.createElement('option');
      opt.value = c;
      datalist.appendChild(opt);
    }
    this._input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't leak command typing into the game
      if (e.key === 'Enter') this._runCommand(this._input.value);
    });
    panel.append(this._input, datalist);

    this._log = document.createElement('pre');
    this._log.style.cssText = 'margin:0;white-space:pre-wrap;color:#8f8aa8;max-height:120px;overflow:auto';
    panel.appendChild(this._log);

    document.body.appendChild(panel);
    this._panel = panel;
  }

  _mkButton(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'flex:1', 'background:#141224', 'border:1px solid #5c5878',
      'color:#d8d4e8', 'font:10px monospace', 'padding:3px 4px', 'cursor:pointer',
    ].join(';');
    b.addEventListener('click', onClick);
    return b;
  }

  _logLine(msg) {
    if (!this._log) return;
    const lines = this._log.textContent.split('\n').filter(Boolean);
    lines.push(`> ${msg}`);
    this._log.textContent = lines.slice(-8).join('\n');
  }

  // ---------------------------------------------------------------- readout

  _textureMemoryMB() {
    try {
      let bytes = 0;
      const list = this.game.textures?.list ?? {};
      for (const key of Object.keys(list)) {
        const t = list[key];
        if (t && t.width && t.height) bytes += t.width * t.height * 4;
      }
      return (bytes / 1048576).toFixed(1);
    } catch {
      return '?';
    }
  }

  _refresh() {
    if (!this._readout) return;
    const loop = this.game.loop;
    const pos = gameState.data.player.position;
    this._readout.textContent = [
      `fps ${Math.round(loop.actualFps)} · frame ${loop.delta.toFixed(1)}ms`,
      `room ${pos.roomId} · x ${Math.round(pos.x)} y ${Math.round(pos.y)}`,
      `enemies 0 · projectiles 0 · particles 0  (Wave 2/3)`,
      `textures ~${this._textureMemoryMB()}MB · audio 0 src (Wave 1)`,
      `dirty ${gameState.dirty ? 'YES' : 'no'} · playTime ${gameState.data.playTime}s`,
    ].join('\n');
  }

  _setPhysicsDebug(on) {
    for (const scene of this.game.scene.getScenes(true)) {
      try {
        if (on) {
          if (!scene.physics?.world?.debugGraphic) scene.physics.world.createDebugGraphic();
          scene.physics.world.drawDebug = true;
          scene.physics.world.debugGraphic.setVisible(true);
        } else if (scene.physics?.world) {
          scene.physics.world.drawDebug = false;
          scene.physics.world.debugGraphic?.setVisible(false);
        }
      } catch {
        /* scene without arcade physics */
      }
    }
  }

  // ---------------------------------------------------------------- commands

  /** @param {string} raw */
  _runCommand(raw) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    const [command, ...args] = parts;
    if (this._input) this._input.value = '';

    // Contract: every command goes through the bus…
    eventBus.emit('debug:command', { command, args });

    // …and the built-ins below use real public APIs, never backdoors.
    const done = (msg) => this._logLine(`${command} ${args.join(' ')} — ${msg}`);
    switch (command) {
      case 'give': {
        const [itemId, n] = args;
        if (!itemId) return done('usage: give <itemId> [n]');
        gameState.addItem(itemId, Math.max(1, Number(n) || 1));
        return done(`added ×${gameState.countItem(itemId)} ${itemId}`);
      }
      case 'unlock': {
        const [abilityId] = args;
        if (!abilityId) return done('usage: unlock <abilityId>');
        gameState.unlockAbility(abilityId);
        return done(`unlocked ${abilityId}`);
      }
      case 'heal': {
        gameState.rest();
        return done(`HP ${gameState.data.player.hp}/${gameState.data.player.maxHp}`);
      }
      case 'mana': {
        gameState.setMp(gameState.data.player.maxMp);
        return done(`MP ${gameState.data.player.mp}/${gameState.data.player.maxMp}`);
      }
      case 'save': {
        const slot = saveManager.getLastSlot();
        saveManager.write(slot, gameState.toJSON()).then((r) =>
          done(r.ok ? `saved slot ${slot}` : `SAVE FAILED: ${r.error}`),
        );
        return done(`writing slot ${slot}…`);
      }
      case 'boss': {
        const [bossId] = args;
        if (!bossId) return done('usage: boss <bossId>');
        // GameScene handles this via the 'debug:command' bus event.
        return done(`boss ${bossId} — routed to GameScene`);
      }
      case 'teleport': {
        const [roomId] = args;
        if (!roomId) return done('usage: teleport <roomId>');
        // GameScene handles this via the 'debug:command' bus event.
        return done(`teleport ${roomId} — routed to GameScene`);
      }
      default: {
        if (DebugCommands.includes(command) && PENDING[command]) {
          return done(`no handler yet (${PENDING[command]})`);
        }
        return done(`unknown command (try: ${DebugCommands.join(', ')})`);
      }
    }
  }
}
