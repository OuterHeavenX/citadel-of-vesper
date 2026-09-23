/**
 * InventoryController — full inventory screen state machine (Wave 5, W5-UI).
 *
 * Headless-safe: no Phaser import. Wraps InventoryManager, EquipmentManager,
 * Bestiary and the data registries; rendering is done by renderInventory()
 * below (duck-typed scene).
 *
 * CONTRACT (ARCHITECTURE §14 tabs):
 * - Tabs: STATUS | ITEMS | EQUIP | MAGIC | MAP | BESTIARY | SAVE | CONFIG.
 *   GameScene wraps open()/close() with UiStack so `ui:opened`/`ui:closed`
 *   { screen:'inventory' } drive the §14 pause ref-count (world frozen while
 *   open).
 * - update(): menu_tab_next/prev (or LB/RB) cycles tabs; move_up/move_down
 *   moves focus; move_left/move_right adjusts CONFIG sliders / cycles the
 *   quick-use item; confirm activates the focused row; cancel closes.
 * - ITEMS tab: confirm on a consumable uses it (through
 *   InventoryManager.useItem with the live Player for effective-max-HP
 *   heals); confirm on equippable gear equips it (EquipmentManager).
 * - EQUIP tab: rows are the 6 fixed slots; confirm unequips the focused slot.
 *   Focused rows in ITEMS/EQUIP show the EQUIPPED-vs-candidate stat compare
 *   (EquipmentManager.compareToEquipped).
 * - MAGIC tab: spells from data/abilities.json, unlocked vs learned state
 *   from gameState, selected spell marker.
 * - MAP tab: MapModel completion summary + "open the full chart" action
 *   (GameScene opens the real MapOverlay and closes this screen).
 * - BESTIARY tab: bestiary.getBestiary() rows; unseen entries are silhouettes.
 * - SAVE tab: slots 1-3 via the injected saveGame(slot) (GameScene writes
 *   through SaveManager).
 * - CONFIG tab: per-channel volume sliders (AudioManager), screen-shake /
 *   damage-number toggles, quick-use item cycler. Changes persist through
 *   the injected persistSettings() (GameScene -> gameState + SaveManager).
 * - getView() returns plain data for renderInventory().
 */
import { inputManager } from '../../core/InputManager.js';
import { gameState } from '../../core/GameState.js';
import { audioManager, Channels } from '../../core/AudioManager.js';
import { dataManager } from '../../core/DataManager.js';
import { mapModel } from '../../map/MapModel.js';
import { InventoryManager, inventoryManager } from '../../systems/InventoryManager.js';
import { EquipmentManager, equipmentManager } from '../../systems/EquipmentManager.js';
import { Bestiary, bestiary } from '../../systems/Bestiary.js';
import { getItemData } from '../../items/ItemData.js';
import {
  InkCss, drawGothicPanel, drawDivider, gothicText, panelHeader, formatDeltas,
} from '../gothic.js';

export const INVENTORY_TABS = Object.freeze([
  'status', 'items', 'equip', 'magic', 'map', 'bestiary', 'save', 'config',
]);

const TAB_LABELS = Object.freeze({
  status: 'STATUS', items: 'ITEMS', equip: 'EQUIP', magic: 'MAGIC',
  map: 'MAP', bestiary: 'BESTIARY', save: 'SAVE', config: 'CONFIG',
});

const SLOT_LABELS = Object.freeze({
  weapon: 'Weapon', offhand: 'Offhand', head: 'Head', body: 'Body',
  accessory1: 'Charm I', accessory2: 'Charm II',
});

const VISIBLE_ROWS = 8;

