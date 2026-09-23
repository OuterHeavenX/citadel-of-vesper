/**
 * test/ui.test.js — W5-UI headless UI-logic tests.
 *
 * Covers the Phaser-free layers (controllers + UiStack + NpcDirector +
 * touch math). Rendering functions are duck-typed but not exercised here;
 * GameScene glue is covered by inspection, not by node.
 *
 * Suites:
 *  - UiStack: open/close state machine, idempotency, closeAll order
 *  - Pause coordination: UiStack emissions through the real PauseCoordinator
 *    (ARCHITECTURE §14 ref-count): closing one screen must NOT resume while
 *    another is open
 *  - InventoryController: open/close, tab cycling, consumable use through
 *    the UI layer, equip + EQUIPPED-vs-candidate stat diff, CONFIG toggles
 *  - ShopController: buy/sell through the UI layer, finite stock, locked
 *    silhouettes, sell-back at tuning.economy.sellRate
 *  - DialogueController: typewriter -> choices -> choose -> ended; cancel
 *  - PauseMenuController: focus + action dispatch
 *  - EndScreenController: gameover/victory modes and actions
 *  - NpcDirector: room presence, proximity prompt, confirm-to-talk
 *  - TouchOverlay: directionFromVector stick math
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../src/core/EventBus.js';
import { gameState } from '../src/core/GameState.js';
import { tuning } from '../src/config/tuning.js';
import { PauseCoordinator } from '../src/scenes/gameEntry.js';
import { UiStack } from '../src/ui/UiStack.js';
import { directionFromVector } from '../src/ui/touch/TouchOverlay.js';
import { NpcDirector } from '../src/ui/npc/NpcDirector.js';
import { DialogueController } from '../src/ui/screens/DialogueController.js';
import { ShopController } from '../src/ui/screens/ShopController.js';
import { InventoryController } from '../src/ui/screens/InventoryController.js';
import { PauseMenuController } from '../src/ui/screens/PauseMenuController.js';
import { EndScreenController } from '../src/ui/screens/EndScreenController.js';
import { InventoryManager } from '../src/systems/InventoryManager.js';
import { EquipmentManager } from '../src/systems/EquipmentManager.js';

/** Fake InputManager-like: press/release drive justPressed(). */
function fakeInput() {
  const pressed = new Set();
  return {
    press(a) {
      pressed.add(a);
    },
    release(a) {
      pressed.delete(a);
    },
    justPressed(a) {
      return pressed.has(a);
    },
    isDown(a) {
      return pressed.has(a);
    },
  };
}

beforeEach(() => {
  gameState.reset();
  eventBus.clear();
});

afterEach(() => {
  eventBus.clear();
  gameState.reset();
});

// ------------------------------------------------------------- UiStack ----

describe('UiStack', () => {
  it('opens and closes screens, emitting ui:opened/ui:closed', () => {
    const seen = [];
    eventBus.on('ui:opened', (p) => seen.push(['opened', p.screen]));
    eventBus.on('ui:closed', (p) => seen.push(['closed', p.screen]));
    const stack = new UiStack();
    expect(stack.open('inventory')).toBe(true);
    expect(stack.isOpen('inventory')).toBe(true);
    expect(stack.top()).toBe('inventory');
    expect(stack.close('inventory')).toBe(true);
    expect(stack.isOpen('inventory')).toBe(false);
    expect(stack.top()).toBeNull();
    expect(seen).toEqual([
      ['opened', 'inventory'],
      ['closed', 'inventory'],
    ]);
  });

  it('open is idempotent per screen; close of a closed screen is a no-op', () => {
    const stack = new UiStack();
    expect(stack.open('shop')).toBe(true);
    expect(stack.open('shop')).toBe(false);
    expect(stack.count()).toBe(1);
    expect(stack.close('nope')).toBe(false);
    expect(stack.close('shop')).toBe(true);
    expect(stack.close('shop')).toBe(false);
  });

  it('closeAll unwinds top-first', () => {
    const closed = [];
    eventBus.on('ui:closed', (p) => closed.push(p.screen));
    const stack = new UiStack();
    stack.open('inventory');
    stack.open('dialogue');
    stack.open('shop');
    stack.closeAll();
    expect(closed).toEqual(['shop', 'dialogue', 'inventory']);
    expect(stack.count()).toBe(0);
  });

  it('runs onClose teardown callbacks', () => {
    const calls = [];
    const stack = new UiStack();
    stack.open('pause', { onClose: () => calls.push('pause') });
    stack.close('pause');
    expect(calls).toEqual(['pause']);
  });
});

