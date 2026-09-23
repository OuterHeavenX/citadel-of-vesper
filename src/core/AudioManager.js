/**
 * AudioManager — channels, volumes, crossfades, WebAudio playback (spec §6).
 *
 * CONTRACT (ARCHITECTURE.md §6):
 * - Channels: 'music' | 'ambience' | 'player' | 'enemies' | 'weapons' |
 *   'environment' | 'ui' — independent volume sliders, 0..1.
 * - playMusic(trackId, { fadeOut, fadeIn }) crossfades; emits
 *   'audio:musicChanged' { trackId, region }.
 * - setAmbience(id) for looped beds (null stops).
 * - playSfx(id, { channel, volume, rate, x, y }) — optional positional audio.
 * - stopAll() silences everything.
 * - AudioContext is created lazily and unlocked on the first user gesture
 *   (pointerdown/keydown); calls made before unlock are QUEUED, not dropped.
 * - Master mute + context suspend on 'game:autoPause', resume on
 *   'game:resumed'.
 * - Volumes: runtime here via getVolumes()/setVolume(). Persistence is owned
 *   by GameScene (later wave): it loads settings into setVolume() on boot
 *   and writes getVolumes() back to the SaveManager settings store on
 *   change. See docs/AUDIO.md ("Volume settings contract").
 * - core/ imports NOTHING except ./EventBus.js — the composition library
 *   (registries + pure resolvers from src/audio/index.js) is INJECTED via
 *   configure(library), called by Boot. Until then, playback calls are
 *   safely ignored (with a console warning).
 *
 * All music/SFX are original synthesized compositions (see src/audio).
 */
import { eventBus } from './EventBus.js';

export const Channels = Object.freeze([
  'music',
  'ambience',
  'player',
  'enemies',
  'weapons',
  'environment',
  'ui',
]);

const LOOKAHEAD_S = 0.6;      // music scheduler lookahead
const TICK_MS = 90;           // music scheduler tick
const POS_RANGE = 700;        // px: beyond this, positional sfx is silent
const POS_PAN_RANGE = 500;    // px: full stereo pan at this offset
const QUEUE_MAX = 64;         // cap on pre-unlock queued calls

export class AudioManager {
  constructor() {
    /** @type {Record<string, number>} channel -> 0..1 */
    this.volumes = {
      music: 0.8,
      ambience: 0.8,
      player: 0.8,
      enemies: 0.8,
      weapons: 0.8,
      environment: 0.8,
      ui: 0.8,
    };
    /** @type {string|null} currently playing track id */
    this.currentTrack = null;
    /** @type {string|null} currently playing ambience id */
    this.currentAmbience = null;

    // Injected composition library (src/audio/index.js AudioLibrary)
    this._lib = null;

    // WebAudio state (all created lazily in browser only)
    this._ctx = null;
    this._master = null;
    this._channelGains = {};
    this._noiseBuffer = null;
    this._unlocked = false;
    this._queue = [];
    this._muted = false;

    // Music scheduler state
    this._musicToken = 0;
    this._musicTimer = null;
    this._musicBus = null;
    this._musicEvents = null;

    // Ambience state
    this._ambienceBus = null;
    this._ambienceNodes = [];
    this._ambienceTimers = [];

    this._listener = { x: 0, y: 0 };
    this._voices = 0; // approximate active one-shot voices (debug)
    this._inited = false;
  }

  // ---------------------------------------------------------------
  // Boot / wiring
  // ---------------------------------------------------------------

  /**
   * Inject the composition library (AudioLibrary from src/audio/index.js).
   * Called once from Boot before any playback.
   * @param {object} library
   */
  configure(library) {
    this._lib = library;
  }

  /**
   * Wire gesture unlock + auto-pause subscriptions. Safe to call in Node
   * (no-ops without a window).
   */
  init() {
    if (this._inited) return;
    this._inited = true;
    if (typeof window === 'undefined') return;
    const unlock = () => this._unlock();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    eventBus.on('game:autoPause', () => this._onAutoPause());
    eventBus.on('game:resumed', () => this._onResumed());
  }

  // ---------------------------------------------------------------
  // Volumes (runtime only — persistence is GameScene's job; docs/AUDIO.md)
  // ---------------------------------------------------------------

