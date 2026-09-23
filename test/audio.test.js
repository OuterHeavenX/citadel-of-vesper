/**
 * test/audio.test.js — W5-AUDIO integration tests (headless, node env).
 *
 * 1. Registry coverage: every sound/music id referenced in data/*.json AND
 *    every playSfx('literal') call site in src/ has a definition in
 *    src/audio/index.js, and resolves without throwing.
 * 2. Every MusicTrack resolves via resolveTrackEvents without throwing.
 * 3. Ambience: every room's bed resolves; every region maps to a bed.
 * 4. MusicDirector: boss start/end transitions unit-tested headless.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AmbienceBeds,
  MusicTracks,
  resolveAmbience,
  resolveSfx,
  resolveTrackEvents,
  SfxDefinitions,
  trackForRegion,
} from '../src/audio/index.js';
import {
  bossMusicFor,
  MusicDirector,
  regionMusicForRoom,
  roomMusicFor,
} from '../src/audio/musicDirector.js';
import {
  REGION_AMBIENCE,
  resolveAmbienceForRegion,
  resolveRoomAmbience,
} from '../src/scenes/gameEntry.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const loadJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collect every referenced id from data + src call sites.
// ---------------------------------------------------------------------------

const enemies = loadJson('data/enemies.json');
const weapons = loadJson('data/weapons.json');
const bosses = loadJson('data/bosses.json');
const bossAttacks = loadJson('data/boss_attacks.json');
const rooms = loadJson('data/rooms.json');
const abilities = loadJson('data/abilities.json');

const dataSfx = new Set();
for (const e of enemies) for (const t of e.telegraphs ?? []) if (t.sound) dataSfx.add(t.sound);
for (const w of weapons) {
  const s = w.attackProfile?.soundId ?? w.attackProfile?.sound;
  if (s) dataSfx.add(s);
}
const attackList = Array.isArray(bossAttacks) ? bossAttacks : bossAttacks.attacks ?? [];
for (const a of attackList) {
  if (a.sfxWindup) dataSfx.add(a.sfxWindup);
  if (a.sfxStrike) dataSfx.add(a.sfxStrike);
}
for (const a of abilities) if (a.sfx) dataSfx.add(a.sfx);

const dataMusic = new Set();
for (const b of bosses) if (b.music) dataMusic.add(b.music);
for (const r of rooms) if (r.music) dataMusic.add(r.music);

// Literal playSfx('id') call sites across src (audio impl excluded — it
// warns on unknown ids by design; call sites must never trigger that).
const srcSfx = new Set();
const lit = /playSfx\(\s*['"`]([A-Za-z0-9_]+)['"`]/g;
for (const f of jsFiles(path.join(ROOT, 'src'))) {
  if (f.endsWith('src/audio/index.js') || f.endsWith('src/core/AudioManager.js')) continue;
  const text = readFileSync(f, 'utf8');
  let m;
  while ((m = lit.exec(text)) !== null) srcSfx.add(m[1]);
}

// ---------------------------------------------------------------------------

describe('SFX registry coverage', () => {
  it('every sound id referenced in data/*.json has a definition', () => {
    expect(dataSfx.size).toBeGreaterThan(0);
    for (const id of [...dataSfx].sort()) {
      expect(SfxDefinitions[id], `data references missing sfx '${id}'`).toBeTruthy();
    }
  });

  it('every playSfx literal call site in src/ has a definition', () => {
    expect(srcSfx.size).toBeGreaterThan(0);
    for (const id of [...srcSfx].sort()) {
      expect(SfxDefinitions[id], `call site references missing sfx '${id}'`).toBeTruthy();
    }
  });

  it('resolveSfx does not throw for any referenced id (default + pitched)', () => {
    for (const id of new Set([...dataSfx, ...srcSfx])) {
      const r1 = resolveSfx(id);
      expect(r1.channel, id).toBeTruthy();
      expect(Array.isArray(r1.recipes) && r1.recipes.length > 0, id).toBe(true);
      const r2 = resolveSfx(id, { rate: 0.7 });
      expect(r2.recipes.length, `${id}@0.7`).toBe(r1.recipes.length);
    }
  });

  it('resolveSfx throws a clear error for unknown ids', () => {
    expect(() => resolveSfx('no_such_sfx_xyz')).toThrow(/unknown sfx/);
  });

  it('every definition carries a valid channel', () => {
    const channels = ['music', 'ambience', 'player', 'enemies', 'weapons', 'environment', 'ui'];
    for (const [id, def] of Object.entries(SfxDefinitions)) {
      expect(channels, id).toContain(def.channel);
      expect(typeof def.make, id).toBe('function');
    }
  });
});

describe('Music track registry', () => {
  it('every music id referenced in data has a track definition', () => {
    expect(dataMusic.size).toBeGreaterThan(0);
    for (const id of [...dataMusic].sort()) {
      expect(MusicTracks[id], `data references missing track '${id}'`).toBeTruthy();
    }
  });

  it('every MusicTrack resolves via resolveTrackEvents without throwing', () => {
    for (const id of Object.keys(MusicTracks)) {
      const { events, duration, loop } = resolveTrackEvents(id);
      expect(events.length, `${id} events`).toBeGreaterThan(0);
      expect(duration, `${id} duration`).toBeGreaterThan(0);
      expect(typeof loop, `${id} loop`).toBe('boolean');
      for (const e of events) {
        expect(Number.isFinite(e.t) && e.t >= 0, `${id} event time`).toBe(true);
        expect(e.freq, `${id} event freq`).toBeGreaterThan(0);
      }
    }
  });

  it('boss themes resolve: boss_theme_1 (Warden) and boss_theme_2 (Matriarch)', () => {
    for (const id of ['boss_theme_1', 'boss_theme_2']) {
      expect(resolveTrackEvents(id).events.length, id).toBeGreaterThan(0);
    }
  });

  it('trackForRegion maps every region in rooms.json; unknown -> null', () => {
    const regions = new Set(rooms.map((r) => r.region));
    expect(regions.size).toBeGreaterThan(0);
    for (const region of regions) {
      const track = trackForRegion(region);
      expect(track, `region '${region}'`).toBeTruthy();
      expect(MusicTracks[track], `track '${track}'`).toBeTruthy();
    }
    expect(trackForRegion('no_such_region')).toBeNull();
  });
});

describe('Ambience wiring', () => {
  it('every room ambience tag resolves to a bed', () => {
    const beds = new Set(rooms.map((r) => r.ambience).filter(Boolean));
    expect(beds.size).toBeGreaterThan(0);
    for (const bed of beds) {
      expect(AmbienceBeds[bed], `bed '${bed}'`).toBeTruthy();
      expect(resolveAmbience(bed).length, bed).toBeGreaterThan(0);
    }
  });

  it('resolveRoomAmbience: room tag wins, region map is the fallback', () => {
    // moonlit_gate_014 is a gate-region room that drones like the keep.
    const r014 = rooms.find((r) => r.id === 'moonlit_gate_014');
    expect(resolveRoomAmbience(r014)).toBe('dungeon_drone');
    const r001 = rooms.find((r) => r.id === 'moonlit_gate_001');
    expect(resolveRoomAmbience(r001)).toBe('wind_night');
    // No tag -> region map; unknown -> null (leave bed playing).
    expect(resolveRoomAmbience({ region: 'hollow_keep' })).toBe('dungeon_drone');
    expect(resolveRoomAmbience({ region: 'nope' })).toBeNull();
    expect(resolveRoomAmbience(null)).toBeNull();
  });

  it('every region in rooms.json resolves to a bed (no gaps on room:changed)', () => {
    for (const region of new Set(rooms.map((r) => r.region))) {
      expect(REGION_AMBIENCE[region] ?? null, `region '${region}'`).toBeTruthy();
      expect(resolveAmbienceForRegion(region)).toBeTruthy();
    }
  });

  it('resolveAmbience throws a clear error for unknown beds', () => {
    expect(() => resolveAmbience('no_such_bed')).toThrow(/unknown bed/);
  });
});

// ---------------------------------------------------------------------------
// MusicDirector — headless transition tests.
// ---------------------------------------------------------------------------

function fakeBus() {
  const handlers = {};
  return {
    on(ev, fn) {
      (handlers[ev] ??= []).push(fn);
      return () => {
        handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn);
      };
    },
    emit(ev, payload) {
      for (const h of [...(handlers[ev] ?? [])]) h(payload);
    },
  };
}

function makeDirector({ rooms: roomDefs = {}, bossDefs = {} } = {}) {
  const bus = fakeBus();
  const played = [];
  const director = new MusicDirector({
    bus,
    audio: { playMusic: (id) => played.push(id) },
    getRoomDef: (id) => roomDefs[id] ?? null,
    getBossDef: (id) => bossDefs[id] ?? null,
  });
  const unwire = director.wire();
  return { bus, played, unwire };
}

const ROOM_FIXTURES = {
  moonlit_gate_014: { id: 'moonlit_gate_014', region: 'moonlit_gate', music: 'boss_theme_1' },
  hollow_keep_010: { id: 'hollow_keep_010', region: 'hollow_keep', music: 'boss_theme_2' },
  moonlit_gate_001: { id: 'moonlit_gate_001', region: 'moonlit_gate', music: 'moonlit_gate' },
};
const BOSS_FIXTURES = {
  chapel_warden: { id: 'chapel_warden', music: 'boss_theme_1' },
  sable_matriarch: { id: 'sable_matriarch', music: 'boss_theme_2' },
};

describe('MusicDirector', () => {
  it('pure helpers: bossMusicFor / roomMusicFor / regionMusicForRoom', () => {
    expect(bossMusicFor(BOSS_FIXTURES.chapel_warden)).toBe('boss_theme_1');
    expect(bossMusicFor(BOSS_FIXTURES.sable_matriarch)).toBe('boss_theme_2');
    expect(bossMusicFor(null)).toBeNull();
    expect(bossMusicFor({})).toBeNull();
    expect(roomMusicFor(ROOM_FIXTURES.moonlit_gate_014)).toBe('boss_theme_1');
    expect(roomMusicFor({ region: 'hollow_keep' })).toBe('hollow_keep');
    // Restore target ignores the arena's boss-theme room tag.
    expect(regionMusicForRoom(ROOM_FIXTURES.moonlit_gate_014)).toBe('moonlit_gate');
    expect(regionMusicForRoom(ROOM_FIXTURES.hollow_keep_010)).toBe('hollow_keep');
    expect(regionMusicForRoom(null)).toBeNull();
  });

  it('boss_theme_1 plays on Warden aggro via boss:encounterStarted', () => {
    const { bus, played } = makeDirector({ rooms: ROOM_FIXTURES, bossDefs: BOSS_FIXTURES });
    bus.emit('room:changed', { from: 'moonlit_gate_001', to: 'moonlit_gate_014', via: 'exit' });
    bus.emit('boss:encounterStarted', { bossId: 'chapel_warden', roomId: 'moonlit_gate_014' });
    expect(played).toEqual(['boss_theme_1']);
  });

  it('boss_theme_2 plays on Matriarch aggro via boss:encounterStarted', () => {
    const { bus, played } = makeDirector({ rooms: ROOM_FIXTURES, bossDefs: BOSS_FIXTURES });
    bus.emit('room:changed', { from: 'hollow_keep_001', to: 'hollow_keep_010', via: 'exit' });
    bus.emit('boss:encounterStarted', { bossId: 'sable_matriarch', roomId: 'hollow_keep_010' });
    expect(played).toEqual(['boss_theme_2']);
  });

  it('boss:died restores the REGION theme, not the arena room tag', () => {
    const { bus, played } = makeDirector({ rooms: ROOM_FIXTURES, bossDefs: BOSS_FIXTURES });
    bus.emit('room:changed', { from: 'moonlit_gate_001', to: 'moonlit_gate_014', via: 'exit' });
    bus.emit('boss:encounterStarted', { bossId: 'chapel_warden', roomId: 'moonlit_gate_014' });
    bus.emit('boss:died', { bossId: 'chapel_warden', roomId: 'moonlit_gate_014', reward: 'moonrise_leap' });
    expect(played).toEqual(['boss_theme_1', 'moonlit_gate']);
  });

  it('player:died during a boss fight restores the region theme', () => {
    const { bus, played } = makeDirector({ rooms: ROOM_FIXTURES, bossDefs: BOSS_FIXTURES });
    bus.emit('room:changed', { from: 'hollow_keep_001', to: 'hollow_keep_010', via: 'exit' });
    bus.emit('boss:encounterStarted', { bossId: 'sable_matriarch', roomId: 'hollow_keep_010' });
    bus.emit('player:died', { roomId: 'hollow_keep_010' });
    expect(played).toEqual(['boss_theme_2', 'hollow_keep']);
  });

  it('unknown boss id plays nothing and never throws', () => {
    const { bus, played } = makeDirector({ rooms: ROOM_FIXTURES, bossDefs: BOSS_FIXTURES });
    expect(() => bus.emit('boss:encounterStarted', { bossId: 'no_such_boss' })).not.toThrow();
    expect(played).toEqual([]);
  });

  it('unwire stops transitions', () => {
    const { bus, played, unwire } = makeDirector({ rooms: ROOM_FIXTURES, bossDefs: BOSS_FIXTURES });
    unwire();
    bus.emit('boss:encounterStarted', { bossId: 'chapel_warden' });
    expect(played).toEqual([]);
  });

  it('real data: both bosses resolve to their themes from data/bosses.json', () => {
    const byId = Object.fromEntries(bosses.map((b) => [b.id, b]));
    expect(bossMusicFor(byId.chapel_warden)).toBe('boss_theme_1');
    expect(bossMusicFor(byId.sable_matriarch)).toBe('boss_theme_2');
    expect(MusicTracks[bossMusicFor(byId.chapel_warden)]).toBeTruthy();
    expect(MusicTracks[bossMusicFor(byId.sable_matriarch)]).toBeTruthy();
  });
});
