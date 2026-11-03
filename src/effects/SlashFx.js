/**
 * SlashFx — detached weapon slashes (the Pale Hour Blade's crescent).
 *
 * Some weapons never draw their blade during the swing: their attack clip
 * (e.g. 'lucien_attack_quick') shows only Lucien's arm, and the cut itself
 * is this effect — a short spritesheet crescent that sweeps in front of him.
 *
 * CONTRACT:
 * - Listens to 'player:slashed' (emitted by PlayerCombat when a weapon with
 *   attackProfile.slashFx opens its active window). Combat never calls this
 *   module directly.
 *     { weaponId, texture, facing, comboStep, flipY, duration,
 *       offsetX, offsetY, tint, scale }
 * - Spritesheet layout (frame size, frame count, pivot) comes from
 *   assets/effects/effects.json — the same index make_art.js writes, so the
 *   art's pivot (Lucien's shoulder) and the runtime anchor stay in sync.
 * - The slash FOLLOWS its owner for its short life: each update() places the
 *   sheet so its pivot sits at ownerFeet + (facing·offsetX, offsetY).
 *   facing < 0 mirrors horizontally; flipY mirrors vertically (alternating
 *   combo swings cut upward).
 * - Frames advance over `duration` seconds (the remaining swing time), then
 *   the sprite hides. update() takes ms; pass 0 while hit pause freezes the
 *   world so the crescent holds on the impact frame.
 * - Pooled (POOL_SIZE sprites, preallocated on attach). If every slot is
 *   busy the oldest slash is recycled. Zero allocation in update().
 * - Cleared on 'room:changed'. No Phaser import (headless-test safe); all
 *   scene interaction is duck-typed, like EffectsManager.
 *
 * Wiring (GameScene):
 *   slashFx.attachScene(scene, { getOwnerPosition: () => player.getPosition() })
 *   slashFx.update(frozen ? 0 : deltaMs)   // every frame
 *   slashFx.detach()                        // scene shutdown
 */
import { eventBus } from '../core/EventBus.js';
import effectsLayout from '../../assets/effects/effects.json';

export const SLASH_POOL_SIZE = 4;
/** Drawn just in front of Lucien (depth 10), below HUD/particles. */
export const SLASH_DEPTH = 12;
/** Phaser.BlendModes.ADD — the crescent glows over the night palette. */
const BLEND_ADD = 1;
/** Shortest visible slash (s) even for very fast swings. */
const MIN_DURATION = 0.08;

/**
 * Sheet layout for an effects texture key, or null when it is not a
 * spritesheet with a pivot (falls back to a centered single frame).
 * @param {string} key
 */
export function slashLayout(key) {
  const e = effectsLayout?.effects?.[key];
  if (!e) return null;
  const frameW = e.frameWidth ?? e.width ?? 0;
  const frameH = e.frameHeight ?? e.height ?? 0;
  return {
    frameW,
    frameH,
    frames: Math.max(1, e.frames ?? 1),
    pivotX: e.pivot?.x ?? frameW / 2,
    pivotY: e.pivot?.y ?? frameH / 2,
  };
}

export class SlashFx {
  /**
   * @param {object} [deps]
   * @param {import('../core/EventBus.js').EventBus} [deps.bus]
   * @param {() => ({x:number,y:number}|null)} [deps.getOwnerPosition] feet position
   */
  constructor({ bus = eventBus, getOwnerPosition = null } = {}) {
    this._bus = bus;
    this._getOwnerPosition = getOwnerPosition;
    this._scene = null;
    this._views = null;
    this._slots = new Array(SLASH_POOL_SIZE);
    for (let i = 0; i < SLASH_POOL_SIZE; i++) {
      this._slots[i] = {
        live: false, t: 0, dur: 0.18, born: 0, facing: 1, flipY: false,
        offX: 0, offY: 0, texture: null, frames: 1, frameW: 0, frameH: 0,
        pivotX: 0, pivotY: 0, scale: 1, frame: -1,
      };
    }
    this._serial = 0;
    /** Scratch vector for placeSlot() in the hot path (no per-frame allocation). */
    this._tmp = { x: 0, y: 0 };
    this._unsubs = [
      bus.on('player:slashed', (p) => this.spawn(p)),
      bus.on('room:changed', () => this.clear()),
    ];
  }

  /**
   * Bind to a scene and preallocate the pooled sprites (hidden).
   * @param {object} scene Phaser scene (or duck-typed fake)
   * @param {{ getOwnerPosition?: Function }} [opts]
   */
  attachScene(scene, opts = {}) {
    this._destroyViews();
    this._scene = scene;
    if (typeof opts.getOwnerPosition === 'function') this._getOwnerPosition = opts.getOwnerPosition;
    const views = new Array(SLASH_POOL_SIZE);
    for (let i = 0; i < SLASH_POOL_SIZE; i++) {
      const s = scene.add.sprite(-1000, -1000, '__DEFAULT');
      s.setOrigin?.(0.5, 0.5);
      s.setDepth?.(SLASH_DEPTH);
      s.setBlendMode?.(BLEND_ADD);
      s.setVisible(false);
      views[i] = s;
    }
    this._views = views;
    this.clear();
  }