  /** @param {string} channel @param {number} volume 0..1 */
  setVolume(channel, volume) {
    if (!Channels.includes(channel)) throw new Error(`unknown channel '${channel}'`);
    const v = Math.min(1, Math.max(0, volume));
    this.volumes[channel] = v;
    const g = this._channelGains[channel];
    if (g && this._ctx) g.gain.setTargetAtTime(v, this._ctx.currentTime, 0.02);
    // NOTE: intentionally emits no event (settings UI reads getVolumes()).
  }

  /** @param {string} channel @returns {number} */
  getVolume(channel) {
    return this.volumes[channel] ?? 0;
  }

  /** @returns {Record<string, number>} copy of all channel volumes */
  getVolumes() {
    return { ...this.volumes };
  }

  /** Master mute switch. @param {boolean} muted */
  setMuted(muted) {
    this._muted = !!muted;
    if (this._master && this._ctx) {
      this._master.gain.setTargetAtTime(this._muted ? 0 : 1, this._ctx.currentTime, 0.02);
    }
  }

  /** @returns {boolean} */
  isMuted() {
    return this._muted;
  }

  /** Positional-audio listener position (world px). */
  setListenerPosition(x, y) {
    this._listener.x = x;
    this._listener.y = y;
  }

  // ---------------------------------------------------------------
  // Music
  // ---------------------------------------------------------------

  /**
   * Crossfade to a music track. Emits 'audio:musicChanged' { trackId, region }.
   * @param {string} trackId
   * @param {{fadeOut?: number, fadeIn?: number}} [opts] seconds
   */
  playMusic(trackId, opts = {}) {
    const run = () => {
      if (!this._lib) {
        console.warn('[AudioManager] playMusic ignored: configure() not called');
        return;
      }
      const track = this._lib.MusicTracks[trackId];
      if (!track) {
        console.warn(`[AudioManager] unknown track '${trackId}'`);
        return;
      }
      if (trackId === this.currentTrack) return;

      const fadeOut = opts.fadeOut ?? 1.0;
      const fadeIn = opts.fadeIn ?? 1.5;
      const token = ++this._musicToken;
      const now = this._ctx.currentTime;

      // Fade out + tear down the old track.
      this._stopMusicScheduler();
      if (this._musicBus) {
        const oldBus = this._musicBus;
        this._musicBus = null;
        oldBus.gain.cancelScheduledValues(now);
        oldBus.gain.setValueAtTime(oldBus.gain.value, now);
        oldBus.gain.linearRampToValueAtTime(0, now + Math.max(0.01, fadeOut));
        setTimeout(() => { try { oldBus.disconnect(); } catch (_) { /* noop */ } }, (fadeOut + 0.1) * 1000);
      }

      // New bus fading in.
      const bus = this._ctx.createGain();
      bus.gain.setValueAtTime(0, now);
      bus.gain.linearRampToValueAtTime(1, now + Math.max(0.01, fadeIn));
      bus.connect(this._channelGains.music);
      this._musicBus = bus;

      const { events, duration, loop } = this._lib.resolveTrackEvents(trackId);
      this._musicEvents = events;
      this.currentTrack = trackId;

      // Iteration scheduler with lookahead.
      let nextIterStart = now + 0.05;
      let iter = 0;
      const scheduleIter = (startT) => {
        for (const e of events) this._playNote(e, startT + e.t, bus);
      };
      const tick = () => {
        if (token !== this._musicToken) return; // superseded
        const horizon = this._ctx.currentTime + LOOKAHEAD_S;
        while (nextIterStart < horizon) {
          scheduleIter(nextIterStart);
          nextIterStart += duration;
          iter += 1;
          if (!loop) {
            // One-shot stinger: stop scheduling after the first iteration.
            this._stopMusicScheduler();
            const endT = nextIterStart + 1.0;
            setTimeout(() => {
              if (token === this._musicToken && this._musicBus === bus) {
                try { bus.disconnect(); } catch (_) { /* noop */ }
                this._musicBus = null;
              }
            }, Math.max(0, (endT - this._ctx.currentTime) * 1000));
            return;
          }
        }
      };
      tick();
      this._musicTimer = setInterval(tick, TICK_MS);

      eventBus.emit('audio:musicChanged', { trackId, region: track.region });
    };
    this._callOrQueue(run);
  }

