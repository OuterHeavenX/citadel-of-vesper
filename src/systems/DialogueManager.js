/**
 * DialogueManager — data-driven NPC dialogue (Wave 4).
 *
 * CONTRACT:
 * - Trees come from data/npcs.json: { defaultStart, variants:[{flag,start}],
 *   nodes:{ id:{ text, onEnter?[], choices:[{text,next,setFlag?,quest?}] } } }.
 * - open(npcId) emits the catalog event `npc:dialogueOpened` and picks the
 *   entry node: the first variant whose flag is truthy in gameState.flags,
 *   else defaultStart.
 * - choose(i) applies the choice's setFlag (via gameState.setFlag ->
 *   `flag:set`) and quest (via gameState.setQuestStage -> `quest:updated`),
 *   then advances; a `next: null` choice ends the conversation.
 * - Node `onEnter` flags are applied when the node is shown (drives
 *   `met_<npc>` flags and post-boss dialogue switches).
 * - getLocation(npcId) resolves NPC relocation: later `relocate` entries win
 *   when their whenFlag is truthy.
 * - Headless-safe (no Phaser). The dialogue UI (Wave 5) renders the node
 *   views returned here and calls choose(); pause coordination lives in
 *   the UI layer per docs/ARCHITECTURE.md §14.
 */
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { dataManager } from '../core/DataManager.js';

export class DialogueManager {
  /**
   * @param {object} [deps]
   * @param {object} [deps.state] GameState singleton (injectable for tests)
   */
  constructor({ state = gameState } = {}) {
    this.state = state;
    /** @type {Map<string, object>} */
    this._npcs = new Map(dataManager.getData('npcs').map((n) => [n.id, n]));
    /** @type {{npcId:string, nodeId:string}|null} */
    this._current = null;
  }

  /** @param {string} npcId @returns {object} npc def (throws on unknown) */
  getNpc(npcId) {
    const npc = this._npcs.get(npcId);
    if (!npc) throw new Error(`unknown npc id '${npcId}'`);
    return npc;
  }

  /** @returns {string[]} all npc ids */
  listNpcIds() {
    return [...this._npcs.keys()];
  }

  /**
   * Resolve where an NPC currently stands (relocation via flags).
   * @param {string} npcId @returns {{roomId:string, x:number|null, y:number|null}}
   */
  getLocation(npcId) {
    const npc = this.getNpc(npcId);
    let loc = { roomId: npc.roomId, x: npc.x ?? null, y: npc.y ?? null };
    for (const r of npc.relocate ?? []) {
      if (this.state.getFlag(r.whenFlag)) {
        loc = { roomId: r.roomId, x: r.x ?? null, y: r.y ?? null };
      }
    }
    return loc;
  }

  /** @param {string} roomId @returns {object[]} npc defs currently in that room */
  npcsInRoom(roomId) {
    return [...this._npcs.values()].filter((n) => this.getLocation(n.id).roomId === roomId);
  }

  /**
   * Open a conversation. Emits `npc:dialogueOpened`.
   * @param {string} npcId @returns {object} node view
   */
  open(npcId) {
    const npc = this.getNpc(npcId);
    const dlg = npc.dialogue;
    const variant = (dlg.variants ?? []).find((v) => this.state.getFlag(v.flag));
    const start = variant ? variant.start : dlg.defaultStart;
    this._current = { npcId, nodeId: start };
    eventBus.emit('npc:dialogueOpened', { npcId });
    return this._showNode(npc, start);
  }

  /** @returns {object|null} current node view, or null when no conversation */
  getCurrent() {
    if (!this._current) return null;
    const npc = this.getNpc(this._current.npcId);
    return this._nodeView(npc, this._current.nodeId);
  }

  /**
   * Pick a choice by index.
   * @param {number} index
   * @returns {{ended:boolean, node?:object}} ended when the choice closes dialogue
   */
  choose(index) {
    if (!this._current) throw new Error('no conversation is open');
    const npc = this.getNpc(this._current.npcId);
    const node = npc.dialogue.nodes[this._current.nodeId];
    const choice = node.choices[index];
    if (!choice) throw new Error(`choice index ${index} out of range for node '${this._current.nodeId}'`);

    if (choice.setFlag) this.state.setFlag(choice.setFlag.flag, choice.setFlag.value);
    if (choice.quest) this.state.setQuestStage(choice.quest.questId, choice.quest.stage);

    if (choice.next == null) {
      this._current = null;
      return { ended: true };
    }
    if (!npc.dialogue.nodes[choice.next]) {
      throw new Error(`dialogue node '${choice.next}' (from '${this._current.nodeId}') does not exist`);
    }
    this._current = { npcId: npc.id, nodeId: choice.next };
    return { ended: false, node: this._showNode(npc, choice.next) };
  }

  /** Close the current conversation without choosing. */
  close() {
    this._current = null;
  }

  /** @private apply onEnter flags, then return the node view */
  _showNode(npc, nodeId) {
    const node = npc.dialogue.nodes[nodeId];
    for (const f of node.onEnter ?? []) this.state.setFlag(f.flag, f.value);
    return this._nodeView(npc, nodeId);
  }

  /** @private @returns {{npcId, npcName, npcTitle, nodeId, text, choices:{text}[]}} */
  _nodeView(npc, nodeId) {
    const node = npc.dialogue.nodes[nodeId];
    return {
      npcId: npc.id,
      npcName: npc.name,
      npcTitle: npc.title,
      nodeId,
      text: node.text,
      choices: node.choices.map((c) => ({ text: c.text })),
    };
  }
}

/** Shared singleton (GameScene / UI use this instance). */
export const dialogueManager = new DialogueManager();
