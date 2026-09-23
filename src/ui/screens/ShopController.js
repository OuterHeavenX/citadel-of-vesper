/**
 * ShopController — merchant buy/sell UI state machine (Wave 5, W5-UI).
 *
 * Headless-safe: no Phaser import. Wraps the Merchant model (Wave 4) and
 * adds presentation state: buy/sell tabs, focus navigation, compare data,
 * transient result messages. Rendering is done by renderShop() below,
 * duck-typed against the scene.
 *
 * CONTRACT:
 * - open(merchantId): builds the stock view; GameScene wraps it with UiStack
 *   so `ui:opened`/`ui:closed` { screen:'shop' } drive the §14 pause ref-count.
 * - update(): polls the injected input:
 *     move_up/move_down -> focus line
 *     menu_tab_next/menu_tab_prev (or move_left/move_right) -> buy/sell tabs
 *     confirm -> buy (buy tab) / sell (sell tab) the focused line
 *     cancel -> close
 * - Locked (flag-gated) lines render as silhouettes ("??? — sealed") and
 *   cannot be bought. Finite stock shows remaining counts; sold-out lines
 *   cannot be bought. Sell-back prices use tuning.economy.sellRate via
 *   Merchant.sellPrice(). Soulbound/equipped items are refused with reasons.
 * - getView() returns plain data for renderShop().
 */
import { inputManager } from '../../core/InputManager.js';
import { gameState } from '../../core/GameState.js';
import { getItemData } from '../../items/ItemData.js';
import { Merchant } from '../../npcs/Merchant.js';
import { InkCss, drawGothicPanel, drawDivider, gothicText, panelHeader, formatDeltas } from '../gothic.js';

/** Categories that can never be sold (mirrors Merchant's soulbound set). */
const SOULBOUND = new Set(['quest', 'relic', 'key']);

/** Reason code -> gothic-flavored player-facing message. */
export const SHOP_MESSAGES = Object.freeze({
  ok_bought: (name, price) => `Purchased ${name} — ${price} coin.`,
  ok_sold: (name, price) => `Sold ${name} — ${price} coin.`,
  insufficient_funds: () => 'Not enough coin.',
  sold_out: () => 'That line is sold out.',
  locked: () => 'Sealed. Some deed not yet done bars this ware.',
  not_in_stock: () => 'Not in stock.',
  soulbound: () => 'That cannot be parted with.',
  equipped: () => 'It is worn — unequip it first.',
  none_held: () => 'None held.',
  unknown_item: () => 'Unknown ware.',
});

