/**
 * AssetPacks — staged-loading manifests (docs/ARCHITECTURE.md §7).
 *
 * Pack naming: 'boot' | 'title' | 'room_<region>' | 'ui' | 'audio'.
 * Stages reference PACK names, never raw file lists.
 *
 * Entry schema:
 *   {
 *     key: 'lucien_idle',            // Phaser cache key (see naming below)
 *     type: 'image'|'spritesheet'|'atlas'|'audio'|'json',
 *     url: 'assets/player/lucien_idle.png',  // repo-relative, under assets/
 *     required: false,               // true => missing asset REJECTS the stage
 *     // spritesheet: frameWidth, frameHeight (+ margin, spacing)
 *     // atlas:       atlasURL (the .json sidecar; url = texture png)
 *     // audio:       urls: ['...webm', '...mp3'] (fallback chain; url used if urls absent)
 *   }
 *
 * Key naming (matches game code):
 *   - Lucien:            'lucien_<anim>'      (see ARCHITECTURE.md §10:
 *                          idle|walk|run|crouch|jump|fall|land|turn|dash|
 *                          attack_<family>|hurt|die)
 *   - Enemies/bosses:    '<id>_<anim>'        (matches data/*.json sprite/id fields)
 *   - Region tiles:      'tiles_<region>'
 *   - Parallax:          'bg_<region>_<layer>' (far|near)
 *   - Icons:             '<icon>'             (matches data/*.json icon fields)
 *   - Music:             '<trackId>'          (matches data music fields, so
 *                          AudioManager.playMusic(id) maps 1:1 to cache keys)
 *   - SFX:               '<sfxId>'            (matches data soundId/sound fields)
 *
 * URL resolution: AssetManager.resolveUrl() prefixes import.meta.env.BASE_URL.
 * Game-ready runtime files live in `public/assets/` (served in dev and copied
 * to dist/ on build); authoring sources live in `assets/`. Both use the same
 * relative paths, so 'assets/player/x.png' == public/assets/player/x.png.
 * Full naming contract: assets/README.md.
 *
 * WAVE 1–4 STATUS: no art/audio exists yet, so EVERY entry is
 * `required: false` — stages resolve `{ ok:false, missing:[...] }` and the
 * game runs on generated fallbacks (AssetManager.getTexture()). Wave 5 art
 * pass: flip `required` to true as each file lands in public/assets/.
 */
const OPT = { required: false }; // art/audio pending — Wave 5 flips these

/** @param {object} e */
const img = (key, url, extra = {}) => ({ key, type: 'image', url, ...OPT, ...extra });
/** @param {object} e */
const sheet = (key, url, frameWidth, frameHeight, extra = {}) => ({
  key, type: 'spritesheet', url, frameWidth, frameHeight, ...OPT, ...extra,
});
/** @param {object} e */
const sfx = (key, id, extra = {}) => ({
  key, type: 'audio', urls: [`assets/sfx/${id}.webm`, `assets/sfx/${id}.mp3`], ...OPT, ...extra,
});
/** @param {object} e */
const music = (key, id, extra = {}) => ({
  key, type: 'audio', urls: [`assets/music/${id}.webm`, `assets/music/${id}.mp3`], ...OPT, ...extra,
});

