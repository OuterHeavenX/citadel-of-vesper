/**
 * src/audio — composition engine + registries (spec §44, §45).
 *
 * ORIGINALITY: every melody, motif, and SFX recipe in this file is an
 * original composition written for The Citadel of Vesper. No melodies,
 * themes, or sound effects are reproduced from Castlevania or any other
 * commercial game.
 *
 * PURE MODULE — this file must stay importable in Node (no AudioContext,
 * no window, no document). It holds:
 *   - note → frequency conversion
 *   - VOICE_DEFS: timbre recipes (partial stacks) per named voice
 *   - MusicTracks / AmbienceBeds: frozen registries of ORIGINAL patterns
 *   - resolveTrackEvents(trackId): pure -> timed note events
 *   - resolveAmbience(id): pure -> bed layer parameters
 *   - SfxDefinitions + resolveSfx(id, opts): pure -> synth recipes
 *   - AudioLibrary: single bundle object handed to AudioManager.configure()
 *
 * Playback (WebAudio graph construction, scheduling, crossfades) lives in
 * src/core/AudioManager.js. This module never touches audio hardware.
 */

// ---------------------------------------------------------------------------
// Note <-> frequency (equal temperament, A4 = 440 Hz)
// ---------------------------------------------------------------------------

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Convert a note name like 'A4', 'C#3', 'Bb2' to frequency in Hz.
 * @param {string} note
 * @returns {number}
 */
export function noteToFreq(note) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(note.trim());
  if (!m) throw new Error(`noteToFreq: bad note name '${note}'`);
  const letter = m[1].toUpperCase();
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = parseInt(m[3], 10);
  const midi = (octave + 1) * 12 + SEMITONES[letter] + acc;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------------------
// Voices — named timbres. Pure data: the manager renders each partial as an
// oscillator. partials: [freqRatio, gainMul, decayMul].
// env: { a: attack s, s: sustain level (0 = full decay pluck), r: release s }
// ---------------------------------------------------------------------------

export const VOICE_DEFS = Object.freeze({
  bell:     { type: 'sine',     partials: [[1, 1, 1], [2.76, 0.32, 0.45], [5.4, 0.16, 0.22]], env: { a: 0.004, s: 0.0, r: 0.25 }, filter: null },
  musicbox: { type: 'sine',     partials: [[1, 1, 1], [3.98, 0.22, 0.3], [9.16, 0.07, 0.12]],  env: { a: 0.003, s: 0.0, r: 0.2 },  filter: null },
  pad:      { type: 'triangle', partials: [[1, 0.7, 1], [2, 0.2, 0.85]],                        env: { a: 0.5, s: 0.8, r: 0.6 },     filter: null },
  lowpad:   { type: 'sawtooth', partials: [[1, 0.8, 1], [2, 0.35, 0.8], [3, 0.15, 0.6]],        env: { a: 0.8, s: 0.85, r: 0.8 },  filter: { type: 'lowpass', freq: 600 } },
  bass:     { type: 'square',   partials: [[1, 0.7, 1], [2, 0.25, 0.7]],                       env: { a: 0.005, s: 0.5, r: 0.08 }, filter: { type: 'lowpass', freq: 900 } },
  pulse:    { type: 'sine',     partials: [[1, 1, 1]],                                         env: { a: 0.004, s: 0.0, r: 0.06 }, filter: null },
  stab:     { type: 'sawtooth', partials: [[1, 0.6, 1], [2, 0.3, 0.6]],                         env: { a: 0.004, s: 0.0, r: 0.15 }, filter: { type: 'lowpass', freq: 1800 } },
  lead:     { type: 'sawtooth', partials: [[1, 0.8, 1], [2, 0.4, 0.8]],                        env: { a: 0.02, s: 0.7, r: 0.2 },  filter: { type: 'lowpass', freq: 2400 } },
  drone:    { type: 'sine',     partials: [[1, 1, 1], [2, 0.15, 0.9]],                         env: { a: 1.2, s: 0.9, r: 1.0 },   filter: null },
});

// ---------------------------------------------------------------------------
// Pattern helpers — pure. Event rows: { b: beat, n: note, d: durBeats,
// v: voice, g: gain }.
// ---------------------------------------------------------------------------

/** Single event row. */
const N = (b, n, d, v = 'bell', g = 1) => ({ b, n, d, v, g });