  /** Fade out and stop music. @param {{fadeOut?: number}} [opts] */
  stopMusic(opts = {}) {
    const run = () => {
      if (!this._ctx) return;
      const fadeOut = opts.fadeOut ?? 0.5;
      this._musicToken += 1;
      this._stopMusicScheduler();
      if (this._musicBus) {
        const bus = this._musicBus;
        this._musicBus = null;
        const now = this._ctx.currentTime;
        bus.gain.cancelScheduledValues(now);
        bus.gain.setValueAtTime(bus.gain.value, now);
        bus.gain.linearRampToValueAtTime(0, now + Math.max(0.01, fadeOut));
        setTimeout(() => { try { bus.disconnect(); } catch (_) { /* noop */ } }, (fadeOut + 0.1) * 1000);
      }
      this.currentTrack = null;
    };
    this._callOrQueue(run);
  }

  _stopMusicScheduler() {
    if (this._musicTimer) {
      clearInterval(this._musicTimer);
      this._musicTimer = null;
    }
    this._musicEvents = null;
  }

  // ---------------------------------------------------------------
  // Ambience
  // ---------------------------------------------------------------

  /**
   * Start a looped ambience bed (crossfades from the previous).
   * @param {string|null} ambienceId bed id, or null to stop
   */
  setAmbience(ambienceId) {
    const run = () => {
      if (!this._lib) {
        console.warn('[AudioManager] setAmbience ignored: configure() not called');
        return;
      }
      if (ambienceId !== null && !this._lib.AmbienceBeds[ambienceId]) {
        console.warn(`[AudioManager] unknown ambience '${ambienceId}'`);
        return;
      }
      if (ambienceId === this.currentAmbience) return;

      // Tear down old bed.
      for (const t of this._ambienceTimers) clearInterval(t);
      this._ambienceTimers = [];
      const oldNodes = this._ambienceNodes;
      this._ambienceNodes = [];
      if (this._ambienceBus) {
        const oldBus = this._ambienceBus;
        this._ambienceBus = null;
        const now = this._ctx.currentTime;
        oldBus.gain.cancelScheduledValues(now);
        oldBus.gain.setValueAtTime(oldBus.gain.value, now);
        oldBus.gain.linearRampToValueAtTime(0, now + 1.5);
        setTimeout(() => {
          for (const n of oldNodes) { try { n.stop ? n.stop() : n.disconnect(); } catch (_) { /* noop */ } }
          try { oldBus.disconnect(); } catch (_) { /* noop */ }
        }, 1700);
      } else {
        for (const n of oldNodes) { try { n.stop ? n.stop() : n.disconnect(); } catch (_) { /* noop */ } }
      }

      this.currentAmbience = ambienceId;
      if (ambienceId === null) return;

      const now = this._ctx.currentTime;
      const bus = this._ctx.createGain();
      bus.gain.setValueAtTime(0, now);
      bus.gain.linearRampToValueAtTime(1, now + 2.0);
      bus.connect(this._channelGains.ambience);
      this._ambienceBus = bus;

      for (const layer of this._lib.resolveAmbience(ambienceId)) {
        this._startAmbienceLayer(layer, bus);
      }
    };
    this._callOrQueue(run);
  }

  _startAmbienceLayer(layer, bus) {
    const ctx = this._ctx;
    const out = ctx.createGain();
    out.gain.value = layer.gain ?? 0.5;
    out.connect(bus);

    if (layer.kind === 'noise') {
      const src = ctx.createBufferSource();
      src.buffer = this._getNoiseBuffer();
      src.loop = true;
      let node = src;
      if (layer.filter) node = this._insertFilter(node, layer.filter);
      node.connect(out);
      src.start();
      this._ambienceNodes.push(src);
      this._attachLfos(layer, out, node);
    } else if (layer.kind === 'tone') {
      const osc = ctx.createOscillator();
      osc.type = layer.type || 'sine';
      osc.frequency.value = layer.freq;
      osc.connect(out);
      osc.start();
      this._ambienceNodes.push(osc);
      this._attachLfos(layer, out, null);
    } else if (layer.kind === 'drips') {
      const timer = setInterval(() => {
        if (Math.random() < layer.rate * 0.4) {
          const t = ctx.currentTime + 0.02;
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          const f = layer.fmin + Math.random() * (layer.fmax - layer.fmin);
          osc.frequency.setValueAtTime(f, t);
          osc.frequency.exponentialRampToValueAtTime(Math.max(40, f * 0.55), t + layer.dur);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(layer.gain ?? 0.2, t + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, t + layer.dur);
          osc.connect(g).connect(bus);
          osc.start(t);
          osc.stop(t + layer.dur + 0.05);
        }
      }, 400);
      this._ambienceTimers.push(timer);
    }
  }