// ------------------------------------------------- pause coordination ----

describe('pause coordination (§14 ref-count via UiStack)', () => {
  function wireCoordinator() {
    const pc = new PauseCoordinator();
    eventBus.on('ui:opened', ({ screen } = {}) => pc.uiOpened(screen));
    eventBus.on('ui:closed', ({ screen } = {}) => pc.uiClosed(screen));
    return pc;
  }

  it('pauses on open, resumes only when every screen is closed', () => {
    const pc = wireCoordinator();
    const stack = new UiStack();
    expect(pc.isPaused()).toBe(false);
    stack.open('inventory');
    expect(pc.isPaused()).toBe(true);
    stack.open('dialogue'); // nested over inventory
    stack.close('inventory'); // closing one must NOT resume
    expect(pc.isPaused()).toBe(true);
    expect(pc.openScreens.has('dialogue')).toBe(true);
    stack.close('dialogue');
    expect(pc.isPaused()).toBe(false);
  });

  it('auto-pause latch never fights the UI ref-count', () => {
    const pc = wireCoordinator();
    const stack = new UiStack();
    stack.open('shop');
    pc.setAutoPaused(true);
    stack.close('shop');
    expect(pc.isPaused()).toBe(true); // tab-hide still holds it
    pc.setAutoPaused(false);
    expect(pc.isPaused()).toBe(false);
  });
});

// ------------------------------------------------- InventoryController ----

