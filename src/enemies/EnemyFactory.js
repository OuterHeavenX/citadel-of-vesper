/**
 * EnemyFactory — instantiates enemies from data ids.
 *
 * CONTRACT:
 * - create(enemyId, scene, x, y, instanceId, ctx?): looks up the enemy
 *   definition (registered via registerDefs, e.g. from
 *   dataManager.getData('enemies')), picks the subclass from the registry
 *   (populated by src/enemies/variants.js), and constructs it.
 * - Unknown id -> throws a CLEAR error naming the id (spec §59).
 * - Unknown SUBCLASS for a known def -> falls back to the base Enemy class
 *   (data-only enemies still work; Wave 4 adds subclasses here).
 * - ctx is forwarded to the Enemy constructor (roomId, getPlayer,
 *   projectileSystem, spawnPickup, onDeath, rng, ... — see Enemy.js).
 *
 * RoomManager integration (Wave 3):
 *   EnemyFactory.registerDefs(dataManager.getData('enemies'));
 *   const enemy = EnemyFactory.create('ash_hound', scene, x, y,
 *     `${roomId}:${i}`, { roomId, getPlayer, projectileSystem, spawnPickup,
 *     onDeath, getFloorY });
 */
import { Enemy } from './Enemy.js';

export class EnemyFactory {
  /** @type {Map<string, class>} enemyId -> Enemy subclass */
  static registry = new Map();

  /** @type {Map<string, object>|null} enemyId -> data/enemies.json entry */
  static defs = null;

  /** @param {string} enemyId @param {class} cls */
  static register(enemyId, cls) {
    EnemyFactory.registry.set(enemyId, cls);
  }

  /**
   * Register enemy definitions (array of data/enemies.json entries).
   * @param {Array<object>} defs
   */
  static registerDefs(defs) {
    EnemyFactory.defs = new Map((defs ?? []).map((d) => [d.id, d]));
  }

  /**
   * @param {string} enemyId
   * @param {Phaser.Scene|null} scene null => headless (no Phaser objects)
   * @param {number} x @param {number} y
   * @param {string} instanceId unique per spawn
   * @param {object} [ctx] forwarded to the Enemy constructor
   * @returns {Enemy}
   * @throws {Error} when the id has no definition
   */
  static create(enemyId, scene, x, y, instanceId, ctx = {}) {
    const defs = ctx.defs ? new Map(ctx.defs.map((d) => [d.id, d])) : EnemyFactory.defs;
    const def = defs?.get(enemyId);
    if (!def) {
      const known = defs ? [...defs.keys()].join(', ') : '(no definitions registered)';
      throw new Error(
        `[EnemyFactory] unknown enemy id '${enemyId}'. Known ids: ${known}. ` +
          `Register definitions with EnemyFactory.registerDefs(dataManager.getData('enemies')).`,
      );
    }
    const Cls = EnemyFactory.registry.get(enemyId) ?? Enemy;
    return new Cls(scene, def, instanceId, x, y, ctx);
  }
}
