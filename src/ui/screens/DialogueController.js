/**
 * DialogueController — dialogue UI state machine (Wave 5, W5-UI).
 *
 * Headless-safe: no Phaser import. Wraps DialogueManager (the data/flow
 * layer) and adds presentation state: typewriter reveal, choice focus,
 * cancel/confirm handling. Rendering is done by renderDialogue() below,
 * which is duck-typed against the scene (no `import 'phaser'`).
 *
 * CONTRACT:
 * - open(npcId): dialogueManager.open() -> first node; emits nothing itself.
 *   GameScene wraps open()/close() with UiStack so `ui:opened`/`ui:closed`
 *   { screen:'dialogue' } drive the §14 pause ref-count.
 * - update(dt): advances the typewriter; polls the injected input:
 *     confirm -> if typing: complete the line; else: pick focused choice
 *       (or end when the node has no choices)
 *     move_up/move_down -> move choice focus (after the line is complete)
 *     cancel -> close without choosing
 * - onDialogueClosed callback fires when the conversation ends or is
 *   cancelled, so GameScene can chain the merchant shop UI.
 * - getView() returns plain data for renderDialogue().
 */
import { inputManager } from '../../core/InputManager.js';
import { dialogueManager as sharedDialogueManager } from '../../systems/DialogueManager.js';
import { InkCss, drawGothicPanel, gothicText } from '../gothic.js';

export const TYPEWRITER_CPS = 48; // chars per second

