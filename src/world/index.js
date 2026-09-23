/**
 * src/world — world-level systems. Public API surface:
 *
 *   WorldGraph.js  buildGraph(rooms) -> WorldGraph — nodes = rooms, edges =
 *                  exits (respecting requires[])
 *                  WorldGraph#findPath(from, to, abilities=[]) — BFS honoring
 *                  ability gates
 *                  WorldGraph#reachableFrom(startId, abilities=[])
 *                  WorldGraph#reachableWithCollection(startId, bossesByArena)
 *                  WorldGraph#validateWorld(options) -> { errors, warnings }
 *                  (function wrappers: buildGraph, findPath, reachableFrom,
 *                  validateWorld — spec §28)
 *
 * Region definitions and cross-era (Living/Ruined Citadel) logic land here
 * in later waves (spec §49 — the Two Ages of Vesper, post-vertical-slice).
 */
export {
  WorldGraph,
  buildGraph,
  validateWorld,
  findPath,
  reachableFrom,
  START_ROOM_ID,
} from './WorldGraph.js';
