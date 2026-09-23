# AUDIO — channels, original music, SFX

> Originality: every track and SFX in this game is an original composition
> synthesized in code. No Castlevania (or any commercial game's) music,
> melodies, or sound effects are reproduced here — see ARCHITECTURE.md §0.

## Module split

| File | Role |
|---|---|
| `src/audio/index.js` | **Composition only.** Frozen registries (`MusicTracks`, `AmbienceBeds`, `SfxDefinitions`), timbre table (`VOICE_DEFS`), and PURE resolvers (`noteToFreq`, `resolveTrackEvents`, `resolveAmbience`, `resolveSfx`, `trackForRegion`). No `AudioContext`, no `window` — importable in Node for tests. |
| `src/audio/musicDirector.js` | **Event-driven music transitions.** Phaser-free `MusicDirector` class + pure helpers (`bossMusicFor`, `roomMusicFor`, `regionMusicForRoom`). Subscribes to `boss:encounterStarted` → boss theme, `boss:died` / `player:died` → region theme. Wired by GameScene. |
| `src/core/AudioManager.js` | **Playback only.** Singleton `audioManager` + `Channels`. Builds the WebAudio graph, schedules music, renders SFX recipes, crossfades, queues pre-unlock calls. Imports nothing except `./EventBus.js` (core dependency rule). |

The composition library is **injected**: Boot calls
`audioManager.configure(AudioLibrary)` once at startup
(`AudioLibrary` is exported from `src/audio/index.js` and bundles the
registries + resolvers). Playback calls before `configure()` are safely
ignored with a console warning.

## Channel model (§6)

Seven independent channels, each with its own gain node under a master gain:

`music` · `ambience` · `player` · `enemies` · `weapons` · `environment` · `ui`

- `audioManager.setVolume(channel, v)` / `getVolume(channel)` / `getVolumes()` — `v` clamped to 0..1. **Emits no events.**
- `setMuted(bool)` — master mute.
- `game:autoPause` suspends the AudioContext; `game:resumed` resumes it (only after the context was unlocked by a gesture).
- Autoplay policy: the context is created lazily and unlocked on the first `pointerdown`/`keydown`. Calls made before unlock are **queued** (cap 64, oldest dropped), not dropped silently.

### Volume settings contract (persistence handoff)

`AudioManager` holds volumes **at runtime only** — it never touches
`SaveManager` (core modules can't import across core). Persistence is owned
by **GameScene** (later wave):

1. On boot, GameScene reads the settings store (SaveManager `settings`,
   key e.g. `audio:volumes`, falling back to `gameState.settings`) and calls
   `audioManager.setVolume(channel, v)` for each of the 7 channels.
2. When the player moves a slider, the settings screen calls
   `audioManager.setVolume(...)` then writes `audioManager.getVolumes()`
   back to the SaveManager settings store.

## Music

`playMusic(trackId, { fadeOut = 1.0, fadeIn = 1.5 })` — crossfades from the
current track (old bus ramps to 0, new bus ramps in), starts a lookahead
scheduler (90 ms tick, 0.6 s horizon) that renders the track's resolved
events through their voice partial stacks. Emits
`audio:musicChanged { trackId, region }`. Calling it with the currently
playing track is a no-op. `stopMusic({ fadeOut })` fades out; `stopAll()`
also kills the ambience bed.

Region mapping: `RoomManager`/`GameScene` should call
`audioManager.playMusic(trackForRegion(regionId))` on region change
(`trackForRegion` returns `null` for unknown regions).

### Boss music (MusicDirector)

`src/audio/musicDirector.js` owns boss-fight music transitions, driven
solely by EventBus catalog events (no direct calls from Boss):

- `boss:encounterStarted { bossId }` → plays the boss's theme from
  `data/bosses.json` `music` (`boss_theme_1` "The Warden's Vigil" for
  `chapel_warden`, `boss_theme_2` "Sable Matriarch" for `sable_matriarch`).
- `boss:died { roomId }` → back to the REGION theme (the arena rooms tag
  the boss theme as their room music, so the region theme is restored
  explicitly).
- `player:died` → region theme of the current room (no-op when no boss
  theme is playing).

Ordinary room-change music stays with `RoomManager`. `playMusic` with the
currently-playing track is a no-op, so entering an arena (whose room tag
is already the boss theme) never double-starts it.

### Track list (all original)

| trackId | Title | Region | Loop | Character |
|---|---|---|---|---|
| `title_theme` | Vesper's Call | `title` | yes | D-minor bell arpeggio over low drones, 72 BPM |
| `moonlit_gate` | Lanterns on the Wall | `moonlit_gate` | yes | Sparse music-box motif over a fifth drone, 60 BPM |
| `hollow_keep` | Stones That Remember | `hollow_keep` | yes | Low string-ish drone + slow bass pulse, 54 BPM |
| `boss_theme` | Sable Matriarch | `boss` | yes | Driving 16th-note minor ostinato + stabs, 144 BPM |
| `victory` | Dawn After Vesper | `sting` | no | Rising bell cadence stinger |
| `gameover` | The Last Bell | `sting` | no | Tolling bells + descending line stinger |

### How to add a track

1. In `src/audio/index.js`, add an entry to `MusicTracks`:
   `{ title, region, loop, bpm, sections: [{ bars, events }] }`.
2. Write events with the `N(beat, note, durBeats, voice, gain)` helper
   (or `arp8(bar, [8 note names], voice, gain)` / `droneBar(bar, note, ...)`).
   Voices: `bell, musicbox, pad, lowpad, bass, pulse, stab, lead, drone`
   (defined in `VOICE_DEFS` — add a new timbre there if needed).
3. Melodies must be **original** — compose them, never transcribe.
4. Node-check it: `node -e "import('./src/audio/index.js').then(A =>
   console.log(A.resolveTrackEvents('your_track').events.length))"`.

## Ambience

`setAmbience(id)` crossfades looped beds; `setAmbience(null)` stops.

| Bed | Layers |
|---|---|
| `wind_night` | Pinkish noise → lowpass with slow spectral + amplitude LFOs (gusts) |
| `dungeon_drone` | 55 Hz + 82.4 Hz sine drones + bandpassed noise wash |
| `water_drips` | Low noise wash + randomized sine "drip" pings (1.1–2.8 kHz) |

Beds are pure parameter data (`resolveAmbience`) rendered by the manager —
add a bed by adding an entry with `noise` / `tone` / `drips` layers.

### Ambience wiring contract

GameScene owns ambience; RoomManager owns music. On `room:changed`
GameScene resolves the bed with `resolveRoomAmbience(roomDef)` (from
`src/scenes/gameEntry.js`, pure and headless-tested): the room def's
`ambience` tag wins when present, otherwise the region map
(`REGION_AMBIENCE`) applies. This is why `moonlit_gate_014` — a gate-region
room — keeps its `dungeon_drone` bed instead of being overridden by the
gate's `wind_night`. Unknown rooms/regions leave the current bed playing.
`water_drips` is registered and resolvable but no vertical-slice room tags
it yet.

## SFX

`playSfx(id, { channel, volume = 1, rate = 1, x, y })`.
`channel` defaults to the definition's channel; `rate` scales time and pitch
(playbackRate semantics); `x, y` enable positional attenuation against the
listener set via `setListenerPosition(x, y)` (silent beyond 700 px, stereo
pan over ±500 px).

All 32 SFX are synthesized from oscillator/noise recipes — no audio files:

| SFX | Channel | SFX | Channel |
|---|---|---|---|
| `swing` / `swing_sword` / `swing_sabre` | weapons | `ui_move` / `ui_confirm` / `ui_cancel` | ui |
| `hit` / `enemy_hit` | weapons | `door` | environment |
| `jump` / `land` / `dash` / `step` | player | `shatter` | environment |
| `coin` / `heart` / `mana` / `pickup_item` | player / ui | `teleport` / `checkpoint` / `secret` | environment |
| `levelup` | player | `enemy_die` / `boss_roar` | enemies |
| `player_hurt` | player | `save` | ui |
| `hound_growl` / `blade_scrape` / `wisp_hiss` / `page_rustle` / `bell_chime` / `swarm_chitter` | enemies | | |

Game-feel wiring (GameScene, event-driven — never called from movement
code, which stays audio-free): `combat:hitLanded` (player attacker) →
`hit`; `player:damaged` → `player_hurt`; `player:leveledUp` → `levelup`;
`save:rested` → `save`; `teleport:used` → `teleport`;
`room:checkpointTouched` → `checkpoint`; `room:secretFound` → `secret`.
Movement states are read per frame: land-state entry → `land` (+ dust),
jump/dash-state entry → `jump` / `dash`, and a timer while `walk`/`run`
plays `step` (cadence from `tuning.audio`, playback rate per region —
softer in `moonlit_gate`, harder in `hollow_keep`).

To add an SFX: add `{ channel, desc, make: (opts) => [recipes] }` to
`SfxDefinitions` using the `O(type, f0, dur, {...})` / `NZ(dur, {...})`
helpers. Unknown ids warn and no-op at playback.

## Debug

`audioManager.getStats()` → `{ unlocked, configured, muted, currentTrack,
currentAmbience, queued, voices, state }` — surfaced by the DebugOverlay
audio readout (spec §16).