/**
 * 8 eighth-note arpeggio across one 4-beat bar. `notes` is exactly 8 note
 * names (the composed contour). Pure.
 */
function arp8(bar, notes, v = 'bell', g = 0.55) {
  if (notes.length !== 8) throw new Error('arp8 needs exactly 8 notes');
  return notes.map((n, i) => N(bar * 4 + i * 0.5, n, 0.55, v, g));
}

/** Whole-bar drone note. */
const droneBar = (bar, n, v = 'drone', g = 0.5) => N(bar * 4, n, 4, v, g);

// ---------------------------------------------------------------------------
// MusicTracks — original compositions. sections: [{ bars, events }].
// ---------------------------------------------------------------------------

// Shared section data for the Sable Matriarch's boss themes —
// defined once so boss_theme and boss_theme_2 stay identical.
const MATRIARCH_SECTIONS = [{
      bars: 8,
      events: [
        // 16th-note bass ostinato — original figure
        ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((bar) => {
          const line = ['E2','E2','E2','G2','E2','E2','A2','G2','E2','E2','E2','G2','A2','G2','F#2','D2'];
          return line.map((n, i) => N(bar * 4 + i * 0.25, n, 0.22, 'bass', i % 4 === 0 ? 0.55 : 0.42));
        }),
        // Stab chords, beats 0 and 2
        ...[0, 1, 4, 5].flatMap((bar) => [
          N(bar * 4, 'E3', 0.75, 'stab', 0.4), N(bar * 4, 'G3', 0.75, 'stab', 0.36), N(bar * 4, 'B3', 0.75, 'stab', 0.36),
          N(bar * 4 + 2, 'E3', 0.75, 'stab', 0.38), N(bar * 4 + 2, 'G3', 0.75, 'stab', 0.34), N(bar * 4 + 2, 'B3', 0.75, 'stab', 0.34),
        ]),
        N(8, 'C3', 0.75, 'stab', 0.4), N(8, 'E3', 0.75, 'stab', 0.36), N(8, 'G3', 0.75, 'stab', 0.36),
        N(10, 'C3', 0.75, 'stab', 0.38), N(10, 'E3', 0.75, 'stab', 0.34), N(10, 'G3', 0.75, 'stab', 0.34),
        N(12, 'D3', 0.75, 'stab', 0.4), N(12, 'F#3', 0.75, 'stab', 0.36), N(12, 'A3', 0.75, 'stab', 0.36),
        N(14, 'D3', 0.75, 'stab', 0.38), N(14, 'F#3', 0.75, 'stab', 0.34), N(14, 'A3', 0.75, 'stab', 0.34),
        N(24, 'C3', 0.75, 'stab', 0.4), N(24, 'E3', 0.75, 'stab', 0.36), N(24, 'G3', 0.75, 'stab', 0.36),
        N(26, 'C3', 0.75, 'stab', 0.38), N(26, 'E3', 0.75, 'stab', 0.34), N(26, 'G3', 0.75, 'stab', 0.34),
        N(28, 'B2', 0.75, 'stab', 0.42), N(28, 'D#3', 0.75, 'stab', 0.38), N(28, 'F#3', 0.75, 'stab', 0.38),
        N(30, 'B2', 1.5, 'stab', 0.42), N(30, 'D#3', 1.5, 'stab', 0.38), N(30, 'F#3', 1.5, 'stab', 0.38),
        // High lead line, bars 5-7
        N(16, 'B4', 1, 'lead', 0.34), N(17, 'C5', 1, 'lead', 0.34),
        N(18, 'B4', 1, 'lead', 0.34), N(19, 'A4', 1, 'lead', 0.34),
        N(20, 'G4', 2, 'lead', 0.34), N(22, 'F#4', 2, 'lead', 0.34),
        N(24, 'E4', 4, 'lead', 0.36),
      ],
    }];