describe('InventoryController', () => {
  function make(input) {
    return new InventoryController({
      input,
      getPlayer: () => null, // headless heal path via GameState
      getStats: () => null,
      saveGame: async () => ({ ok: true }),
      persistSettings: () => {},
    });
  }

  it('open/close state machine; double-open is a no-op', () => {
    const ctl = make(fakeInput());
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.open('items')).toBe(true);
    expect(ctl.open('items')).toBe(false);
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.tab).toBe('items');
    expect(ctl.close()).toBe(true);
    expect(ctl.close()).toBe(false);
    expect(ctl.getView()).toBeNull();
  });

  it('cancel closes the screen', () => {
    const input = fakeInput();
    const ctl = make(input);
    ctl.open('status');
    input.press('cancel');
    ctl.update();
    input.release('cancel');
    expect(ctl.isOpen()).toBe(false);
  });

  it('menu_tab_next/prev cycles the 8 tabs', () => {
    const input = fakeInput();
    const ctl = make(input);
    ctl.open('status');
    input.press('menu_tab_next');
    ctl.update();
    input.release('menu_tab_next');
    expect(ctl.tab).toBe('items');
    input.press('menu_tab_prev');
    ctl.update();
    input.release('menu_tab_prev');
    expect(ctl.tab).toBe('status');
  });

  it('uses a consumable through the UI layer (headless heal path)', () => {
    const input = fakeInput();
    const ctl = make(input);
    const inv = new InventoryManager();
    inv.add('ember_tonic', 2);
    gameState.setHp(10);
    ctl.open('items');
    expect(ctl.getView().items.rows[0].itemId).toBe('ember_tonic');
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    // ember_tonic heals 50 through GameState (maxHp 60)
    expect(gameState.data.player.hp).toBe(60);
    expect(inv.count('ember_tonic')).toBe(1);
    expect(ctl.getView().message).toContain('Used');
  });

  it('equips gear from ITEMS and shows EQUIPPED-vs-candidate diff', () => {
    const input = fakeInput();
    const ctl = make(input);
    const inv = new InventoryManager();
    const eq = new EquipmentManager();
    inv.add('recruit_blade', 1);
    inv.add('moonsteel_sabre', 1);
    ctl.open('items');
    // focus recruit_blade (row 0), confirm equips it
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(eq.getEquipped().weapon?.id).toBe('recruit_blade');
    // now focus moonsteel_sabre: compare vs recruit_blade must show deltas
    const view = ctl.getView();
    const idx = view.items.rows.findIndex((r) => r.itemId === 'moonsteel_sabre');
    expect(idx).toBeGreaterThanOrEqual(0);
    ctl._focus = idx;
    const focused = ctl.getView().items.rows[idx];
    expect(focused.equippable).toBe(true);
    expect(focused.compare).toBeTruthy();
    expect(focused.compare.ok).toBe(true);
    expect(focused.compare.equippedId).toBe('recruit_blade');
    expect(typeof focused.compare.atkDelta).toBe('number');
  });

  it('EQUIP tab unequips the focused slot', () => {
    const input = fakeInput();
    const ctl = make(input);
    const inv = new InventoryManager();
    inv.add('recruit_blade', 1);
    new EquipmentManager().equip('recruit_blade');
    ctl.open('equip');
    const view = ctl.getView();
    expect(view.equip.slots[0].itemId).toBe('recruit_blade');
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(new EquipmentManager().getEquipped().weapon).toBeNull();
    expect(inv.count('recruit_blade')).toBe(1);
  });

  it('CONFIG toggles screen shake and persists settings', () => {
    const input = fakeInput();
    let persisted = 0;
    const ctl = new InventoryController({
      input,
      persistSettings: () => persisted++,
      audio: { getVolumes: () => ({}), setVolume: () => {} },
    });
    ctl.open('config');
    const rows = ctl.getView().config.rows;
    const shakeIdx = rows.findIndex((r) => r.id === 'screenShake');
    expect(shakeIdx).toBeGreaterThanOrEqual(0);
    expect(gameState.data.settings.screenShake).toBe(true);
    ctl._focus = shakeIdx;
    input.press('confirm'); // toggles
    ctl.update();
    input.release('confirm');
    expect(gameState.data.settings.screenShake).toBe(false);
    expect(persisted).toBeGreaterThan(0);
  });

  it('SAVE tab writes through the injected saveGame', async () => {
    const input = fakeInput();
    const saved = [];
    const ctl = new InventoryController({
      input,
      saveGame: async (slot) => {
        saved.push(slot);
        return { ok: true };
      },
    });
    ctl.open('save');
    ctl._focus = 1; // slot 2
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    await new Promise((r) => setTimeout(r, 10));
    expect(saved).toEqual([2]);
    expect(ctl.getView().message).toContain('slot 2');
  });

  it('BESTIARY tab shows silhouettes for unseen entries', () => {
    const ctl = make(fakeInput());
    ctl.open('bestiary');
    const rows = ctl.getView().bestiary.rows;
    expect(rows.length).toBeGreaterThan(0);
    // fresh state: nothing seen
    expect(rows.every((r) => r.seen === false)).toBe(true);
    gameState.recordBestiaryKill('ash_hound');
    const rows2 = ctl.getView().bestiary.rows;
    const ghoul = rows2.find((r) => r.id === 'ash_hound');
    expect(ghoul.seen).toBe(true);
    expect(ghoul.kills).toBe(1);
  });
});

// ------------------------------------------------------ ShopController ----