export class InventoryController {
  /**
   * @param {object} [deps]
   * @param {object} [deps.input] InputManager-like
   * @param {object} [deps.state] GameState singleton
   * @param {object} [deps.inventory] InventoryManager-like
   * @param {object} [deps.equipment] EquipmentManager-like
   * @param {object} [deps.bestiary] Bestiary-like
   * @param {object} [deps.audio] AudioManager-like
   * @param {Function} [deps.getPlayer] () -> Player facade | null (for useItem heals)
   * @param {Function} [deps.getStats] () -> { getDerived(), xpForNextLevel() } | null
   * @param {Function} [deps.saveGame] async (slot) -> { ok, error? }
   * @param {Function} [deps.openFullMap] () -> void (MAP tab action)
   * @param {Function} [deps.persistSettings] () -> void
   * @param {Function} [deps.onViewChanged] () -> void
   */
  constructor(deps = {}) {
    this.input = deps.input ?? inputManager;
    this.state = deps.state ?? gameState;
    this.inventory = deps.inventory ?? inventoryManager;
    this.equipment = deps.equipment ?? equipmentManager;
    this.bestiary = deps.bestiary ?? bestiary;
    this.audio = deps.audio ?? audioManager;
    this.getPlayer = deps.getPlayer ?? (() => null);
    this.getStats = deps.getStats ?? (() => null);
    this.saveGame = deps.saveGame ?? (async () => ({ ok: false, error: 'no save handler' }));
    this.openFullMap = deps.openFullMap ?? (() => {});
    this.persistSettings = deps.persistSettings ?? (() => {});
    this.onViewChanged = deps.onViewChanged ?? (() => {});
    this._items = getItemData();
    this._open = false;
    this._tab = 'items';
    this._focus = 0;
    this._message = '';
    this._saveBusy = false;
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  /** @returns {string} active tab id */
  get tab() {
    return this._tab;
  }

  /**
   * @param {string} [tab] initial tab
   * @returns {boolean} false when already open
   */
  open(tab = 'items') {
    if (this._open) return false;
    this._open = true;
    this._tab = INVENTORY_TABS.includes(tab) ? tab : 'items';
    this._focus = 0;
    this._message = '';
    this._notify();
    return true;
  }

  /** @returns {boolean} */
  close() {
    if (!this._open) return false;
    this._open = false;
    return true;
  }

  /** Switch to a tab (used by the pause menu's SETTINGS/SAVE shortcuts). */
  setTab(tab) {
    if (!INVENTORY_TABS.includes(tab)) return;
    this._tab = tab;
    this._focus = 0;
    this._message = '';
    this._notify();
  }

  // ------------------------------------------------------------ input ----

  /** Poll input. */
  update() {
    if (!this._open) return;
    const pressed = (a) => {
      try {
        return this.input.justPressed(a) === true;
      } catch {
        return false;
      }
    };
    if (pressed('cancel')) {
      this.close();
      return;
    }
    if (pressed('menu_tab_next')) {
      this._cycleTab(1);
      return;
    }
    if (pressed('menu_tab_prev')) {
      this._cycleTab(-1);
      return;
    }
    const rows = this._rowCount();
    let changed = false;
    if (pressed('move_up')) {
      this._focus = (this._focus + rows - 1) % Math.max(1, rows);
      changed = true;
    } else if (pressed('move_down')) {
      this._focus = (this._focus + 1) % Math.max(1, rows);
      changed = true;
    }
    if (pressed('move_left')) {
      if (this._adjust(-1)) return;
      changed = true;
    } else if (pressed('move_right')) {
      if (this._adjust(1)) return;
      changed = true;
    }
    if (pressed('confirm')) {
      this._activate();
      return;
    }
    if (changed) this._notify();
  }

  /** @private */
  _cycleTab(dir) {
    const i = INVENTORY_TABS.indexOf(this._tab);
    this._tab = INVENTORY_TABS[(i + dir + INVENTORY_TABS.length) % INVENTORY_TABS.length];
    this._focus = 0;
    this._message = '';
    this._notify();
  }

  /** @private left/right adjustments; true when the key was consumed */
  _adjust(dir) {
    if (this._tab === 'config') {
      this._adjustConfig(dir);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ rows -----

  /** @private number of focusable rows in the active tab */
  _rowCount() {
    switch (this._tab) {
      case 'items':
        return this.inventory.getInventory().length;
      case 'equip':
        return Object.keys(SLOT_LABELS).length;
      case 'magic':
        return this._spellRows().length;
      case 'map':
        return 1;
      case 'bestiary':
        return this.bestiary.getBestiary().length;
      case 'save':
        return 3;
      case 'config':
        return this._configRows().length;
      default:
        return 0; // status: no rows
    }
  }

  /** @private */
  _spellRows() {
    const learned = new Set(this.state.data.player.spells ?? []);
    const selected = this.state.data.player.selectedSpell ?? null;
    return dataManager
      .getData('abilities')
      .filter((a) => a.kind === 'spell')
      .map((a) => ({
        id: a.id,
        name: a.name,
        unlocked: learned.has(a.id),
        selected: selected === a.id,
        mpCost: a.mpCost ?? 0,
        description: a.description ?? '',
        element: a.element ?? '',
      }));
  }

  /** @private config rows (sliders + toggles + quick-use cycler) */
  _configRows() {
    const s = this.state.data.settings ?? {};
    let volumes = {};
    try {
      volumes = this.audio.getVolumes() ?? {};
    } catch {
      volumes = {};
    }
    const rows = [
      { id: 'music', label: 'Music', kind: 'slider', value: volumes.music ?? s.musicVolume ?? 0.8 },
      { id: 'ambience', label: 'Ambience', kind: 'slider', value: volumes.ambience ?? s.ambienceVolume ?? 0.8 },
      { id: 'sfx', label: 'Effects', kind: 'slider', value: volumes.player ?? s.sfxVolume ?? 0.8 },
      { id: 'screenShake', label: 'Screen shake', kind: 'toggle', value: s.screenShake !== false },
      { id: 'damageNumbers', label: 'Damage numbers', kind: 'toggle', value: s.damageNumbers !== false },
      { id: 'quickUse', label: 'Quick use', kind: 'cycler', value: this._quickUseId() },
    ];
    return rows;
  }

  /** @private */
  _quickUseId() {
    return this.state.data.settings?.quickUseItemId ?? 'ember_tonic';
  }

  /** @private */
  _adjustConfig(dir) {
    const rows = this._configRows();
    const row = rows[this._focus];
    if (!row) return;
    const s = this.state.data.settings ?? {};
    if (row.kind === 'slider') {
      const v = Math.round(Math.min(1, Math.max(0, row.value + dir * 0.1)) * 10) / 10;
      if (row.id === 'music') {
        this._setChannelVolume('music', v);
        this.state.updateSettings({ musicVolume: v });
      } else if (row.id === 'ambience') {
        this._setChannelVolume('ambience', v);
        this.state.updateSettings({ ambienceVolume: v });
      } else {
        for (const ch of ['player', 'enemies', 'weapons', 'environment', 'ui']) {
          this._setChannelVolume(ch, v);
        }
        this.state.updateSettings({ sfxVolume: v });
      }
      this.persistSettings();
    } else if (row.kind === 'toggle') {
      const next = !row.value;
      this.state.updateSettings({ [row.id]: next });
      this.persistSettings();
    } else if (row.kind === 'cycler') {
      const consumables = this.inventory.getConsumables();
      if (!consumables.length) {
        this._message = 'No consumables held.';
      } else {
        const ids = consumables.map((c) => c.item.id);
        const cur = ids.indexOf(this._quickUseId());
        const next = ids[(cur + dir + ids.length) % ids.length];
        this.state.updateSettings({ quickUseItemId: next });
        this.persistSettings();
        this._message = `Quick use: ${this._items.get(next).name}.`;
      }
    }
    this._notify();
  }

  /** @private */
  _setChannelVolume(channel, v) {
    try {
      this.audio.setVolume(channel, v);
    } catch {
      /* unknown channel — ignore */
    }
  }

  /** @private confirm on the focused row */
  _activate() {
    switch (this._tab) {
      case 'items':
        this._activateItem();
        break;
      case 'equip':
        this._activateSlot();
        break;
      case 'magic':
        this._activateSpell();
        break;
      case 'map':
        this.openFullMap();
        break;
      case 'save':
        void this._activateSave();
        break;
      case 'config': {
        const row = this._configRows()[this._focus];
        if (row?.kind === 'toggle') this._adjustConfig(1);
        break;
      }
      default:
        break;
    }
  }

  /** @private */
  _activateItem() {
    const rows = this.inventory.getInventory();
    const row = rows[this._focus];
    if (!row) return;
    const def = row.item;
    if (def.category === 'consumable') {
      const res = this.inventory.useItem(def.id, { player: this.getPlayer() });
      this._message = res.ok
        ? `Used ${def.name}.`
        : `Cannot use ${def.name}: ${res.reason ?? 'unknown'}.`;
    } else if (this.equipment.resolveSlot(def.id)) {
      const res = this.equipment.equip(def.id);
      this._message = res.ok
        ? `Equipped ${def.name}.`
        : `Cannot equip ${def.name}: ${res.reason ?? 'unknown'}.`;
    } else {
      this._message = `${def.name}: ${def.description ?? 'no use here'}`;
    }
    this._focus = Math.min(this._focus, Math.max(0, this.inventory.getInventory().length - 1));
    this._notify();
  }

  /** @private */
  _activateSlot() {
    const slots = Object.keys(SLOT_LABELS);
    const slot = slots[this._focus];
    if (!slot) return;
    const res = this.equipment.unequip(slot);
    this._message = res.ok
      ? `Unequipped ${this._items.get(res.itemId).name}.`
      : 'Nothing worn there.';
    this._notify();
  }

  /** @private */
  _activateSpell() {
    const rows = this._spellRows();
    const row = rows[this._focus];
    if (!row || !row.unlocked) return;
    this.state.data.player.selectedSpell = row.id;
    this.state.dirty = true;
    this._message = `${row.name} readied.`;
    this._notify();
  }

  /** @private */
  async _activateSave() {
    if (this._saveBusy) return;
    const slot = this._focus + 1;
    this._saveBusy = true;
    this._message = `Writing slot ${slot}…`;
    this._notify();
    let res;
    try {
      res = await this.saveGame(slot);
    } catch {
      res = { ok: false, error: 'save failed' };
    }
    this._saveBusy = false;
    this._message = res?.ok ? `Chronicle sealed in slot ${slot}.` : `Save failed: ${res?.error ?? 'unknown'}.`;
    this._notify();
  }

  // ------------------------------------------------------------ view -----

  /**
   * @returns {object|null} plain view data for renderInventory()
   */
  getView() {
    if (!this._open) return null;
    const p = this.state.data.player;
    const view = {
      tab: this._tab,
      tabs: INVENTORY_TABS.map((t) => ({ id: t, label: TAB_LABELS[t] })),
      currency: this.state.data.currency ?? 0,
      focus: this._focus,
      message: this._message,
    };
    switch (this._tab) {
      case 'status':
        view.status = this._statusView(p);
        break;
      case 'items':
        view.items = this._itemsView();
        break;
      case 'equip':
        view.equip = this._equipView();
        break;
      case 'magic':
        view.magic = { rows: this._spellRows() };
        break;
      case 'map':
        view.map = this._mapView();
        break;
      case 'bestiary':
        view.bestiary = { rows: this.bestiary.getBestiary() };
        break;
      case 'save':
        view.save = { slots: [1, 2, 3] };
        break;
      case 'config':
        view.config = { rows: this._configRows() };
        break;
      default:
        break;
    }
    return view;
  }

  /** @private */
  _statusView(p) {
    const stats = this.getStats();
    let derived = {};
    let xpNext = null;
    try {
      derived = stats?.getDerived?.() ?? {};
      xpNext = stats?.xpForNextLevel?.() ?? null;
    } catch {
      /* headless without stats */
    }
    return {
      name: p.name ?? 'Lucien Vale',
      level: p.level ?? 1,
      xp: p.xp ?? 0,
      xpNext,
      hp: p.hp ?? 0,
      maxHp: p.maxHp ?? 1,
      mp: p.mp ?? 0,
      maxMp: p.maxMp ?? 1,
      base: { ...(p.stats ?? {}) },
      derived: {
        physicalAttack: derived.physicalAttack ?? 0,
        magicAttack: derived.magicAttack ?? 0,
        defense: derived.defense ?? 0,
        magicDefense: derived.magicDefense ?? 0,
        critChance: derived.critChance ?? 0,
        attackSpeed: derived.attackSpeed ?? 0,
        moveSpeed: derived.moveSpeed ?? 0,
      },
      buffs: (this.state.data.buffs ?? []).map((b) => b.name ?? b.id),
    };
  }

  /** @private */
  _itemsView() {
    const rows = this.inventory.getInventory().map(({ item, quantity }) => {
      const cmp = this.equipment.resolveSlot(item.id)
        ? this.equipment.compareToEquipped(item.id)
        : null;
      return {
        itemId: item.id,
        name: item.name,
        quantity,
        category: item.category,
        rarity: item.rarity ?? 'common',
        description: item.description ?? '',
        usable: item.category === 'consumable',
        equippable: !!this.equipment.resolveSlot(item.id),
        compare: cmp?.ok ? cmp : null,
      };
    });
    return { rows };
  }

  /** @private */
  _equipView() {
    const equipped = this.equipment.getEquipped();
    const slots = Object.keys(SLOT_LABELS).map((slot) => {
      const def = equipped[slot] ?? null;
      return {
        slot,
        label: SLOT_LABELS[slot],
        itemId: def?.id ?? null,
        name: def?.name ?? '— empty —',
        stats: def?.stats ?? {},
      };
    });
    // compare for the focused slot's item vs nothing is meaningless; the
    // ITEMS tab carries the compare view. Show focused slot stats instead.
    return { slots };
  }

  /** @private */
  _mapView() {
    let completion = 0;
    let discovered = [];
    try {
      completion = mapModel.getCompletion();
      discovered = mapModel.getDiscoveredRooms?.() ?? [];
    } catch {
      /* headless without map model */
    }
    const regions = {};
    for (const id of this.state.data.map?.discovered ?? []) {
      const region = dataManager.getRoom(id)?.region ?? 'unknown';
      regions[region] = (regions[region] ?? 0) + 1;
    }
    return {
      completion: Math.round(completion),
      discovered: discovered.length || (this.state.data.map?.discovered ?? []).length,
      regions: Object.entries(regions).map(([region, count]) => ({ region, count })),
    };
  }

  /** @private */
  _notify() {
    try {
      this.onViewChanged();
    } catch {
      /* render hook must never break the screen */
    }
  }
}

/**
 * Render the inventory screen (duck-typed scene; no Phaser import).
 * Layout (480x270): left vertical tab rail, right content panel, bottom
 * message/hint line. Original gothic styling via src/ui/gothic.js.
 * @param {object} scene Phaser Scene (duck-typed)
 * @param {object} view getView() output
 * @returns {object} container
 */
export function renderInventory(scene, view) {
  const W = 480;
  const H = 270;
  const pw = 436;
  const ph = 240;
  const px = (W - pw) / 2;
  const py = (H - ph) / 2;
  const root = scene.add.container(0, 0).setDepth(1600).setScrollFactor(0);
  const g = scene.add.graphics();
  drawGothicPanel(g, px, py, pw, ph);
  root.add(g);

  const railW = 92;
  const cx = px + railW + 10;
  const cw = pw - railW - 26;

  // tab rail
  view.tabs.forEach((t, i) => {
    const active = t.id === view.tab;
    const ty = py + 26 + i * 22;
    if (active) {
      const hg = scene.add.graphics();
      hg.fillStyle(0x2a2140, 0.95);
      hg.fillRect(px + 10, ty - 3, railW - 8, 19);
      root.add(hg);
    }
    const tt = gothicText(scene, px + 18, ty, t.label, {
      size: '9px',
      color: active ? InkCss.goldBright : InkCss.dim,
      spacing: 1,
    });
    root.add(tt);
  });
  const coin = gothicText(scene, px + pw - 16, py + 8, `◈ ${view.currency}`, {
    size: '9px',
    color: InkCss.gold,
    mono: true,
  });
  coin.setOrigin(1, 0);
  root.add(coin);
  const title = gothicText(scene, cx, py + 8, TAB_LABELS[view.tab] ?? view.tab, {
    size: '11px',
    color: InkCss.gold,
    spacing: 3,
  });
  root.add(title);
  drawDivider(g, cx, py + 26, cw);

  const bodyY = py + 34;
  const bodyH = ph - 34 - 30;
  renderTabBody(scene, root, view, cx, bodyY, cw, bodyH);

  if (view.message) {
    const mt = gothicText(scene, px + pw / 2, py + ph - 24, view.message, {
      size: '9px',
      color: InkCss.gold,
    });
    mt.setOrigin(0.5, 0);
    root.add(mt);
  }
  const hint = gothicText(scene, px + pw / 2, py + ph - 12, '↑↓ select · ←→ adjust · Q/E or LB/RB tabs · confirm act · cancel close', {
    size: '7px',
    color: InkCss.faint,
    mono: true,
  });
  hint.setOrigin(0.5, 0);
  root.add(hint);
  return root;
}

/** @private render the active tab's body */
function renderTabBody(scene, root, view, cx, y, cw, h) {
  const start = Math.max(0, Math.min(view.focus - 3, 99));
  const line = (i, focused) => {
    if (focused) {
      const hg = scene.add.graphics();
      hg.fillStyle(0x2a2140, 0.9);
      hg.fillRect(cx - 4, y + i * 16 - 2, cw + 8, 16);
      root.add(hg);
    }
  };
  const row = (i, left, right, { leftColor = InkCss.ink, rightColor = InkCss.dim } = {}) => {
    line(i, i + start === view.focus);
    const lt = gothicText(scene, cx + 4, y + i * 16, left, { size: '9px', color: leftColor });
    root.add(lt);
    if (right != null) {
      const rt = gothicText(scene, cx + cw - 4, y + i * 16, right, {
        size: '9px',
        color: rightColor,
        mono: true,
      });
      rt.setOrigin(1, 0);
      root.add(rt);
    }
  };

  switch (view.tab) {
    case 'status': {
      const s = view.status;
      const rows = [
        [`${s.name}`, `Lv ${s.level}`],
        [`HP  ${s.hp} / ${s.maxHp}`, ''],
        [`MP  ${s.mp} / ${s.maxMp}`, ''],
        [`XP  ${s.xp}${s.xpNext != null ? ` / ${s.xpNext}` : ''}`, ''],
        ['', ''],
        [`Attack  ${s.derived.physicalAttack}`, `Magic  ${s.derived.magicAttack}`],
        [`Defense  ${s.derived.defense}`, `M.Def  ${s.derived.magicDefense}`],
        [`Crit  ${Math.round((s.derived.critChance ?? 0) * 100)}%`, `Speed  ${s.derived.attackSpeed ?? 0}`],
      ];
      rows.forEach(([l, r], i) => row(i, l, r || null));
      if (s.buffs.length) {
        const bt = gothicText(scene, cx + 4, y + rows.length * 16 + 4, `Blessed: ${s.buffs.join(', ')}`, {
          size: '8px',
          color: InkCss.xp,
          wrap: cw - 8,
        });
        root.add(bt);
      }
      break;
    }
    case 'items': {
      const rows = view.items.rows;
      if (!rows.length) {
        const t = gothicText(scene, cx + 4, y, 'Empty pockets. The Citadel provides… eventually.', {
          size: '9px',
          color: InkCss.dim,
          wrap: cw - 8,
        });
        root.add(t);
        break;
      }
      for (let i = 0; i < VISIBLE_ROWS; i++) {
        const r = rows[start + i];
        if (!r) break;
        const tag = r.usable ? '[use]' : r.equippable ? '[equip]' : '';
        row(i, `${i + start === view.focus ? '❖ ' : '  '}${r.name} ×${r.quantity}`, tag, {
          leftColor: i + start === view.focus ? InkCss.goldBright : InkCss.ink,
        });
      }
      // compare strip for the focused row
      const f = rows[view.focus];
      if (f?.compare) {
        const parts = [];
        if (f.compare.atkDelta) parts.push(`${f.compare.atkDelta > 0 ? '+' : ''}${f.compare.atkDelta} atk`);
        for (const d of formatDeltas(f.compare.statDeltas)) parts.push(d.text);
        for (const d of formatDeltas(f.compare.resistanceDeltas)) parts.push(d.text);
        const eqName = f.compare.equippedId ? `vs ${f.compare.equippedId}` : 'vs nothing worn';
        const ct = gothicText(scene, cx + 4, y + VISIBLE_ROWS * 16 + 6,
          `${eqName}: ${parts.length ? parts.join('   ') : 'no change'}`, {
            size: '8px',
            color: InkCss.dim,
            wrap: cw - 8,
          });
        root.add(ct);
      } else if (f) {
        const dt = gothicText(scene, cx + 4, y + VISIBLE_ROWS * 16 + 6, f.description, {
          size: '8px',
          color: InkCss.dim,
          wrap: cw - 8,
        });
        root.add(dt);
      }
      break;
    }
    case 'equip': {
      view.equip.slots.forEach((s, i) => {
        const statBits = Object.entries(s.stats ?? {})
          .map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`)
          .join(' ');
        row(i, `${i === view.focus ? '❖ ' : '  '}${s.label}`, null, {
          leftColor: i === view.focus ? InkCss.goldBright : InkCss.ink,
        });
        const nt = gothicText(scene, cx + 96, y + i * 16, `${s.name}${statBits ? `  (${statBits})` : ''}`, {
          size: '8px',
          color: s.itemId ? InkCss.dim : InkCss.faint,
        });
        root.add(nt);
      });
      const et = gothicText(scene, cx + 4, y + 6 * 16 + 8, 'Confirm on a worn relic to return it to your pack.', {
        size: '8px',
        color: InkCss.faint,
        wrap: cw - 8,
      });
      root.add(et);
      break;
    }
    case 'magic': {
      const rows = view.magic.rows;
      for (let i = 0; i < VISIBLE_ROWS; i++) {
        const r = rows[start + i];
        if (!r) break;
        const mark = r.selected ? ' ◆' : '';
        row(i, `${i + start === view.focus ? '❖ ' : '  '}${r.unlocked ? r.name : '???'}${mark}`,
          r.unlocked ? `${r.mpCost} MP` : null, {
            leftColor: !r.unlocked ? InkCss.faint : (i + start === view.focus ? InkCss.goldBright : InkCss.ink),
          });
      }
      const f = rows[view.focus];
      if (f?.unlocked) {
        const dt = gothicText(scene, cx + 4, y + VISIBLE_ROWS * 16 + 6, f.description, {
          size: '8px',
          color: InkCss.dim,
          wrap: cw - 8,
        });
        root.add(dt);
      }
      break;
    }
    case 'map': {
      const m = view.map;
      row(0, 'Chart completion', `${m.completion}%`);
      row(1, 'Chambers mapped', `${m.discovered}`);
      m.regions.slice(0, 4).forEach((r, i) => row(2 + i, r.region.replace(/_/g, ' '), `${r.count}`));
      const t = gothicText(scene, cx + 4, y + 6 * 16 + 8, '❖ Open the full chart', {
        size: '9px',
        color: view.focus === 0 ? InkCss.goldBright : InkCss.ink,
      });
      root.add(t);
      break;
    }
    case 'bestiary': {
      const rows = view.bestiary.rows;
      for (let i = 0; i < VISIBLE_ROWS; i++) {
        const r = rows[start + i];
        if (!r) break;
        const label = r.seen ? r.name : '???';
        const right = r.seen && r.kills > 0 ? `slain ×${r.kills}` : null;
        row(i, `${i + start === view.focus ? '❖ ' : '  '}${label}`, right, {
          leftColor: !r.seen ? InkCss.faint : (i + start === view.focus ? InkCss.goldBright : InkCss.ink),
        });
      }
      const f = rows[view.focus];
      if (f?.seen && f.lore) {
        const lt = gothicText(scene, cx + 4, y + VISIBLE_ROWS * 16 + 6,
          `${f.title ? f.title + ' — ' : ''}${f.lore}`, {
            size: '8px',
            color: InkCss.dim,
            wrap: cw - 8,
          });
        root.add(lt);
      } else if (f && !f.seen) {
        const lt = gothicText(scene, cx + 4, y + VISIBLE_ROWS * 16 + 6,
          'No chronicle yet. Cross blades with it and live.', {
            size: '8px',
            color: InkCss.faint,
            wrap: cw - 8,
          });
        root.add(lt);
      }
      break;
    }
    case 'save': {
      for (let i = 0; i < 3; i++) {
        row(i, `${i === view.focus ? '❖ ' : '  '}Chronicle ${i + 1}`, null, {
          leftColor: i === view.focus ? InkCss.goldBright : InkCss.ink,
        });
      }
      const t = gothicText(scene, cx + 4, y + 3 * 16 + 8,
        'Confirm seals your journey into a chronicle slot.', {
          size: '8px',
          color: InkCss.faint,
          wrap: cw - 8,
        });
      root.add(t);
      break;
    }
    case 'config': {
      const rows = view.config.rows;
      rows.forEach((r, i) => {
        let right;
        if (r.kind === 'slider') {
          const filled = Math.round(r.value * 10);
          right = `[${'◆'.repeat(filled)}${'◇'.repeat(10 - filled)}]`;
        } else if (r.kind === 'toggle') {
          right = r.value ? 'on' : 'off';
        } else {
          try {
            right = getItemData().get(r.value).name;
          } catch {
            right = r.value;
          }
        }
        row(i, `${i === view.focus ? '❖ ' : '  '}${r.label}`, right, {
          leftColor: i === view.focus ? InkCss.goldBright : InkCss.ink,
          rightColor: r.kind === 'toggle' && !r.value ? InkCss.faint : InkCss.dim,
        });
      });
      break;
    }
    default:
      break;
  }
}