export const AssetPacks = Object.freeze({
  // Always-resident: Lucien's sheets + shared combat FX. Needed from the
  // first GameScene frame, so they ride the boot stage (small payload).
  boot: [
    sheet('lucien_idle', 'assets/player/lucien_idle.png', 64, 64),
    sheet('lucien_walk', 'assets/player/lucien_walk.png', 64, 64),
    sheet('lucien_run', 'assets/player/lucien_run.png', 64, 64),
    sheet('lucien_crouch', 'assets/player/lucien_crouch.png', 64, 64),
    sheet('lucien_jump', 'assets/player/lucien_jump.png', 64, 64),
    sheet('lucien_fall', 'assets/player/lucien_fall.png', 64, 64),
    sheet('lucien_land', 'assets/player/lucien_land.png', 64, 64),
    sheet('lucien_turn', 'assets/player/lucien_turn.png', 64, 64),
    sheet('lucien_dash', 'assets/player/lucien_dash.png', 64, 64),
    sheet('lucien_attack_sword', 'assets/player/lucien_attack_sword.png', 64, 64),
    sheet('lucien_hurt', 'assets/player/lucien_hurt.png', 64, 64),
    sheet('lucien_die', 'assets/player/lucien_die.png', 64, 64),
    img('fx_hit_spark', 'assets/effects/fx_hit_spark.png'),
    img('fx_slash_arc', 'assets/effects/fx_slash_arc.png'),
    img('fx_dust_puff', 'assets/effects/fx_dust_puff.png'),
  ],

  // Title screen.
  title: [
    img('logo_vesper', 'assets/ui/logo_vesper.png'),
    img('bg_title', 'assets/environments/bg_title.png'),
  ],

  // Moonlit Gate region: tiles, parallax, its enemies + miniboss.
  room_moonlit_gate: [
    img('tiles_moonlit_gate', 'assets/tilesets/moonlit_gate_tiles.png'),
    img('bg_moonlit_gate_far', 'assets/environments/bg_moonlit_gate_far.png'),
    img('bg_moonlit_gate_near', 'assets/environments/bg_moonlit_gate_near.png'),
    sheet('ash_hound_idle', 'assets/enemies/ash_hound_idle.png', 64, 64),
    sheet('ash_hound_run', 'assets/enemies/ash_hound_run.png', 64, 64),
    sheet('ash_hound_attack', 'assets/enemies/ash_hound_attack.png', 64, 64),
    sheet('rustbound_revenant_idle', 'assets/enemies/rustbound_revenant_idle.png', 64, 64),
    sheet('rustbound_revenant_walk', 'assets/enemies/rustbound_revenant_walk.png', 64, 64),
    sheet('rustbound_revenant_attack', 'assets/enemies/rustbound_revenant_attack.png', 64, 64),
    sheet('chapel_warden_idle', 'assets/bosses/chapel_warden_idle.png', 128, 128),
    sheet('chapel_warden_attack', 'assets/bosses/chapel_warden_attack.png', 128, 128),
    sheet('chapel_warden_hurt', 'assets/bosses/chapel_warden_hurt.png', 128, 128),
    sheet('chapel_warden_die', 'assets/bosses/chapel_warden_die.png', 128, 128),
    // Wave 5: Moonlit Gate NPC idle sheets (<sprite>_idle, 64x64).
    sheet('old_tam_idle', 'assets/npcs/old_tam_idle.png', 64, 64),
    sheet('sister_ansel_idle', 'assets/npcs/sister_ansel_idle.png', 64, 64),
    sheet('corvus_vane_idle', 'assets/npcs/corvus_vane_idle.png', 64, 64),
    sheet('maribel_quill_idle', 'assets/npcs/maribel_quill_idle.png', 64, 64),
  ],

  // Hollow Keep region (rooms land in Wave 3; boss: Sable Matriarch).
  room_hollow_keep: [
    img('tiles_hollow_keep', 'assets/tilesets/hollow_keep_tiles.png'),
    img('bg_hollow_keep_far', 'assets/environments/bg_hollow_keep_far.png'),
    img('bg_hollow_keep_near', 'assets/environments/bg_hollow_keep_near.png'),
    sheet('sable_matriarch_idle', 'assets/bosses/sable_matriarch_idle.png', 128, 128),
    sheet('sable_matriarch_attack', 'assets/bosses/sable_matriarch_attack.png', 128, 128),
    sheet('sable_matriarch_hurt', 'assets/bosses/sable_matriarch_hurt.png', 128, 128),
    sheet('sable_matriarch_die', 'assets/bosses/sable_matriarch_die.png', 128, 128),
    // Wave 2: Hollow Keep enemy idle sheets (<id>_<anim>, 64x64).
    // Wave 5: attack sheets for the three weakest enemies land here;
    // createEnemyAnims() tolerates enemies that only have an idle sheet.
    sheet('cinder_wisp_idle', 'assets/enemies/cinder_wisp_idle.png', 64, 64),
    sheet('cinder_wisp_attack', 'assets/enemies/cinder_wisp_attack.png', 64, 64),
    sheet('hollow_sentinel_idle', 'assets/enemies/hollow_sentinel_idle.png', 64, 64),
    sheet('vellum_phantom_idle', 'assets/enemies/vellum_phantom_idle.png', 64, 64),
    sheet('vellum_phantom_attack', 'assets/enemies/vellum_phantom_attack.png', 64, 64),
    sheet('vesper_chimer_idle', 'assets/enemies/vesper_chimer_idle.png', 64, 64),
    sheet('mote_swarm_idle', 'assets/enemies/mote_swarm_idle.png', 64, 64),
    sheet('mote_swarm_attack', 'assets/enemies/mote_swarm_attack.png', 64, 64),
    sheet('cinder_mastiff_idle', 'assets/enemies/cinder_mastiff_idle.png', 64, 64),
    // Wave 5: Hollow Keep NPC idle sheets (<sprite>_idle, 64x64).
    sheet('wren_aldervale_idle', 'assets/npcs/wren_aldervale_idle.png', 64, 64),
    sheet('gideon_hollow_idle', 'assets/npcs/gideon_hollow_idle.png', 64, 64),
  ],

  // Shared UI chrome + item/ability icons. Icon keys match data/*.json `icon`
  // fields 1:1 so UI code can do getTexture(scene, item.icon) directly.
  ui: [
    // weapons (assets/weapons/)
    img('recruit_blade', 'assets/weapons/recruit_blade.png'),
    img('moonsteel_sabre', 'assets/weapons/moonsteel_sabre.png'),
    // armor + accessories + consumables (assets/items/)
    img('wayfarer_coat', 'assets/items/wayfarer_coat.png'),
    img('dusk_hood', 'assets/items/dusk_hood.png'),
    img('moonstone_charm', 'assets/items/moonstone_charm.png'),
    img('iron_signet', 'assets/items/iron_signet.png'),
    img('ember_tonic', 'assets/items/ember_tonic.png'),
    img('vesper_draught', 'assets/items/vesper_draught.png'),
    img('ashward_draught', 'assets/items/ashward_draught.png'),
    img('waybread', 'assets/items/waybread.png'),
    // abilities (assets/items/)
    img('moonrise_leap', 'assets/items/moonrise_leap.png'),
    img('gale_dash', 'assets/items/gale_dash.png'),
    img('cinder_wave', 'assets/items/cinder_wave.png'),
    img('mending_pulse', 'assets/items/mending_pulse.png'),
    // Wave 5: gothic UI chrome keys (ui_panel, ui_button, ui_cursor, ...)
    // are appended here as the UI art pass lands.
  ],

  // Wave 5: room props (breakables + decor). Loaded once at game boot —
  // rooms reference these texture keys via data breakables[].
  props: [
    sheet('candle', 'assets/environments/props/candle.png', 8, 16),
    sheet('urn', 'assets/environments/props/urn.png', 16, 20),
    sheet('crate', 'assets/environments/props/crate.png', 16, 16),
    sheet('chandelier', 'assets/environments/props/chandelier.png', 32, 24),
    sheet('brazier', 'assets/environments/props/brazier.png', 16, 24),
    sheet('torch_wall', 'assets/environments/props/torch_wall.png', 16, 22),
    sheet('barrel', 'assets/environments/props/barrel.png', 16, 20),
    sheet('signpost', 'assets/environments/props/signpost.png', 16, 24),
    sheet('teleport_dais', 'assets/environments/props/teleport_dais.png', 32, 16),
  ],

  // All music + SFX in one pack (loaded at the title stage so the title
  // theme can play immediately). Keys match data `music` / `soundId` /
  // `sound` fields 1:1.
  audio: [
    // music (ids match src/audio/index.js MusicTracks exactly)
    music('title_theme', 'title_theme'),
    music('moonlit_gate', 'moonlit_gate'),
    music('hollow_keep', 'hollow_keep'),
    music('boss_theme_1', 'boss_theme_1'),
    music('boss_theme_2', 'boss_theme_2'),
    music('victory', 'victory'),
    music('gameover', 'gameover'),
    // sfx referenced by data
    sfx('swing_sword', 'swing_sword'),
    sfx('swing_sabre', 'swing_sabre'),
    sfx('hound_growl', 'hound_growl'),
    sfx('blade_scrape', 'blade_scrape'),
    // Wave 2: enemy telegraph + breakable sfx referenced by data/enemies.json
    // and src/props/Breakable.js (files land in Wave 5; optional until then).
    sfx('wisp_hiss', 'wisp_hiss'),
    sfx('page_rustle', 'page_rustle'),
    sfx('bell_chime', 'bell_chime'),
    sfx('swarm_chitter', 'swarm_chitter'),
    sfx('shatter', 'shatter'),
    // Wave 5 (audio): footstep tap — resolved from the synthesized
    // registry in src/audio. (enemy_hit/pickup_item already listed below
    // in the core sfx set.)
    sfx('step', 'step'),
    // core sfx set (systems reference these ids)
    sfx('ui_confirm', 'ui_confirm'),
    sfx('ui_cancel', 'ui_cancel'),
    sfx('ui_cursor', 'ui_cursor'),
    sfx('player_hurt', 'player_hurt'),
    sfx('enemy_hit', 'enemy_hit'),
    sfx('enemy_die', 'enemy_die'),
    sfx('pickup_item', 'pickup_item'),
    sfx('save_rest', 'save_rest'),
    sfx('checkpoint', 'checkpoint'),
    sfx('level_up', 'level_up'),
    sfx('ability_unlock', 'ability_unlock'),
    sfx('boss_roar', 'boss_roar'),
    // Wave 5: ambience beds (amb_<region>) are appended here; registries in src/audio/index.js.
  ],
});