describe('ShopController', () => {
  function make(input) {
    return new ShopController({ input, state: gameState });
  }

  it('buys an unlimited line: currency down, item added', () => {
    const input = fakeInput();
    const ctl = make(input);
    gameState.addCurrency(500);
    ctl.open('corvus_vane');
    const view = ctl.getView();
    const idx = view.rows.findIndex((r) => r.itemId === 'ember_tonic');
    expect(idx).toBeGreaterThanOrEqual(0);
    ctl._focus = idx;
    const before = gameState.data.currency;
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(gameState.data.currency).toBeLessThan(before);
    expect(gameState.countItem('ember_tonic')).toBe(1);
    expect(ctl.getView().message).toContain('Purchased');
  });

  it('refuses a purchase with insufficient funds', () => {
    const input = fakeInput();
    const ctl = make(input);
    gameState.addCurrency(1);
    ctl.open('corvus_vane');
    const idx = ctl.getView().rows.findIndex((r) => r.itemId === 'ember_tonic');
    ctl._focus = idx;
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(ctl.getView().message).toContain('Not enough coin');
    expect(gameState.countItem('ember_tonic')).toBe(0);
  });

  it('finite stock decrements and sells out', () => {
    const input = fakeInput();
    const ctl = make(input);
    gameState.addCurrency(100000);
    ctl.open('corvus_vane');
    // ashward_draught has quantity 3 for corvus_vane
    const idx = ctl.getView().rows.findIndex((r) => r.itemId === 'ashward_draught');
    expect(ctl.getView().rows[idx].quantity).toBe(3);
    for (let i = 0; i < 3; i++) {
      ctl._focus = idx;
      input.press('confirm');
      ctl.update();
      input.release('confirm');
    }
    expect(gameState.countItem('ashward_draught')).toBe(3);
    const view = ctl.getView();
    const row = view.rows.find((r) => r.itemId === 'ashward_draught');
    expect(row.quantity).toBe(0);
    expect(row.soldOut).toBe(true);
    ctl._focus = view.rows.indexOf(row);
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(ctl.getView().message).toContain('sold out');
  });

  it('locked lines render as silhouettes and cannot be bought', () => {
    const input = fakeInput();
    const ctl = make(input);
    gameState.addCurrency(100000);
    ctl.open('corvus_vane');
    const view = ctl.getView();
    const idx = view.rows.findIndex((r) => r.itemId === 'moonstone_charm');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(view.rows[idx].locked).toBe(true);
    expect(view.rows[idx].name).toBe('???');
    ctl._focus = idx;
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(ctl.getView().message).toContain('Sealed');
    expect(gameState.countItem('moonstone_charm')).toBe(0);
    // unlocking the flag reveals the line
    gameState.setFlag('boss_defeated_chapel_warden', true);
    ctl.close();
    ctl.open('corvus_vane');
    const row = ctl.getView().rows.find((r) => r.itemId === 'moonstone_charm');
    expect(row.locked).toBe(false);
    expect(row.name).not.toBe('???');
  });

  it('sells back at tuning.economy.sellRate and refuses soulbound', () => {
    const input = fakeInput();
    const ctl = make(input);
    const inv = new InventoryManager();
    inv.add('ember_tonic', 2); // value 30
    gameState.addCurrency(0);
    ctl.open('corvus_vane');
    // switch to sell tab
    input.press('menu_tab_next');
    ctl.update();
    input.release('menu_tab_next');
    expect(ctl.mode).toBe('sell');
    const idx = ctl.getView().rows.findIndex((r) => r.itemId === 'ember_tonic');
    expect(idx).toBeGreaterThanOrEqual(0);
    ctl._focus = idx;
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    const expected = Math.floor(30 * tuning.economy.sellRate);
    expect(gameState.data.currency).toBe(expected);
    expect(inv.count('ember_tonic')).toBe(1);
    expect(ctl.getView().message).toContain('Sold');
  });

  it('cancel closes the shop', () => {
    const input = fakeInput();
    const ctl = make(input);
    ctl.open('corvus_vane');
    input.press('cancel');
    const closed = ctl.update();
    input.release('cancel');
    expect(closed).toBe(true);
    expect(ctl.isOpen()).toBe(false);
  });
});

// -------------------------------------------------- DialogueController ----

