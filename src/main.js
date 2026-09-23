/**
 * The Citadel of Vesper — v0.1.0 ALPHA
 * Entry point: Phaser.Game boot, friendly error surface, tab auto-pause,
 * dev-only debug overlay.
 *
 * ORIGINALITY: all names, characters, dialogue, music, and art in this
 * project are original creations. See docs/ARCHITECTURE.md ("Originality
 * guardrail") and README.md.
 */
import Phaser from 'phaser';
import { gameConfig } from './config/gameConfig.js';
import { eventBus } from './core/EventBus.js';

function showBootError(err) {
  console.error('[Vesper] boot failure:', err);
  const el = document.getElementById('boot-error');
  if (el) {
    el.style.display = 'block';
    const detail = document.getElementById('boot-error-detail');
    if (detail) detail.textContent = String(err?.stack ?? err?.message ?? err);
  }
  const loading = document.getElementById('boot-loading');
  if (loading) loading.remove();
}

async function boot() {
  // Wave 1: validate the canvas host exists before starting Phaser.
  const parent = document.getElementById('game');
  if (!parent) throw new Error('missing #game container');

  const game = new Phaser.Game(gameConfig);

  // Remove the "entering" placeholder once the canvas is up.
  const loading = document.getElementById('boot-loading');
  if (loading) loading.remove();

  // Friendly error surface per spec §59 (crash protection).
  window.addEventListener('error', (e) => {
    console.error('[Vesper] runtime error:', e.error || e.message);
    eventBus.emit('game:error', { message: String(e.error?.message ?? e.message) });
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Vesper] unhandled rejection:', e.reason);
    eventBus.emit('game:error', { message: String(e.reason?.message ?? e.reason) });
  });

  // Auto-pause on tab hide per spec §58; GameScene honors the events.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) eventBus.emit('game:autoPause', { reason: 'tab_hidden' });
    else eventBus.emit('game:resumed', { reason: 'tab_visible' });
  });

  // Debug overlay: dev builds only, Backquote toggle (spec §53).
  if (import.meta.env.DEV) {
    try {
      const { DebugOverlay } = await import('./debug/index.js');
      new DebugOverlay(game);
    } catch (err) {
      console.warn('[Vesper] DebugOverlay failed to attach:', err);
    }
  }

  eventBus.emit('game:booted', { version: gameConfig.version });
  return game;
}

boot().catch(showBootError);
