/**
 * Player facade — feet anchoring (art stands on the collision floor) and
 * attack-input wiring (J / X / pad X / touch ATK -> PlayerCombat.tryAttack).
 * Duck-typed Phaser scene/sprite/body; no Phaser import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Player } from '../src/player/Player.js';
import { tuning } from '../src/config/tuning.js';
import { gameState } from '../src/core/GameState.js';

function makeBody() {
  return {
    offset: { x: 0, y: 0 },
    width: 0,
    height: 0,
    velocity: { x: 0, y: 0 },
    blocked: { down: false, up: false, left: false, right: false },
    touching: { down: false },
    checkCollision: { down: true },
    setAllowGravity: vi.fn(),
    setSize(w, h) { this.width = w; this.height = h; return this; },
    setOffset(x, y) { this.offset.x = x; this.offset.y = y; return this; },
    setVelocity(x, y) { this.velocity.x = x; this.velocity.y = y; return this; },
    reset: vi.fn(),
  };
}

function makeSprite(x, y, w, h) {
  return {
    x, y,
    frame: { width: w, height: h },
    originX: 0.5, originY: 0.5,
    get displayOriginX() { return this.originX * this.frame.width; },
    get displayOriginY() { return this.originY * this.frame.height; },
    flipX: false,
    body: makeBody(),
    setOrigin(ox, oy) { this.originX = ox; this.originY = oy; return this; },
    setDepth() { return this; },
    setPosition(nx, ny) { this.x = nx; this.y = ny; return this; },
    setFlipX(v) { this.flipX = v; return this; },
    destroy: vi.fn(),
  };
}

function makeScene({ art = true } = {}) {
  const scene = {
    textures: { exists: (k) => (k === 'lucien_idle' ? art : false) },
    make: {
      graphics: () => ({ fillStyle() {}, fillRect() {}, generateTexture() {}, destroy() {} }),
    },
    physics: {
      add: {
        sprite: vi.fn((x, y, key) => {
          const s = key === 'lucien_idle' ? makeSprite(x, y, 64, 64) : makeSprite(x, y, 16, 24);
          scene.lastSprite = s;
          return s;
        }),
      },
    },
  };
  return scene;
}

/** World-space body rect via the Arcade formula (offset − displayOrigin). */
function bodyRect(s) {
  const left = s.x + s.body.offset.x - s.displayOriginX;
  const top = s.y + s.body.offset.y - s.displayOriginY;
  return { left, top, right: left + s.body.width, bottom: top + s.body.height };
}

function makeInput() {
  const pressed = new Set();
  return {
    isDown: () => false,
    justPressed: (a) => pressed.has(a),
    justReleased: () => false,
    axis: () => 0,
    press(a) { pressed.add(a); },
    clear() { pressed.clear(); },
  };
}

describe('Player facade — feet anchoring', () => {
  it('64x64 art: the drawn boots sit on the body bottom, body centered under Lucien', () => {
    const scene = makeScene({ art: true });
    const player = new Player(scene, 100, 236);
    const s = player.getSprite();
    expect(scene.physics.add.sprite.mock.calls[0][2]).toBe('lucien_idle'); // no size swap later
    // Boots end on art row 62 of the 64px frame -> origin there.
    expect(s.displayOriginY).toBeCloseTo(62);
    const r = bodyRect(s);
    expect(r.bottom).toBeCloseTo(s.y); // feet == sprite y == body bottom
    expect((r.left + r.right) / 2).toBeCloseTo(s.x); // centered
    expect(player.getPosition()).toEqual({ x: s.x, y: s.y });
    player.destroy();
  });

  it('placeholder art (16x24) is feet-anchored the same way', () => {
    const scene = makeScene({ art: false });
    const player = new Player(scene, 50, 200);
    const s = player.getSprite();
    expect(s.originY).toBe(1);
    const r = bodyRect(s);
    expect(r.bottom).toBeCloseTo(s.y);
    expect((r.left + r.right) / 2).toBeCloseTo(s.x);
    player.destroy();
  });

  it('spawns and teleports lift the feet above the requested y (never inside a floor)', () => {
    const scene = makeScene();
    const player = new Player(scene, 100, 236);
    const lift = tuning.combat.spawnLift;
    expect(lift).toBeGreaterThan(0);
    expect(player.getSprite().y).toBe(236 - lift);
    player.setPosition(300, 240, -1);
    expect(player.getPosition()).toEqual({ x: 300, y: 240 - lift });
    expect(player.getSprite().flipX).toBe(true);
    player.destroy();
  });
});

describe('Player facade — attack input', () => {
  let scene;
  let player;
  let input;
  let combat;

  beforeEach(() => {
    gameState.data.player.hp = 60;
    scene = makeScene();
    player = new Player(scene, 100, 236);
    input = makeInput();
    player.movement.input = input;
    combat = { tryAttack: vi.fn(), update: vi.fn(), isAttacking: () => false };
    player.attachCombat(combat);
  });

  afterEach(() => {
    player.destroy();
    gameState.data.player.hp = 60;
  });

  it('a fresh attack press calls combat.tryAttack()', () => {
    player.update(1 / 60);
    expect(combat.tryAttack).not.toHaveBeenCalled();
    input.press('attack');
    player.update(1 / 60);
    expect(combat.tryAttack).toHaveBeenCalledTimes(1);
  });

  it('ignores the press on frames the scene reports a UI consumed it', () => {
    input.press('attack');
    player.update(1 / 60, { attackInput: false });
    expect(combat.tryAttack).not.toHaveBeenCalled();
  });

  it('no swings while stunned, mid-backdash or dead', () => {
    input.press('attack');
    for (const state of ['hitstun', 'dash', 'dead']) {
      vi.spyOn(player.movement, 'getState').mockReturnValue(state);
      vi.spyOn(player.movement, 'update').mockImplementation(() => {});
      player.update(1 / 60);
    }
    expect(combat.tryAttack).not.toHaveBeenCalled();
  });

  it('passes the weapon clip + swing serial to the animation layer while attacking', () => {
    gameState.equip('weapon', 'pale_hour_blade');
    const anim = { setState: vi.fn(), update: vi.fn() };
    player.attachAnimation(anim);
    player.attachCombat({ ...combat, isAttacking: () => true, getAttackSerial: () => 7 });
    player.update(1 / 60);
    const [state, opts] = anim.setState.mock.calls.at(-1);
    expect(state).toBe('attack');
    expect(opts.attackKey).toBe('lucien_attack_quick');
    expect(opts.attackId).toBe(7);
    gameState.unequip('weapon');
  });
});