  _attachLfos(layer, outGain, filterNode) {
    const ctx = this._ctx;
    if (layer.ampLfo) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = layer.ampLfo.rate;
      const depth = ctx.createGain();
      const base = layer.gain ?? 0.5;
      depth.gain.value = base * layer.ampLfo.depth;
      lfo.connect(depth).connect(outGain.gain);
      lfo.start();
      this._ambienceNodes.push(lfo);
    }
    if (layer.filterLfo && filterNode && filterNode.frequency) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = layer.filterLfo.rate;
      const depth = ctx.createGain();
      depth.gain.value = layer.filterLfo.depth;
      lfo.connect(depth).connect(filterNode.frequency);
      lfo.start();
      this._ambienceNodes.push(lfo);
    }
  }

  // ---------------------------------------------------------------
  // SFX
  // ---------------------------------------------------------------

  /**
   * Play a synthesized SFX.
   * @param {string} sfxId
   * @param {{channel?: string, volume?: number, rate?: number, x?: number, y?: number}} [opts]
   */
  playSfx(sfxId, opts = {}) {
    const run = () => {
      if (!this._lib) {
        console.warn('[AudioManager] playSfx ignored: configure() not called');
        return;
      }
      let resolved;
      try {
        resolved = this._lib.resolveSfx(sfxId, { rate: opts.rate });
      } catch (e) {
        console.warn(`[AudioManager] ${e.message}`);
        return;
      }
      const channel = opts.channel || resolved.channel;
      const chanGain = this._channelGains[channel];
      if (!chanGain) {
        console.warn(`[AudioManager] unknown channel '${channel}'`);
        return;
      }
      let vol = opts.volume ?? 1;
      let pan = 0;
      if (opts.x !== undefined && opts.y !== undefined) {
        const dx = opts.x - this._listener.x;
        const dy = opts.y - this._listener.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= POS_RANGE) return; // out of earshot
        vol *= 1 - dist / POS_RANGE;
        pan = Math.max(-1, Math.min(1, dx / POS_PAN_RANGE));
      }
      const t0 = this._ctx.currentTime + 0.01;
      const out = this._ctx.createGain();
      out.gain.value = Math.max(0, vol);
      if (pan !== 0 && this._ctx.createStereoPanner) {
        const panner = this._ctx.createStereoPanner();
        panner.pan.value = pan;
        out.connect(panner).connect(chanGain);
      } else {
        out.connect(chanGain);
      }
      for (const r of resolved.recipes) this._playRecipe(r, t0, out);
    };
    this._callOrQueue(run);
  }

  // ---------------------------------------------------------------
  // Global controls
  // ---------------------------------------------------------------

  /** Stop music + ambience immediately-ish. */
  stopAll() {
    this.stopMusic({ fadeOut: 0.3 });
    this.setAmbience(null);
  }

  /** Debug/telemetry snapshot. */
  getStats() {
    return {
      unlocked: this._unlocked,
      configured: !!this._lib,
      muted: this._muted,
      currentTrack: this.currentTrack,
      currentAmbience: this.currentAmbience,
      queued: this._queue.length,
      voices: this._voices,
      state: this._ctx ? this._ctx.state : 'none',
    };
  }

  // ---------------------------------------------------------------
  // Internals — context, unlock, queue, recipe rendering
  // ---------------------------------------------------------------

  _callOrQueue(fn) {
    if (this._ctx && this._ctx.state === 'running') {
      fn();
      return;
    }
    if (this._queue.length >= QUEUE_MAX) this._queue.shift();
    this._queue.push(fn);
    // Lazily create the context now (still suspended until gesture).
    this._ensureCtx();
  }

  _ensureCtx() {
    if (this._ctx || typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      console.warn('[AudioManager] WebAudio not available');
      return;
    }
    this._ctx = new AC();
    this._master = this._ctx.createGain();
    this._master.gain.value = this._muted ? 0 : 1;
    this._master.connect(this._ctx.destination);
    for (const ch of Channels) {
      const g = this._ctx.createGain();
      g.gain.value = this.volumes[ch];
      g.connect(this._master);
      this._channelGains[ch] = g;
    }
    if (this._ctx.state === 'running') this._flushQueue();
  }

  _unlock() {
    if (!this._ctx) this._ensureCtx();
    if (!this._ctx) return;
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().then(() => this._flushQueue()).catch(() => {});
    } else {
      this._flushQueue();
    }
  }

  _flushQueue() {
    if (!this._unlocked && this._ctx && this._ctx.state === 'running') {
      this._unlocked = true;
    }
    if (!this._unlocked) return;
    const q = this._queue;
    this._queue = [];
    for (const fn of q) {
      try { fn(); } catch (e) { console.error('[AudioManager] queued call failed', e); }
    }
  }

  _onAutoPause() {
    if (this._ctx && this._ctx.state === 'running') {
      this._ctx.suspend().catch(() => {});
    }
  }

  _onResumed() {
    if (this._ctx && this._ctx.state === 'suspended' && this._unlocked) {
      this._ctx.resume().catch(() => {});
    }
  }

  _getNoiseBuffer() {
    if (this._noiseBuffer) return this._noiseBuffer;
    const len = this._ctx.sampleRate * 2;
    const buf = this._ctx.createBuffer(1, len, this._ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // pinkish
      data[i] = last * 3.2;
    }
    this._noiseBuffer = buf;
    return buf;
  }

  _insertFilter(node, spec) {
    const f = this._ctx.createBiquadFilter();
    f.type = spec.type;
    f.frequency.value = spec.freq;
    f.Q.value = spec.Q ?? 0.8;
    node.connect(f);
    return f;
  }

  /** Render one music-note event through its voice's partial stack. */
  _playNote(e, when, bus) {
    const def = this._lib.VOICE_DEFS[e.voice];
    if (!def) return;
    const ctx = this._ctx;
    const env = def.env;
    for (const [ratio, gMul, decayMul] of def.partials) {
      const dur = e.dur * decayMul;
      const t = when;
      const osc = ctx.createOscillator();
      osc.type = def.type;
      osc.frequency.value = Math.max(1, e.freq * ratio);
      let head = osc;
      if (def.filter) head = this._insertFilter(osc, def.filter);
      const g = ctx.createGain();
      const peak = e.gain * gMul * 0.5;
      const a = Math.min(env.a, dur * 0.3);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(Math.max(0.0001, peak), t + a);
      if (env.s > 0 && dur > a + 0.05) {
        g.gain.linearRampToValueAtTime(peak * env.s, t + Math.min(dur, a + 0.4));
        g.gain.setValueAtTime(peak * env.s, t + dur);
      } else {
        g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.02, dur));
      }
      g.gain.linearRampToValueAtTime(0.0001, t + dur + env.r);
      head.connect(g).connect(bus);
      osc.start(t);
      osc.stop(t + dur + env.r + 0.05);
    }
  }

  /** Render one SFX recipe. t0 = SFX start time on the context clock. */
  _playRecipe(r, t0, out) {
    const ctx = this._ctx;
    const t = t0 + r.t;
    const peak = Math.max(0.0001, r.gain * 0.6);
    const endT = t + r.dur;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(r.a, r.dur * 0.5));
    if (r.s > 0) {
      g.gain.linearRampToValueAtTime(Math.max(0.0001, peak * r.s), t + Math.min(r.dur, r.a + r.d));
      g.gain.setValueAtTime(Math.max(0.0001, peak * r.s), endT);
    } else if (r.dur > r.a + 0.02) {
      g.gain.exponentialRampToValueAtTime(0.0001, endT);
    }
    g.gain.linearRampToValueAtTime(0.0001, endT + r.r);
    g.connect(out);

    if (r.kind === 'osc') {
      const osc = ctx.createOscillator();
      osc.type = r.type;
      osc.frequency.setValueAtTime(Math.max(1, r.f0), t);
      if (r.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, r.f1), endT);
      if (r.detune) osc.detune.value = r.detune;
      let head = osc;
      if (r.filter) head = this._insertFilter(osc, r.filter);
      head.connect(g);
      osc.start(t);
      osc.stop(endT + r.r + 0.05);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = this._getNoiseBuffer();
      src.loop = true;
      src.playbackRate.value = 0.7 + Math.random() * 0.6;
      let head = src;
      if (r.filter) head = this._insertFilter(src, r.filter);
      head.connect(g);
      src.start(t, Math.random() * 1.5);
      src.stop(endT + r.r + 0.05);
    }
    this._voices += 1;
    setTimeout(() => { this._voices = Math.max(0, this._voices - 1); }, (r.t + r.dur + r.r + 0.2) * 1000);
  }
}

/** Shared singleton. */
export const audioManager = new AudioManager();
