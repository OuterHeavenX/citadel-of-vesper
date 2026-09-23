/**
 * DialogueManager + Npc tests — tree navigation, flag/quest side effects,
 * flag-driven dialogue variants (post-Warden), relocation, room listing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DialogueManager } from '../src/systems/DialogueManager.js';
import { Npc } from '../src/npcs/Npc.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';

describe('DialogueManager', () => {
  let dlg;
  let seen;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    dlg = new DialogueManager();
    seen = { opened: [], flags: [], quests: [] };
    eventBus.on('npc:dialogueOpened', (p) => seen.opened.push(p));
    eventBus.on('flag:set', (p) => seen.flags.push(p));
    eventBus.on('quest:updated', (p) => seen.quests.push(p));
  });
  afterEach(() => {
    eventBus.clear();
    gameState.reset();
  });

  it('open emits npc:dialogueOpened and applies onEnter flags', () => {
    const node = dlg.open('old_tam');
    expect(seen.opened).toEqual([{ npcId: 'old_tam' }]);
    expect(node.npcName).toBe('Old Tam');
    expect(node.text).toContain('Threshold');
    expect(node.choices).toHaveLength(3);
    expect(gameState.getFlag('met_old_tam')).toBe(true);
    expect(seen.flags).toContainEqual({ flag: 'met_old_tam', value: true });
  });

  it('choose advances nodes and can end the conversation', () => {
    dlg.open('old_tam');
    const r1 = dlg.choose(0); // "What is this place?"
    expect(r1.ended).toBe(false);
    expect(r1.node.text).toContain('Moonlit Gate');
    const r2 = dlg.choose(1); // "Understood." -> next: null
    expect(r2.ended).toBe(true);
    expect(dlg.getCurrent()).toBeNull();
  });

  it('choice quest side effects emit quest:updated', () => {
    dlg.open('maribel_quill');
    const r1 = dlg.choose(1); // "How does one fight the Warden?"
    expect(r1.ended).toBe(false);
    expect(gameState.data.quests.chapel_warden_hunt.stage).toBe('heard');
    expect(seen.quests).toEqual([{ questId: 'chapel_warden_hunt', stage: 'heard' }]);
  });

  it('flag variants switch the entry node (post-Warden dialogue)', () => {
    const before = dlg.open('sister_ansel');
    expect(before.text).toContain('Lantern Court');
    dlg.close();
    gameState.setFlag('boss_defeated_chapel_warden', true);
    const after = dlg.open('sister_ansel');
    expect(after.text).toContain('bell has gone silent');
    expect(after.nodeId).toBe('post_warden');
  });

  it('choose throws on bad index and unknown next nodes are validated', () => {
    dlg.open('old_tam');
    expect(() => dlg.choose(99)).toThrow('out of range');
    expect(() => dlg.open('no_such_npc')).toThrow("unknown npc id 'no_such_npc'");
  });

  it('getLocation honors relocation flags; npcsInRoom lists room occupants', () => {
    const loc = dlg.getLocation('sister_ansel');
    expect(loc.roomId).toBe('moonlit_gate_002');
    const room2 = dlg.npcsInRoom('moonlit_gate_002').map((n) => n.id).sort();
    expect(room2).toEqual(['corvus_vane', 'sister_ansel']);
    expect(dlg.npcsInRoom('hollow_keep_002').map((n) => n.id).sort()).toEqual([
      'gideon_hollow',
      'wren_aldervale',
    ]);
  });

  it('all six NPCs load with valid dialogue graphs', () => {
    expect(dlg.listNpcIds()).toHaveLength(6);
    for (const id of dlg.listNpcIds()) {
      const npc = dlg.getNpc(id);
      expect(npc.dialogue.nodes[npc.dialogue.defaultStart]).toBeDefined();
      // Every node reachable: walk the graph from the default start.
      const seenNodes = new Set();
      const walk = (nodeId) => {
        if (seenNodes.has(nodeId) || !npc.dialogue.nodes[nodeId]) return;
        seenNodes.add(nodeId);
        for (const c of npc.dialogue.nodes[nodeId].choices) {
          if (c.next) walk(c.next);
        }
      };
      walk(npc.dialogue.defaultStart);
      expect([...seenNodes].length).toBeGreaterThan(1);
    }
  });
});

describe('Npc', () => {
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
  });
  afterEach(() => {
    eventBus.clear();
    gameState.reset();
  });

  it('is headless-safe and delegates interact() to the DialogueManager', () => {
    const tam = new Npc(null, 'old_tam');
    expect(tam.name).toBe('Old Tam');
    expect(tam.isMerchant).toBe(false);
    expect(tam.getLocation().roomId).toBe('moonlit_gate_001');
    const node = tam.interact();
    expect(node.npcId).toBe('old_tam');

    const wren = new Npc(null, 'wren_aldervale');
    expect(wren.isMerchant).toBe(true);
    const merchant = wren.getMerchant();
    expect(merchant.name).toBe('Wren Aldervale');
    expect(() => tam.getMerchant()).toThrow('is not a merchant');
  });
});
