/**
 * GameScene — the persistent gameplay scene (docs/ARCHITECTURE.md §15).
 *
 * Wave 3 (W3-GAME): full integration glue. RoomManager (W3-ROOMS) swaps room
 * content inside THIS scene — it is never restarted for room changes.
 *
 * Wiring owned here:
 * - Entry intent: { newGame } / { slot } from scene.start data, else trust
 *   the gameState TitleScene pre-hydrated (reset() for new game,
 *   hydrate(save) for continue/load). Spawns at the saved position, or
 *   'moonlit_gate_001' for a fresh game.
 * - Systems: HitboxSystem, ProjectileSystem (prewarmed 48), EffectsManager
 *   (attachScene + per-frame update with REAL ms), RoomManager.
 * - Player facade + PlayerCombat + PlayerAnimation; the facade is registered
 *   as the canonical 'player' hurtbox with HitboxSystem (ARCHITECTURE §9).
 * - Camera: follow + lerp + deadzone (tuning.camera), per-room bounds.
 * - Minimal HUD (Wave 5 restyles): HP/MP bars, currency, room name, boss bar.
 * - Pause: ARCHITECTURE §14 ref-count (ui:opened/ui:closed) + tab-hide
 *   auto-pause, via PauseCoordinator (src/scenes/gameEntry.js). Gameplay
 *   updates freeze while paused; Esc toggles a minimal pause overlay
 *   (Wave 5 builds the real menu). Tab toggles the map overlay (pauses
 *   while open); I opens the inventory hook (toast until Wave 5).
 * - Ambience: audioManager.setAmbience on room:changed — room-aware
 *   (the room def's `ambience` tag wins, else the region map from
 *   src/scenes/gameEntry.js; region MUSIC stays with RoomManager per the
 *   W3-ROOMS contract). Boss-fight music is owned by the MusicDirector
 *   (src/audio/musicDirector.js): boss theme on boss:encounterStarted,
 *   region theme restored on boss:died / player:died.
 *
 * Defensive notes (parallel Wave 3 agents):
 * - RoomManager is currently the Wave 1 stub (methods throw "not
 *   implemented"). All calls go through _callRoomSync/_enterRoom, which
 *   detect the stub once and degrade to player-in-an-empty-room instead of
 *   crashing. When W3-ROOMS lands, the same call sites light up.
 * - SaveSanctum / TeleportChamber (W3-ABILITIES) and MapOverlay (W3-WORLD)
 *   landed during this wave and are loaded via import.meta.glob (separate
 *   chunks, build-safe). Wired to their exact APIs:
 *     SaveSanctum:  new SaveSanctum({ render }) +
 *                    roomManager.onSaveRoom = (room) => sanctum.activate(room)
 *                    (the hook W3-ROOMS was asked to call); update() per frame.
 *     TeleportChamber: new TeleportChamber(roomManager, { render }) +
 *                    roomManager.onTeleportRoom = (room) => chamber.bind(room);
 *                    update() per frame.
 *     MapOverlay:   new MapOverlay(scene); toggle()/show()/hide()/isOpen()/
 *                    setCurrentRoom()/update(delta). It emits ui:opened/
 *                    ui:closed { screen:'map' } itself, so GameScene does NOT
 *                    re-emit for it.
 *   INTEGRATION DECISION: while a sanctum/chamber modal is active the game
 *   pauses via the §14 ref-count (screens 'save'/'teleport'), edge-detected
 *   in _syncModalPause(). A rest/travel modal that leaves enemies live felt
 *   wrong; W3-ABILITIES can veto.
 */
import Phaser from 'phaser';
import { gameState } from '../core/GameState.js';
import { saveManager } from '../core/SaveManager.js';
import { inputManager } from '../core/InputManager.js';
import { audioManager } from '../core/AudioManager.js';
import { assetManager, Stages } from '../core/AssetManager.js';
import { dataManager } from '../core/DataManager.js';
import { eventBus } from '../core/EventBus.js';
import { tuning } from '../config/tuning.js';
import { Player } from '../player/Player.js';
import { PlayerCombat } from '../player/PlayerCombat.js';
import { PlayerAnimation } from '../player/PlayerAnimation.js';
import { HitboxSystem } from '../combat/HitboxSystem.js';
import { ProjectileSystem } from '../combat/ProjectileSystem.js';
import { effectsManager } from '../effects/index.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { Boss, resolveFloorY } from '../bosses/Boss.js';
import { SceneKeys } from './index.js';
import {
  modalRoomId,
  PauseCoordinator,
  resolveEntryIntent,
  resolveRoomAmbience,
  resolveSpawn,
  START_ROOM_ID,
} from './gameEntry.js';
import { MusicDirector } from '../audio/musicDirector.js';
// Wave 5 UI (W5-UI): headless systems registration + full-screen screens.
import { bestiary } from '../systems/Bestiary.js';
import { initStoryFlags } from '../systems/storyFlags.js';
import { inventoryManager } from '../systems/InventoryManager.js';
import { UiStack } from '../ui/UiStack.js';
import { NpcDirector } from '../ui/npc/NpcDirector.js';
import { DialogueController, renderDialogue } from '../ui/screens/DialogueController.js';
import { ShopController, renderShop } from '../ui/screens/ShopController.js';
import { InventoryController, renderInventory } from '../ui/screens/InventoryController.js';
import { PauseMenuController, renderPauseMenu } from '../ui/screens/PauseMenuController.js';
import { EndScreenController, renderEndScreen } from '../ui/screens/EndScreenController.js';
import { TouchOverlay } from '../ui/touch/TouchOverlay.js';

/**
 * Optional parallel-agent modules. import.meta.glob matches nothing until
 * the files land, so this is build-safe either way; wiring below activates
 * automatically once W3-ABILITIES / W3-WORLD merge.
 */
const OPTIONAL_MODULES = import.meta.glob([
  '../rooms/SaveSanctum.js',
  '../rooms/TeleportChamber.js',
  '../map/MapOverlay.js',
]);

const PROJECTILE_PREWARM = 48;
const CAMERA_DEADZONE_W = 64;
const CAMERA_DEADZONE_H = 36;
const PLAYER_HURTBOX = Object.freeze({ w: 12, h: 22 });
// W5-UI: defeating this boss shows the victory screen (post-credit state).
const VICTORY_BOSS_ID = 'sable_matriarch';

