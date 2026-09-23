/**
 * Phaser boot configuration.
 *
 * Pixel-art rendering rules per spec §9: 480×270 internal resolution,
 * integer-friendly scaling, no blur. Arcade physics with per-spec gravity
 * (feel numbers live in config/tuning.js — this is the global default).
 */
import Phaser from 'phaser';
import { BootScene } from '../scenes/BootScene.js';
import { TitleScene } from '../scenes/TitleScene.js';
import { GameScene } from '../scenes/GameScene.js';
import { UIScene } from '../scenes/UIScene.js';

/** Human-readable build version, rendered on the title screen (spec §61). */
export const GAME_VERSION = 'v0.1.0 ALPHA';

export const gameConfig = {
  type: Phaser.AUTO,
  version: '0.1.0 ALPHA',
  title: 'The Citadel of Vesper',
  parent: 'game',
  // Internal render resolution (spec §9): 480×270, FIT-scaled to viewport.
  width: 480,
  height: 270,
  backgroundColor: '#0b0d1a',
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 2000 }, // global default; feel lives in tuning.js
      debug: false, // enabled by DebugOverlay in dev builds only
    },
  },
  scene: [BootScene, TitleScene, GameScene, UIScene],
  fps: {
    target: 60, // spec §10
    forceSetTimeOut: false,
  },
  disableContextMenu: true,
  disablePhaserLogo: true,
};