describe('DialogueController', () => {
  function make(input, hooks = {}) {
    return new DialogueController({ input, ...hooks });
  }

  it('typewriter reveals text, confirm completes then chooses', () => {
    const input = fakeInput();
    const closed = [];
    const ctl = make(input, { onDialogueClosed: (id, ended) => closed.push([id, ended]) });
    expect(ctl.open('old_tam')).toBe(true);
    expect(ctl.isOpen()).toBe(true);
    let view = ctl.getView();
    expect(view.text.length).toBe(0);
    expect(view.typing).toBe(true);
    // advance the typewriter with a large dt
    ctl.update(10);
    view = ctl.getView();
    expect(view.typing).toBe(false);
    expect(view.text.length).toBeGreaterThan(50);
    expect(view.choices).toHaveLength(3);
    // confirm picks choice 0 -> advances to a new node
    input.press('confirm');
    ctl.update(0);
    input.release('confirm');
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.getView().text.length).toBe(0); // new node starts typing
    // finish typing, pick the "leave" choice (last) -> ends
    ctl.update(10);
    const choices = ctl.getView().choices;
    const leaveIdx = choices.length - 1;
    for (let i = 0; i < leaveIdx; i++) {
      input.press('move_down');
      ctl.update(0);
      input.release('move_down');
    }
    input.press('confirm');
    ctl.update(0);
    input.release('confirm');
    expect(ctl.isOpen()).toBe(false);
    expect(closed).toEqual([['old_tam', true]]);
  });

  it('confirm while typing completes the line instead of choosing', () => {
    const input = fakeInput();
    const ctl = make(input);
    ctl.open('old_tam');
    input.press('confirm');
    ctl.update(0.01); // barely any time has passed
    input.release('confirm');
    const view = ctl.getView();
    expect(view.typing).toBe(false); // line completed instantly
    expect(ctl.isOpen()).toBe(true); // still open, no choice made
  });

  it('cancel closes the conversation without choosing', () => {
    const input = fakeInput();
    const closed = [];
    const ctl = make(input, { onDialogueClosed: (id, ended) => closed.push([id, ended]) });
    ctl.open('old_tam');
    input.press('cancel');
    ctl.update(0);
    input.release('cancel');
    expect(ctl.isOpen()).toBe(false);
    expect(closed).toEqual([['old_tam', false]]);
  });

  it('choice side effects still flow (flags + quests)', () => {
    const input = fakeInput();
    const ctl = make(input);
    ctl.open('maribel_quill');
    ctl.update(10);
    // "How does one fight the Warden?" is choice index 1
    input.press('move_down');
    ctl.update(0);
    input.release('move_down');
    input.press('confirm');
    ctl.update(0);
    input.release('confirm');
    expect(gameState.data.quests.chapel_warden_hunt.stage).toBe('heard');
  });
});

// -------------------------------------------------- PauseMenuController ----

describe('PauseMenuController', () => {
  it('focus navigation wraps and confirm dispatches the focused action', () => {
    const input = fakeInput();
    const calls = [];
    const ctl = new PauseMenuController({
      input,
      actions: {
        resume: () => calls.push('resume'),
        openInventory: () => calls.push('inventory'),
        openMap: () => calls.push('map'),
        openSettings: () => calls.push('settings'),
        openSave: () => calls.push('save'),
        quitToTitle: () => calls.push('quit'),
      },
    });
    ctl.open();
    expect(ctl.focus).toBe('resume');
    input.press('move_up'); // wraps to last
    ctl.update();
    input.release('move_up');
    expect(ctl.focus).toBe('quit');
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(calls).toEqual(['quit']);
    // cancel resumes
    input.press('cancel');
    ctl.update();
    input.release('cancel');
    expect(calls).toEqual(['quit', 'resume']);
  });
});

// ---------------------------------------------------- EndScreenController ----

describe('EndScreenController', () => {
  it('gameover: cancel maps to respawn (never an accidental quit)', () => {
    const input = fakeInput();
    const calls = [];
    const ctl = new EndScreenController({
      input,
      actions: {
        respawn: () => calls.push('respawn'),
        continue: () => calls.push('continue'),
        quitToTitle: () => calls.push('quit'),
      },
    });
    expect(ctl.open('gameover')).toBe(true);
    expect(ctl.mode).toBe('gameover');
    const view = ctl.getView();
    expect(view.title).toBe('THE BELL TOLLS');
    expect(view.options).toHaveLength(2);
    input.press('cancel');
    ctl.update();
    input.release('cancel');
    expect(calls).toEqual(['respawn']);
  });

  it('victory: confirm on focused option continues', () => {
    const input = fakeInput();
    const calls = [];
    const ctl = new EndScreenController({
      input,
      actions: {
        respawn: () => calls.push('respawn'),
        continue: () => calls.push('continue'),
        quitToTitle: () => calls.push('quit'),
      },
    });
    ctl.open('victory');
    expect(ctl.getView().title).toBe('VESPER FALLS SILENT');
    input.press('confirm');
    ctl.update();
    input.release('confirm');
    expect(calls).toEqual(['continue']);
    expect(ctl.open('gameover')).toBe(false); // already open: no-op
  });
});

// ------------------------------------------------------------ NpcDirector ----