export const MusicTracks = Object.freeze({
  // "Vesper's Call" — slow D-minor bell arpeggio over low drones.
  title_theme: {
    title: 'Vesper\'s Call', region: 'title', loop: true, bpm: 72,
    sections: [{
      bars: 8,
      events: [
        // Drones (roots)
        droneBar(0, 'D2'), droneBar(1, 'D2'), droneBar(2, 'Bb1'), droneBar(3, 'A1'),
        droneBar(4, 'D2'), droneBar(5, 'D2'), droneBar(6, 'G2'), droneBar(7, 'A1'),
        // Bell arpeggios — original contours
        ...arp8(0, ['D3','F3','A3','D4','A3','F3','D3','F3']),
        ...arp8(1, ['D3','A3','F3','D4','F3','A3','D3','A3']),
        ...arp8(2, ['Bb2','D3','F3','Bb3','F3','D3','Bb2','D3']),
        ...arp8(3, ['A2','E3','A3','C#4','A3','E3','A2','C#3']),
        ...arp8(4, ['D3','F3','A3','D4','C4','A3','F3','D3']),
        ...arp8(5, ['D3','A3','D4','F4','D4','A3','F3','A3']),
        ...arp8(6, ['G2','Bb2','D3','G3','D3','Bb2','G2','Bb2']),
        ...arp8(7, ['A2','C#3','E3','A3','G3','E3','C#3','E3']),
        // Sparse high answer (music box), bars 5-8
        N(20, 'A4', 2, 'musicbox', 0.5), N(22, 'F4', 2, 'musicbox', 0.5),
        N(24, 'E4', 3, 'musicbox', 0.5),
        N(28, 'D4', 2, 'musicbox', 0.45), N(30, 'C4', 1, 'musicbox', 0.4),
        N(28, 'D4', 4, 'bell', 0.4),
      ],
    }],
  },

  // "Lanterns on the Wall" — sparse music-box motif over a low fifth drone.
  moonlit_gate: {
    title: 'Lanterns on the Wall', region: 'moonlit_gate', loop: true, bpm: 60,
    sections: [{
      bars: 8,
      events: [
        // Drone: A1 + E2 fifths, whole bars
        ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((bar) => [
          droneBar(bar, 'A1', 'drone', 0.42), droneBar(bar, 'E2', 'drone', 0.3),
        ]),
        // Original music-box motif
        N(0, 'E5', 1, 'musicbox', 0.55), N(1, 'A5', 1, 'musicbox', 0.55), N(2, 'C6', 1.5, 'musicbox', 0.5),
        N(4.5, 'B5', 1, 'musicbox', 0.5), N(6, 'A5', 2, 'musicbox', 0.5),
        N(8, 'G5', 1, 'musicbox', 0.5), N(10, 'E5', 1, 'musicbox', 0.5),
        N(12, 'D5', 3, 'musicbox', 0.5),
        N(16, 'E5', 1, 'musicbox', 0.55), N(17, 'G5', 1, 'musicbox', 0.55), N(18, 'A5', 1.5, 'musicbox', 0.5),
        N(20, 'C6', 2.5, 'musicbox', 0.5),
        N(24, 'B5', 1, 'musicbox', 0.5), N(25.5, 'G5', 1, 'musicbox', 0.45),
        N(28, 'A5', 3.5, 'musicbox', 0.55),
        // Bell tolls marking the phrase
        N(0, 'E4', 3, 'bell', 0.4), N(16, 'E4', 3, 'bell', 0.4),
      ],
    }],
  },

  // "Stones That Remember" — low string-ish drone with a slow bass pulse.
  hollow_keep: {
    title: 'Stones That Remember', region: 'hollow_keep', loop: true, bpm: 54,
    sections: [{
      bars: 8,
      events: [
        // Low drone C2 + G2
        ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((bar) => [
          droneBar(bar, 'C2', 'lowpad', 0.5), droneBar(bar, 'G2', 'lowpad', 0.34),
        ]),
        // Slow eighth-note pulse — original line
        ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((bar) => {
          const line = ['C2','C2','G1','C2','C2','Bb1','C2','G1'];
          return line.map((n, i) => N(bar * 4 + i * 0.5, n, 0.4, 'pulse', i % 4 === 0 ? 0.42 : 0.3));
        }),
        // Tolls
        N(0, 'G3', 4, 'bell', 0.45), N(16, 'C4', 4, 'bell', 0.45),
        // Sparse high color
        N(10, 'Eb4', 2, 'musicbox', 0.35),
        N(24, 'D4', 1, 'musicbox', 0.35), N(26, 'C4', 2, 'musicbox', 0.35),
      ],
    }],
  },

  // "The Warden's Vigil" — tolling chapel bells over a low D-minor
  // ostinato; the Chapel Warden's theme (original composition).
  boss_theme_1: {
    title: "The Warden's Vigil", region: 'boss', loop: true, bpm: 100,
    sections: [{
      bars: 8,
      events: [
        // Tolling bells
        ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((bar) => [
          N(bar * 4, 'D5', 2.5, 'bell', 0.5),
          N(bar * 4 + 2, bar % 2 === 0 ? 'A4' : 'C5', 2, 'bell', 0.42),
        ]),
        // 8th-note low ostinato — original figure
        ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((bar) => {
          const line = ['D2','D2','F2','D2','G2','D2','E2','C2'];
          return line.map((n, i) => N(bar * 4 + i * 0.5, n, 0.45, 'bass', i % 2 === 0 ? 0.5 : 0.4));
        }),
        // Stab chords on beats 0 and 2: Dm - Bb - Gm - A
        ...[0, 2, 4, 6].flatMap((bar) => {
          const chords = [['D3','F3','A3'], ['Bb2','D3','F3'], ['G2','Bb2','D3'], ['A2','C#3','E3']];
          const ch = chords[bar / 2];
          return [
            N(bar * 4, ch[0], 1.5, 'stab', 0.38), N(bar * 4, ch[1], 1.5, 'stab', 0.34), N(bar * 4, ch[2], 1.5, 'stab', 0.34),
            N(bar * 4 + 2, ch[0], 1.5, 'stab', 0.36), N(bar * 4 + 2, ch[1], 1.5, 'stab', 0.32), N(bar * 4 + 2, ch[2], 1.5, 'stab', 0.32),
          ];
        }),
      ],
    }],
  },

  // "Sable Matriarch" — driving minor ostinato for the major boss.
  boss_theme: {
    title: 'Sable Matriarch', region: 'boss', loop: true, bpm: 144,
    sections: MATRIARCH_SECTIONS,
  },
  // Second id for the Matriarch (matches data/bosses.json music field).
  boss_theme_2: {
    title: 'Sable Matriarch', region: 'boss', loop: true, bpm: 144,
    sections: MATRIARCH_SECTIONS,
  },

  // "Dawn After Vesper" — victory stinger (one-shot).
  victory: {
    title: 'Dawn After Vesper', region: 'sting', loop: false, bpm: 90,
    sections: [{
      bars: 2,
      events: [
        N(0, 'D5', 1, 'bell', 0.6), N(1, 'F#5', 1, 'bell', 0.6),
        N(2, 'A5', 1, 'bell', 0.6), N(3, 'D6', 2.5, 'bell', 0.65),
        N(0, 'D3', 8, 'pad', 0.35), N(0, 'A3', 8, 'pad', 0.3), N(0, 'D4', 8, 'pad', 0.3),
        N(4, 'G3', 4, 'pad', 0.3), N(4, 'B3', 4, 'pad', 0.28), N(4, 'D4', 4, 'pad', 0.28),
      ],
    }],
  },

  // "The Last Bell" — game-over stinger (one-shot).
  gameover: {
    title: 'The Last Bell', region: 'sting', loop: false, bpm: 60,
    sections: [{
      bars: 2,
      events: [
        N(0, 'A1', 8, 'drone', 0.5), N(0, 'E2', 8, 'drone', 0.35),
        N(0, 'A2', 4, 'bell', 0.6), N(4, 'A2', 4, 'bell', 0.55),
        N(0, 'A4', 1.5, 'musicbox', 0.5), N(2, 'G4', 1.5, 'musicbox', 0.5),
        N(4, 'F4', 1.5, 'musicbox', 0.5), N(6, 'E4', 2, 'musicbox', 0.55),
      ],
    }],
  },
});

