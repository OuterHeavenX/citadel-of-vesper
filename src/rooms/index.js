/**
 * src/rooms — room data + streaming. Public API surface:
 *
 *   RoomManager.js  class RoomManager — loadRoom / transitionThrough /
 *                   requestExit / unloadCurrentRoom / spawnPickup / update
 *                   + pure helpers checkExitGate / resolveSpawn
 *                   + hooks onSaveRoom / onTeleportRoom (default no-op)
 *   Room.js         class Room — runtime wrapper: build / update / destroy
 *                   + secretFlag(secretId)
 *
 * Room JSON format: docs/ROOM_FORMAT.md + data/schemas/room.schema.json.
 * Only the current room is live (spec §10, §56).
 */
export { RoomManager, checkExitGate, resolveSpawn } from './RoomManager.js';
export { Room, secretFlag } from './Room.js';
