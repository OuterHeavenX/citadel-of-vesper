/**
 * storyFlags — quest/story flag reactions (Wave 4).
 *
 * CONTRACT:
 * - initStoryFlags() subscribes (catalog events only):
 *     `boss:died`        -> gameState.setBossState(id, 'defeated') +
 *                            setFlag(`boss_defeated_<bossId>`, true)
 *     `room:secretFound` -> setFlag(`secret:<roomId>:<secretId>`, true)
 * - These flags drive NPC dialogue variants (data/npcs.json `variants`) and
 *   merchant stock unlocks (data/merchants.json `requiresFlag`) — e.g. the
 *   post-Warden dialogue and the moonsteel_sabre / moonstone_charm stock.
 * - Returns an unsubscribe function (tests / teardown). Idempotent.
 *
 * Wave 5 wiring: GameScene calls initStoryFlags() once at boot alongside
 * bestiary.init().
 */
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';

export function initStoryFlags({ state = gameState } = {}) {
  const unsubs = [
    eventBus.on('boss:died', ({ bossId }) => {
      state.setBossState(bossId, 'defeated');
      state.setFlag(`boss_defeated_${bossId}`, true);
    }),
    eventBus.on('room:secretFound', ({ roomId, secretId }) => {
      state.setFlag(`secret:${roomId}:${secretId}`, true);
    }),
  ];
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const unsub of unsubs) unsub();
  };
}
