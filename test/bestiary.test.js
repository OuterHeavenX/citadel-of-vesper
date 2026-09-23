/**
 * Bestiary + storyFlags tests — enemy:died unlocks kill counts, boss
 * encounter/death tracking, lore rows; boss:died sets defeat flags that
 * drive NPC dialogue variants and merchant unlocks.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Bestiary } from '../src/systems/Bestiary.js';
import { initStoryFlags } from '../src/systems/storyFlags.js';
import { Merchant } from '../src/npcs/Merchant.js';
import { DialogueManager } from '../src/systems/DialogueManager.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';

const ENEMY_DIED = (enemyId) => ({
  enemyId,
  instanceId: `${enemyId}_inst_1`,
  roomId: 'moonlit_gate_004',
  drops: [],
});

describe('Bestiary', () => {
  let bestiary;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    bestiary = new Bestiary();
    bestiary.init();
  });
  afterEach(() => {
    bestiary.destroy();
    eventBus.clear();
    gameState.reset();
  });

  it('records kills on enemy:died and exposes lore rows', () => {
    eventBus.emit('enemy:died', ENEMY_DIED('ash_hound'));
    eventBus.emit('enemy:died', ENEMY_DIED('ash_hound'));
    eventBus.emit('enemy:died', ENEMY_DIED('cinder_wisp'));
    expect(bestiary.getKillCount('ash_hound')).toBe(2);
    expect(bestiary.getTotalKills()).toBe(3);

    const rows = bestiary.getBestiary();
    expect(rows).toHaveLength(10); // 8 enemies + 2 bosses
    const hound = rows.find((r) => r.id === 'ash_hound');
    expect(hound).toMatchObject({
      kind: 'enemy',
      name: 'Ash Hound',
      kills: 2,
      seen: true,
    });
    expect(hound.lore.length).toBeGreaterThan(0);
    const unseen = rows.find((r) => r.id === 'rustbound_revenant');
    expect(unseen.seen).toBe(false);
    expect(unseen.kills).toBe(0);
  });

  it('tracks bosses via encounterStarted and boss:died', () => {
    eventBus.emit('boss:encounterStarted', { bossId: 'chapel_warden', roomId: 'moonlit_gate_014' });
    let warden = bestiary.getEntry('chapel_warden');
    expect(warden.seen).toBe(true);
    expect(warden.kills).toBe(0);
    expect(warden.lore).toContain('guard');
    eventBus.emit('boss:died', { bossId: 'chapel_warden', roomId: 'moonlit_gate_014', reward: 'moonrise_leap' });
    warden = bestiary.getEntry('chapel_warden');
    expect(warden.kills).toBe(1);
  });

  it('bestiary state is serializable with the save', () => {
    eventBus.emit('enemy:died', ENEMY_DIED('mote_swarm'));
    const json = gameState.toJSON();
    expect(json.bestiary.mote_swarm).toEqual({ seen: true, kills: 1 });
  });

  it('init is idempotent and destroy unsubscribes', () => {
    bestiary.init(); // second call is a no-op
    eventBus.emit('enemy:died', ENEMY_DIED('ash_hound'));
    expect(bestiary.getKillCount('ash_hound')).toBe(1); // not double-counted
    bestiary.destroy();
    eventBus.emit('enemy:died', ENEMY_DIED('ash_hound'));
    expect(bestiary.getKillCount('ash_hound')).toBe(1); // no listener left
  });
});

describe('storyFlags', () => {
  let stop;
  let seen;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    seen = [];
    eventBus.on('flag:set', (p) => seen.push(p));
    stop = initStoryFlags();
  });
  afterEach(() => {
    stop();
    eventBus.clear();
    gameState.reset();
  });

  it('boss:died marks the boss defeated and sets the flag', () => {
    eventBus.emit('boss:died', { bossId: 'chapel_warden', roomId: 'moonlit_gate_014', reward: 'moonrise_leap' });
    expect(gameState.data.bossStates.chapel_warden).toBe('defeated');
    expect(gameState.getFlag('boss_defeated_chapel_warden')).toBe(true);
    expect(seen).toContainEqual({ flag: 'boss_defeated_chapel_warden', value: true });
  });

  it('boss flags unlock merchant stock and switch NPC dialogue', () => {
    const wren = new Merchant('wren_aldervale');
    const dlg = new DialogueManager();
    expect(wren.getStock().find((s) => s.itemId === 'moonsteel_sabre').locked).toBe(true);
    expect(dlg.open('sister_ansel').nodeId).not.toBe('post_warden');
    dlg.close();

    eventBus.emit('boss:died', { bossId: 'chapel_warden', roomId: 'moonlit_gate_014', reward: 'moonrise_leap' });

    expect(wren.getStock().find((s) => s.itemId === 'moonsteel_sabre').locked).toBe(false);
    expect(dlg.open('sister_ansel').nodeId).toBe('post_warden');
  });

  it('room:secretFound sets a namespaced flag', () => {
    eventBus.emit('room:secretFound', { roomId: 'moonlit_gate_011', secretId: 'high_alcove' });
    expect(gameState.getFlag('secret:moonlit_gate_011:high_alcove')).toBe(true);
  });
});