export class ShopController {
  /**
   * @param {object} [deps]
   * @param {object} [deps.input] InputManager-like
   * @param {object} [deps.state] GameState singleton (injectable for tests)
   * @param {Function} [deps.onViewChanged] () -> void (re-render hook)
   */
  constructor(deps = {}) {
    this.input = deps.input ?? inputManager;
    this.state = deps.state ?? gameState;
    this.onViewChanged = deps.onViewChanged ?? (() => {});
    this._items = getItemData();
    this._merchant = null;
    this._open = false;
    this._mode = 'buy'; // 'buy' | 'sell'
    this._focus = 0;
    this._message = '';
    this._rows = [];
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  /** @returns {Merchant|null} */
  get merchant() {
    return this._merchant;
  }

  /** @returns {'buy'|'sell'} */
  get mode() {
    return this._mode;
  }

  /**
   * @param {string} merchantId id in data/merchants.json
   * @returns {boolean} false when already open
   */
  open(merchantId) {
    if (this._open) return false;
    this._merchant = new Merchant(merchantId, { state: this.state });
    this._open = true;
    this._mode = 'buy';
    this._focus = 0;
    this._message = '';
    this._rebuildRows();
    this._notify();
    return true;
  }

  /** Close the shop. @returns {boolean} */
  close() {
    if (!this._open) return false;
    this._open = false;
    this._merchant = null;
    this._rows = [];
    return true;
  }

  /** @private rebuild the focused row list for the current tab */
  _rebuildRows() {
    if (!this._merchant) {
      this._rows = [];
      return;
    }
    if (this._mode === 'buy') {
      this._rows = this._merchant.getStock().map((line) => ({
        kind: 'buy',
        itemId: line.itemId,
        name: line.locked ? '???' : line.item.name,
        price: line.price,
        quantity: line.quantity, // null = unlimited
        locked: line.locked,
        soldOut: line.quantity === 0,
        item: line.item,
      }));
    } else {
      const equipped = new Set(
        Object.values(this.state.data.equipment ?? {}).filter(Boolean)
      );
      this._rows = this.state.data.inventory
        .filter((e) => {
          let def;
          try {
            def = this._items.get(e.itemId);
          } catch {
            return false;
          }
          return !SOULBOUND.has(def.category) && e.quantity > 0;
        })
        .map((e) => {
          const def = this._items.get(e.itemId);
          return {
            kind: 'sell',
            itemId: e.itemId,
            name: def.name,
            price: this._merchant.sellPrice(e.itemId),
            quantity: e.quantity,
            locked: false,
            soldOut: false,
            equipped: equipped.has(e.itemId),
            item: def,
          };
        });
    }
    if (this._focus >= this._rows.length) this._focus = Math.max(0, this._rows.length - 1);
  }

  /** @private */
  _setMode(mode) {
    if (this._mode === mode) return;
    this._mode = mode;
    this._focus = 0;
    this._message = '';
    this._rebuildRows();
    this._notify();
  }

  /** @private execute the focused line */
  _activate() {
    const row = this._rows[this._focus];
    if (!row) return;
    let result;
    if (row.kind === 'buy') {
      result = this._merchant.buy(row.itemId);
      if (result.ok) {
        this._message = SHOP_MESSAGES.ok_bought(row.name, result.price);
      } else {
        this._message = (SHOP_MESSAGES[result.reason] ?? SHOP_MESSAGES.unknown_item)();
      }
    } else {
      result = this._merchant.sell(row.itemId);
      if (result.ok) {
        this._message = SHOP_MESSAGES.ok_sold(row.name, result.price);
      } else {
        this._message = (SHOP_MESSAGES[result.reason] ?? SHOP_MESSAGES.unknown_item)();
      }
    }
    this._rebuildRows(); // stock counts / currency changed
    this._notify();
  }

  /** Poll input. @returns {boolean} true when the shop closed itself */
  update() {
    if (!this._open) return false;
    const pressed = (a) => {
      try {
        return this.input.justPressed(a) === true;
      } catch {
        return false;
      }
    };
    if (pressed('cancel')) {
      this.close();
      return true;
    }
    let changed = false;
    if (pressed('move_up')) {
      this._focus = (this._focus + this._rows.length - 1) % Math.max(1, this._rows.length);
      changed = true;
    } else if (pressed('move_down')) {
      this._focus = (this._focus + 1) % Math.max(1, this._rows.length);
      changed = true;
    }
    if (pressed('menu_tab_next') || pressed('move_right')) {
      this._setMode(this._mode === 'buy' ? 'sell' : 'buy');
      return false;
    }
    if (pressed('menu_tab_prev') || pressed('move_left')) {
      this._setMode(this._mode === 'buy' ? 'sell' : 'buy');
      return false;
    }
    if (pressed('confirm')) this._activate();
    else if (changed) this._notify();
    return false;
  }

  /**
   * @returns {object|null} plain view data for renderShop()
   */
  getView() {
    if (!this._open || !this._merchant) return null;
    const focus = this._rows[this._focus] ?? null;
    let compare = null;
    if (focus && !focus.locked && focus.item) {
      try {
        const c = this._merchant.compare(focus.itemId);
        if (c.ok) compare = c;
      } catch {
        compare = null;
      }
    }
    return {
      merchantName: this._merchant.name,
      merchantTitle: this._merchant.def.title ?? '',
      flavor: this._merchant.def.flavor ?? '',
      mode: this._mode,
      currency: this.state.data.currency ?? 0,
      rows: this._rows.map((r) => ({
        itemId: r.itemId,
        name: r.name,
        price: r.price,
        quantity: r.quantity,
        locked: r.locked,
        soldOut: r.soldOut,
        equipped: !!r.equipped,
        rarity: r.item?.rarity ?? 'common',
      })),
      focus: this._focus,
      compare,
      compareName: focus && !focus.locked ? focus.name : null,
      message: this._message,
    };
  }

  /** @private */
  _notify() {
    try {
      this.onViewChanged();
    } catch {
      /* render hook must never break the shop */
    }
  }
}

/**
 * Render the shop (duck-typed scene; no Phaser import).
 * @param {object} scene Phaser Scene (duck-typed)
 * @param {object} view getView() output
 * @returns {object} container
 */
export function renderShop(scene, view) {
  const W = 480;
  const H = 270;
  const pw = 420;
  const ph = 230;
  const px = (W - pw) / 2;
  const py = (H - ph) / 2;
  const root = scene.add.container(0, 0).setDepth(1600).setScrollFactor(0);
  const g = scene.add.graphics();
  drawGothicPanel(g, px, py, pw, ph);
  root.add(g);

  let y = panelHeader(g, scene, px, py + 6, pw, view.merchantName.toUpperCase());
  const sub = gothicText(scene, px + pw / 2, y - 4, view.merchantTitle, {
    size: '8px',
    color: InkCss.dim,
  });
  sub.setOrigin(0.5, 0);
  root.add(sub);
  y += 10;

  // buy/sell tabs
  const tabs = ['buy', 'sell'];
  tabs.forEach((t, i) => {
    const active = view.mode === t;
    const tx = px + 20 + i * 70;
    const label = `${t.toUpperCase()}${t === 'sell' ? ' ◈' : ''}`;
    const tt = gothicText(scene, tx, y, label, {
      size: '10px',
      color: active ? InkCss.goldBright : InkCss.dim,
      spacing: 2,
    });
    if (active) {
      const ug = scene.add.graphics();
      ug.lineStyle(1, 0xc9a227, 1);
      ug.lineBetween(tx, y + 13, tx + tt.width, y + 13);
      root.add(ug);
    }
    root.add(tt);
  });
  const coin = gothicText(scene, px + pw - 20, y, `◈ ${view.currency}`, {
    size: '10px',
    color: InkCss.gold,
    mono: true,
  });
  coin.setOrigin(1, 0);
  root.add(coin);
  y += 20;
  drawDivider(g, px + 16, y, pw - 32);
  y += 8;

  // rows (scroll window of 7)
  const ROW_H = 17;
  const VISIBLE = 7;
  const start = Math.max(0, Math.min(view.focus - 3, view.rows.length - VISIBLE));
  const listH = VISIBLE * ROW_H;
  for (let i = 0; i < VISIBLE; i++) {
    const row = view.rows[start + i];
    if (!row) break;
    const ry = y + i * ROW_H;
    const focused = start + i === view.focus;
    if (focused) {
      const hg = scene.add.graphics();
      hg.fillStyle(0x2a2140, 0.9);
      hg.fillRect(px + 14, ry - 2, pw - 28, ROW_H);
      root.add(hg);
    }
    const cursor = focused ? '❖ ' : '  ';
    const nameColor = row.locked ? InkCss.faint : focused ? InkCss.goldBright : InkCss.ink;
    const rt = gothicText(scene, px + 20, ry, `${cursor}${row.name}`, {
      size: '9px',
      color: nameColor,
    });
    root.add(rt);
    let detail;
    if (row.locked) {
      detail = 'sealed';
    } else if (view.mode === 'buy') {
      detail = row.soldOut ? 'sold out' : row.quantity == null ? `${row.price} ◈` : `${row.price} ◈ ×${row.quantity}`;
    } else {
      detail = `${row.price} ◈ ×${row.quantity}${row.equipped ? ' (worn)' : ''}`;
    }
    const dt = gothicText(scene, px + pw - 20, ry, detail, {
      size: '9px',
      color: row.locked ? InkCss.faint : InkCss.dim,
      mono: true,
    });
    dt.setOrigin(1, 0);
    root.add(dt);
  }
  y += listH + 6;

  // compare strip
  const cmp = view.compare;
  if (cmp && view.compareName) {
    const parts = [];
    if (cmp.atkDelta) parts.push({ text: `${cmp.atkDelta > 0 ? '+' : ''}${cmp.atkDelta} atk`, positive: cmp.atkDelta > 0 });
    for (const d of formatDeltas(cmp.statDeltas)) parts.push(d);
    for (const d of formatDeltas(cmp.resistanceDeltas)) parts.push(d);
    const eqName = cmp.equippedId ?? '(nothing worn)';
    const line = parts.length
      ? parts.map((p) => p.text).join('   ')
      : 'no stat change';
    const ct = gothicText(scene, px + 20, y, `vs ${eqName}: ${line}`, {
      size: '8px',
      color: InkCss.dim,
      wrap: pw - 40,
    });
    root.add(ct);
    y += 14;
  }

  // message line
  if (view.message) {
    const mt = gothicText(scene, px + pw / 2, py + ph - 24, view.message, {
      size: '9px',
      color: InkCss.gold,
    });
    mt.setOrigin(0.5, 0);
    root.add(mt);
  }
  const hint = gothicText(scene, px + pw / 2, py + ph - 12, '↑↓ browse · ←→ buy/sell · confirm trade · cancel leave', {
    size: '7px',
    color: InkCss.faint,
    mono: true,
  });
  hint.setOrigin(0.5, 0);
  root.add(hint);
  return root;
}
