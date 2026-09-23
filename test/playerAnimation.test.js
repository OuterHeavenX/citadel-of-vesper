/**
 * PlayerAnimation unit tests — clip creation from lucien.json layout,
 * state-driven key selection, facing flip, headless guards.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlayerAnimation } from '../src/player/PlayerAnimation.js';

function makeScene({ texturesExist = true, animsExist = false } = {}) {
  return {
    textures: { exists: vi.fn(() => texturesExist) },
    anims: {
      exists: vi.fn(() => animsExist),
      create: vi.fn(),
      generateFrameNumbers: (key, { start, end }) => {
        const out = [];
        for (let i = start; i <= end; i++) out.push({ key, frame: i });
        return out;
      },
    },
  };
}

function makePlayer(state = 'idle', facingRight = true) {
  const sprite = { flipX: false, play: vi.fn(), once: vi.fn() };
  return {
    sprite,
    _state: state,
    _facing: facingRight,
    getSprite() { return this.sprite; },
    isFacingRight() { return this._facing; },
    getState: () => state,
    getStats: () => ({}),
    getPosition: () => ({ x: 0, y: 0 }),
  };
}

describe('PlayerAnimation', () => {
  it('createAnims builds one clip per lucien.json entry (12 clips)', () => {
    const anim = new PlayerAnimation(makePlayer());
    const scene = makeScene();
    anim.createAnims(scene);
    expect(scene.anims.create).toHaveBeenCalledTimes(12);
    const keys = scene.anims.create.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('lucien_idle');
    expect(keys).toContain('lucien_attack_sword');
    expect(keys).toContain('lucien_die');
    // locomotion loops, one-shots hold
    const idle = scene.anims.create.mock.calls.find((c) => c[0].key === 'lucien_idle')[0];
    const die = scene.anims.create.mock.calls.find((c) => c[0].key === 'lucien_die')[0];
    expect(idle.repeat).toBe(-1);
    expect(die.repeat).toBe(0);
    // frame counts follow the layout
    const atk = scene.anims.create.mock.calls.find((c) => c[0].key === 'lucien_attack_sword')[0];
    expect(atk.frames).toHaveLength(3);
    expect(atk.frameRate).toBe(12);
  });

  it('skips clips whose textures are missing (headless / art not staged)', () => {
    const anim = new PlayerAnimation(makePlayer());
    const scene = makeScene({ texturesExist: false });
    expect(() => anim.createAnims(scene)).not.toThrow();
    expect(scene.anims.create).not.toHaveBeenCalled();
  });

  it('update() selects clips from state and flips the sprite', () => {
    const player = makePlayer('walk', false);
    const anim = new PlayerAnimation(player);
    anim.createAnims(makeScene({ animsExist: true }));

    anim.update(player);
    expect(player.sprite.flipX).toBe(true); // facing left
    expect(player.sprite.play).toHaveBeenCalledWith('lucien_walk');

    player.sprite.play.mockClear();
    anim.update(player); // same state -> no restart
    expect(player.sprite.play).not.toHaveBeenCalled();
  });

  it('maps every movement state to its key', () => {
    const anim = new PlayerAnimation(makePlayer());
    anim.createAnims(makeScene({ animsExist: true }));
    const cases = {
      idle: 'lucien_idle', run: 'lucien_run', crouch: 'lucien_crouch',
      jump: 'lucien_jump', fall: 'lucien_fall', land: 'lucien_land',
      turn: 'lucien_turn', dash: 'lucien_dash', hitstun: 'lucien_hurt',
      dead: 'lucien_die',
    };
    for (const [state, key] of Object.entries(cases)) {
      const p = makePlayer(state);
      const a = new PlayerAnimation(p);
      a.createAnims(makeScene({ animsExist: true }));
      a.update(p);
      expect(p.sprite.play).toHaveBeenCalledWith(key);
    }
  });

  it("attack state plays lucien_attack_<family> (sword art fallback)", () => {
    const player = makePlayer('attack');
    const anim = new PlayerAnimation(player);
    anim.createAnims(makeScene({ animsExist: true }));
    anim.update(player);
    expect(player.sprite.play).toHaveBeenCalledWith('lucien_attack_sword');
  });

  it('is a no-op without a sprite and never reads input', () => {
    const anim = new PlayerAnimation({ getSprite: () => null, getState: () => 'walk' });
    expect(() => anim.update({ getSprite: () => null, getState: () => 'walk' })).not.toThrow();
  });

  it('sprite mode: setState drives clips + facing from explicit args', () => {
    const sprite = { flipX: false, play: vi.fn(), setFlipX: vi.fn() };
    const anim = new PlayerAnimation(sprite);
    anim.createAnims(makeScene({ animsExist: true }));

    anim.setState('run', { facing: -1 });
    expect(sprite.setFlipX).toHaveBeenCalledWith(true);
    expect(sprite.play).toHaveBeenCalledWith('lucien_run');

    sprite.play.mockClear();
    anim.setState('run', { facing: -1 }); // same state -> no restart
    expect(sprite.play).not.toHaveBeenCalled();

    anim.setState('attack', { facing: 1, weaponFamily: 'sword' });
    expect(sprite.play).toHaveBeenCalledWith('lucien_attack_sword');
  });

  it('sprite mode: update(dt) is a safe no-op that flushes pending state', () => {
    const sprite = { flipX: false, play: vi.fn() };
    const anim = new PlayerAnimation(null); // no sprite yet
    anim.createAnims(makeScene({ animsExist: true }));
    anim.setState('jump', { facing: 1 }); // stashed — no sprite
    expect(sprite.play).not.toHaveBeenCalled();
    anim._sprite = sprite; // sprite arrives late
    expect(() => anim.update(0.016)).not.toThrow();
    expect(sprite.play).toHaveBeenCalledWith('lucien_jump');
  });

  it('facade mode: attack wins while combat.isAttacking()', () => {
    const player = makePlayer('run', true);
    player.getCombat = () => ({ isAttacking: () => true });
    const anim = new PlayerAnimation(player);
    anim.createAnims(makeScene({ animsExist: true }));
    anim.update(player);
    expect(player.sprite.play).toHaveBeenCalledWith('lucien_attack_sword');
  });
});
