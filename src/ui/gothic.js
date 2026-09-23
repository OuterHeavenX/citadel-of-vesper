/**
 * gothic — shared ORIGINAL gothic visual language for Wave 5 UI screens.
 *
 * Headless-safe: no `import 'phaser'` here. Every helper takes a duck-typed
 * scene/graphics/text object, so these run against the real Phaser scene in
 * the game and against fakes in node tests.
 *
 * Signature look (original design, not imitating any commercial game):
 *   - near-black plum panels (#100c18) with a double gold border and small
 *     corner diamonds
 *   - serif display text (Georgia) in bone-ink, gold for headers, blood-red
 *     for danger, dim violet for secondary text
 *   - thin divider rules between sections
 */
export const GOTHIC_FONT = "Georgia, 'Times New Roman', serif";
export const GOTHIC_MONO = "'Courier New', monospace";

export const Ink = Object.freeze({
  panel: 0x100c18,
  panelSoft: 0x171224,
  gold: 0xc9a227,
  goldBright: 0xe8c95a,
  ink: '#d8d4e8',
  dim: '#6a6488',
  faint: '#453f5e',
  blood: '#a8353f',
  bloodDim: '#6e2430',
  mana: '#4a6ea8',
  xp: '#7a9e4a',
  poison: '#5a8e3c',
});

/** CSS hex strings for the palette (Phaser text wants '#rrggbb'). */
export const InkCss = Object.freeze({
  gold: '#c9a227',
  goldBright: '#e8c95a',
  ink: '#d8d4e8',
  dim: '#6a6488',
  faint: '#453f5e',
  blood: '#c0505c',
  mana: '#7a9ed8',
  xp: '#9ec86a',
});

/**
 * Draw the signature gothic panel: dark fill, double gold border, corner
 * diamonds, subtle inner shadow line.
 * @param {object} g Phaser Graphics (duck-typed)
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {object} [opts] @param {number} [opts.fill] fill color
 */
export function drawGothicPanel(g, x, y, w, h, { fill = Ink.panel } = {}) {
  g.fillStyle(fill, 0.96);
  g.fillRect(x, y, w, h);
  // outer gold border
  g.lineStyle(1, Ink.gold, 0.9);
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // inner dim border
  g.lineStyle(1, Ink.faint, 0.9);
  g.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
  // corner diamonds
  g.fillStyle(Ink.gold, 1);
  const d = 2.5;
  const corners = [
    [x + 1, y + 1],
    [x + w - 1, y + 1],
    [x + 1, y + h - 1],
    [x + w - 1, y + h - 1],
  ];
  for (const [cx, cy] of corners) {
    g.fillPoints(
      [
        { x: cx, y: cy - d },
        { x: cx + d, y: cy },
        { x: cx, y: cy + d },
        { x: cx - d, y: cy },
      ],
      true
    );
  }
}

/**
 * Horizontal divider rule with a center diamond.
 * @param {object} g Phaser Graphics (duck-typed)
 */
export function drawDivider(g, x, y, w) {
  g.lineStyle(1, Ink.faint, 0.8);
  g.lineBetween(x, y, x + w, y);
  g.fillStyle(Ink.gold, 0.8);
  const cx = x + w / 2;
  g.fillTriangle(cx - 3, y, cx + 3, y, cx, y - 3);
  g.fillTriangle(cx - 3, y, cx + 3, y, cx, y + 3);
}

/**
 * Create a text object with the gothic defaults.
 * @param {object} scene Phaser Scene (duck-typed: add.text)
 * @returns {object} the text object
 */
export function gothicText(scene, x, y, str, opts = {}) {
  return scene.add.text(x, y, str, {
    fontFamily: opts.mono ? GOTHIC_MONO : GOTHIC_FONT,
    fontSize: opts.size ?? '10px',
    color: opts.color ?? InkCss.ink,
    letterSpacing: opts.spacing ?? 0,
    align: opts.align ?? 'left',
    lineSpacing: opts.lineSpacing ?? 2,
    wordWrap: opts.wrap ? { width: opts.wrap } : undefined,
  });
}

/**
 * Panel header: small gold caps title + divider.
 * @returns {number} y position just below the divider
 */
export function panelHeader(g, scene, x, y, w, title) {
  const t = gothicText(scene, x + w / 2, y, title, {
    size: '11px',
    color: InkCss.gold,
    spacing: 3,
  });
  t.setOrigin(0.5, 0);
  drawDivider(g, x + 12, y + 17, w - 24);
  return y + 24;
}

/**
 * Format a stat-delta map into a compact colored string, e.g. "+3 atk".
 * @param {object} deltas stat -> delta
 * @returns {{ text: string, positive: boolean }[]}
 */
export function formatDeltas(deltas) {
  const out = [];
  for (const [k, v] of Object.entries(deltas ?? {})) {
    if (v === 0) continue;
    const sign = v > 0 ? '+' : '';
    const num = Number.isInteger(v) ? `${v}` : v.toFixed(2);
    out.push({ text: `${sign}${num} ${k}`, positive: v > 0 });
  }
  return out;
}
