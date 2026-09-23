/**
 * WorldGraph — world connectivity + validation (spec §24, §28).
 *
 * CONTRACT:
 * - Built from data/rooms.json: nodes = rooms, edges = exits (respecting
 *   `requires[]` ability gates).
 * - buildGraph(rooms) -> WorldGraph instance (nodes + adjacency).
 * - findPath(from, to, abilities=[]) -> roomId[] | null — BFS honoring
 *   ability gates (debug teleport + map hints).
 * - reachableFrom(startId, abilities=[]) -> Set<roomId> — BFS honoring gates.
 * - validateWorld(rooms, options) -> { errors, warnings } — RUN BY
 *   scripts/validate.js AND npm test. ERRORS fail the build:
 *     * exit target room id does not exist
 *     * a room is unreachable from the start room with no abilities AND/OR
 *       with the full ability set (ability-gated critical path)
 *     * boss arenas (from data/bosses.json) unreachable
 *     * duplicate map grid cells
 *     * `requires` references an unknown ability id
 *   WARNINGS (legal design, flagged for review):
 *     * exit with no matching reverse exit (one-way passages are legal)
 *     * one-way trap: a non-arena room with no path back to start even with
 *       all abilities, unless it is a save room or teleport chamber
 *     * boss arena id not present in rooms.json yet (ships in a later wave)
 *     * a dead-end room (no exits) that is not a save/teleport room
 * - Ability-gated reachability uses fixpoint collection: abilities granted
 *   by reachable rooms (boss rewards, secret rewards) are treated as
 *   collected, then reachability is recomputed until no new rooms appear.
 *
 * Pure functions over room JSON — no Phaser dependency. Node-safe (used by
 * scripts/validate.js in CI).
 */

export const START_ROOM_ID = 'moonlit_gate_001';

/**
 * Build the world graph from room definitions.
 * @param {object[]} rooms room definitions array (data/rooms.json shape)
 * @returns {WorldGraph}
 */
export function buildGraph(rooms) {
  return new WorldGraph(rooms);
}

/**
 * World graph: nodes = rooms, edges = exits (respecting requires[]).
 */
export class WorldGraph {
  /**
   * @param {object[]} rooms room definitions array
   */
  constructor(rooms) {
    /** @type {object[]} */
    this.rooms = Array.isArray(rooms) ? rooms : [];
    /** @type {Map<string, object>} room id -> room def */
    this.nodes = new Map();
    /** @type {Map<string, Array<{to:string, exitId:string, dir:string, requires:string[]}>>} */
    this.adj = new Map();
    for (const room of this.rooms) {
      if (!room || typeof room.id !== 'string') continue;
      this.nodes.set(room.id, room);
      this.adj.set(
        room.id,
        (room.exits ?? []).map((e) => ({
          to: e.target,
          exitId: e.id,
          dir: e.dir,
          requires: Array.isArray(e.requires) ? [...e.requires] : [],
        })),
      );
    }
  }

