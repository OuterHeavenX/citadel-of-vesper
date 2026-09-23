/**
 * EventBus — global pub/sub for decoupled systems.
 *
 * Usage:
 *   import { eventBus } from './EventBus.js';
 *   eventBus.on('enemy:died', ({ enemyId, roomId }) => { ... });
 *   eventBus.emit('enemy:died', { enemyId: 'revenant_01', roomId: 'moonlit_gate_004' });
 *
 * Rules (see docs/ARCHITECTURE.md):
 * - Event names are namespaced: '<domain>:<pastTenseVerb>'.
 * - Payloads are plain objects with the documented shape. Never positional args.
 * - Never emit per-frame; use for state transitions only.
 * - A singleton instance is exported as `eventBus`; classes that need an
 *   isolated bus may `new EventBus()`.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * @param {string} event namespaced event name, e.g. 'player:damaged'
   * @param {Function} handler receives the payload object
   * @returns {Function} unsubscribe function
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe for one emission only. */
  once(event, handler) {
    const unsub = this.on(event, (payload) => {
      unsub();
      handler(payload);
    });
    return unsub;
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  /**
   * @param {string} event
   * @param {object} [payload={}] plain-object payload per the event catalog
   */
  emit(event, payload = {}) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const h of [...handlers]) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[EventBus] handler for '${event}' threw:`, err);
      }
    }
  }

  /** Remove all listeners (used by scene shutdown / tests). */
  clear() {
    this._listeners.clear();
  }
}

/**
 * EVENT CATALOG (frozen). Wave agents: add new events here AND document them
 * in docs/ARCHITECTURE.md. Do not invent ad-hoc event names elsewhere.
 *
 * Shape legend: payload keys with types.
 */
export const Events = Object.freeze({
  // ---- lifecycle ----
  'game:booted': { version: 'string' },
  'game:autoPause': { reason: 'string' },
  'game:resumed': { reason: 'string' },
  'game:saved': { slot: 'number', playTime: 'number' },
  'game:error': { message: 'string' },

  // ---- player ----
  'player:damaged': { amount: 'number', source: 'string', hp: 'number', maxHp: 'number' },
  'player:healed': { amount: 'number', hp: 'number', maxHp: 'number' },
  'player:died': { roomId: 'string' },
  'player:leveledUp': { level: 'number', stats: 'object' },
  'player:xpGained': { amount: 'number', total: 'number' },
  'player:abilityUnlocked': { abilityId: 'string' },

  // ---- combat ----
  'combat:hitLanded': { attacker: 'string', target: 'string', amount: 'number', critical: 'boolean' },

  // ---- enemies / bosses ----
  'enemy:died': { enemyId: 'string', instanceId: 'string', roomId: 'string', drops: 'string[]' },
  'enemy:damaged': { instanceId: 'string', amount: 'number', hp: 'number' },
  'boss:encounterStarted': { bossId: 'string', roomId: 'string' },
  'boss:phaseChanged': { bossId: 'string', phase: 'number' },
  'boss:died': { bossId: 'string', roomId: 'string', reward: 'string' },

  // ---- world / rooms ----
  'room:changed': { from: 'string|null', to: 'string', via: 'string' },
  'room:secretFound': { roomId: 'string', secretId: 'string' },
  'room:checkpointTouched': { roomId: 'string', checkpointId: 'string' },

  // ---- items / inventory ----
  'item:pickedUp': { itemId: 'string', quantity: 'number' },
  'item:equipped': { itemId: 'string', slot: 'string' },
  'item:unequipped': { slot: 'string' },
  'inventory:changed': {},

  // ---- map ----
  'map:roomDiscovered': { roomId: 'string', region: 'string', completion: 'number' },

  // ---- quests / flags ----
  'flag:set': { flag: 'string', value: 'any' },
  'quest:updated': { questId: 'string', stage: 'string' },
  'npc:dialogueOpened': { npcId: 'string' },

  // ---- save rooms / teleport ----
  'save:rested': { roomId: 'string' },
  'teleport:discovered': { chamberId: 'string' },
  'teleport:used': { from: 'string', to: 'string' },

  // ---- input ----
  'input:deviceChanged': { device: "'keyboard'|'gamepad-xbox'|'gamepad-playstation'|'steamdeck'|'touch'" },

  // ---- audio ----
  'audio:musicChanged': { trackId: 'string', region: 'string' },

  // ---- ui ----
  'ui:opened': { screen: 'string' },
  'ui:closed': { screen: 'string' },

  // ---- debug ----
  'debug:command': { command: 'string', args: 'string[]' },
});

/** Shared singleton. */
export const eventBus = new EventBus();
