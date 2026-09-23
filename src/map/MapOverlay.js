/**
 * MapOverlay — fullscreen exploration map overlay (spec §27).
 *
 * FUNCTIONAL implementation; Wave 5 owns the gothic visual restyle.
 *
 * Renders discovered rooms (from MapModel) as panels on a dark parchment
 * background, positioned by room `map: {x, y}` grid cells:
 *   - current room: bright gold border
 *   - save rooms: lantern icon (pale circle + flame)
 *   - teleport chambers: pale-blue diamond
 *   - boss arenas: blood-red diamond
 *   - unexplored doors: gold ticks on the room edge toward the exit `dir`
 *     (gray when the exit is ability-gated)
 * Header shows MAP COMPLETION %.
 *
 * Layout: fit-all zoom computed from discovered extents, plus D-pad / move
 * axis pan. Driven by InputManager: `confirm`/`cancel` closes the map
 * (the `map` action opens it — wired by the UI scene in Wave 5).
 * Emits `ui:opened` / `ui:closed` { screen: 'map' } on the event bus.
 *
 * No `import 'phaser'` here — the scene is duck-typed (add.graphics/text/
 * container) so this module stays import-safe outside the game.
 */
import { eventBus } from '../core/EventBus.js';
import { inputManager } from '../core/InputManager.js';
import { mapModel } from './MapModel.js';

// Internal resolution (ARCHITECTURE §0).
const VIEW_W = 480;
const VIEW_H = 270;
const CELL = 18; // px per map-grid cell at zoom 1
const PAN_SPEED = 140; // px/s

const COLORS = {
  bg: 0x0b0906,
  parchment: 0x171008,
  panel: 0x1d150c,
  panelEdge: 0x6b5323,
  current: 0xd8a93f,
  currentFill: 0x33230e,
  lantern: 0xffd98a,
  teleport: 0x9fd8ff,
  boss: 0xc03a2e,
  door: 0xd8a93f,
  doorLocked: 0x5a5a5a,
  text: 0xe8d9b0,
  dim: 0x8a7a5c,
};

const DIR_OFFSET = {
  north: [0.5, 0],
  south: [0.5, 1],
  east: [1, 0.5],
  west: [0, 0.5],
  up: [0.5, 0.5],
  down: [0.5, 0.5],
};