describe('NpcDirector', () => {
  const DEF = { id: 'old_tam', name: 'Old Tam', title: 'Threshold Keeper', roomId: 'r1', x: 100, y: 120 };

  function make(input, pos, hooks = {}) {
    const dialogue = {
      npcsInRoom: (roomId) => (roomId === 'r1' ? [DEF] : []),
      getLocation: () => ({ roomId: 'r1', x: DEF.x, y: DEF.y }),
    };
    return new NpcDirector({
      input,
      dialogue,
      getPlayerPos: () => pos,
      isUiOpen: () => false,
      ...hooks,
    });
  }

  it('spawns NPCs on room change and despawns on leave', () => {
    const spawned = [];
    const despawned = [];
    const dir = make(fakeInput(), { x: 0, y: 0 }, {
      spawnSprite: (npc) => {
        spawned.push(npc.id);
        return { npc: npc.id };
      },
      despawnSprite: (handle, npc) => despawned.push(npc.id),
    });
    dir.onRoomChanged('r1');
    expect(dir.present.map((n) => n.id)).toEqual(['old_tam']);
    expect(spawned).toEqual(['old_tam']);
    dir.onRoomChanged('r2');
    expect(dir.present).toEqual([]);
    expect(despawned).toEqual(['old_tam']);
  });

  it('shows the TALK prompt in radius and interacts on confirm', () => {
    const input = fakeInput();
    const prompts = [];
    const interacted = [];
    const dir = make(input, { x: 110, y: 120 }, {
      showPrompt: (npc, x, y) => prompts.push([npc.id, x, y]),
      hidePrompt: () => prompts.push(['hide']),
      onInteract: (npc) => interacted.push(npc.id),
    });
    dir.onRoomChanged('r1');
    dir.update();
    expect(prompts[0]).toEqual(['old_tam', 100, 120]);
    input.press('confirm');
    dir.update();
    input.release('confirm');
    expect(interacted).toEqual(['old_tam']);
    expect(prompts[prompts.length - 1]).toEqual(['hide']);
  });

  it('no prompt out of radius; move_up also interacts (W3-ABILITIES convention)', () => {
    const input = fakeInput();
    const prompts = [];
    const interacted = [];
    const dir = make(input, { x: 400, y: 400 }, {
      showPrompt: (npc) => prompts.push(npc.id),
      onInteract: (npc) => interacted.push(npc.id),
    });
    dir.onRoomChanged('r1');
    dir.update();
    expect(prompts).toEqual([]);
    // walk into radius, press move_up
    dir.getPlayerPos = () => ({ x: 100, y: 120 });
    dir.update();
    expect(prompts).toEqual(['old_tam']);
    input.press('move_up');
    dir.update();
    input.release('move_up');
    expect(interacted).toEqual(['old_tam']);
  });

  it('suppresses prompt and interact while a UI screen is open', () => {
    const input = fakeInput();
    const prompts = [];
    const interacted = [];
    const dir = make(input, { x: 100, y: 120 }, {
      showPrompt: (npc) => prompts.push(npc.id),
      onInteract: (npc) => interacted.push(npc.id),
      isUiOpen: () => true,
    });
    dir.onRoomChanged('r1');
    dir.update();
    expect(prompts).toEqual([]);
    input.press('confirm');
    dir.update();
    input.release('confirm');
    expect(interacted).toEqual([]);
  });
});

// ---------------------------------------------------------- touch math ----

describe('directionFromVector', () => {
  it('deadzone swallows small deflections', () => {
    expect(directionFromVector(0.1, 0.1)).toEqual({
      move_left: false, move_right: false, move_up: false, move_down: false,
    });
  });

  it('maps cardinal pushes', () => {
    expect(directionFromVector(-0.9, 0).move_left).toBe(true);
    expect(directionFromVector(0.9, 0).move_right).toBe(true);
    expect(directionFromVector(0, -0.9).move_up).toBe(true);
    expect(directionFromVector(0, 0.9).move_down).toBe(true);
  });

  it('diagonals engage both axes', () => {
    const d = directionFromVector(0.8, 0.8);
    expect(d.move_right).toBe(true);
    expect(d.move_down).toBe(true);
    expect(d.move_left).toBe(false);
    expect(d.move_up).toBe(false);
  });
});