  /** Unsubscribe and destroy views. */
  detach() {
    for (const off of this._unsubs) off();
    this._unsubs = [];
    this._destroyViews();
    this._scene = null;
  }

  _destroyViews() {
    if (!this._views) return;
    for (const v of this._views) {
      try {
        v.destroy();
      } catch { /* scene already torn down */ }
    }
    this._views = null;
  }

  /** Hide every live slash (room swap / teardown). */
  clear() {
    for (let i = 0; i < SLASH_POOL_SIZE; i++) {
      const slot = this._slots[i];
      slot.live = false;
      slot.frame = -1;
      const v = this._views?.[i];
      if (v) v.setVisible(false);
    }
  }

  /** @returns {number} live slashes */
  get activeCount() {
    let n = 0;
    for (let i = 0; i < SLASH_POOL_SIZE; i++) if (this._slots[i].live) n++;
    return n;
  }

  /**
   * Start a slash ('player:slashed' payload). Recycles the oldest slot when
   * the pool is full. @returns {number} slot index, or -1 when ignored
   */
  spawn(p = {}) {
    if (typeof p.texture !== 'string') return -1;
    const layout = slashLayout(p.texture);
    if (!layout) return -1;
    let idx = -1;
    let oldest = Infinity;
    let oldestIdx = 0;
    for (let i = 0; i < SLASH_POOL_SIZE; i++) {
      const s = this._slots[i];
      if (!s.live) {
        idx = i;
        break;
      }
      if (s.born < oldest) {
        oldest = s.born;
        oldestIdx = i;
      }
    }
    if (idx < 0) idx = oldestIdx;

    const slot = this._slots[idx];
    slot.live = true;
    slot.t = 0;
    slot.dur = Math.max(MIN_DURATION, Number.isFinite(p.duration) ? p.duration : 0.18);
    slot.born = ++this._serial;
    slot.facing = p.facing < 0 ? -1 : 1;
    slot.flipY = p.flipY === true;
    slot.offX = Number.isFinite(p.offsetX) ? p.offsetX : 0;
    slot.offY = Number.isFinite(p.offsetY) ? p.offsetY : 0;
    slot.scale = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
    slot.texture = p.texture;
    slot.frames = layout.frames;
    slot.frameW = layout.frameW;
    slot.frameH = layout.frameH;
    slot.pivotX = layout.pivotX;
    slot.pivotY = layout.pivotY;
    slot.frame = -1;

    const v = this._views?.[idx];
    if (v) {
      try {
        v.setTexture(p.texture, 0);
      } catch { /* texture missing — sprite shows the default */ }
      v.setFlipX?.(slot.facing < 0);
      v.setFlipY?.(slot.flipY);
      v.setScale?.(slot.scale);
      if (typeof p.tint === 'number') v.setTint?.(p.tint);
      v.setAlpha?.(1);
      v.setVisible(true);
    }
    this._advance(idx, slot, 0);
    return idx;
  }

  /**
   * Advance + place all live slashes. Real milliseconds; pass 0 to hold
   * (hit pause). Zero allocation.
   * @param {number} dtMs
   */
  update(dtMs) {
    const dt = Math.max(0, dtMs || 0) / 1000;
    for (let i = 0; i < SLASH_POOL_SIZE; i++) {
      const slot = this._slots[i];
      if (slot.live) this._advance(i, slot, dt);
    }
  }

  /**
   * World-space center of a slot's sprite so its pivot lands on the
   * owner-relative anchor. Exposed for tests. Writes into `out`.
   */
  placeSlot(slot, ownerX, ownerY, out) {
    const pivotWX = ownerX + slot.facing * slot.offX;
    const pivotWY = ownerY + slot.offY;
    out.x = pivotWX + slot.facing * (slot.frameW / 2 - slot.pivotX) * slot.scale;
    out.y = pivotWY + (slot.flipY ? -1 : 1) * (slot.frameH / 2 - slot.pivotY) * slot.scale;
    return out;
  }

  _advance(i, slot, dt) {
    slot.t += dt;
    const v = this._views?.[i];
    if (slot.t >= slot.dur) {
      slot.live = false;
      slot.frame = -1;
      if (v) v.setVisible(false);
      return;
    }
    const frame = Math.min(slot.frames - 1, Math.floor((slot.t / slot.dur) * slot.frames));
    if (!v) {
      slot.frame = frame;
      return;
    }
    if (frame !== slot.frame) {
      slot.frame = frame;
      try {
        v.setFrame(frame);
      } catch { /* missing texture/frame — keep the current one */ }
    }
    const pos = this._getOwnerPosition?.();
    if (pos) {
      this.placeSlot(slot, pos.x, pos.y, this._tmp);
      v.setPosition(this._tmp.x, this._tmp.y);
    }
  }

  /** Test seam: slot state (not part of the game API). */
  get _debug() {
    return { slots: this._slots, views: this._views };
  }
}