  /**
   * BFS honoring ability gates. An edge is traversable when every id in
   * `requires` is present in `abilities`.
   * @param {string} from @param {string} to @param {string[]} abilities
   * @returns {string[]|null} room id path, or null when unreachable
   */
  findPath(from, to, abilities = []) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    if (from === to) return [from];
    const have = new Set(abilities);
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const edge of this.adj.get(cur) ?? []) {
        if (prev.has(edge.to)) continue;
        if (!this.nodes.has(edge.to)) continue; // dangling target: validateWorld flags it
        if (!edge.requires.every((a) => have.has(a))) continue;
        prev.set(edge.to, cur);
        if (edge.to === to) {
          const path = [to];
          let p = cur;
          while (p !== null) {
            path.unshift(p);
            p = prev.get(p);
          }
          return path;
        }
        queue.push(edge.to);
      }
    }
    return null;
  }

  /**
   * All rooms reachable from `startId` with the given abilities.
   * @param {string} startId @param {string[]} abilities
   * @returns {Set<string>} reachable room ids
   */
  reachableFrom(startId, abilities = []) {
    const seen = new Set();
    if (!this.nodes.has(startId)) return seen;
    const have = new Set(abilities);
    const queue = [startId];
    seen.add(startId);
    while (queue.length) {
      const cur = queue.shift();
      for (const edge of this.adj.get(cur) ?? []) {
        if (seen.has(edge.to) || !this.nodes.has(edge.to)) continue;
        if (!edge.requires.every((a) => have.has(a))) continue;
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
    return seen;
  }

  /**
   * Ability ids granted by a room: secret rewards + (boss rewards, supplied
   * via options.bosses matched on arenaRoomId).
   * @param {object} room
   * @param {Map<string, object>} bossesByArena arenaRoomId -> boss def
   * @returns {string[]}
   */
  static abilitiesGrantedBy(room, bossesByArena) {
    const out = new Set();
    for (const s of room.secrets ?? []) {
      if (s.reward?.abilityId) out.add(s.reward.abilityId);
    }
    const boss = bossesByArena.get(room.id);
    if (boss?.reward?.abilityId) out.add(boss.reward.abilityId);
    return [...out];
  }

  /**
   * Reachability with ability collection: treat abilities granted by
   * reachable rooms as collected (boss rewards, secret rewards), then
   * recompute until fixpoint. Models the real critical path.
   * @param {string} startId @param {Map<string, object>} bossesByArena
   * @returns {{ reachable: Set<string>, abilities: Set<string> }}
   */
  reachableWithCollection(startId, bossesByArena = new Map()) {
    const abilities = new Set();
    let reachable = new Set();
    for (;;) {
      const next = this.reachableFrom(startId, [...abilities]);
      let grew = false;
      for (const id of next) {
        const room = this.nodes.get(id);
        if (!room) continue;
        for (const a of WorldGraph.abilitiesGrantedBy(room, bossesByArena)) {
          if (!abilities.has(a)) {
            abilities.add(a);
            grew = true;
          }
        }
      }
      reachable = next;
      if (!grew) break;
    }
    return { reachable, abilities };
  }

  /**
   * Validate the world. See module header for the error/warning contract.
   * @param {object} [options]
   * @param {string} [options.startRoomId] default 'moonlit_gate_001'
   * @param {string[]} [options.abilities] full ability id set (gated paths are
   *   checked with no abilities AND with this full set)
   * @param {object[]} [options.bosses] boss defs (arenaRoomId lookup)
   * @returns {{errors: string[], warnings: string[]}}
   */
  validateWorld(options = {}) {
    const errors = [];
    const warnings = [];
    const startRoomId = options.startRoomId ?? START_ROOM_ID;
    const allAbilities = options.abilities ?? [];
    const bosses = options.bosses ?? [];
    const bossesByArena = new Map(bosses.map((b) => [b.arenaRoomId, b]));
    const abilitySet = new Set(allAbilities);

    if (!this.nodes.has(startRoomId)) {
      errors.push(`world: start room '${startRoomId}' is missing`);
      return { errors, warnings };
    }

    // ---- exit targets exist + requires reference known abilities ----
    for (const room of this.rooms) {
      for (const edge of this.adj.get(room.id) ?? []) {
        if (!this.nodes.has(edge.to)) {
          errors.push(
            `world:${room.id}: exit '${edge.exitId}' targets missing room '${edge.to}'`,
          );
        }
        for (const req of edge.requires) {
          if (!abilitySet.has(req)) {
            errors.push(
              `world:${room.id}: exit '${edge.exitId}' requires unknown ability '${req}'`,
            );
          }
        }
      }
    }

    // ---- unique map cells ----
    const cells = new Map();
    for (const room of this.rooms) {
      const key = `${room.map?.x},${room.map?.y}`;
      if (cells.has(key)) {
        errors.push(
          `world:${room.id}: map cell (${key}) already used by '${cells.get(key)}'`,
        );
      } else {
        cells.set(key, room.id);
      }
    }

    // ---- reachability: no abilities, full abilities, and fixpoint collection ----
    const reachNone = this.reachableFrom(startRoomId, []);
    const reachAll = this.reachableFrom(startRoomId, allAbilities);
    const { reachable: reachCollected } = this.reachableWithCollection(
      startRoomId,
      bossesByArena,
    );
    for (const id of this.nodes.keys()) {
      if (!reachCollected.has(id)) {
        errors.push(
          `world:${id}: unreachable from '${startRoomId}' even with all collectable abilities`,
        );
      } else if (!reachAll.has(id)) {
        errors.push(
          `world:${id}: unreachable from '${startRoomId}' with the full ability set`,
        );
      }
      if (!reachNone.has(id) && reachCollected.has(id)) {
        // room sits behind an ability gate: expected metroidvania shape,
        // surfaced as a warning so reviewers confirm the gate is intended
        warnings.push(
          `world:${id}: only reachable behind an ability gate (ok if intended)`,
        );
      }
    }

    // ---- boss arenas reachable (with the full ability set) ----
    for (const boss of bosses) {
      if (!boss.arenaRoomId) continue;
      if (!this.nodes.has(boss.arenaRoomId)) {
        warnings.push(
          `world: boss '${boss.id}' arena room '${boss.arenaRoomId}' not in rooms.json yet (ok if arena ships in a later wave)`,
        );
        continue;
      }
      if (!reachAll.has(boss.arenaRoomId)) {
        errors.push(
          `world: boss '${boss.id}' arena '${boss.arenaRoomId}' unreachable from '${startRoomId}' with all abilities`,
        );
      }
    }

    // ---- softlock / one-way trap check ----
    // Every non-arena room must have a path back to start using the full
    // ability set (approximation of "the abilities available at that
    // point"). Save rooms and teleport chambers are exempt: the player can
    // rest / teleport out. Boss arenas are exempt: exits unlock after the
    // fight (Wave 4 owns fight-time locking).
    const arenaIds = new Set(
      bosses.map((b) => b.arenaRoomId).filter((id) => this.nodes.has(id)),
    );
    for (const room of this.rooms) {
      if (arenaIds.has(room.id)) continue;
      if (room.saveRoom === true || room.teleport === true) continue;
      const back = this.findPath(room.id, startRoomId, allAbilities);
      if (back === null) {
        const exits = (this.adj.get(room.id) ?? []).length;
        if (exits === 0) {
          warnings.push(
            `world:${room.id}: dead-end with no exits and no path back to '${startRoomId}' (ok only if intentional; not a save/teleport room)`,
          );
        } else {
          warnings.push(
            `world:${room.id}: one-way trap — no path back to '${startRoomId}' even with all abilities (no save room / teleport chamber escape)`,
          );
        }
      }
    }

    // ---- one-way exit pairing (conventional, not mandatory) ----
    for (const room of this.rooms) {
      for (const edge of this.adj.get(room.id) ?? []) {
        if (!this.nodes.has(edge.to)) continue;
        const back = (this.adj.get(edge.to) ?? []).some((e) => e.to === room.id);
        if (!back) {
          warnings.push(
            `world:${room.id}: exit '${edge.exitId}' -> '${edge.to}' has no matching reverse exit (one-way is legal; confirm intended)`,
          );
        }
      }
    }

    // ---- hidden rooms are never required for completion ----
    // (completion % counts non-hidden rooms only — see MapModel). They must
    // still be reachable (findable), which the reachability checks above
    // already enforce; here we only assert they are marked honestly.
    for (const room of this.rooms) {
      if (room.hidden === true && !reachCollected.has(room.id)) {
        errors.push(`world:${room.id}: hidden room is unreachable — it can never be found`);
      }
    }

    return { errors, warnings };
  }
}

/**
 * @param {object[]} rooms
 * @param {string} startRoomId
 * @param {string[]} abilities
 * @returns {Set<string>}
 */
export function reachableFrom(rooms, startRoomId, abilities = []) {
  return buildGraph(rooms).reachableFrom(startRoomId, abilities);
}

/**
 * @param {object[]} rooms
 * @param {string} from @param {string} to @param {string[]} abilities
 * @returns {string[]|null}
 */
export function findPath(rooms, from, to, abilities = []) {
  return buildGraph(rooms).findPath(from, to, abilities);
}

/**
 * @param {object[]} rooms
 * @param {object} [options] startRoomId, abilities, bosses
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateWorld(rooms, options = {}) {
  return buildGraph(rooms).validateWorld(options);
}