/** Find the track id for a region id; returns null when unknown. Pure. */
export function trackForRegion(region) {
  for (const [id, t] of Object.entries(MusicTracks)) {
    if (t.region === region) return id;
  }
  return null;
}

/**
 * Resolve a track into timed, frequency-based events. Pure.
 * @param {string} trackId
 * @returns {{ events: Array<{t:number,freq:number,dur:number,voice:string,gain:number}>, duration: number, loop: boolean }}
 */
export function resolveTrackEvents(trackId) {
  const track = MusicTracks[trackId];
  if (!track) throw new Error(`resolveTrackEvents: unknown track '${trackId}'`);
  const beat = 60 / track.bpm;
  const events = [];
  let t = 0;
  for (const section of track.sections) {
    for (const e of section.events) {
      events.push({
        t: t + e.b * beat,
        freq: noteToFreq(e.n),
        dur: Math.max(0.03, e.d * beat),
        voice: e.v,
        gain: e.g ?? 1,
      });
    }
    t += section.bars * 4 * beat;
  }
  events.sort((a, b) => a.t - b.t);
  return { events, duration: t, loop: track.loop };
}

// ---------------------------------------------------------------------------
// AmbienceBeds — looped environmental beds. Pure parameter data; the manager
// renders layers into looped noise buffers / drone oscillators / drip timers.
// ---------------------------------------------------------------------------

