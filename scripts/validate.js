/**
 * scripts/validate.js — data + world validation (master prompt §54).
 *
 * Runs in CI BEFORE the build: `npm run validate`. The deploy workflow
 * (`.github/workflows/deploy.yml`) must not deploy if this exits non-zero.
 *
 * Checks:
 *   1. Every data/*.json parses and validates against its schema.
 *   2. Ids are unique within each data file.
 *   3. Cross-references resolve (enemy ids, item ids, ability ids, room ids).
 *   4. Room exits: every exit target exists; every `requires` ability exists.
 *   5. World connectivity: every room reachable from the start room (BFS),
 *      map grid cells are unique.
 *   6. WorldGraph.validateWorld() (src/world/WorldGraph.js): ability-gated
 *      reachability (no abilities / full set / fixpoint collection), boss
 *      arena reachability, one-way trap / softlock warnings, reverse-exit
 *      pairing warnings. Errors from WorldGraph fail the build; warnings
 *      print and pass. Mid-rewrite rooms.json is handled gracefully (skips
 *      WorldGraph when rooms failed to parse instead of crashing).
 *
 * Usage: node scripts/validate.js
 * Exit: 0 = all green, 1 = errors (messages on stderr).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { validateWorld } from '../src/world/WorldGraph.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'data');
const SCHEMAS = path.join(DATA, 'schemas');

const START_ROOM_ID = 'moonlit_gate_001';

/** data file -> { schema, kind: 'array' | 'object' } */
const TARGETS = {
  'weapons.json': { schema: 'weapon.schema.json', kind: 'array' },
  'armor.json': { schema: 'armor.schema.json', kind: 'array' },
  'accessories.json': { schema: 'accessory.schema.json', kind: 'array' },
  'consumables.json': { schema: 'consumable.schema.json', kind: 'array' },
  'enemies.json': { schema: 'enemy.schema.json', kind: 'array' },
  'bosses.json': { schema: 'boss.schema.json', kind: 'array' },
  'merchants.json': { schema: 'merchant.schema.json', kind: 'array' },
  'npcs.json': { schema: 'npc.schema.json', kind: 'array' },
  'boss_attacks.json': { schema: 'boss_attack.schema.json', kind: 'array' },
  'abilities.json': { schema: 'ability.schema.json', kind: 'array' },
  'rooms.json': { schema: 'room.schema.json', kind: 'array' },
  'progression.json': { schema: 'progression.schema.json', kind: 'object' },
};

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function loadJson(relPath) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'));
  } catch (e) {
    fail(`${relPath}: invalid JSON — ${e.message}`);
    return null;
  }
}