export class DialogueController {
  /**
   * @param {object} [deps]
   * @param {object} [deps.input] InputManager-like
   * @param {object} [deps.dialogue] DialogueManager-like
   * @param {Function} [deps.onDialogueClosed] (npcId, ended:boolean) -> void
   * @param {Function} [deps.onViewChanged] () -> void (re-render hook)
   */
  constructor(deps = {}) {
    this.input = deps.input ?? inputManager;
    this.dialogue = deps.dialogue ?? sharedDialogueManager;
    this.onDialogueClosed = deps.onDialogueClosed ?? (() => {});
    this.onViewChanged = deps.onViewChanged ?? (() => {});
    this._open = false;
    this._npcId = null;
    this._node = null; // node view from DialogueManager
    this._revealed = 0; // typewriter progress (chars)
    this._focus = 0;
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  /** @returns {string|null} npc id of the live conversation */
  get npcId() {
    return this._npcId;
  }

  /**
   * Open a conversation.
   * @param {string} npcId @returns {boolean} false when already open
   */
  open(npcId) {
    if (this._open) return false;
    this._node = this.dialogue.open(npcId); // emits npc:dialogueOpened
    this._open = true;
    this._npcId = npcId;
    this._revealed = 0;
    this._focus = 0;
    this._notify();
    return true;
  }

  /** Close the conversation (cancel path). */
  close() {
    if (!this._open) return false;
    const npcId = this._npcId;
    try {
      this.dialogue.close();
    } catch {
      /* already closed */
    }
    this._open = false;
    this._npcId = null;
    this._node = null;
    this.onDialogueClosed(npcId, false);
    return true;
  }

  /** @private finish via a choice that ends the conversation */
  _end() {
    const npcId = this._npcId;
    this._open = false;
    this._npcId = null;
    this._node = null;
    this.onDialogueClosed(npcId, true);
  }

  /**
   * Advance the typewriter and poll input. Safe to call while paused —
   * GameScene ticks dialogue before the pause gate.
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this._open || !this._node) return;
    const full = this._node.text ?? '';
    let changed = false;
    if (this._revealed < full.length) {
      this._revealed = Math.min(full.length, this._revealed + TYPEWRITER_CPS * dt);
      changed = true;
    }
    const pressed = (a) => {
      try {
        return this.input.justPressed(a) === true;
      } catch {
        return false;
      }
    };
    const typing = this._revealed < full.length;
    const choices = this._node.choices ?? [];
    if (pressed('cancel')) {
      this.close();
      return;
    }
    if (pressed('confirm')) {
      if (typing) {
        this._revealed = full.length;
        this._notify();
        return;
      }
      if (choices.length === 0) {
        this._end();
        return;
      }
      const result = this.dialogue.choose(this._focus);
      if (result.ended) {
        this._end();
      } else {
        this._node = result.node;
        this._revealed = 0;
        this._focus = 0;
        this._notify();
      }
      return;
    }
    if (!typing && choices.length > 1) {
      if (pressed('move_up')) {
        this._focus = (this._focus + choices.length - 1) % choices.length;
        changed = true;
      } else if (pressed('move_down')) {
        this._focus = (this._focus + 1) % choices.length;
        changed = true;
      }
    }
    if (changed) this._notify();
  }

  /**
   * @returns {object|null} plain view data for renderDialogue(), or null
   *   when closed
   */
  getView() {
    if (!this._open || !this._node) return null;
    const full = this._node.text ?? '';
    const typing = Math.floor(this._revealed) < full.length;
    return {
      npcName: this._node.npcName ?? '???',
      npcTitle: this._node.npcTitle ?? '',
      text: full.slice(0, Math.floor(this._revealed)),
      fullText: full,
      typing,
      advanceHint: typing,
      choices: typing ? [] : (this._node.choices ?? []).map((c) => c.text),
      focus: this._focus,
    };
  }

  /** @private */
  _notify() {
    try {
      this.onViewChanged();
    } catch {
      /* render hook must never break dialogue */
    }
  }
}

/**
 * Render the dialogue box into a container (duck-typed scene; no Phaser import).
 * JRPG-style: name plate overlapping the top edge, double gold border with
 * corner diamonds (drawGothicPanel), typewriter text, choice list with a
 * focus cursor, bouncing advance indicator while typing.
 *
 * @param {object} scene Phaser Scene (duck-typed)
 * @param {object} view getView() output
 * @param {string} confirmPrompt inputManager.getPrompt('confirm')
 * @returns {object} container holding the box
 */
export function renderDialogue(scene, view, confirmPrompt = 'E') {
  const W = 480;
  const boxW = 400;
  const x = (W - boxW) / 2;

  // Measure the FULL node text (not the typewriter slice) so the box keeps a
  // stable height while typing. Choices are laid out below the measured text
  // block — the old `split('\n')` estimate ignored Phaser word-wrap and let
  // the first choice overlap the last line of body text.
  const body = gothicText(scene, x + 14, 0, view.fullText ?? view.text, {
    size: '10px',
    wrap: boxW - 28,
    lineSpacing: 3,
  });
  const fullH = body.height;
  const choiceH = !view.typing && view.choices.length > 0 ? view.choices.length * 13 : 0;
  const boxH = Math.max(86, 16 + fullH + (choiceH > 0 ? 6 + choiceH : 0) + 14);
  const y = 270 - boxH - 12;
  body.setY(y + 16);
  body.setText(view.text); // show the typewriter slice
  const root = scene.add.container(0, 0).setDepth(1600).setScrollFactor(0);
  const g = scene.add.graphics();
  drawGothicPanel(g, x, y, boxW, boxH);
  root.add(g);

  // name plate overlapping the top edge
  const plateW = Math.min(boxW - 40, 40 + view.npcName.length * 7);
  const plate = scene.add.graphics();
  drawGothicPanel(plate, x + 16, y - 11, plateW, 20, { fill: 0x1a1428 });
  root.add(plate);
  const name = gothicText(scene, x + 16 + plateW / 2, y - 8, view.npcName, {
    size: '10px',
    color: InkCss.goldBright,
    spacing: 1,
  });
  name.setOrigin(0.5, 0);
  root.add(name);

  root.add(body);

  if (view.typing) {
    const hint = gothicText(scene, x + boxW - 14, y + boxH - 16, '▼', {
      size: '9px',
      color: InkCss.dim,
    });
    hint.setOrigin(1, 1);
    root.add(hint);
    try {
      scene.tweens.add({ targets: hint, y: hint.y - 3, duration: 350, yoyo: true, repeat: -1 });
    } catch {
      /* headless / no tweens */
    }
  } else if (view.choices.length > 0) {
    const cy = y + 16 + fullH + 6;
    view.choices.forEach((choice, i) => {
      const focused = i === view.focus;
      const ct = gothicText(scene, x + 26, cy + i * 13, `${focused ? '❖' : '·'} ${choice}`, {
        size: '9px',
        color: focused ? InkCss.goldBright : InkCss.ink,
        wrap: boxW - 44,
      });
      root.add(ct);
    });
  } else {
    const hint = gothicText(scene, x + boxW - 14, y + boxH - 14, `[${confirmPrompt}]`, {
      size: '8px',
      color: InkCss.dim,
      mono: true,
    });
    hint.setOrigin(1, 1);
    root.add(hint);
  }
  return root;
}