export const AmbienceBeds = Object.freeze({
  wind_night: {
    title: 'Night Wind',
    layers: [
      {
        kind: 'noise', gain: 0.5,
        filter: { type: 'lowpass', freq: 420, Q: 0.7 },
        filterLfo: { rate: 0.06, depth: 260 },   // slow spectral sweep
        ampLfo: { rate: 0.045, depth: 0.35 },    // breathing gusts
      },
    ],
  },
  dungeon_drone: {
    title: 'Dungeon Drone',
    layers: [
      { kind: 'tone', type: 'sine', freq: 55, gain: 0.34 },
      { kind: 'tone', type: 'sine', freq: 82.41, gain: 0.2 },
      { kind: 'tone', type: 'sine', freq: 110.5, gain: 0.08, ampLfo: { rate: 0.11, depth: 0.6 } },
      {
        kind: 'noise', gain: 0.1,
        filter: { type: 'bandpass', freq: 240, Q: 1.1 },
        ampLfo: { rate: 0.09, depth: 0.5 },
      },
    ],
  },
  water_drips: {
    title: 'Water Drips',
    layers: [
      { kind: 'noise', gain: 0.16, filter: { type: 'lowpass', freq: 300, Q: 0.5 } },
      { kind: 'drips', rate: 0.55, fmin: 1100, fmax: 2800, dur: 0.09, gain: 0.22 },
    ],
  },
});

/**
 * Resolve an ambience bed into its layer parameters. Pure.
 * @param {string} id
 * @returns {Array<object>}
 */
export function resolveAmbience(id) {
  const bed = AmbienceBeds[id];
  if (!bed) throw new Error(`resolveAmbience: unknown bed '${id}'`);
  return bed.layers;
}

// ---------------------------------------------------------------------------
// SFX — tiny synth recipe language. Pure: each definition is a function that
// returns an array of recipes; the manager renders them into WebAudio nodes.
//
// Recipe kinds:
//   { kind:'osc', type, f0, f1?, t, dur, gain, a?, d?, s?, r?, detune?, filter? }
//   { kind:'noise', t, dur, gain, a?, d?, s?, r?, filter? }
// Times are offsets in seconds from the SFX start; durations in seconds.
// ---------------------------------------------------------------------------

/** Oscillator recipe. */
const O = (type, f0, dur, opts = {}) => ({
  kind: 'osc', type, f0, dur,
  t: opts.t ?? 0, f1: opts.f1 ?? null, gain: opts.gain ?? 0.5,
  a: opts.a ?? 0.005, d: opts.d ?? 0.02, s: opts.s ?? 0, r: opts.r ?? 0.05,
  detune: opts.detune ?? 0, filter: opts.filter ?? null,
});

/** Noise recipe. */
const NZ = (dur, opts = {}) => ({
  kind: 'noise', dur,
  t: opts.t ?? 0, gain: opts.gain ?? 0.5,
  a: opts.a ?? 0.003, d: opts.d ?? 0.02, s: opts.s ?? 0, r: opts.r ?? 0.05,
  filter: opts.filter ?? null,
});

const LP = (freq, Q = 0.8) => ({ type: 'lowpass', freq, Q });
const HP = (freq, Q = 0.8) => ({ type: 'highpass', freq, Q });
const BP = (freq, Q = 1.2) => ({ type: 'bandpass', freq, Q });

