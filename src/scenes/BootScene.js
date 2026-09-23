/**
 * BootScene — first scene. Inits the core singletons, loads the boot/title
 * asset stages, restores persisted audio volumes, then hands off to Title.
 *
 * Init order (Wave 1 integration):
 *  1. inputManager.init() — keyboard/gamepad/touch listeners
 *  2. saveManager.open() — IndexedDB (non-fatal on failure)
 *  3. assetManager.setPackManifest(AssetPacks)
 *  4. audioManager.configure(AudioLibrary) + init() (guarded, never breaks boot)
 *  5. restore persisted channel volumes from SaveManager settings store
 *  6. loadStage(BOOT, ['boot']) -> loadStage(TITLE, ['title'])
 *  7. -> Title scene
 */
import Phaser from 'phaser';
import { inputManager } from '../core/InputManager.js';
import { saveManager } from '../core/SaveManager.js';
import { audioManager, Channels } from '../core/AudioManager.js';
import { assetManager, Stages } from '../core/AssetManager.js';
import { AssetPacks } from '../config/assets.js';
import { AudioLibrary } from '../audio/index.js';
import { SceneKeys } from './index.js';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: SceneKeys.BOOT });
  }

  create() {
    this._boot();
  }

  async _boot() {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#0b0d1a');
    const status = this.add
      .text(width / 2, height / 2, 'WAKING THE CITADEL…', {
        fontFamily: "Georgia, serif",
        fontSize: '14px',
        color: '#c9a227',
        letterSpacing: 3,
      })
      .setOrigin(0.5);

    try {
      // 1. Input first — everything downstream assumes actions work.
      inputManager.init();

      // 2. IndexedDB open is async and non-fatal.
      try {
        await saveManager.open();
      } catch (err) {
        console.warn('[Vesper] SaveManager.open() failed; saves disabled this session:', err);
      }

      // 3. Asset manifest injection (core/ cannot import config/).
      assetManager.setPackManifest(AssetPacks);

      // 4. Audio: inject the composition library, then init (guarded).
      try {
        audioManager.configure(AudioLibrary);
        const r = audioManager.init();
        if (r && typeof r.catch === 'function') await r.catch(() => {});
      } catch (err) {
        console.warn('[Vesper] AudioManager init failed; audio disabled:', err);
      }

      // 5. Restore persisted channel volumes (runtime-only in AudioManager).
      try {
        const saved = await saveManager.readSetting('audio:volumes');
        if (saved && typeof saved === 'object') {
          for (const ch of Object.values(Channels)) {
            const v = saved[ch];
            if (typeof v === 'number') audioManager.setVolume(ch, v);
          }
        }
      } catch {
        /* volumes stay at defaults */
      }

      // 6. Staged loading: boot pack, then title pack.
      status.setText('LOADING…');
      await assetManager.loadStage(this, Stages.BOOT, ['boot']);
      await assetManager.loadStage(this, Stages.TITLE, ['title']);
    } catch (err) {
      console.error('[Vesper] boot sequence failed:', err);
      status.setText('BOOT FAILED — see console');
      return;
    }

    // 7. Hand off.
    this.scene.start(SceneKeys.TITLE);
  }
}
