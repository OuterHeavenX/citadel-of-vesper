/**
 * gameEntry.test.js — headless tests for GameScene's Phaser-free logic
 * (src/scenes/gameEntry.js). GameScene.js itself imports Phaser and cannot
 * run under vitest's node environment; these cover the entry-intent,
 * spawn-resolution, pause ref-count, and region-ambience contracts it
 * depends on.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPAWN,
  modalRoomId,
  PauseCoordinator,
  resolveAmbienceForRegion,
  resolveEntryIntent,
  resolveSpawn,
  START_ROOM_ID,
} from '../src/scenes/gameEntry.js';

describe('resolveEntryIntent', () => {
  it('honors an explicit newGame flag', () => {
    expect(resolveEntryIntent({ newGame: true })).toEqual({ mode: 'new' });
  });

  it('honors an explicit slot payload', () => {
    expect(resolveEntryIntent({ slot: 2 })).toEqual({ mode: 'load-slot', slot: 2 });
  });

  it('ignores a non-integer slot and trusts state', () => {
    expect(resolveEntryIntent({ slot: 'x' })).toEqual({ mode: 'trust-state' });
    expect(resolveEntryIntent({ slot: 1.5 })).toEqual({ mode: 'trust-state' });
  });

  it('trusts pre-hydrated gameState when TitleScene passes no data', () => {
    expect(resolveEntryIntent(undefined)).toEqual({ mode: 'trust-state' });
    expect(resolveEntryIntent(null)).toEqual({ mode: 'trust-state' });
    expect(resolveEntryIntent({})).toEqual({ mode: 'trust-state' });
  });
});

describe('resolveSpawn', () => {
  it('passes a valid saved position through', () => {
    expect(resolveSpawn({ roomId: 'hollow_keep_003', x: 120, y: 44 })).toEqual({
      roomId: 'hollow_keep_003',
      x: 120,
      y: 44,
    });
  });

  it('falls back to the new-game spawn for missing/corrupt positions', () => {
    expect(resolveSpawn(null)).toEqual({ ...DEFAULT_SPAWN });
    expect(resolveSpawn(undefined)).toEqual({ ...DEFAULT_SPAWN });
    expect(resolveSpawn({})).toEqual({ ...DEFAULT_SPAWN });
  });

  it('repairs field-by-field so a partial position never strands the player', () => {
    expect(resolveSpawn({ roomId: '', x: NaN, y: 10 })).toEqual({
      roomId: START_ROOM_ID,
      x: DEFAULT_SPAWN.x,
      y: 10,
    });
  });
});

describe('resolveAmbienceForRegion', () => {
  it('maps known regions to their beds', () => {
    expect(resolveAmbienceForRegion('moonlit_gate')).toBe('wind_night');
    expect(resolveAmbienceForRegion('hollow_keep')).toBe('dungeon_drone');
  });

  it('returns null for unknown regions (bed keeps playing)', () => {
    expect(resolveAmbienceForRegion('unknown_region')).toBeNull();
    expect(resolveAmbienceForRegion(null)).toBeNull();
    expect(resolveAmbienceForRegion(undefined)).toBeNull();
  });
});

describe('PauseCoordinator (ARCHITECTURE §14 ref-count)', () => {
  it('starts unpaused', () => {
    expect(new PauseCoordinator().isPaused()).toBe(false);
  });

  it('pauses on ui:opened and resumes on ui:closed', () => {
    const p = new PauseCoordinator();
    p.uiOpened('pause');
    expect(p.isPaused()).toBe(true);
    p.uiClosed('pause');
    expect(p.isPaused()).toBe(false);
  });

  it('holds the pause while ANY screen is open (ref-count)', () => {
    const p = new PauseCoordinator();
    p.uiOpened('inventory');
    p.uiOpened('map');
    p.uiClosed('inventory');
    expect(p.isPaused()).toBe(true); // map still open — must NOT resume
    p.uiClosed('map');
    expect(p.isPaused()).toBe(false);
  });

  it('ignores duplicate opens and closes of unknown screens', () => {
    const p = new PauseCoordinator();
    p.uiOpened('pause');
    p.uiOpened('pause');
    expect(p.uiCount).toBe(1);
    p.uiClosed('never-opened');
    expect(p.isPaused()).toBe(true);
    p.uiClosed('pause');
    p.uiClosed('pause');
    expect(p.uiCount).toBe(0);
    expect(p.isPaused()).toBe(false);
  });

  it('auto-pause latches independently of the UI ref-count', () => {
    const p = new PauseCoordinator();
    p.setAutoPaused(true);
    expect(p.isPaused()).toBe(true);
    p.uiOpened('pause');
    p.setAutoPaused(false); // tab visible again, but pause menu still open
    expect(p.isPaused()).toBe(true);
    p.uiClosed('pause');
    expect(p.isPaused()).toBe(false);
  });

  it('ui:closed without a matching open never drives the count negative', () => {
    const p = new PauseCoordinator();
    p.uiClosed();
    p.uiClosed();
    expect(p.uiCount).toBe(0);
    expect(p.isPaused()).toBe(false);
  });
});

describe('modalRoomId', () => {
  it('prefers the Room instance .roomId over the raw field (SaveSanctum)', () => {
    const room = { roomId: 'save_room_1' }; // real Room exposes .roomId, not .id
    const mod = { room, roomId: room }; // raw field holds the object (.id was undefined)
    expect(modalRoomId(mod)).toBe('save_room_1');
  });

  it('falls back through .id and .def.id', () => {
    expect(modalRoomId({ room: { id: 'r2' } })).toBe('r2');
    expect(modalRoomId({ room: { def: { id: 'r3' } } })).toBe('r3');
  });

  it('falls back to the raw roomId/from fields when no room is stored', () => {
    expect(modalRoomId({ roomId: 'r4' })).toBe('r4');
    expect(modalRoomId({ from: 'r5' })).toBe('r5');
  });

  it('returns undefined for null/empty modals', () => {
    expect(modalRoomId(null)).toBeUndefined();
    expect(modalRoomId(undefined)).toBeUndefined();
    expect(modalRoomId({})).toBeUndefined();
  });
});