export const SfxDefinitions = Object.freeze({
  swing: {
    channel: 'weapons', desc: 'Blade swing whoosh (generic fallback)',
    make: () => [NZ(0.14, { gain: 0.4, filter: { type: 'bandpass', freq: 900, Q: 0.9 }, a: 0.02, d: 0.1, r: 0.04 })],
  },
  swing_sword: {
    channel: 'weapons', desc: 'Arming-sword swing whoosh',
    make: () => [
      NZ(0.16, { gain: 0.42, filter: { type: 'bandpass', freq: 1400, Q: 1.0 }, a: 0.03, d: 0.1, r: 0.05 }),
      O('triangle', 340, 0.12, { f1: 180, gain: 0.12, a: 0.02, d: 0.08, r: 0.04 }),
    ],
  },
  swing_sabre: {
    channel: 'weapons', desc: 'Sabre swing — lighter and faster',
    make: () => [
      NZ(0.12, { gain: 0.38, filter: { type: 'bandpass', freq: 2100, Q: 1.1 }, a: 0.02, d: 0.08, r: 0.04 }),
      O('triangle', 520, 0.1, { f1: 260, gain: 0.1, a: 0.015, d: 0.06, r: 0.03 }),
    ],
  },
  enemy_hit: {
    channel: 'weapons', desc: 'Heavy impact crunch (boss strikes, telegraph fallback)',
    make: () => [
      O('square', 150, 0.12, { f1: 55, gain: 0.5, d: 0.08, r: 0.05 }),
      NZ(0.1, { gain: 0.4, filter: LP(1000), a: 0.004, d: 0.06, r: 0.04 }),
      O('sine', 90, 0.14, { f1: 45, gain: 0.4, d: 0.09, r: 0.05 }),
    ],
  },
  step: {
    channel: 'player', desc: 'Footstep tap (rate varies by region)',
    make: () => [
      NZ(0.06, { gain: 0.34, filter: LP(500), a: 0.004, d: 0.04, r: 0.03 }),
      O('sine', 110, 0.05, { f1: 70, gain: 0.22, d: 0.03, r: 0.02 }),
    ],
  },
  hit: {
    channel: 'weapons', desc: 'Weapon impact thud',
    make: () => [
      O('square', 170, 0.1, { f1: 60, gain: 0.5, d: 0.06, r: 0.04 }),
      NZ(0.08, { gain: 0.35, filter: LP(800) }),
    ],
  },
  jump: {
    channel: 'player', desc: 'Player jump',
    make: () => [O('sine', 300, 0.16, { f1: 620, gain: 0.38, a: 0.01, d: 0.12, r: 0.04 })],
  },
  land: {
    channel: 'player', desc: 'Landing thump',
    make: () => [
      NZ(0.09, { gain: 0.42, filter: LP(320) }),
      O('sine', 130, 0.09, { f1: 60, gain: 0.4, d: 0.05, r: 0.04 }),
    ],
  },
  dash: {
    channel: 'player', desc: 'Dash air rush',
    make: () => [NZ(0.2, { gain: 0.32, filter: { type: 'highpass', freq: 1400, Q: 0.7 }, a: 0.03, d: 0.14, r: 0.05 })],
  },
  coin: {
    channel: 'player', desc: 'Currency pickup chime',
    make: () => [
      O('square', 920, 0.06, { gain: 0.22, d: 0.04, r: 0.03 }),
      O('square', 1380, 0.09, { t: 0.06, gain: 0.22, d: 0.05, r: 0.04 }),
    ],
  },
  heart: {
    channel: 'player', desc: 'Health pickup',
    make: () => [
      O('sine', 520, 0.12, { f1: 780, gain: 0.42, a: 0.01, d: 0.09, r: 0.05 }),
      O('sine', 780, 0.14, { t: 0.09, f1: 1040, gain: 0.38, a: 0.01, d: 0.1, r: 0.05 }),
    ],
  },
  mana: {
    channel: 'player', desc: 'Mana pickup shimmer',
    make: () => [
      O('triangle', 620, 0.2, { f1: 1240, gain: 0.36, a: 0.01, d: 0.14, r: 0.08 }),
      O('sine', 1860, 0.16, { t: 0.05, gain: 0.14, a: 0.02, d: 0.1, r: 0.06 }),
    ],
  },
  levelup: {
    channel: 'player', desc: 'Level-up fanfare arpeggio',
    make: () => [523.25, 659.25, 783.99, 1046.5].map((f, i) =>
      O('sine', f, 0.22, { t: i * 0.09, gain: 0.4, a: 0.008, d: 0.14, r: 0.1 })),
  },
  save: {
    channel: 'ui', desc: 'Save confirmation chime',
    make: () => [
      O('sine', 440, 0.5, { gain: 0.34, a: 0.01, d: 0.3, r: 0.2 }),
      O('sine', 660, 0.5, { t: 0.02, gain: 0.2, a: 0.01, d: 0.3, r: 0.2 }),
    ],
  },
  ui_move: {
    channel: 'ui', desc: 'Menu cursor tick',
    make: () => [O('square', 700, 0.04, { gain: 0.16, d: 0.02, r: 0.02 })],
  },
  ui_confirm: {
    channel: 'ui', desc: 'Menu confirm',
    make: () => [
      O('sine', 660, 0.07, { gain: 0.3, d: 0.04, r: 0.04 }),
      O('sine', 880, 0.1, { t: 0.06, gain: 0.3, d: 0.05, r: 0.05 }),
    ],
  },
  ui_cancel: {
    channel: 'ui', desc: 'Menu cancel',
    make: () => [O('sine', 440, 0.1, { f1: 330, gain: 0.3, d: 0.06, r: 0.05 })],
  },
  door: {
    channel: 'environment', desc: 'Heavy stone door',
    make: () => [
      NZ(0.45, { gain: 0.5, filter: LP(200), a: 0.05, d: 0.3, r: 0.15 }),
      O('sine', 70, 0.4, { f1: 44, gain: 0.5, a: 0.03, d: 0.3, r: 0.12 }),
    ],
  },
  shatter: {
    channel: 'environment', desc: 'Breakable shatter',
    make: () => [
      NZ(0.12, { gain: 0.5, filter: HP(2800), d: 0.08, r: 0.04 }),
      NZ(0.14, { t: 0.04, gain: 0.4, filter: HP(3600), d: 0.09, r: 0.05 }),
      O('square', 1800, 0.1, { t: 0.02, f1: 900, gain: 0.18, d: 0.06, r: 0.04 }),
    ],
  },
  enemy_die: {
    channel: 'enemies', desc: 'Enemy death rattle',
    make: () => [
      O('sawtooth', 220, 0.3, { f1: 50, gain: 0.4, a: 0.005, d: 0.22, r: 0.08, filter: LP(1200) }),
      NZ(0.18, { t: 0.05, gain: 0.28, filter: LP(600) }),
    ],
  },
  player_hurt: {
    channel: 'player', desc: 'Player takes damage',
    make: () => [
      O('square', 200, 0.18, { f1: 90, gain: 0.42, a: 0.004, d: 0.12, r: 0.06 }),
      NZ(0.1, { gain: 0.25, filter: LP(900) }),
    ],
  },
  boss_roar: {
    channel: 'enemies', desc: 'Boss roar',
    make: () => [
      O('sawtooth', 82, 0.85, { f1: 40, gain: 0.55, a: 0.05, d: 0.6, r: 0.25, detune: 8, filter: LP(420) }),
      O('sawtooth', 55, 0.85, { t: 0.05, f1: 32, gain: 0.5, a: 0.06, d: 0.6, r: 0.25, detune: -6, filter: LP(300) }),
      NZ(0.7, { t: 0.05, gain: 0.3, filter: LP(500), a: 0.08, d: 0.5, r: 0.2 }),
    ],
  },
  teleport: {
    channel: 'environment', desc: 'Teleport shimmer',
    make: () => [
      O('sine', 400, 0.42, { f1: 1600, gain: 0.32, a: 0.05, d: 0.3, r: 0.1 }),
      O('sine', 600, 0.42, { t: 0.06, f1: 2400, gain: 0.2, a: 0.05, d: 0.3, r: 0.1 }),
      NZ(0.35, { t: 0.1, gain: 0.16, filter: HP(4000), a: 0.1, d: 0.2, r: 0.08 }),
    ],
  },
  checkpoint: {
    channel: 'environment', desc: 'Checkpoint lit chime',
    make: () => [
      O('sine', 440, 0.6, { gain: 0.36, a: 0.008, d: 0.4, r: 0.25 }),
      O('sine', 554.37, 0.6, { t: 0.02, gain: 0.24, a: 0.008, d: 0.4, r: 0.25 }),
      O('sine', 659.25, 0.7, { t: 0.14, gain: 0.3, a: 0.008, d: 0.45, r: 0.3 }),
    ],
  },
  hound_growl: {
    channel: 'enemies', desc: 'Hound telegraph growl',
    make: () => [
      O('sawtooth', 72, 0.5, { f1: 48, gain: 0.5, a: 0.06, d: 0.35, r: 0.12, detune: 6, filter: LP(300) }),
      O('sawtooth', 68, 0.5, { f1: 44, gain: 0.45, a: 0.06, d: 0.35, r: 0.12, detune: -7, filter: LP(260) }),
      NZ(0.4, { t: 0.05, gain: 0.18, filter: LP(400), a: 0.08, d: 0.25, r: 0.1 }),
    ],
  },
  blade_scrape: {
    channel: 'enemies', desc: 'Blade dragged across stone',
    make: () => [
      NZ(0.5, { gain: 0.34, filter: HP(1800), a: 0.08, d: 0.35, r: 0.1 }),
      O('sine', 2400, 0.45, { f1: 900, gain: 0.1, a: 0.06, d: 0.3, r: 0.1 }),
    ],
  },
  wisp_hiss: {
    channel: 'enemies', desc: 'Wisp ember telegraph hiss',
    make: () => [
      NZ(0.55, { gain: 0.36, filter: HP(3200), a: 0.12, d: 0.35, r: 0.12 }),
      NZ(0.4, { t: 0.08, gain: 0.22, filter: BP(5200, 1.4), a: 0.1, d: 0.25, r: 0.1 }),
    ],
  },
  page_rustle: {
    channel: 'enemies', desc: 'Tome-page rustle',
    make: () => [
      NZ(0.09, { gain: 0.4, filter: BP(2600, 0.8), a: 0.01, d: 0.06, r: 0.03 }),
      NZ(0.11, { t: 0.1, gain: 0.44, filter: BP(3100, 0.8), a: 0.01, d: 0.07, r: 0.04 }),
      NZ(0.08, { t: 0.22, gain: 0.34, filter: BP(2300, 0.8), a: 0.01, d: 0.05, r: 0.03 }),
    ],
  },
  bell_chime: {
    channel: 'enemies', desc: 'Chapel bell strike',
    make: () => [
      O('sine', 392, 1.1, { gain: 0.5, a: 0.004, d: 0.8, r: 0.4 }),
      O('sine', 1081, 0.7, { gain: 0.16, a: 0.004, d: 0.5, r: 0.25 }),
      O('sine', 2117, 0.4, { gain: 0.07, a: 0.004, d: 0.28, r: 0.15 }),
    ],
  },
  swarm_chitter: {
    channel: 'enemies', desc: 'Swarm chittering',
    make: () => [620, 540, 700, 480, 660, 520].map((f, i) =>
      O('square', f, 0.05, { t: i * 0.055, gain: 0.2, a: 0.004, d: 0.03, r: 0.02, filter: HP(900) })),
  },
  pickup_item: {
    channel: 'ui', desc: 'Generic item pickup',
    make: () => [
      O('triangle', 740, 0.09, { gain: 0.32, a: 0.008, d: 0.06, r: 0.04 }),
      O('triangle', 1108, 0.12, { t: 0.07, gain: 0.3, a: 0.008, d: 0.08, r: 0.05 }),
    ],
  },
  secret: {
    channel: 'environment', desc: 'Secret discovered arpeggio',
    make: () => [659.25, 783.99, 987.77, 1318.5].map((f, i) =>
      O('triangle', f, 0.5, { t: i * 0.14, gain: 0.3, a: 0.01, d: 0.35, r: 0.2 })),
  },
});