const HUD = Object.freeze({
  depth: 1000,
  font: "Georgia, 'Times New Roman', serif",
  mono: 'monospace',
  ink: '#d8d4e8',
  dim: '#5c5878',
  gold: '#c9a227',
  blood: '#8e2f3c',
  mana: '#3c5a8e',
});

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: SceneKeys.GAME });
    this._pause = new PauseCoordinator();
    this._ready = false;
    this._roomDead = false; // true once the RoomManager stub is detected
    this._playTimeAcc = 0;
    this._unsubs = [];
    this._prevMoveState = null;
    // W5-AUDIO: movement-audio state (footstep timer, current room for
    // region timber) + the boss-music director.
    this._stepT = 0;
    this._audioRoomId = null;
    this._musicDirector = null;
    this._mapOverlay = null;
    this._bossId = null;
    this._bossMaxHp = 1;
    this._bossHp = 1;
    this._bossPhase = 0;
    // W4-BOSS: the live boss fight (null outside arena rooms).
    this._boss = null;
    this._bossBanner = null;
    this._bossBannerTween = null;
    // Special-room modals (W3-ABILITIES exact APIs).
    this._saveSanctum = null;
    this._teleportChamber = null;
    this._sanctumWasActive = false;
    this._chamberWasActive = false;
    this._sanctumText = null;
    this._teleportText = null;

    // Built in create()/boot():
    this.player = null;
    this.roomManager = null;
    this.hitboxSystem = null;
    this.projectileSystem = null;
    this.effectsManager = effectsManager;
    this._pauseOverlay = null;
    this._pauseHint = null;
    this._toastText = null;
    this._toastTween = null;
    this._hud = null;
    // W5-UI: screen stack, controllers, NPC director, touch overlay (built in _boot).
    this._uiStack = null;
    this._dialogue = null;
    this._dialogueView = null;
    this._dialogueNpc = null;
    this._shop = null;
    this._shopView = null;
    this._inventory = null;
    this._inventoryView = null;
    this._pauseMenu = null;
    this._pauseView = null;
    this._endScreen = null;
    this._endView = null;
    this._npcDirector = null;
    this._npcPrompt = null;
    this._touchOverlay = null;
    this._storyUnsub = null;
    this._roomBanner = null;
    this._roomBannerTween = null;
  }

  // ------------------------------------------------------------- create ----

  create() {
    this.cameras.main.setBackgroundColor('#0b0d1a');

    // Launch the UI overlay scene (Wave 5 fills it with HUD/menus).
    if (!this.scene.isActive(SceneKeys.UI)) {
      this.scene.launch(SceneKeys.UI);
    }

    this._buildPauseOverlay();
    this._buildToast();
    this._subscribeBus();
    this.events.once('shutdown', () => this._onShutdown());

    // Entry intent: explicit { newGame } / { slot } wins; otherwise trust
    // the gameState TitleScene already reset()/hydrate()d.
    const intent = resolveEntryIntent(this.scene.settings.data);
    if (intent.mode === 'new') {
      gameState.reset();
      this._bootGuard();
    } else if (intent.mode === 'load-slot') {
      this._toast('Loading…');
      saveManager
        .read(intent.slot)
        .then((save) => {
          if (save) {
            gameState.hydrate(save);
            saveManager.setLastSlot(intent.slot);
          } else {
            gameState.reset(); // missing/corrupt slot: safe new game
          }
          this._bootGuard();
        })
        .catch(() => {
          gameState.reset();
          this._bootGuard();
        });
    } else {
      this._bootGuard();
    }
  }

  /** Run _boot() exactly once, surfacing async failures instead of hanging. */
  _bootGuard() {
    if (this._ready || this._booting) return;
    this._booting = true;
    this._boot()
      .catch((err) => {
        console.error('[GameScene] boot failed:', err);
        this._toast('Failed to start — see console');
      })
      .finally(() => {
        this._booting = false;
      });
  }

  /** Full wiring. Async only because the first room load + optional modules are. */
  async _boot() {
    // --- 1. combat systems ---
    this.hitboxSystem = new HitboxSystem(this);
    this.projectileSystem = new ProjectileSystem(this, this.hitboxSystem);
    this.projectileSystem.prewarm(PROJECTILE_PREWARM);

    // --- 2. AssetManager room-graph wiring (ARCHITECTURE §7) ---
    assetManager.setRoomGraphProvider(
      (roomId) => dataManager.getRoom(roomId)?.exits?.map((e) => e.target) ?? []
    );
    assetManager.setRoomRegionResolver((id) => dataManager.getRoom(id)?.region ?? null);

    // --- 2b. Wave 5: room props (breakables reference these texture keys) ---
    try {
      await assetManager.loadStage(this, Stages.ROOM('props'), ['props']);
      this._createPropAnims();
    } catch (err) {
      console.warn('[GameScene] props pack failed (breakables use fallbacks):', err?.message);
    }

    // --- 3. effects (GAME_FEEL checklist #1) ---
    this.effectsManager.attachScene(this);

    // --- 4. room manager (stub-safe until W3-ROOMS lands) ---
    this.roomManager = new RoomManager(this);
    try {
      this.roomManager.init?.({
        hitboxSystem: this.hitboxSystem,
        projectileSystem: this.projectileSystem,
        effectsManager: this.effectsManager,
      });
    } catch (err) {
      console.warn('[GameScene] roomManager.init failed:', err?.message);
    }

    // --- 5. player ---
    const spawn = resolveSpawn(gameState.data.player.position);
    const player = new Player(this, spawn.x, spawn.y);
    player.attachCombat(new PlayerCombat(player, { hitboxSystem: this.hitboxSystem }));
    const playerAnim = new PlayerAnimation(player.getSprite());
    playerAnim.createAnims(this);
    player.attachAnimation(playerAnim);
    this.player = player;

    // The FACADE is the canonical DamageSystem target (PlayerCombat docs).
    // HitboxSystem needs id/kind/getBounds on it — shimmed here so the
    // facade's own hitboxes skip it via the `target === owner` check.
    player.id = 'player';
    player.kind = 'player';
    player.getBounds = () => {
      const s = player.getSprite();
      if (s && typeof s.getBounds === 'function') {
        try {
          return s.getBounds();
        } catch {
          /* sprite mid-destroy — fall through */
        }
      }
      const p = player.getPosition();
      return { x: p.x - 8, y: p.y - 12, width: 16, height: 24 };
    };
    this.hitboxSystem.registerHurtbox(player, { ...PLAYER_HURTBOX });
    // GAME_FEEL checklist #3: victim registry for hit flashes.
    this.effectsManager.registerVictim('player', player.getSprite());

    // --- 5b. Wave 5 UI: headless systems + screen controllers + NPCs + touch ---
    this._registerWave5Systems();
    this._buildWave5Ui();

    // --- 6. camera: follow + lerp + deadzone (tuning.camera) ---
    const cam = this.cameras.main;
    const lerp = tuning?.camera?.lerp ?? 0.12;
    cam.startFollow(player.getSprite(), false, lerp, lerp);
    cam.setDeadzone(CAMERA_DEADZONE_W, CAMERA_DEADZONE_H);

    // --- 7. HUD (Wave 5 restyles) ---
    this._buildHud();
    this._refreshHudBars();
    this._refreshCurrency();
    this._refreshQuickUse();
    this._refreshRoomName(spawn.roomId);

    // --- 8. volume settings -> AudioManager channels (docs/AUDIO.md) ---
    this._applyVolumeSettings();

    // --- 9. optional parallel-agent modules ---
    this._buildModalTexts();
    await this._wireSpecialRooms();
    await this._wireMapOverlay();

    // --- 10. enter the room ---
    this._ready = true;
    this._audioRoomId = spawn.roomId;
    this._applyRoomAmbience(spawn.roomId);
    this._mapOverlay?.setCurrentRoom?.(spawn.roomId);
    await this._enterRoom(spawn.roomId, { x: spawn.x, y: spawn.y });
    this._applyCameraBounds();
  }

  // ------------------------------------------------------------- update ----

  update(_time, delta) {
    inputManager.update();
    if (!this._ready) return;

    // W6-QA: capture UI/modal activity BEFORE updates so an Escape that
    // closes inventory or a sanctum/chamber modal doesn't also open pause
    // on the same key edge.
    const stackWasActive = (this._uiStack?.count() ?? 0) > 0;
    const sanctumWasActive = this._sanctumWasActive === true;
    const chamberWasActive = this._chamberWasActive === true;

    // Special-room modals poll input themselves; tick them before the pause
    // gate so they stay responsive even while another screen holds a pause.
    try {
      this._saveSanctum?.update?.();
    } catch (err) {
      console.error('[GameScene] saveSanctum.update threw:', err);
    }
    try {
      this._teleportChamber?.update?.();
    } catch (err) {
      console.error('[GameScene] teleportChamber.update threw:', err);
    }
    this._syncModalPause();

    // The map overlay handles its own close actions (confirm/cancel) and
    // emits ui:closed itself. An Esc that just closed the map must not also
    // open the pause menu on the same press.
    const mapWasOpen = this._mapOverlay?.isOpen?.() === true;
    if (mapWasOpen) {
      try {
        this._mapOverlay.update(delta);
      } catch (err) {
        console.error('[GameScene] mapOverlay.update threw:', err);
      }
    }
    // W5-UI: screens tick before the pause gate (dialogue typewriter keeps
    // flowing, NPC prompt stays in sync) but freeze while any pause is held.
    this._tickUiScreens(delta);

    const mapJustClosed = mapWasOpen && this._mapOverlay?.isOpen?.() !== true;
    const modalWasActive = sanctumWasActive || chamberWasActive;
    if (
      inputManager.justPressed('pause') &&
      !mapJustClosed &&
      !stackWasActive &&
      !modalWasActive
    ) {
      this._openPauseMenu();
    }

    if (!this._pause.isPaused()) {
      if (inputManager.justPressed('map')) {
        try {
          this._mapOverlay?.toggle?.();
        } catch (err) {
          console.warn('[GameScene] MapOverlay toggle failed:', err?.message);
        }
      }
      if (inputManager.justPressed('inventory')) this._openInventory('items');
      if (inputManager.justPressed('quick_use')) this._quickUse();
    } else {
      return; // gameplay (and effects) frozen while a screen is open
    }

    // Play-time accumulation (1s granularity keeps GameState writes cheap).
    this._playTimeAcc += delta / 1000;
    if (this._playTimeAcc >= 1) {
      const whole = Math.floor(this._playTimeAcc);
      this._playTimeAcc -= whole;
      gameState.setPlayTime(gameState.data.playTime + whole);
    }

    const dt = Math.min(delta / 1000, 0.1); // clamp hitch spikes
    if (!this.effectsManager.shouldFreeze()) {
      try {
        this.player?.update(dt);
      } catch (err) {
        console.error('[GameScene] player.update threw:', err);
      }
      this._callRoomSync('update', dt);
      this._updateBoss(dt); // W4-BOSS: boss AI runs with the room
      this.hitboxSystem.update(dt);
      this.projectileSystem.update(dt);
      this._detectMovementAudio(dt); // GAME_FEEL checklist #4: land dust + W5-AUDIO movement sfx
      const p = this.player?.getPosition?.();
      if (p) audioManager.setListenerPosition(p.x, p.y);
    }
    // REAL unscaled ms — hit-pause countdowns must complete while frozen.
    this.effectsManager.update(delta);
  }

  // -------------------------------------------------- bus subscriptions ----

  _subscribeBus() {
    this._unsubs = [
      eventBus.on('ui:opened', ({ screen } = {}) => {
        this._pause.uiOpened(screen);
        this._applyPause();
        this._refreshHudVisibility();
      }),
      eventBus.on('ui:closed', ({ screen } = {}) => {
        this._pause.uiClosed(screen);
        this._applyPause();
        this._refreshHudVisibility();
      }),
      eventBus.on('game:autoPause', () => {
        this._pause.setAutoPaused(true);
        this._applyPause();
      }),
      eventBus.on('game:resumed', () => {
        this._pause.setAutoPaused(false);
        this._applyPause();
      }),
      eventBus.on('room:changed', ({ to } = {}) => {
        // GAME_FEEL checklist #5: release live particles/numbers/flashes on
        // swap, then rebuild views (detachViews clears the victim registry).
        try {
          this.effectsManager.detachViews();
          this.effectsManager.attachScene(this);
          if (this.player) {
            this.effectsManager.registerVictim('player', this.player.getSprite());
          }
        } catch (err) {
          console.warn('[GameScene] effects re-attach on room:changed failed:', err?.message);
        }
        // Leave save/teleport modals only when the new room re-arms them
        // (RoomManager calls onSaveRoom/onTeleportRoom during loadRoom,
        // which runs BEFORE room:changed is emitted). The modules store the
        // Room instance (which exposes .roomId, not .id), so derive the id
        // via modalRoomId() rather than trusting their raw fields.
        try {
          if (this._saveSanctum?.isActive() && modalRoomId(this._saveSanctum) !== to) {
            this._saveSanctum.deactivate();
          }
        } catch {
          /* module teardown edge — ignore */
        }
        try {
          if (this._teleportChamber?.isActive() && modalRoomId(this._teleportChamber) !== to) {
            this._teleportChamber.deactivate();
          }
        } catch {
          /* module teardown edge — ignore */
        }
        try {
          this._mapOverlay?.setCurrentRoom?.(to);
        } catch {
          /* overlay not wired — ignore */
        }
        this._applyRoomAmbience(to);
        this._audioRoomId = to;
        this._applyCameraBounds();
        this._refreshRoomName(to);
        this._showRoomBanner(to); // W5-UI: animated room-name banner
        this._npcDirector?.onRoomChanged(to); // W5-UI: rebuild NPC presence
        this._syncBossForRoom(to); // W4-BOSS: spawn/abort the arena fight
        try {
          assetManager.preloadAdjacent(this, to);
        } catch {
          /* preloading must never break gameplay */
        }
      }),
      eventBus.on('player:damaged', () => this._refreshHudBars()),
      eventBus.on('player:healed', () => this._refreshHudBars()),
      eventBus.on('player:leveledUp', () => this._refreshHudBars()),
      eventBus.on('inventory:changed', () => {
        this._refreshCurrency();
        this._refreshQuickUse(); // W5-UI: quick-use count changes
      }),
      eventBus.on('boss:encounterStarted', ({ bossId } = {}) => this._showBossBar(bossId)),
      eventBus.on('boss:phaseChanged', ({ bossId, phase } = {}) =>
        this._updateBossBar(bossId, phase)
      ),
      eventBus.on('boss:died', ({ bossId } = {}) => {
        this._hideBossBar();
        if (bossId === VICTORY_BOSS_ID) this._onVictory(); // W5-UI: victory screen
      }),
      // W4-BOSS: dying aborts the fight (exits unlock, boss cleans up).
      // W5-UI: death also raises the game-over screen.
      eventBus.on('player:died', () => {
        this._clearBoss('player-died');
        this._onPlayerDied();
      }),
      // W4-BOSS: `boss <bossId>` loads the arena through the real room
      // pipeline; room:changed then spawns the fight.
      eventBus.on('debug:command', ({ command, args } = {}) => {
        if (command === 'boss') this._debugBoss(args?.[0]);
        if (command === 'teleport') this._debugTeleport(args?.[0]);
      }),
      // Opportunistic boss-HP feed: Wave 4's Boss emits enemy:damaged with
      // its instanceId. Assumes instanceId === bossId for boss fights.
      eventBus.on('enemy:damaged', ({ instanceId, hp } = {}) => {
        if (this._bossId && instanceId === this._bossId && Number.isFinite(hp)) {
          this._bossHp = Math.max(0, hp);
          this._drawBossBar();
        }
      }),
      eventBus.on('save:rested', ({ roomId } = {}) => {
        const p = this.player?.getPosition?.();
        if (p) this.effectsManager.burst(p.x, p.y, 'save');
        this._toast(`Rested${roomId ? ` — ${roomId}` : ''}`);
      }),
      // Touch overlay UI lands in Wave 5; the setTouchAction path already
      // exists on InputManager, so there is nothing to wire here.
      eventBus.on('input:deviceChanged', () => {}),
    ];

    // W5-AUDIO: boss-fight music director + game-feel SFX subscriptions.
    this._musicDirector = new MusicDirector({
      bus: eventBus,
      audio: audioManager,
      getRoomDef: (id) => {
        try {
          return dataManager.getRoom(id) ?? null;
        } catch {
          return null;
        }
      },
      getBossDef: (id) => {
        try {
          return dataManager.getData('bosses').find((b) => b.id === id) ?? null;
        } catch {
          return null;
        }
      },
    });
    this._unsubs.push(this._musicDirector.wire());
    this._subscribeAudioBus();
  }

  /**
   * W5-AUDIO: game-feel SFX driven ONLY by EventBus catalog events —
   * AudioManager is the only audio path. All handlers are best-effort so a
   * missing/muted manager never breaks gameplay.
   * @private
   */
  _subscribeAudioBus() {
    const un = (ev, fn) => {
      try {
        const off = eventBus.on(ev, fn);
        if (typeof off === 'function') this._unsubs.push(off);
      } catch {
        /* bus is best-effort */
      }
    };
    // Player weapon impacts (enemy hits on the player surface via player:damaged).
    un('combat:hitLanded', ({ attacker } = {}) => {
      if (attacker?.kind === 'player') {
        this._sfx('hit', { channel: 'weapons', volume: tuning.audio.hitVolume });
      }
    });
    un('player:damaged', () => this._sfx('player_hurt', { channel: 'player' }));
    un('player:leveledUp', () => this._sfx('levelup', { channel: 'player' }));
    un('save:rested', () => this._sfx('save', { channel: 'ui' }));
    un('teleport:used', () => this._sfx('teleport', { channel: 'environment' }));
    un('room:checkpointTouched', () => this._sfx('checkpoint', { channel: 'environment' }));
    un('room:secretFound', () => this._sfx('secret', { channel: 'environment' }));
  }

  /** W5-AUDIO: guarded playSfx — audio must never throw into gameplay. @private */
  _sfx(id, opts = {}) {
    try {
      audioManager.playSfx(id, opts);
    } catch {
      /* audio is best-effort */
    }
  }

  // -------------------------------------------------------------- pause ----

  /**
   * Esc opens the full pause menu (W5-UI). Closing is handled by the
   * PauseMenuController itself (RESUME / cancel action) — Esc never toggles
   * a screen off while another screen still holds the pause ref-count.
   * @private
   */
  _openPauseMenu() {
    if ((this._uiStack?.count() ?? 0) > 0) return;
    if (!this._pauseMenu?.open()) return;
    this._uiStack.open('pause', {
      onClose: () => {
        try {
          this._pauseMenu.close();
        } catch {
          /* already closed */
        }
        this._destroyScreenView('_pauseView');
      },
    });
    this._renderPauseMenu();
  }

  /** Freeze gameplay while any UI screen or auto-pause demands it. */
  _applyPause() {
    const paused = this._pause.isPaused();
    try {
      if (paused) this.physics.pause();
      else this.physics.resume();
    } catch {
      /* arcade plugin is always present in gameConfig; guard anyway */
    }
    this._refreshPauseOverlay();
  }

  /**
   * W6-QA: hide HUD elements while inventory/shop are open (Phaser Canvas
   * compositing bleeds HUD-depth objects through full-screen UI).
   * @private
   */
  _refreshHudVisibility() {
    const h = this._hud;
    if (!h) return;
    // Only hide for inventory/shop; dialogue/map/etc. keep HUD visible.
    let hide = false;
    try {
      const screens = this._uiStack?.list?.() ?? [];
      hide = screens.some((s) => s === 'inventory' || s === 'shop');
    } catch {
      hide = false;
    }
    try {
      for (const key of Object.keys(h)) {
        const obj = h[key];
        if (obj?.setVisible) obj.setVisible(!hide);
      }
    } catch {
      /* best-effort */
    }
  }

  _buildPauseOverlay() {
    const { width, height } = this.scale;
    this._pauseOverlay = this.add
      .text(width / 2, height / 2 - 8, '❚❚ PAUSED', {
        fontFamily: HUD.font,
        fontSize: '20px',
        color: HUD.gold,
        letterSpacing: 4,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2000)
      .setVisible(false);
    this._pauseHint = this.add
      .text(width / 2, height / 2 + 16, '', {
        fontFamily: HUD.font,
        fontSize: '10px',
        color: HUD.dim,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2000)
      .setVisible(false);
  }

  _refreshPauseOverlay() {
    if (!this._pauseOverlay) return;
    const paused = this._pause.isPaused();
    // W6-QA: only show the pause watermark for manual pause or tab-hide
    // auto-pause; never cover full-screen UI (inventory/shop at depth 1600).
    const ui = this._pause.uiCount > 0;
    const show = paused && !ui;
    this._pauseOverlay.setVisible(show);
    this._pauseHint.setVisible(show);
    if (show) {
      const auto = this._pause.autoPaused;
      this._pauseHint.setText(
        auto ? 'tab hidden — return to resume' : 'Esc — resume'
      );
    }
  }

  // ---------------------------------------------------------------- map ----

  async _wireMapOverlay() {
    const mod = await this._loadOptional('../map/MapOverlay.js');
    const Ctor = mod?.MapOverlay ?? mod?.default;
    if (typeof Ctor !== 'function') return;
    try {
      // Exact attach: new MapOverlay(scene). It emits ui:opened/ui:closed
      // { screen:'map' } itself — GameScene must NOT re-emit for it.
      this._mapOverlay = new Ctor(this);
    } catch (err) {
      console.warn('[GameScene] MapOverlay construction failed:', err?.message);
      this._mapOverlay = null;
    }
  }

  // ------------------------------------------------------- special rooms ----

  /**
   * SaveSanctum / TeleportChamber (W3-ABILITIES) — wired to their exact APIs:
   *   SaveSanctum:     new SaveSanctum({ render })
   *   TeleportChamber: new TeleportChamber(roomManager, { render })
   * RoomManager (W3-ROOMS) was asked to call `this.onSaveRoom?.(room)` /
   * `this.onTeleportRoom?.(room)` after loadRoom for save/teleport rooms, so
   * GameScene installs those hooks here. If the modules fail to load, a
   * minimal rest+save fallback keeps save rooms functional.
   */
  async _wireSpecialRooms() {
    // --- SaveSanctum ---
    const ssMod = await this._loadOptional('../rooms/SaveSanctum.js');
    const SsCtor = ssMod?.SaveSanctum ?? ssMod?.default;
    if (typeof SsCtor === 'function') {
      try {
        this._saveSanctum = new SsCtor({
          render: (s) => this._renderSanctum(s),
          // W6-QA: live position for the pre-save snapshot (gameState
          // position goes stale mid-room; the sanctum is Phaser-free).
          getPlayerPosition: () => {
            const p = this.player?.getPosition?.();
            if (!p) return null;
            return {
              roomId: this.roomManager?.currentRoomId ?? null,
              x: p.x,
              y: p.y,
            };
          },
        });
      } catch (err) {
        console.warn('[GameScene] SaveSanctum construction failed:', err?.message);
        this._saveSanctum = null;
      }
    }
    // --- TeleportChamber ---
    const tcMod = await this._loadOptional('../rooms/TeleportChamber.js');
    const TcCtor = tcMod?.TeleportChamber ?? tcMod?.default;
    if (typeof TcCtor === 'function') {
      try {
        this._teleportChamber = new TcCtor(this.roomManager, {
          render: (s) => this._renderChamber(s),
        });
      } catch (err) {
        console.warn('[GameScene] TeleportChamber construction failed:', err?.message);
        this._teleportChamber = null;
      }
    }

    if (this.roomManager) {
      if (this._saveSanctum) {
        this.roomManager.onSaveRoom = (room) => {
          try {
            this._saveSanctum.activate(room);
          } catch (err) {
            console.warn('[GameScene] saveSanctum.activate failed:', err?.message);
          }
        };
      } else {
        // Fallback: rest + persist so save rooms work before W3-ABILITIES lands.
        this.roomManager.onSaveRoom = (room) =>
          this._defaultSaveRoomRest(room?.id ?? room);
      }
      if (this._teleportChamber) {
        this.roomManager.onTeleportRoom = (room) => {
          try {
            this._teleportChamber.bind(room);
          } catch (err) {
            console.warn('[GameScene] teleportChamber.bind failed:', err?.message);
          }
        };
      }
    }
  }

  /**
   * Edge-detect sanctum/chamber modal activity and hold/release the §14
   * pause ref-count accordingly (screens 'save' / 'teleport'). The modules
   * activate/deactivate themselves (RoomManager hooks, cancel key), so
   * polling is the only reliable signal.
   * @private
   */
  _syncModalPause() {
    let sActive = false;
    let tActive = false;
    try {
      sActive = this._saveSanctum?.isActive() === true;
    } catch {
      sActive = false;
    }
    try {
      tActive = this._teleportChamber?.isActive() === true;
    } catch {
      tActive = false;
    }
    if (sActive !== this._sanctumWasActive) {
      this._sanctumWasActive = sActive;
      eventBus.emit(sActive ? 'ui:opened' : 'ui:closed', { screen: 'save' });
    }
    if (tActive !== this._chamberWasActive) {
      this._chamberWasActive = tActive;
      eventBus.emit(tActive ? 'ui:opened' : 'ui:closed', { screen: 'teleport' });
    }
  }

  /** Minimal text views for the sanctum/chamber modals (Wave 5 restyles). */
  _buildModalTexts() {
    const { width } = this.scale;
    const style = {
      fontFamily: HUD.font,
      fontSize: '11px',
      color: HUD.ink,
      backgroundColor: '#14101ecc',
      padding: { x: 10, y: 6 },
      align: 'center',
      lineSpacing: 4,
    };
    this._sanctumText = this.add
      .text(width / 2, 148, '', style)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1500)
      .setVisible(false);
    this._teleportText = this.add
      .text(width / 2, 244, '', style)
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1500)
      .setVisible(false);
  }

  /** @private SaveSanctum render callback */
  _renderSanctum(state) {
    const t = this._sanctumText;
    if (!t) return;
    if (!this._saveSanctum?.isActive?.()) {
      t.setVisible(false);
      return;
    }
    const confirm = inputManager.getPrompt('confirm');
    const cancel = inputManager.getPrompt('cancel');
    let msg;
    if (state.mode === 'slots') {
      const slots = [1, 2, 3]
        .map((s) => (s === state.slot ? `❖${s}` : ` ${s} `))
        .join('  ');
      msg = `— SHRINE OF REST —\n${slots}\n[${confirm}] save · [${cancel}] back`;
    } else if (state.mode === 'done') {
      msg = `${state.message ?? ''}\n[${confirm}] continue`;
    } else {
      msg =
        `❖ Shrine of Rest ❖\n` +
        `[${confirm}] rest · [${cancel}] leave`;
    }
    t.setText(msg).setVisible(true);
  }

  /** @private TeleportChamber render callback */
  _renderChamber(state) {
    const t = this._teleportText;
    if (!t) return;
    if (!this._teleportChamber?.isActive?.()) {
      t.setVisible(false);
      return;
    }
    const confirm = inputManager.getPrompt('confirm');
    const cancel = inputManager.getPrompt('cancel');
    let msg;
    if (state.mode === 'select') {
      const lines = (state.targets ?? []).map((id, i) =>
        i === state.cursor ? `❖ ${id}` : `   ${id}`
      );
      msg =
        `— TELEPORT CHAMBER —\n` +
        (lines.length ? lines.join('\n') : '(no other chambers discovered)') +
        `\n[${confirm}] travel · [${cancel}] back`;
    } else {
      msg = `❖ Teleport Chamber ❖\n[${confirm}] choose destination · [${cancel}] leave`;
    }
    t.setText(msg).setVisible(true);
  }

  /** Minimal rest sequence used only until SaveSanctum lands. */
  async _defaultSaveRoomRest(roomId) {
    gameState.rest();
    const p = this.player?.getPosition?.();
    const rid = roomId ?? this.roomManager?.currentRoomId ?? START_ROOM_ID;
    if (p) gameState.setPosition(rid, p.x, p.y);
    const slot = saveManager.getLastSlot() ?? 1;
    let ok = false;
    try {
      ok = (await saveManager.write(slot, gameState.toJSON()))?.ok === true;
    } catch {
      ok = false;
    }
    this._toast(ok ? 'Rested — progress saved' : 'Rested (save failed)');
  }

  /** @private load an optional parallel-agent module, or null when absent */
  async _loadOptional(path) {
    const loader = OPTIONAL_MODULES[path];
    if (typeof loader !== 'function') return null;
    try {
      return await loader();
    } catch (err) {
      console.warn(`[GameScene] optional module '${path}' failed to load:`, err?.message);
      return null;
    }
  }

  // --------------------------------------------------------------- rooms ----

  /** @private stub-safe synchronous RoomManager call */
  _callRoomSync(method, ...args) {
    if (this._roomDead || !this.roomManager) return undefined;
    const fn = this.roomManager[method];
    if (typeof fn !== 'function') return undefined;
    try {
      const ret = fn.apply(this.roomManager, args);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => this._noteRoomFailure(method, err));
      }
      return ret;
    } catch (err) {
      this._noteRoomFailure(method, err);
      return undefined;
    }
  }

  /** @private first load + transitions; never throws out */
  async _enterRoom(roomId, spawnHint) {
    let ret;
    try {
      ret = this.roomManager?.loadRoom?.(roomId, spawnHint);
    } catch (err) {
      this._noteRoomFailure('loadRoom', err);
      return;
    }
    if (ret && typeof ret.then === 'function') {
      try {
        await ret;
      } catch (err) {
        this._noteRoomFailure('loadRoom', err);
      }
    }
  }

  /** @private classify RoomManager failures: stub (expected) vs real errors */
  _noteRoomFailure(method, err) {
    if (String(err?.message).includes('not implemented')) {
      if (!this._roomDead) {
        this._roomDead = true;
        console.warn(
          '[GameScene] RoomManager is the Wave 1 stub (W3-ROOMS not landed) — ' +
            'room content disabled, player/HUD still live.'
        );
      }
      return;
    }
    console.error(`[GameScene] RoomManager.${method} failed:`, err);
    this._toast('Room failed to load');
  }

  /** Camera bounds from the live room (RoomManager.getBounds, W3-ROOMS). */
  _applyCameraBounds() {
    const b = this._callRoomSync('getBounds');
    if (!b || typeof b !== 'object') return;
    let x, y, w, h;
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) {
      x = b.x ?? b.left ?? 0;
      y = b.y ?? b.top ?? 0;
      w = b.width;
      h = b.height;
    } else if (
      Number.isFinite(b.left) &&
      Number.isFinite(b.right) &&
      Number.isFinite(b.top) &&
      Number.isFinite(b.bottom)
    ) {
      x = b.left;
      y = b.top;
      w = b.right - b.left;
      h = b.bottom - b.top;
    } else {
      return;
    }
    if (!(w > 0 && h > 0)) return;
    this.cameras.main.setBounds(x, y, w, h);
    try {
      this.physics.world.setBounds(x, y, w, h);
    } catch {
      /* camera bounds are the contract; world bounds are best-effort */
    }
  }

  /**
   * Room ambience bed on room change (music stays with RoomManager).
   * Room-aware: the room def's `ambience` tag wins over the region map,
   * so moonlit_gate_014 keeps its dungeon drone instead of being
   * overridden by the gate's night wind.
   */
  _applyRoomAmbience(roomId) {
    let bed = null;
    try {
      bed = resolveRoomAmbience(dataManager.getRoom(roomId) ?? null);
    } catch {
      /* data lookup is best-effort */
    }
    if (!bed) return; // unknown room/region: leave the current bed playing
    try {
      audioManager.setAmbience(bed);
    } catch (err) {
      console.warn('[GameScene] setAmbience failed:', err?.message);
    }
  }

  // ----------------------------------------------------------------- HUD ----

  _buildHud() {
    const d = HUD.depth;
    const label = (x, y, text) =>
      this.add
        .text(x, y, text, { fontFamily: HUD.mono, fontSize: '8px', color: HUD.dim })
        .setScrollFactor(0)
        .setDepth(d);
    label(8, 8, 'HP');
    label(8, 20, 'MP');
    const gfx = this.add.graphics().setScrollFactor(0).setDepth(d);
    const levelText = this.add
      .text(154, 19, '', { fontFamily: HUD.mono, fontSize: '9px', color: HUD.gold })
      .setScrollFactor(0)
      .setDepth(d);
    const currency = this.add
      .text(8, 36, '', { fontFamily: HUD.mono, fontSize: '9px', color: HUD.gold })
      .setScrollFactor(0)
      .setDepth(d);
    // W5-UI: quick-use consumable indicator.
    const quickUse = this.add
      .text(8, 47, '', { fontFamily: HUD.mono, fontSize: '9px', color: HUD.dim })
      .setScrollFactor(0)
      .setDepth(d);
    const roomName = this.add
      .text(472, 8, '', {
        fontFamily: HUD.font,
        fontSize: '10px',
        color: HUD.ink,
        letterSpacing: 1,
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(d);
    // Boss bar (hidden until boss:encounterStarted).
    const bossGfx = this.add.graphics().setScrollFactor(0).setDepth(d).setVisible(false);
    const bossName = this.add
      .text(240, 228, '', {
        fontFamily: HUD.font,
        fontSize: '11px',
        color: HUD.blood,
        letterSpacing: 2,
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(d)
      .setVisible(false);
    const bossPhase = this.add
      .text(240, 254, '', { fontFamily: HUD.mono, fontSize: '8px', color: HUD.dim })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(d)
      .setVisible(false);
    this._hud = { gfx, currency, roomName, bossGfx, bossName, bossPhase, levelText, quickUse };
  }

  _refreshHudBars() {
    const h = this._hud;
    if (!h) return;
    const p = gameState.data.player;
    let maxHp = p.maxHp ?? 1;
    let maxMp = p.maxMp ?? 1;
    try {
      maxHp = this.player?.getStats?.()?.getEffectiveMaxHp?.() ?? maxHp;
    } catch {
      /* stats not wired — fall back to stored max */
    }
    const hpFrac = Math.max(0, Math.min(1, (p.hp ?? 0) / Math.max(1, maxHp)));
    const mpFrac = Math.max(0, Math.min(1, (p.mp ?? 0) / Math.max(1, maxMp)));
    const g = h.gfx;
    g.clear();
    // HP bar
    g.fillStyle(0x14101e, 0.8).fillRect(30, 8, 120, 8);
    g.fillStyle(0x8e2f3c, 1).fillRect(30, 8, 120 * hpFrac, 8);
    // MP bar
    g.fillStyle(0x14101e, 0.8).fillRect(30, 20, 120, 6);
    g.fillStyle(0x3c5a8e, 1).fillRect(30, 20, 120 * mpFrac, 6);
    // W5-UI: XP bar + level
    let xpFrac = 0;
    try {
      const next = this.player?.getStats?.()?.xpForNextLevel?.();
      if (Number.isFinite(next) && next > 0) {
        xpFrac = Math.max(0, Math.min(1, (p.xp ?? 0) / next));
      }
    } catch {
      /* stats not wired — bar stays empty */
    }
    g.fillStyle(0x14101e, 0.8).fillRect(30, 29, 120, 3);
    g.fillStyle(0xc9a227, 1).fillRect(30, 29, 120 * xpFrac, 3);
    try {
      h.levelText?.setText(`Lv ${p.level ?? 1}`);
    } catch {
      /* text write is cosmetic */
    }
  }

  /**
   * W5-UI: refresh the quick-use consumable/count indicator.
   * @private
   */
  _refreshQuickUse() {
    const h = this._hud;
    if (!h?.quickUse) return;
    const id = gameState.data.settings?.quickUseItemId ?? 'ember_tonic';
    const count = inventoryManager.count(id);
    const data = inventoryManager.describe(id);
    const key = inputManager.getPrompt('quick_use');
    h.quickUse.setText(`[${key}] ${data?.name ?? id} ×${count}`);
  }

  /**
   * W5-UI: drink the configured quick-use consumable (no pause needed).
   * @private
   */
  _quickUse() {
    const id = gameState.data.settings?.quickUseItemId ?? 'ember_tonic';
    let res;
    try {
      res = inventoryManager.useItem(id, { player: this.player });
    } catch {
      res = { ok: false };
    }
    if (!res?.ok) {
      this._toast(res?.reason === 'none_held' ? 'None left' : 'Cannot use that now');
    }
  }

  /** @private animated room-name banner on every room:changed */
  _showRoomBanner(roomId) {
    if (!roomId) return;
    try {
      if (this._roomBannerTween) {
        this._roomBannerTween.stop();
        this._roomBannerTween = null;
      }
      this._roomBanner?.destroy?.();
      const name = dataManager.getRoom(roomId)?.name ?? roomId;
      const { width } = this.scale;
      this._roomBanner = this.add
        .text(width / 2, 52, name, {
          fontFamily: HUD.font,
          fontSize: '16px',
          color: '#e8d9a0',
          letterSpacing: 6,
          stroke: '#0b0d1a',
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(2001)
        .setAlpha(0);
      this._roomBannerTween = this.tweens.add({
        targets: this._roomBanner,
        alpha: 1,
        duration: 500,
        hold: 1500,
        yoyo: true,
        onComplete: () => {
          try {
            this._roomBanner?.destroy?.();
          } catch {
            /* ignore */
          }
          this._roomBanner = null;
          this._roomBannerTween = null;
        },
      });
    } catch {
      /* banner is cosmetic; never break room transitions */
    }
  }

  _refreshCurrency() {
    this._hud?.currency.setText(`◈ ${gameState.data.currency ?? 0}`);
  }

  _refreshRoomName(roomId) {
    if (!this._hud || !roomId) return;
    const name = dataManager.getRoom(roomId)?.name ?? roomId;
    this._hud.roomName.setText(name);
  }

  _bossDef(bossId) {
    try {
      return dataManager.getData('bosses').find((b) => b.id === bossId) ?? null;
    } catch {
      return null;
    }
  }

  _showBossBar(bossId) {
    if (!bossId || !this._hud) return;
    const def = this._bossDef(bossId);
    this._bossId = bossId;
    this._bossMaxHp = Number.isFinite(def?.hp) && def.hp > 0 ? def.hp : 1;
    this._bossHp = this._bossMaxHp;
    this._bossPhase = 0;
    this._hud.bossGfx.setVisible(true);
    this._hud.bossName.setVisible(true).setText(def?.name ?? bossId);
    this._hud.bossPhase.setVisible(true);
    this._drawBossBar();
  }

  _updateBossBar(bossId, phase) {
    if (!this._hud || bossId !== this._bossId) return;
    if (Number.isFinite(phase)) this._bossPhase = phase;
    this._drawBossBar();
  }

  _hideBossBar() {
    this._bossId = null;
    if (!this._hud) return;
    this._hud.bossGfx.setVisible(false);
    this._hud.bossName.setVisible(false);
    this._hud.bossPhase.setVisible(false);
  }

  _drawBossBar() {
    const h = this._hud;
    if (!h || !this._bossId) return;
    const g = h.bossGfx;
    g.clear();
    const w = 200;
    const x = 240 - w / 2;
    const frac = Math.max(0, Math.min(1, this._bossHp / this._bossMaxHp));
    g.fillStyle(0x14101e, 0.85).fillRect(x, 242, w, 8);
    g.fillStyle(0x8e2f3c, 1).fillRect(x, 242, w * frac, 8);
    const phases = this._bossDef(this._bossId)?.phases ?? 0;
    h.bossPhase.setText(
      phases > 0 ? `phase ${Math.min(this._bossPhase + 1, phases)} / ${phases}` : ''
    );
  }

  // ---------------------------------------------------------- W4-BOSS ----

  /**
   * Keep the live boss in sync with the current room: spawn the arena's
   * boss on entry (unless defeated), abort the fight when leaving the
   * arena or when the arena has no boss.
   * @param {string} roomId the room that just went live
   */
  _syncBossForRoom(roomId) {
    let def = null;
    try {
      def = dataManager.getData('bosses').find((b) => b.arenaRoomId === roomId) ?? null;
    } catch {
      def = null;
    }
    if (!def) {
      this._clearBoss('left-arena');
      return;
    }
    if (gameState.data.bossStates?.[def.id] === 'defeated') {
      this._clearBoss('defeated');
      return;
    }
    if (this._boss && this._boss.bossId === def.id && this._boss.isAlive()) return;
    this._clearBoss('respawn');
    this._spawnBoss(def, roomId);
  }

  /** @private construct the Boss with GameScene-wired hooks */
  _spawnBoss(def, roomId) {
    const roomDef = dataManager.getRoom(roomId);
    const spawn = def.spawn ?? { x: (roomDef?.width ?? 960) * 0.72 };
    const floorY = resolveFloorY(roomDef, spawn.x);
    const y = Number.isFinite(spawn.y) ? spawn.y : floorY;
    try {
      this._boss = new Boss(this, def, spawn.x, y, {
        roomId,
        hitboxSystem: this.hitboxSystem,
        projectileSystem: this.projectileSystem,
        effectsManager: this.effectsManager,
        getPlayer: () => this.player,
        getFloorY: (x) => resolveFloorY(dataManager.getRoom(roomId), x),
        spawnMinion: (enemyId, mx, my) => this.roomManager?.spawnEnemy?.(enemyId, mx, my) ?? null,
        onCameraLock: (locked) => this._setBossCameraLock(locked),
        onShowBanner: (name, title) => this._showBossBanner(name, title),
        onLockExits: (locked) => {
          try {
            if (locked) this.roomManager?.lockExits?.('boss');
            else this.roomManager?.unlockExits?.();
          } catch { /* never break the fight */ }
        },
        fx: {
          shake: (trauma) => {
            try { this.effectsManager.screenShake(trauma, 350); } catch { /* ignore */ }
          },
          hitPause: (ms) => {
            try { this.effectsManager.hitPause(ms); } catch { /* ignore */ }
          },
          landDust: (x, dy) => {
            try { this.effectsManager.spawnLandDust(x, dy); } catch { /* ignore */ }
          },
        },
      });
    } catch (err) {
      console.error(`[GameScene] boss spawn failed (${def.id}):`, err);
      this._boss = null;
    }
  }

  /** @private tick the live boss; never throws out */
  _updateBoss(dt) {
    if (!this._boss || this._boss.destroyed) return;
    try {
      const p = this.player?.getPosition?.();
      this._boss.update(dt, p ? { x: p.x, y: p.y } : null);
      if (this._boss.isDead()) this._boss = null; // death rewards already granted
    } catch (err) {
      console.error('[GameScene] boss.update threw:', err);
    }
  }

  /** @private abort/teardown the live boss (room left, player died, respawn) */
  _clearBoss(reason) {
    if (!this._boss) return;
    try {
      this._boss.destroy();
    } catch (err) {
      console.warn(`[GameScene] boss destroy (${reason}) threw:`, err?.message);
    }
    this._boss = null;
  }

  /** @private entrance name banner (original gothic styling) */
  _showBossBanner(name, title) {
    try {
      if (this._bossBannerTween) {
        this._bossBannerTween.stop();
        this._bossBannerTween = null;
      }
      this._bossBanner?.destroy?.();
      const { width } = this.scale;
      this._bossBanner = this.add
        .text(width / 2, 84, `${name}\n${title}`, {
          fontFamily: HUD.font,
          fontSize: '15px',
          color: '#e8d9a0',
          align: 'center',
          lineSpacing: 4,
          stroke: '#0b0d1a',
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(2001)
        .setAlpha(0);
      this._bossBannerTween = this.tweens.add({
        targets: this._bossBanner,
        alpha: 1,
        duration: 400,
        hold: 1600,
        yoyo: true,
        onComplete: () => {
          try { this._bossBanner?.destroy?.(); } catch { /* ignore */ }
          this._bossBanner = null;
          this._bossBannerTween = null;
        },
      });
    } catch {
      /* banner is cosmetic; never break the fight */
    }
  }

  /** @private camera lock during the boss entrance sequence */
  _setBossCameraLock(locked) {
    try {
      const cam = this.cameras.main;
      if (locked) {
        cam.stopFollow();
        const b = this._boss;
        if (b) cam.pan(b.x, Math.max(60, b.y - 60), 500);
      } else {
        const sprite = this.player?.getSprite?.();
        if (sprite) cam.startFollow(sprite, false, tuning.camera.lerp, tuning.camera.lerp);
      }
    } catch {
      /* camera is best-effort */
    }
  }

  /** @private debug `boss <bossId>`: load the arena via the real pipeline */
  _debugBoss(bossId) {
    if (!bossId) {
      this._toast('usage: boss <bossId>');
      return;
    }
    const def = this._bossDef(bossId);
    if (!def) {
      this._toast(`unknown boss '${bossId}'`);
      return;
    }
    this._toast(`summoning ${def.name}…`);
    this._enterRoom(def.arenaRoomId, null);
  }

  /** W6-QA: `teleport <roomId>` — routes through the real room pipeline. */
  _debugTeleport(roomId) {
    if (!roomId) {
      this._toast('usage: teleport <roomId>');
      return;
    }
    let def = null;
    try {
      def = dataManager.getRoom(roomId) ?? null;
    } catch {
      def = null;
    }
    if (!def) {
      this._toast(`unknown room '${roomId}'`);
      return;
    }
    this._toast(`teleporting to ${roomId}…`);
    this._enterRoom(roomId, null);
  }

  // ------------------------------------------------------------ W5-UI ----

  /**
   * Register Wave 5 headless systems once per GameScene lifetime. Guarded
   * so scene restarts on the same instance don't double-subscribe the bus.
   * @private
   */
  _registerWave5Systems() {
    try {
      bestiary.init(); // idempotent — safe on every boot
    } catch (err) {
      console.warn('[GameScene] bestiary.init failed:', err?.message);
    }
    if (!this._storyUnsub) {
      try {
        this._storyUnsub = initStoryFlags();
      } catch (err) {
        console.warn('[GameScene] initStoryFlags failed:', err?.message);
      }
    }
  }

  /** @private build every Wave 5 screen controller, the NPC director, touch */
  _buildWave5Ui() {
    this._uiStack = new UiStack();

    this._dialogue = new DialogueController({
      onViewChanged: () => this._renderDialogue(),
      onDialogueClosed: (npcId, ended) => this._onDialogueClosed(npcId, ended),
    });
    this._shop = new ShopController({ onViewChanged: () => this._renderShop() });
    this._inventory = new InventoryController({
      getPlayer: () => this.player,
      getStats: () => {
        try {
          return this.player?.getStats?.() ?? null;
        } catch {
          return null;
        }
      },
      saveGame: (slot) => this._saveToSlot(slot),
      openFullMap: () => this._openFullMapFromInventory(),
      persistSettings: () => this._persistSettings(),
      onViewChanged: () => this._renderInventory(),
    });
    this._pauseMenu = new PauseMenuController({
      actions: {
        resume: () => this._uiStack.close('pause'),
        openInventory: () => {
          this._uiStack.close('pause');
          this._openInventory('items');
        },
        openMap: () => {
          this._uiStack.close('pause');
          try {
            this._mapOverlay?.show?.();
          } catch (err) {
            console.warn('[GameScene] map show failed:', err?.message);
          }
        },
        openSettings: () => {
          this._uiStack.close('pause');
          this._openInventory('config');
        },
        openSave: () => {
          this._uiStack.close('pause');
          this._openInventory('save');
        },
        quitToTitle: () => this._quitToTitle(),
      },
      onViewChanged: () => this._renderPauseMenu(),
    });
    this._endScreen = new EndScreenController({
      actions: {
        respawn: () => {
          void this._respawnAtLastSave();
        },
        continue: () => this._uiStack.close('victory'),
        quitToTitle: () => this._quitToTitle(),
      },
      onViewChanged: () => this._renderEndScreen(),
    });

    this._npcDirector = new NpcDirector({
      input: inputManager,
      getPlayerPos: () => {
        try {
          return this.player?.getPosition?.() ?? null;
        } catch {
          return null;
        }
      },
      isUiOpen: () => (this._uiStack?.count() ?? 0) > 0 || this._pause.isPaused(),
      spawnSprite: (npc) => this._spawnNpcSprite(npc),
      despawnSprite: (handle) => this._despawnNpcSprite(handle),
      showPrompt: (npc, x, y) => this._showNpcPrompt(npc, x, y),
      hidePrompt: () => this._hideNpcPrompt(),
      onInteract: (npc) => this._openDialogue(npc),
    });
    this._buildNpcPrompt();

    this._touchOverlay = new TouchOverlay(this);
    this._touchOverlay.attach();
  }

  /** @private per-frame tick for all Wave 5 screens; never throws out */
  _tickUiScreens(delta) {
    const dt = Math.min(delta / 1000, 0.1);
    // W6-QA: capture shop state BEFORE the dialogue update. If the dialogue
    // closes and opens the shop this frame, the shop must NOT tick on the
    // same confirm press that closed the dialogue (would auto-buy item 0).
    const shopWasOpen = this._shop?.isOpen() === true;
    try {
      this._dialogue?.update(dt);
    } catch (err) {
      console.error('[GameScene] dialogue.update threw:', err);
    }
    try {
      if (shopWasOpen && this._shop?.isOpen() && this._shop.update()) this._uiStack?.close('shop');
    } catch (err) {
      console.error('[GameScene] shop.update threw:', err);
    }
    try {
      const inv = this._inventory;
      const wasOpen = inv?.isOpen() === true;
      inv?.update();
      if (wasOpen && inv && !inv.isOpen()) this._uiStack?.close('inventory');
    } catch (err) {
      console.error('[GameScene] inventory.update threw:', err);
    }
    try {
      this._pauseMenu?.update();
    } catch (err) {
      console.error('[GameScene] pauseMenu.update threw:', err);
    }
    try {
      this._endScreen?.update();
    } catch (err) {
      console.error('[GameScene] endScreen.update threw:', err);
    }
    try {
      this._npcDirector?.update();
    } catch (err) {
      console.error('[GameScene] npcDirector.update threw:', err);
    }
  }

  /** @private destroy a Phaser view field, best-effort */
  _destroyScreenView(field) {
    try {
      this[field]?.destroy?.();
    } catch {
      /* already gone */
    }
    this[field] = null;
  }

  // ---- dialogue ----

  /**
   * Open dialogue for an NPC (never while another screen owns the stack).
   * Merchants chain into their shop when the dialogue ends.
   * @private
   */
  _openDialogue(npc) {
    if (!npc || (this._uiStack?.count() ?? 0) > 0) return;
    let ok = false;
    try {
      ok = this._dialogue.open(npc.id);
    } catch (err) {
      console.warn('[GameScene] dialogue open failed:', err?.message);
      return;
    }
    if (!ok) return;
    this._dialogueNpc = npc;
    this._uiStack.open('dialogue', {
      onClose: () => {
        try {
          this._dialogue.close();
        } catch {
          /* already closed */
        }
        this._destroyScreenView('_dialogueView');
        this._dialogueNpc = null;
      },
    });
    this._renderDialogue();
  }

  /** @private DialogueController hook: dialogue ended or was cancelled */
  _onDialogueClosed(npcId, ended) {
    const npc = this._dialogueNpc;
    this._uiStack?.close('dialogue');
    // W6-QA: only open the merchant shop when the dialogue ENDED (not on
    // cancel/escape); a cancelled dialogue should not open the shop.
    if (ended === true && npc && npc.isMerchant) this._openShop(npc);
  }

  /** @private rebuild the Phaser dialogue view from the controller state */
  _renderDialogue() {
    this._destroyScreenView('_dialogueView');
    const view = this._dialogue?.getView?.();
    if (!view) return;
    try {
      this._dialogueView = renderDialogue(this, view, inputManager.getPrompt('confirm'));
    } catch (err) {
      console.warn('[GameScene] renderDialogue failed:', err?.message);
    }
  }

  // ---- shop ----

  /** @private open the merchant's shop after his dialogue closes */
  _openShop(npc) {
    if ((this._uiStack?.count() ?? 0) > 0) return;
    let merchantId = null;
    try {
      merchantId = npc?.getMerchant?.().id ?? null;
    } catch {
      merchantId = null;
    }
    if (!merchantId) return;
    let ok = false;
    try {
      ok = this._shop.open(merchantId);
    } catch (err) {
      console.warn('[GameScene] shop open failed:', err?.message);
      return;
    }
    if (!ok) return;
    this._uiStack.open('shop', {
      onClose: () => {
        try {
          this._shop.close();
        } catch {
          /* already closed */
        }
        this._destroyScreenView('_shopView');
      },
    });
    this._renderShop();
  }

  /** @private rebuild the Phaser shop view from the controller state */
  _renderShop() {
    this._destroyScreenView('_shopView');
    const view = this._shop?.getView?.();
    if (!view) return;
    try {
      this._shopView = renderShop(this, view);
    } catch (err) {
      console.warn('[GameScene] renderShop failed:', err?.message);
    }
  }

  // ---- inventory ----

  /** @private open the full-screen character menu */
  _openInventory(tab) {
    if (this._uiStack?.isOpen?.('inventory')) return;
    if ((this._uiStack?.count() ?? 0) > 0) return;
    let ok = false;
    try {
      ok = this._inventory.open(tab);
    } catch (err) {
      console.warn('[GameScene] inventory open failed:', err?.message);
      return;
    }
    if (!ok) return;
    this._uiStack.open('inventory', {
      onClose: () => {
        try {
          this._inventory.close();
        } catch {
          /* already closed */
        }
        this._destroyScreenView('_inventoryView');
      },
    });
    this._renderInventory();
  }

  /** @private rebuild the Phaser inventory view from the controller state */
  _renderInventory() {
    this._destroyScreenView('_inventoryView');
    const view = this._inventory?.getView?.();
    if (!view) return;
    try {
      this._inventoryView = renderInventory(this, view);
    } catch (err) {
      console.warn('[GameScene] renderInventory failed:', err?.message);
    }
  }

  /** @private persist gameState to a slot; resolves { ok } */
  async _saveToSlot(slot) {
    const p = this.player?.getPosition?.();
    const roomId = this.roomManager?.currentRoomId ?? START_ROOM_ID;
    if (p) {
      try {
        gameState.setPosition(roomId, p.x, p.y);
      } catch {
        /* position write is best-effort */
      }
    }
    try {
      const res = await saveManager.write(slot, gameState.toJSON());
      if (res?.ok) saveManager.setLastSlot(slot);
      return res ?? { ok: false };
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  }

  /** @private leave the character menu for the full map */
  _openFullMapFromInventory() {
    this._uiStack?.close('inventory');
    try {
      this._mapOverlay?.show?.();
    } catch (err) {
      console.warn('[GameScene] map show failed:', err?.message);
    }
  }

  /** @private InventoryController hook: persist mixer volumes to settings */
  _persistSettings() {
    try {
      saveManager.writeSetting('volumes', audioManager.getVolumes());
    } catch (err) {
      console.warn('[GameScene] persistSettings failed:', err?.message);
    }
  }

  // ---- pause menu ----

  /** @private rebuild the Phaser pause-menu view from the controller state */
  _renderPauseMenu() {
    this._destroyScreenView('_pauseView');
    const view = this._pauseMenu?.getView?.();
    if (!view) return;
    try {
      this._pauseView = renderPauseMenu(this, view);
    } catch (err) {
      console.warn('[GameScene] renderPauseMenu failed:', err?.message);
    }
  }

  // ---- end screens ----

  /** @private open the game-over or victory screen */
  _openEndScreen(mode) {
    if ((this._uiStack?.count() ?? 0) > 0) return;
    let ok = false;
    try {
      ok = this._endScreen.open(mode);
    } catch (err) {
      console.warn('[GameScene] end screen open failed:', err?.message);
      return;
    }
    if (!ok) return;
    this._uiStack.open(mode === 'victory' ? 'victory' : 'gameover', {
      onClose: () => {
        try {
          this._endScreen.close();
        } catch {
          /* already closed */
        }
        this._destroyScreenView('_endView');
      },
    });
    this._renderEndScreen();
  }

  /** @private rebuild the Phaser end-screen view from the controller state */
  _renderEndScreen() {
    this._destroyScreenView('_endView');
    const view = this._endScreen?.getView?.();
    if (!view) return;
    try {
      this._endView = renderEndScreen(this, view);
    } catch (err) {
      console.warn('[GameScene] renderEndScreen failed:', err?.message);
    }
  }

  /** @private player:died → game-over stinger + screen (boss bar hidden) */
  _onPlayerDied() {
    this._hideBossBar();
    try {
      audioManager.playMusic('gameover');
    } catch {
      /* audio is best-effort */
    }
    this._openEndScreen('gameover');
  }

  /** @private Sable Matriarch defeated → victory stinger + screen */
  _onVictory() {
    try {
      audioManager.playMusic('victory');
    } catch {
      /* audio is best-effort */
    }
    this._openEndScreen('victory');
  }

  /** @private respawn from the last save (safe new-game fallback) */
  async _respawnAtLastSave() {
    this._uiStack?.closeAll();
    const slot = saveManager.getLastSlot() ?? 1;
    let save = null;
    try {
      save = await saveManager.read(slot);
    } catch {
      save = null;
    }
    if (save) {
      try {
        gameState.hydrate(save);
      } catch {
        gameState.reset();
      }
      try {
        saveManager.setLastSlot(slot);
      } catch {
        /* ignore */
      }
    } else {
      gameState.reset();
    }
    this.scene.restart();
  }

  /** @private return to the title screen from pause / end screens */
  _quitToTitle() {
    this._uiStack?.closeAll();
    try {
      this.scene.stop(SceneKeys.UI);
    } catch {
      /* never launched */
    }
    this.scene.start(SceneKeys.TITLE);
  }

  // ---- Props ----

  /** @private Wave 5: looping flicker anims for 2-frame prop sheets */
  _createPropAnims() {
    const defs = [
      { key: 'candle', fps: 6 },
      { key: 'brazier', fps: 8 },
      { key: 'torch_wall', fps: 7 },
      { key: 'teleport_dais', fps: 4 },
    ];
    for (const d of defs) {
      try {
        if (!this.textures.exists(d.key) || this.anims.exists(d.key)) continue;
        this.anims.create({
          key: d.key,
          frames: this.anims.generateFrameNumbers(d.key, {}),
          frameRate: d.fps,
          repeat: -1,
        });
      } catch { /* cosmetic */ }
    }
  }

  /** @private play a prop's flicker anim when one is registered */
  _playPropAnim(sprite, key) {
    try {
      if (sprite && this.anims.exists(key)) sprite.play(key);
    } catch { /* cosmetic */ }
  }

  // ---- NPCs ----

  /** @private original procedural NPC figure texture (built once) */
  _makeNpcTexture() {
    if (this.textures.exists('npc_figure')) return;
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0x241f33, 1);
    g.fillTriangle(3, 22, 13, 22, 8, 4); // cloak
    g.fillStyle(0x352c4d, 1);
    g.fillCircle(8, 8, 5); // hood
    g.fillStyle(0x0b0d1a, 1);
    g.fillCircle(8, 9, 3); // shadowed face
    g.fillStyle(0xc9a227, 1);
    g.fillCircle(6.4, 9, 1); // eyes
    g.fillCircle(9.6, 9, 1);
    g.generateTexture('npc_figure', 16, 24);
    g.destroy();
  }

  /** @private NpcDirector hook: build a world-space NPC figure */
  _spawnNpcSprite(npc) {
    this._makeNpcTexture();
    const loc = npc.getLocation();
    const x = Number.isFinite(loc?.x) ? loc.x : 64;
    const y = Number.isFinite(loc?.y) ? loc.y : 200;
    const c = this.add.container(x, y).setDepth(9);
    // Wave 5 art: per-NPC idle sheet (<sprite>_idle); falls back to the
    // generic figure when the texture is missing.
    const spriteId = npc.def?.sprite ?? npc.id;
    const texKey = `${spriteId}_idle`;
    let s;
    if (this.textures.exists(texKey)) {
      try {
        if (!this.anims.exists(texKey)) {
          this.anims.create({
            key: texKey,
            frames: this.anims.generateFrameNumbers(texKey, {}),
            frameRate: 4,
            repeat: -1,
          });
        }
        s = this.add.sprite(0, 0, texKey);
        s.setOrigin(0.5, 1);
        try { s.play(texKey); } catch { /* ignore */ }
      } catch {
        s = null;
      }
    }
    if (!s) {
      s = this.add.sprite(0, -10, 'npc_figure');
      if (npc.isMerchant) s.setTint(0xf0d060);
    }
    const label = this.add
      .text(0, -70, npc.name, { fontFamily: HUD.font, fontSize: '8px', color: HUD.dim })
      .setOrigin(0.5);
    c.add([s, label]);
    npc.sprite = s;
    return c;
  }

  /** @private NpcDirector hook: remove an NPC figure */
  _despawnNpcSprite(handle) {
    try {
      handle?.destroy?.();
    } catch {
      /* already gone */
    }
  }

  /** @private non-blocking proximity prompt text */
  _buildNpcPrompt() {
    this._npcPrompt = this.add
      .text(0, 0, '', {
        fontFamily: HUD.font,
        fontSize: '9px',
        color: '#e8d9a0',
        backgroundColor: '#14101ecc',
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5)
      .setDepth(1500)
      .setVisible(false);
  }

  /** @private NpcDirector hook: show the TALK prompt above an NPC */
  _showNpcPrompt(npc, x, y) {
    const t = this._npcPrompt;
    if (!t) return;
    t.setText(`${npc.name} — [${inputManager.getPrompt('confirm')}] TALK`)
      .setPosition(x, y - 40)
      .setVisible(true);
  }

  /** @private NpcDirector hook: hide the TALK prompt */
  _hideNpcPrompt() {
    this._npcPrompt?.setVisible(false);
  }

  // ----------------------------------------------------------------- misc ----

  /**
   * GAME_FEEL checklist #4 + W5-AUDIO: land dust + land thump when the land
   * state starts; jump/dash whooshes on state entry; subtle footsteps on a
   * timer while running on the ground, with timber (playback rate) per
   * region. PlayerMovement itself stays audio-free — the scene reads state.
   */
  _detectMovementAudio(dt) {
    const s = this.player?.getState?.();
    const prev = this._prevMoveState;
    const p = this.player?.getPosition?.();
    const au = tuning.audio ?? {};
    if (s === 'land' && prev !== 'land') {
      if (p) this.effectsManager.spawnLandDust(p.x, p.y + 10);
      this._sfx('land', { channel: 'player', volume: au.landVolume ?? 0.55 });
    }
    if (s === 'jump' && prev !== 'jump') {
      this._sfx('jump', { channel: 'player', volume: au.jumpVolume ?? 0.4 });
    }
    if (s === 'dash' && prev !== 'dash') {
      this._sfx('dash', { channel: 'player', volume: au.dashVolume ?? 0.45 });
    }
    if ((s === 'walk' || s === 'run') && dt > 0) {
      this._stepT -= dt;
      if (this._stepT <= 0) {
        let region = null;
        try {
          region = dataManager.getRoom(this._audioRoomId)?.region ?? null;
        } catch {
          /* data lookup is best-effort */
        }
        const rate = au.stepRateByRegion?.[region] ?? 1;
        this._sfx('step', {
          channel: 'player',
          volume: au.stepVolume ?? 0.3,
          rate,
          ...(p ? { x: p.x, y: p.y } : {}),
        });
        this._stepT = s === 'run' ? au.stepIntervalRun ?? 0.3 : au.stepIntervalWalk ?? 0.42;
      }
    } else {
      this._stepT = 0;
    }
    this._prevMoveState = s;
  }

  /** docs/AUDIO.md: GameScene restores persisted volumes into the channels. */
  _applyVolumeSettings() {
    const s = gameState.data.settings ?? {};
    const set = (channel, v) => {
      if (typeof v !== 'number') return;
      try {
        audioManager.setVolume(channel, v);
      } catch {
        /* unknown channel — ignore */
      }
    };
    set('music', s.musicVolume);
    set('ambience', s.ambienceVolume);
    // sfxVolume fans out to every non-music/ambience channel.
    if (typeof s.sfxVolume === 'number') {
      for (const ch of ['player', 'enemies', 'weapons', 'environment', 'ui']) {
        set(ch, s.sfxVolume);
      }
    }
    // W5-UI: volumes persisted via the settings menu override.
    try {
      saveManager
        .readSetting('volumes', null)
        .then((volumes) => {
          if (!volumes || typeof volumes !== 'object') return;
          for (const [ch, v] of Object.entries(volumes)) set(ch, v);
        })
        .catch(() => {
          /* no persisted volumes — defaults stand */
        });
    } catch {
      /* settings store unavailable */
    }
  }

  _buildToast() {
    const { width } = this.scale;
    this._toastText = this.add
      .text(width / 2, 246, '', {
        fontFamily: HUD.font,
        fontSize: '11px',
        color: HUD.ink,
        backgroundColor: '#14101ecc',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2000)
      .setVisible(false);
  }

  /** Small transient message (Wave 5 replaces these with real UI). */
  _toast(msg) {
    const t = this._toastText;
    if (!t) return;
    try {
      if (this._toastTween) {
        this._toastTween.stop();
        this._toastTween = null;
      }
      t.setText(msg).setVisible(true).setAlpha(1);
      this._toastTween = this.tweens.add({
        targets: t,
        alpha: 0,
        delay: 1400,
        duration: 600,
        onComplete: () => t.setVisible(false),
      });
    } catch {
      t.setText(msg).setVisible(true);
    }
  }

  // ------------------------------------------------------------- shutdown ----

  _onShutdown() {
    // W5-UI teardown first: close screens so ui:closed flows through the
    // still-subscribed bus handlers, then drop the controllers.
    try {
      this._uiStack?.closeAll();
    } catch {
      /* ignore */
    }
    this._uiStack = null;
    try {
      this._npcDirector?.destroy();
    } catch {
      /* ignore */
    }
    this._npcDirector = null;
    try {
      this._touchOverlay?.destroy();
    } catch {
      /* ignore */
    }
    this._touchOverlay = null;
    this._dialogue = null;
    this._shop = null;
    this._inventory = null;
    this._pauseMenu = null;
    this._endScreen = null;
    this._destroyScreenView('_dialogueView');
    this._destroyScreenView('_shopView');
    this._destroyScreenView('_inventoryView');
    this._destroyScreenView('_pauseView');
    this._destroyScreenView('_endView');
    this._destroyScreenView('_npcPrompt');
    this._destroyScreenView('_roomBanner');
    try {
      this._roomBannerTween?.stop();
    } catch {
      /* ignore */
    }
    this._roomBannerTween = null;
    for (const unsub of this._unsubs) {
      try {
        unsub();
      } catch {
        /* already removed */
      }
    }
    this._unsubs = [];
    this._ready = false;
    this._sanctumWasActive = false;
    this._chamberWasActive = false;
    try {
      this._mapOverlay?.destroy?.();
    } catch {
      /* overlay teardown edge — ignore */
    }
    this._mapOverlay = null;
    this._saveSanctum = null;
    this._teleportChamber = null;
    // Release views but keep the singleton's bus subscription alive —
    // detach() would permanently unhook 'combat:hitLanded'.
    try {
      this.effectsManager.unregisterVictim('player');
    } catch {
      /* never attached */
    }
    try {
      this.effectsManager.detachViews();
    } catch {
      /* never attached */
    }
    this._callRoomSync('unloadCurrentRoom');
    try {
      this.hitboxSystem?.shutdown();
    } catch {
      /* already shut down */
    }
    try {
      this.projectileSystem?.shutdown();
    } catch {
      /* already shut down */
    }
    try {
      this.player?.destroy();
    } catch {
      /* already destroyed */
    }
    this.player = null;
    this.roomManager = null;
    this.hitboxSystem = null;
    this.projectileSystem = null;
    this._hud = null;
  }
}