export class MapOverlay {
  /**
   * @param {object} scene Phaser Scene (duck-typed: add.graphics/text/container)
   * @param {object} [deps]
   * @param {import('./MapModel.js').MapModel} [deps.model]
   * @param {object} [deps.input] InputManager-like (axis/justPressed)
   * @param {object} [deps.bus] EventBus-like (emit)
   */
  constructor(scene, deps = {}) {
    this.scene = scene;
    this.model = deps.model ?? mapModel;
    this.input = deps.input ?? inputManager;
    this.bus = deps.bus ?? eventBus;
    /** @type {string|null} */
    this.currentRoomId = null;
    this._open = false;
    this._panX = 0;
    this._panY = 0;
    this._zoom = 1;
    this._bg = null;
    this._root = null; // panned/zoomed container
    this._gfx = null;
    this._header = null;
    this._footer = null;
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  toggle() {
    if (this._open) this.hide();
    else this.show();
  }

  show() {
    if (this._open) return;
    this._open = true;
    this._build();
    this.refresh();
    this.bus.emit('ui:opened', { screen: 'map' });
  }

  hide() {
    if (!this._open) return;
    this._open = false;
    this._teardown();
    this.bus.emit('ui:closed', { screen: 'map' });
  }

  /** @param {string} roomId */
  setCurrentRoom(roomId) {
    this.currentRoomId = roomId;
    if (this._open) this.refresh();
  }

  /**
   * Per-frame tick — call from the owning scene's update(). Handles pan and
   * the close actions. No-ops while closed.
   * @param {number} delta ms since last frame
   */
  update(delta = 16.7) {
    if (!this._open) return;
    if (
      this.input.justPressed('confirm') ||
      this.input.justPressed('cancel')
    ) {
      this.hide();
      return;
    }
    const dt = delta / 1000;
    const mx = this.input.axis('move_x') ?? 0;
    const my = this.input.axis('move_y') ?? 0;
    if (mx !== 0 || my !== 0) {
      this._panX = this._clampPanX(this._panX + mx * PAN_SPEED * dt);
      this._panY = this._clampPanY(this._panY + my * PAN_SPEED * dt);
      this._applyTransform();
    }
  }

  /** Rebuild the node drawing from current discovery state. */
  refresh() {
    if (!this._open || !this._gfx) return;
    const g = this._gfx;
    g.clear();
    const nodes = this.model.getDiscoveredNodes();
    if (nodes.length === 0) {
      this._drawEmpty(g);
    } else {
      for (const node of nodes) this._drawNode(g, node);
      this._drawDoors(g);
    }
    this._drawHeader();
    this._applyTransform();
  }

  destroy() {
    this._teardown();
    this.scene = null;
  }

  // ------------------------------------------------------------ internals

  _build() {
    this._bg = this.scene.add.rectangle(0, 0, VIEW_W, VIEW_H, COLORS.bg, 0.94);
    this._bg.setOrigin(0, 0).setDepth(900).setScrollFactor(0);
    this._root = this.scene.add.container(0, 0).setDepth(901);
    this._gfx = this.scene.add.graphics();
    this._root.add(this._gfx);
    const style = (size, color = COLORS.text) => ({
      fontFamily: 'monospace',
      fontSize: `${size}px`,
      color: `#${color.toString(16).padStart(6, '0')}`,
    });
    this._header = this.scene.add
      .text(12, 8, '', style(12))
      .setDepth(902)
      .setScrollFactor(0);
    this._footer = this.scene.add
      .text(12, VIEW_H - 20, '[Tab] close · move to pan', style(9, COLORS.dim))
      .setDepth(902)
      .setScrollFactor(0);
    this._fitAll();
  }

  _teardown() {
    for (const o of [this._header, this._footer, this._root, this._bg]) {
      if (o && typeof o.destroy === 'function') o.destroy();
    }
    this._header = this._footer = this._root = this._gfx = this._bg = null;
    this._panX = 0;
    this._panY = 0;
    this._zoom = 1;
  }

  _fitAll() {
    const nodes = this.model.getDiscoveredNodes();
    if (nodes.length === 0) {
      this._zoom = 1;
      this._panX = 0;
      this._panY = 0;
      return;
    }
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const worldW = (maxX - minX + 1) * CELL;
    const worldH = (maxY - minY + 1) * CELL;
    this._zoom = Math.min(
      (VIEW_W - 48) / worldW,
      (VIEW_H - 72) / worldH,
      2.5,
    );
    // center the extents in the viewport
    const cx = (minX + maxX + 1) / 2;
    const cy = (minY + maxY + 1) / 2;
    this._panX = VIEW_W / 2 - cx * CELL * this._zoom;
    this._panY = (VIEW_H - 12) / 2 - cy * CELL * this._zoom;
  }

  _applyTransform() {
    if (!this._root) return;
    this._root.setPosition(this._panX, this._panY);
    this._root.setScale(this._zoom);
  }

  _clampPanX(x) {
    return Math.max(-VIEW_W, Math.min(VIEW_W, x));
  }

  _clampPanY(y) {
    return Math.max(-VIEW_H, Math.min(VIEW_H, y));
  }

  _nodeRect(node) {
    const w = CELL * 0.92;
    const h = CELL * 0.92;
    return {
      x: node.x * CELL + (CELL - w) / 2,
      y: node.y * CELL + (CELL - h) / 2,
      w,
      h,
    };
  }

  _drawNode(g, node) {
    const r = this._nodeRect(node);
    const isCurrent = node.roomId === this.currentRoomId;
    g.fillStyle(isCurrent ? COLORS.currentFill : COLORS.panel, 1);
    g.fillRect(r.x, r.y, r.w, r.h);
    g.lineStyle(isCurrent ? 2 : 1, isCurrent ? COLORS.current : COLORS.panelEdge, 1);
    g.strokeRect(r.x, r.y, r.w, r.h);

    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (node.isSaveRoom) {
      // lantern icon: pale glow + flame
      g.fillStyle(COLORS.lantern, 0.9);
      g.fillCircle(cx, cy + 1, 2.4);
      g.fillTriangle(cx - 1.2, cy - 1, cx + 1.2, cy - 1, cx, cy - 3.4);
    }
    if (node.isTeleport) {
      // teleport chamber: pale-blue diamond
      const s = 3.2;
      g.fillStyle(COLORS.teleport, 0.95);
      g.fillPoints(
        [
          { x: cx, y: cy - s },
          { x: cx + s, y: cy },
          { x: cx, y: cy + s },
          { x: cx - s, y: cy },
        ],
        true,
      );
    }
    if (node.isBoss) {
      // boss arena: blood-red diamond ring
      const s = 4.4;
      g.lineStyle(1.5, COLORS.boss, 1);
      g.strokePoints(
        [
          { x: cx, y: cy - s },
          { x: cx + s, y: cy },
          { x: cx, y: cy + s },
          { x: cx - s, y: cy },
        ],
        true,
      );
    }
  }

  _drawDoors(g) {
    for (const door of this.model.getUnexploredDoors()) {
      const from = this.model.getRoomNode(door.from);
      if (!from) continue;
      const r = this._nodeRect(from);
      const [ox, oy] = DIR_OFFSET[door.dir] ?? [0.5, 0.5];
      const x = r.x + r.w * ox;
      const y = r.y + r.h * oy;
      const locked = door.requires.length > 0;
      g.fillStyle(locked ? COLORS.doorLocked : COLORS.door, 1);
      g.fillCircle(x, y, locked ? 1.6 : 2.2);
    }
  }

  _drawEmpty(g) {
    g.lineStyle(1, COLORS.dim, 0.6);
    g.strokeRect(VIEW_W / 2 - 60, VIEW_H / 2 - 14, 120, 28);
  }

  _drawHeader() {
    if (!this._header) return;
    const completion = this.model.getCompletion().toFixed(1);
    const cur = this.currentRoomId ? this.model.getRoomNode(this.currentRoomId) : null;
    const where = cur ? ` — ${cur.name}` : '';
    this._header.setText(`MAP OF VESPER${where}   ${completion}%`);
  }
}