/**
 * Resolve an SFX into synth recipes, applying playback-rate scaling.
 * Rate > 1 = faster + higher pitched (playbackRate semantics).
 * Pure.
 * @param {string} id
 * @param {{ rate?: number }} [opts]
 * @returns {{ channel: string, recipes: Array<object> }}
 */
export function resolveSfx(id, opts = {}) {
  const def = SfxDefinitions[id];
  if (!def) throw new Error(`resolveSfx: unknown sfx '${id}'`);
  const rate = opts.rate && opts.rate > 0 ? opts.rate : 1;
  const recipes = def.make(opts).map((r) => {
    const out = { ...r, t: r.t / rate, dur: Math.max(0.01, r.dur / rate) };
    if (out.kind === 'osc' && out.f0) out.f0 = out.f0 * rate;
    if (out.kind === 'osc' && out.f1) out.f1 = out.f1 * rate;
    return out;
  });
  return { channel: def.channel, recipes };
}

/**
 * Single bundle handed to AudioManager.configure(). Keeps core/ free of
 * cross-core imports (ARCHITECTURE.md dependency rules).
 */
export const AudioLibrary = Object.freeze({
  MusicTracks,
  AmbienceBeds,
  SfxDefinitions,
  VOICE_DEFS,
  noteToFreq,
  trackForRegion,
  resolveTrackEvents,
  resolveAmbience,
  resolveSfx,
});