function main() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const compiled = {};
  for (const { schema } of Object.values(TARGETS)) {
    const schemaJson = loadJson(path.join('data/schemas', schema));
    if (!schemaJson) continue;
    compiled[schema] = ajv.compile(schemaJson);
  }

  const tables = {}; // data file -> parsed content

  // ---- 1+2. schema validation + id uniqueness ----
  for (const [file, { schema, kind }] of Object.entries(TARGETS)) {
    const data = loadJson(path.join('data', file));
    if (data === null) continue;
    tables[file] = data;
    const validate = compiled[schema];
    if (!validate) continue;

    const items = kind === 'array' ? data : [data];
    if (kind === 'array' && !Array.isArray(data)) {
      fail(`${file}: expected a JSON array`);
      continue;
    }
    const seen = new Set();
    items.forEach((item, i) => {
      const label = kind === 'array' ? `${file}[${i}]` : file;
      if (!validate(item)) {
        for (const e of validate.errors ?? []) {
          fail(`${label}: schema error at '${e.instancePath || '/'}' — ${e.message}`);
        }
      }
      if (item && typeof item.id === 'string') {
        if (seen.has(item.id)) fail(`${file}: duplicate id '${item.id}'`);
        seen.add(item.id);
      }
    });
  }

  // ---- 3. cross-references ----
  const itemIds = new Set();
  for (const f of ['weapons.json', 'armor.json', 'accessories.json', 'consumables.json']) {
    for (const it of tables[f] ?? []) itemIds.add(it.id);
  }
  const enemyIds = new Set((tables['enemies.json'] ?? []).map((e) => e.id));
  const abilityIds = new Set((tables['abilities.json'] ?? []).map((a) => a.id));
  const roomIds = new Set((tables['rooms.json'] ?? []).map((r) => r.id));
  const rooms = tables['rooms.json'] ?? [];

  const roomSecrets = new Set();
  for (const r of rooms) for (const sc of r.secrets ?? []) roomSecrets.add(`${r.id}:${sc.id}`);
  for (const room of rooms) {
    for (const e of room.enemies ?? []) {
      if (!enemyIds.has(e.id)) fail(`rooms.json:${room.id}: unknown enemy id '${e.id}'`);
    }
    for (const p of room.pickups ?? []) {
      if (!itemIds.has(p.itemId)) fail(`rooms.json:${room.id}: unknown pickup item '${p.itemId}'`);
    }
    for (const s of room.secrets ?? []) {
      const rid = s.reward?.itemId;
      if (rid && !itemIds.has(rid)) fail(`rooms.json:${room.id}: secret '${s.id}' unknown reward item '${rid}'`);
      const aid = s.reward?.abilityId;
      if (aid && !abilityIds.has(aid)) fail(`rooms.json:${room.id}: secret '${s.id}' unknown reward ability '${aid}'`);
    }
    for (const exit of room.exits ?? []) {
      if (exit.requiresItem && !itemIds.has(exit.requiresItem)) {
        fail(`rooms.json:${room.id}: exit '${exit.id}' requiresItem unknown item '${exit.requiresItem}'`);
      }
      if (exit.secretId && !roomSecrets.has(`${room.id}:${exit.secretId}`)) {
        fail(`rooms.json:${room.id}: exit '${exit.id}' secretId '${exit.secretId}' has no matching secret in this room`);
      }
      if (!roomIds.has(exit.target)) {
        fail(`rooms.json:${room.id}: exit '${exit.id}' targets missing room '${exit.target}'`);
      }
      for (const req of exit.requires ?? []) {
        if (!abilityIds.has(req)) fail(`rooms.json:${room.id}: exit '${exit.id}' requires unknown ability '${req}'`);
      }
    }
  }
  for (const enemy of tables['enemies.json'] ?? []) {
    for (const d of enemy.drops ?? []) {
      if (!itemIds.has(d.itemId)) fail(`enemies.json:${enemy.id}: unknown drop item '${d.itemId}'`);
    }
  }
  const merchantIds = new Set((tables['merchants.json'] ?? []).map((m) => m.id));
  for (const merchant of tables['merchants.json'] ?? []) {
    if (!roomIds.has(merchant.roomId)) {
      fail(`merchants.json:${merchant.id}: unknown roomId '${merchant.roomId}'`);
    }
    for (const line of merchant.stock ?? []) {
      if (!itemIds.has(line.itemId)) {
        fail(`merchants.json:${merchant.id}: unknown stock item '${line.itemId}'`);
      }
    }
  }
  for (const npc of tables['npcs.json'] ?? []) {
    if (!roomIds.has(npc.roomId)) fail(`npcs.json:${npc.id}: unknown roomId '${npc.roomId}'`);
    for (const r of npc.relocate ?? []) {
      if (!roomIds.has(r.roomId)) fail(`npcs.json:${npc.id}: relocate to unknown room '${r.roomId}'`);
    }
    if (npc.merchantId && !merchantIds.has(npc.merchantId)) {
      fail(`npcs.json:${npc.id}: unknown merchantId '${npc.merchantId}'`);
    }
    const nodes = npc.dialogue?.nodes ?? {};
    for (const vid of (npc.dialogue?.variants ?? []).map((v) => v.start)) {
      if (!nodes[vid]) fail(`npcs.json:${npc.id}: dialogue variant start '${vid}' is not a node`);
    }
    if (!nodes[npc.dialogue?.defaultStart]) {
      fail(`npcs.json:${npc.id}: defaultStart '${npc.dialogue?.defaultStart}' is not a node`);
    }
    for (const [nodeId, node] of Object.entries(nodes)) {
      for (const choice of node.choices ?? []) {
        if (choice.next != null && !nodes[choice.next]) {
          fail(`npcs.json:${npc.id}: node '${nodeId}' choice targets unknown node '${choice.next}'`);
        }
      }
    }
  }
  for (const boss of tables['bosses.json'] ?? []) {
    if (!roomIds.has(boss.arenaRoomId)) {
      // Same message as WorldGraph.validateWorld so the merge below dedupes it.
      warn(`world: boss '${boss.id}' arena room '${boss.arenaRoomId}' not in rooms.json yet (ok if arena ships in a later wave)`);
    }
    const rid = boss.reward?.itemId;
    if (rid && !itemIds.has(rid)) fail(`bosses.json:${boss.id}: unknown reward item '${rid}'`);
    const aid = boss.reward?.abilityId;
    if (aid && !abilityIds.has(aid)) fail(`bosses.json:${boss.id}: unknown reward ability '${aid}'`);
  }
  // Boss attack patterns: every id referenced by a boss (base attacks +
  // phase additions) must exist in boss_attacks.json and belong to that boss.
  const attackById = new Map((tables['boss_attacks.json'] ?? []).map((a) => [a.id, a]));
  for (const boss of tables['bosses.json'] ?? []) {
    const refs = [
      ...(boss.attacks ?? []).map((a) => a.id),
      ...(boss.phases ?? []).flatMap((p) => p.addsAttacks ?? []),
    ];
    for (const ref of refs) {
      const pat = attackById.get(ref);
      if (!pat) fail(`bosses.json:${boss.id}: unknown attack pattern '${ref}'`);
      else if (pat.bossId !== boss.id) {
        fail(`boss_attacks.json:${ref}: bossId '${pat.bossId}' does not match referencing boss '${boss.id}'`);
      }
    }
  }

  // ---- 4. connectivity (BFS from start) ----
  if (roomIds.has(START_ROOM_ID)) {
    const adj = new Map(rooms.map((r) => [r.id, (r.exits ?? []).map((e) => e.target)]));
    const seen = new Set([START_ROOM_ID]);
    const queue = [START_ROOM_ID];
    while (queue.length) {
      for (const next of adj.get(queue.shift()) ?? []) {
        if (!seen.has(next) && roomIds.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const id of roomIds) {
      if (!seen.has(id)) fail(`rooms.json:${id}: unreachable from start room '${START_ROOM_ID}'`);
    }
  } else {
    fail(`rooms.json: start room '${START_ROOM_ID}' is missing`);
  }

  // ---- 5. map grid uniqueness ----
  const cells = new Map();
  for (const room of rooms) {
    const key = `${room.map?.x},${room.map?.y}`;
    if (cells.has(key)) fail(`rooms.json:${room.id}: map cell ${key} already used by '${cells.get(key)}'`);
    else cells.set(key, room.id);
  }

  // ---- 6. world-graph validation (src/world/WorldGraph.js) ----
  // Handles a mid-rewrite rooms.json gracefully: skips when rooms failed to
  // parse or are not an array (checks above already recorded the failure),
  // and never lets a WorldGraph exception escape as an unhandled crash.
  if (Array.isArray(rooms) && rooms.length > 0) {
    try {
      const { errors: wgErrors, warnings: wgWarnings } = validateWorld(rooms, {
        abilities: [...abilityIds],
        bosses: tables['bosses.json'] ?? [],
      });
      const seenMsg = new Set([...errors, ...warnings]);
      for (const e of wgErrors) {
        if (!seenMsg.has(e)) {
          fail(e);
          seenMsg.add(e);
        }
      }
      for (const w of wgWarnings) {
        if (!seenMsg.has(w)) {
          warn(w);
          seenMsg.add(w);
        }
      }
    } catch (e) {
      fail(`world graph validation crashed on rooms.json — ${e.message}`);
    }
  } else if (!Array.isArray(rooms)) {
    fail('rooms.json: expected a JSON array of room definitions');
  }

  // ---- report ----
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length) {
    console.error(`\nvalidate: ${errors.length} error(s) found:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`validate: OK — ${Object.keys(TARGETS).length} data files, ${rooms.length} rooms, ${warnings.length} warning(s).`);
}

main();
