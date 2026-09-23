#!/usr/bin/env node
/* ============================================================================
 * make_art.js — procedural ORIGINAL pixel-art pipeline for THE CITADEL OF VESPER
 * Wave 1 art stand-in. Zero npm dependencies (node:fs, node:path, node:zlib).
 *
 * Every sprite painted here is an original creation for this project
 * (see docs/ARCHITECTURE.md §0 originality guardrail). No rips, no traces.
 *
 * Usage:  node scripts/make_art.js        (run from repo root)
 * Output: PNG files under assets/ plus companion *.json frame indices.
 * The script ends with a verification pass: PNG magic/IHDR checks plus
 * pixel stats (unique colors, alpha coverage) per file.
 * ========================================================================== */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const A = (...parts) => path.join(ROOT, 'assets', ...parts);
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

/* ---------------- deterministic RNG (mulberry32) ---------------- */
function rng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let z = Math.imul(t ^ (t >>> 15), t | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- palette ----------------
 * Moonlit Gate: moonlit blues / silvers. Hollow Keep: deep purples,
 * ashen grays, ember oranges. Lucien + shared accents below. */
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const PAL = {
  // night skies
  night0: hex('#070b14'), night1: hex('#0c1322'), night2: hex('#16233f'), night3: hex('#22345a'),
  keep0: hex('#0d0812'), keep1: hex('#160e1e'), keep2: hex('#241631'), keep3: hex('#3a2347'),
  moon: hex('#f2eedd'), moonDim: hex('#c9cdbd'), halo: hex('#8fa0c8'),
  star: hex('#dfe6f5'),
  // moonlit gate stone
  stoneD: hex('#232a3e'), stone: hex('#39445e'), stoneL: hex('#525f82'), stoneH: hex('#8b98b8'),
  silver: hex('#c7d2e8'), moss: hex('#3d5a44'),
  // hollow keep basalt / iron / wood
  basaltD: hex('#14101b'), basalt: hex('#221a2c'), basaltL: hex('#352844'), basaltH: hex('#5b4c6e'),
  iron: hex('#43434e'), ironL: hex('#7d7d8f'), ironD: hex('#26262e'), rust: hex('#8a4a2a'), rustD: hex('#5a2f1c'),
  wood: hex('#4a3220'), woodD: hex('#2c1e12'), woodL: hex('#6e4c2e'),
  ember: hex('#ff7a2a'), emberH: hex('#ffc46b'), emberD: hex('#a83c14'),
  ash: hex('#9a938c'), ashD: hex('#57524b'),
  // Lucien Vale — disgraced knight-explorer
  coat: hex('#252b40'), coatD: hex('#141828'), coatL: hex('#3d4563'), coatRim: hex('#a9bce4'),
  lining: hex('#6e2a35'), liningD: hex('#431820'),
  hair: hex('#e6ebf7'), hairD: hex('#a7b2cb'), hairRim: hex('#ffffff'),
  skin: hex('#d9b48f'), skinD: hex('#9c744f'),
  trouser: hex('#20263a'), boot: hex('#221a10'), bootL: hex('#41321f'),
  blade: hex('#d7deee'), bladeH: hex('#ffffff'), guard: hex('#9a7a40'), grip: hex('#33261a'),
  lantern: hex('#ffbe5a'), lanternGlow: hex('#ff9a3a'),
  // pickups / fx
  gold: hex('#e0aa34'), goldL: hex('#ffe08a'), goldD: hex('#7d5518'),
  heart: hex('#c93a4a'), heartL: hex('#ff8296'), heartD: hex('#6e1c28'),
  mana: hex('#5aa8e8'), manaL: hex('#b5e2ff'), manaD: hex('#245a8c'),
  key: hex('#c9a44a'), keyL: hex('#ffe9a8'), keyD: hex('#7d5f22'),
  flame: hex('#ffcf6b'), flameH: hex('#fff3c9'), flameD: hex('#e07f2e'),
  candle: hex('#e6d9b8'), candleD: hex('#a8946a'),
  slash: hex('#cfe0ff'), slashH: hex('#ffffff'),
  parchment: hex('#cfc2a0'), parchmentD: hex('#8f8262'),
  // ui
  uiBg: hex('#141020'), uiBgL: hex('#221b36'), uiTrim: hex('#8f9cc0'), uiTrimL: hex('#d5dcf2'),
  btnT: hex('#2c2742'), btnB: hex('#171224'),
};

/* ---------------- pixel canvas ---------------- */
class Px {
  constructor(w, h) { this.w = w; this.h = h; this.d = Buffer.alloc(w * h * 4); }
  _i(x, y) { return (y * this.w + x) * 4; }
  in(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  px(x, y, c, a = 255) {
    x |= 0; y |= 0; if (!this.in(x, y) || a <= 0) return;
    const i = this._i(x, y); this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a;
  }
  blend(x, y, c, a) { // alpha-composite a translucent color over existing pixel
    x |= 0; y |= 0; if (!this.in(x, y) || a <= 0) return;
    const i = this._i(x, y);
    const sa = a / 255, da = this.d[i + 3] / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    this.d[i] = Math.round((c[0] * sa + this.d[i] * da * (1 - sa)) / oa);
    this.d[i + 1] = Math.round((c[1] * sa + this.d[i + 1] * da * (1 - sa)) / oa);
    this.d[i + 2] = Math.round((c[2] * sa + this.d[i + 2] * da * (1 - sa)) / oa);
    this.d[i + 3] = Math.round(oa * 255);
  }
  rect(x, y, w, h, c, a = 255) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, c, a);
  }
  dith(x, y, c1, c2) { this.px(x, y, ((x + y) & 1) ? c1 : c2); }
  dithRect(x, y, w, h, c1, c2) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.dith(i, j, c1, c2);
  }
  line(x0, y0, x1, y1, c, w = 1, a = 255) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    const stamp = (sx2, sy2) => { if (w <= 1) this.px(sx2, sy2, c, a); else this.disc(sx2, sy2, (w - 1) / 2, c, a); };
    for (;;) { stamp(x, y); if (x === x1 && y === y1) break; const e2 = 2 * err; if (e2 > -dy) { err -= dy; x += sx; } if (e2 < dx) { err += dx; y += sy; } }
  }
  disc(cx, cy, r, c, a = 255) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r + 0.4) this.px(x, y, c, a);
  }
  ring(cx, cy, r, c, a = 255) {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        if (Math.abs(d - r) < 0.7) this.px(x, y, c, a);
      }
  }
  ell(cx, cy, rx, ry, c, a = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1.05) this.px(x, y, c, a);
      }
  }
  poly(pts, c, a = 255) { // filled polygon, even-odd scanline
    let y0 = this.h - 1, y1 = 0;
    for (const p of pts) { y0 = Math.min(y0, Math.floor(p[1])); y1 = Math.max(y1, Math.ceil(p[1])); }
    y0 = Math.max(0, y0); y1 = Math.min(this.h - 1, y1);
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2)
        for (let x = Math.ceil(xs[i]); x <= xs[i + 1]; x++) this.px(x, y, c, a);
    }
  }
  tri(ax, ay, bx, by, cx, cy, c, a = 255) { this.poly([[ax, ay], [bx, by], [cx, cy]], c, a); }
  blit(src, dx, dy, flip = false) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      const si = (y * src.w + x) * 4, sa = src.d[si + 3];
      if (sa === 0) continue;
      const dx2 = flip ? dx + src.w - 1 - x : dx + x;
      this.blend(dx2, dy + y, [src.d[si], src.d[si + 1], src.d[si + 2]], sa);
    }
  }
  vgrad(stops) { // stops: [[t, color], ...] t in 0..1
    for (let y = 0; y < this.h; y++) {
      const t = y / (this.h - 1);
      let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
      const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
      const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
      const c = [0, 1, 2].map(k => Math.round(c0[k] + (c1[k] - c0[k]) * f));
      for (let x = 0; x < this.w; x++) this.px(x, y, c);
    }
  }
  vignette(strength = 90) {
    const cx = this.w / 2, cy = this.h / 2, max = Math.sqrt(cx * cx + cy * cy);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / max;
      if (d > 0.55) this.blend(x, y, [0, 0, 0], Math.round(strength * (d - 0.55) / 0.45));
    }
  }
  speckle(n, colors, seed, x0 = 0, y0 = 0, w = null, h = null) {
    const R = rng(seed); w = w || this.w; h = h || this.h;
    for (let i = 0; i < n; i++) {
      const x = x0 + ((R() * w) | 0), y = y0 + ((R() * h) | 0);
      this.px(x, y, colors[(R() * colors.length) | 0]);
    }
  }
  glowDisc(cx, cy, r, c, maxA = 120) { // soft radial glow
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        if (d < r) this.blend(x, y, c, Math.round(maxA * (1 - d / r)));
      }
  }
}

/* ---------------- minimal PNG encoder (RGBA8, filter 0) ---------------- */
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); td.copy(out, 4);
  out.writeUInt32BE(crc32(td), 8 + data.length);
  return out;
}
function encodePNG(px) {
  const { w, h, d } = px;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; d.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function writePNG(px, file) { mkdir(path.dirname(file)); fs.writeFileSync(file, encodePNG(px)); return file; }

/* minimal PNG decoder (for the verification pass; handles our own output) */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('bad magic');
  let pos = 8, w = 0, h = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Px(w, h);
  const stride = 1 + w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    if (f !== 0) throw new Error('unsupported filter ' + f);
    raw.copy(px.d, y * w * 4, y * stride + 1, (y + 1) * stride);
  }
  return px;
}
function pixelStats(px) {
  const seen = new Set(); let alpha = 0;
  for (let i = 0; i < px.d.length; i += 4) {
    if (px.d[i + 3] > 8) { alpha++; seen.add((px.d[i] << 16) | (px.d[i + 1] << 8) | px.d[i + 2]); }
  }
  return { colors: seen.size, alphaPx: alpha, coverage: alpha / (px.w * px.h) };
}

/* manifest of everything written, for verification + docs */
const MANIFEST = [];
function emit(px, rel, meta = {}) {
  const file = writePNG(px, A(...rel.split('/')));
  MANIFEST.push({ file: path.join('assets', rel), w: px.w, h: px.h, ...meta });
  return px;
}
function emitJSON(rel, obj) {
  const file = A(...rel.split('/')); mkdir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  MANIFEST.push({ file: path.join('assets', rel), json: true });
}

/* ================= LUCIEN VALE — original protagonist =================
 * Disgraced knight-explorer: high-collared dark greatcoat, silver-white
 * swept-back hair, lantern-pendant at the chest, arming sword.
 * Side view, faces right. Moonlight rim from upper-right. */
function shadeCol(c, f) { return [0, 1, 2].map(k => Math.max(0, Math.min(255, Math.round(c[k] * f)))); }

function legJoints(hipX, hipY, phase, stride, lift, kneeFwd, GY) {
  const fx = hipX + Math.cos(phase) * stride;
  const fy = GY - Math.max(0, Math.sin(phase)) * lift;
  return { fx, fy, kx: (hipX + fx) / 2 + kneeFwd, ky: (hipY + fy) / 2 + 1.5 };
}
function armJoints(sx, sy, angDeg, L) {
  const a = angDeg * Math.PI / 180;
  return {
    hx: sx + Math.sin(a) * L, hy: sy + Math.cos(a) * L,
    ex: sx + Math.sin(a) * L * 0.5, ey: sy + Math.cos(a) * L * 0.5 + 1,
  };
}
function drawSword(px, hx, hy, angDeg, len) {
  const a = angDeg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
  px.line(hx, hy, hx + dx * 3, hy + dy * 3, PAL.grip, 3);
  const gx = hx + dx * 4, gy = hy + dy * 4;
  px.line(gx - dy * 3, gy + dx * 3, gx + dy * 3, gy - dx * 3, PAL.guard, 2);
  const bx = gx + dx * 2, by = gy + dy * 2;
  px.line(bx, by, gx + dx * len, gy + dy * len, PAL.blade, 3);
  px.line(bx - dy, by + dx, gx + dx * len - dy, gy + dy * len + dx, PAL.bladeH, 1);
}
function drawSlashArc(px, cx, cy, r, a0, a1) {
  for (let a = a0; a <= a1; a += 4) {
    const q = a * Math.PI / 180, x = cx + Math.cos(q) * r, y = cy + Math.sin(q) * r;
    px.disc(x, y, 2.4, PAL.slash, 190);
    px.disc(x, y, 1.2, PAL.slashH, 235);
  }
  const R = rng(77);
  for (let i = 0; i < 12; i++) {
    const a = (a0 + R() * (a1 - a0)) * Math.PI / 180, rr = r + (R() * 10 - 5);
    px.px(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, PAL.slashH);
  }
}
function limb(px, x0, y0, x1, y1, x2, y2, w, c) {
  px.line(x0, y0, x1, y1, c, w); px.line(x1, y1, x2, y2, c, w);
  px.disc(x1, y1, w / 2, c);
}

function lucienFrame(p) {
  if (p.prone) return lucienProne();
  const W = p.w || 32, H = p.h || 48, ox = p.ox || 0;
  const px = new Px(W, H);
  const by = p.by || 0, lean = p.lean || 0;
  const GY = 46 + by; // ground line for feet
  const hipX = 16 + ox + lean * 0.25, hipY = (p.hipY || 30) + by;
  const shX = 16 + ox + lean, shY = 17 + by;
  const headX = 17 + ox + lean * 1.35 + (p.headDX || 0), headY = 10 + by + (p.headDY || 0);
  const stride = p.stride || 0, lift = p.lift || 0, kneeFwd = p.kneeFwd != null ? p.kneeFwd : 2.5;

  // legs (trousers + boots)
  const legB = legJoints(hipX - 1, hipY, p.phaseB != null ? p.phaseB : Math.PI, stride, lift, kneeFwd, GY);
  const legF = legJoints(hipX + 1, hipY, p.phaseF || 0, stride, lift, kneeFwd, GY);
  const trouserD = shadeCol(PAL.trouser, 0.6);
  limb(px, hipX - 1, hipY, legB.kx, legB.ky, legB.fx, legB.fy - 2, 3, trouserD);
  px.rect(legB.fx - 2, legB.fy - 3, 5, 3, PAL.boot);
  // back arm (sleeve, darker)
  const armB = armJoints(shX - 1, shY + 1, p.armSwingB || -8, 9);
  limb(px, shX - 1, shY + 1, armB.ex, armB.ey, armB.hx, armB.hy, 3, PAL.coatD);
  px.disc(armB.hx, armB.hy, 1.4, PAL.skin);

  // greatcoat: two-tone trapezoid, moonlit rim on the right edge
  const sway = p.coatSway || 0, clift = p.coatLift || 0, flare = p.coatFlare || 0;
  const shL = shX - 5, shR = shX + 5, hemY = 37 + by + clift, hemX = 16 + ox + lean * 0.5 + sway;
  const midX = (shL + shR) / 2, hemMid = hemX;
  px.poly([[shL, shY], [midX, shY], [hemMid, hemY], [hemX - 7 - flare, hemY]], PAL.coatD);
  px.poly([[midX, shY], [shR, shY], [hemX + 7 + flare, hemY], [hemMid, hemY]], PAL.coat);
  px.line(shR, shY + 1, hemX + 7 + flare, hemY - 1, PAL.coatRim, 1); // moon rim
  if (flare > 0) px.line(hemMid, hemY, hemMid + 1, hemY - 7, PAL.lining, 2); // coat opening
  // belt + buckle
  px.rect(shX - 5, 27 + by, 10, 2, PAL.boot);
  px.px(shX + 2, 27 + by, PAL.guard); px.px(shX + 2, 28 + by, PAL.guard);
  // high collar (behind head) + front lapel
  px.poly([[shX - 4, 16 + by], [shX + 4, 16 + by], [shX + 5, 9 + by], [shX - 5, 9 + by]], PAL.coatD);
  px.tri(shX + 1, 16 + by, shX + 5, 16 + by, shX + 4, 10 + by, PAL.liningD);

  // head: silver-white swept hair, face, eye
  px.disc(headX, headY, 4, PAL.hair);
  px.rect(headX - 7, headY - 3, 4, 5, PAL.hair);            // swept back
  px.rect(headX - 7, headY - 4, 5, 2, PAL.hairD);           // hair shade
  px.rect(headX + 1, headY - 2, 3, 5, PAL.skin);            // face
  px.rect(headX + 1, headY + 2, 3, 1, PAL.skinD);
  px.px(headX + 3, headY - 1, [20, 16, 24]);               // eye
  px.line(headX + 1, headY - 4, headX + 4, headY - 4, PAL.hairRim, 1); // hair rim

  // front leg
  limb(px, hipX + 1, hipY, legF.kx, legF.ky, legF.fx, legF.fy - 2, 3, PAL.trouser);
  px.rect(legF.fx - 2, legF.fy - 3, 5, 3, PAL.boot);
  px.line(legF.fx - 2, legF.fy - 3, legF.fx + 2, legF.fy - 3, PAL.bootL, 1);
  // front arm + sword
  const armF = armJoints(shX + 1, shY + 1, p.armSwingF || 8, 9);
  limb(px, shX + 1, shY + 1, armF.ex, armF.ey, armF.hx, armF.hy, 3, PAL.coat);
  px.disc(armF.hx, armF.hy, 1.4, PAL.skin);
  if (p.swordA != null) drawSword(px, armF.hx, armF.hy, p.swordA, p.swordLen || 17);

  // lantern-pendant at the chest
  const lx = shX + 2, ly = 22 + by;
  px.glowDisc(lx, ly, 5, PAL.lanternGlow, 70);
  px.rect(lx - 1, ly - 1, 3, 4, PAL.lantern);
  px.px(lx, ly, PAL.flameH);

  // fx
  if (p.slash) drawSlashArc(px, p.slash.cx, p.slash.cy, p.slash.r, p.slash.a0, p.slash.a1);
  if (p.dashStreaks) for (const yy of [21, 27, 33])
    px.line(ox + 2, yy + by, ox + 13, yy + by, PAL.slash, 2, 90);
  if (p.flash) {
    const f = p.flash * 0.6;
    for (let i = 0; i < px.d.length; i += 4) {
      if (px.d[i + 3] === 0) continue;
      px.d[i] = Math.round(px.d[i] + (255 - px.d[i]) * f);
      px.d[i + 1] = Math.round(px.d[i + 1] + (235 - px.d[i + 1]) * f);
      px.d[i + 2] = Math.round(px.d[i + 2] + (235 - px.d[i + 2]) * f);
    }
  }
  return px;
}

function lucienProne() { // death, final frame: fallen flat, sword dropped
  const px = new Px(44, 18);
  px.poly([[2, 8], [38, 8], [42, 15], [0, 15]], PAL.coatD);
  px.poly([[6, 7], [34, 7], [37, 14], [4, 14]], PAL.coat);
  px.line(4, 14, 38, 14, PAL.coatRim, 1);
  px.disc(7, 6, 3.6, PAL.hair);                 // head
  px.rect(8, 4, 3, 5, PAL.skin);
  px.line(20, 10, 27, 14, PAL.coat, 3); px.disc(27, 14, 1.4, PAL.skin); // arm
  px.line(35, 11, 43, 11, PAL.trouser, 3);      // legs
  px.rect(39, 9, 4, 3, PAL.boot);
  px.line(12, 16, 30, 14, PAL.blade, 2);       // dropped sword
  px.line(20, 17, 20, 13, PAL.guard, 2);
  px.glowDisc(20, 8, 6, PAL.lanternGlow, 40);   // fading pendant
  return px;
}

const LUCIEN_ANIMS = {
  idle: { fps: 4, frames: [
    { armSwingF: 8, armSwingB: -6, swordA: -52, stride: 1.5 },
    { by: 1, headDY: 1, coatSway: 1, armSwingF: 6, armSwingB: -4, swordA: -50, stride: 1.5 },
  ]},
  walk: { fps: 8, frames: [0, 1, 2, 3].map(i => ({
    phaseF: i * Math.PI / 2, phaseB: i * Math.PI / 2 + Math.PI,
    stride: 5, lift: 3, by: [1, 0, 1, 0][i], lean: 1,
    armSwingF: [14, 0, -14, 0][i], armSwingB: [-14, 0, 14, 0][i],
    swordA: -40, coatSway: [-1, 0, 1, 0][i],
  }))},
  run: { fps: 12, frames: [0, 1, 2, 3].map(i => ({
    phaseF: i * Math.PI / 2, phaseB: i * Math.PI / 2 + Math.PI,
    stride: 8, lift: 5, by: -1, lean: 3, headDX: 1,
    armSwingF: [35, 10, -35, -10][i], armSwingB: [-35, -10, 35, 10][i],
    swordA: -25, coatSway: -4, coatFlare: 2,
  }))},
  jump: { fps: 6, frames: [
    { phaseF: Math.PI / 2, phaseB: Math.PI * 1.4, stride: 3, lift: 8, by: -2, swordA: -80, armSwingF: -30, armSwingB: 20, coatLift: -3, coatFlare: 3 },
    { phaseF: Math.PI * 0.8, phaseB: Math.PI * 1.7, stride: 4, lift: 6, by: -1, swordA: -70, armSwingF: -20, armSwingB: 15, coatLift: -2, coatFlare: 2 },
  ]},
  fall: { fps: 6, frames: [
    { stride: 2, lift: 0, by: 0, armSwingF: 28, armSwingB: -28, swordA: -30, coatLift: -4, coatFlare: 4, headDY: -1 },
  ]},
  crouch: { fps: 2, frames: [
    { hipY: 35, by: 2, stride: 3, kneeFwd: 5, lean: 2, headDY: 2, swordA: -15, armSwingF: 18, coatSway: 1 },
  ]},
  dash: { fps: 14, frames: [
    { lean: 6, headDX: 2, phaseF: 0, phaseB: Math.PI, stride: 7, lift: 1, armSwingF: -20, armSwingB: 20, swordA: -10, coatSway: -7, coatFlare: 2, dashStreaks: true },
    { lean: 6, headDX: 2, phaseF: Math.PI, phaseB: 0, stride: 7, lift: 1, armSwingF: -15, armSwingB: 25, swordA: -12, coatSway: -6, coatFlare: 2, dashStreaks: true },
  ]},
  hurt: { fps: 8, frames: [
    { lean: -4, headDX: -3, headDY: -1, by: -1, armSwingF: 42, armSwingB: -42, swordA: -70, coatSway: 2, flash: 0.55, stride: 2 },
  ]},
  land: { fps: 8, frames: [
    { hipY: 34, by: 2, stride: 3, kneeFwd: 5, lean: 1, headDY: 2, swordA: -25, armSwingF: 15, armSwingB: -15, coatSway: 1, coatFlare: 2, coatLift: 2 },
  ]},
  turn: { fps: 10, frames: [
    { lean: 2, swordA: -45, armSwingF: 10, armSwingB: -10, stride: 2 },
    { lean: 2, swordA: -45, armSwingF: 10, armSwingB: -10, stride: 2, flip: true },
  ]},
  die: { fps: 6, frames: [
    { lean: -5, headDX: -3, headDY: -1, by: 0, armSwingF: 45, armSwingB: -45, swordA: -75, coatSway: 3, stride: 2 },
    { hipY: 36, by: 4, stride: 2, kneeFwd: 6, lean: -2, headDY: 3, swordA: null, armSwingF: 30, armSwingB: -20, coatSway: 2 },
    { prone: true },
  ]},
  attack_sword: { fps: 12, w: 48, h: 48, ox: 8, frames: [
    { lean: -3, armSwingF: -55, armSwingB: -10, swordA: -115, swordLen: 17, stride: 4, coatSway: -2 },
    { lean: 4, headDX: 1, armSwingF: 58, armSwingB: 10, swordA: 18, swordLen: 20, stride: 4, coatSway: 3,
      slash: { cx: 16 + 8 + 4, cy: 18, r: 24, a0: -75, a1: 35 } },
    { lean: 1, armSwingF: 20, armSwingB: 0, swordA: -20, swordLen: 17, stride: 4, coatSway: 1 },
  ]},
};

function buildPlayer() {
  // Asset contract (src/config/assets.js + assets/README.md): 64x64 frames.
  // Art is authored ~32x48 and centered bottom in the frame.
  const index = { character: 'Lucien Vale', frameContract: '64x64, art authored ~32x48 centered-bottom', animations: {} };
  for (const [name, anim] of Object.entries(LUCIEN_ANIMS)) {
    const aw = anim.w || 32, ah = anim.h || 48, FW = 64, FH = 64;
    const sheet = new Px(FW * anim.frames.length, FH);
    anim.frames.forEach((pose, i) => {
      const f = lucienFrame({ ...pose, w: aw, h: ah, ox: anim.ox || 0 });
      sheet.blit(f, i * FW + ((FW - f.w) >> 1), FH - f.h, !!pose.flip);
    });
    const rel = `player/lucien_${name}.png`;
    emit(sheet, rel, { kind: 'player', anim: name });
    index.animations[name] = { file: `assets/${rel}`, frameWidth: FW, frameHeight: FH, frames: anim.frames.length, fps: anim.fps };
  }
  emitJSON('player/lucien.json', index);
}

/* ================= ENEMIES — all original designs =================
 * ash_hound + rustbound_revenant match data/enemies.json ids.
 * The other six are original provisional designs for the ENEMIES.md
 * vertical-slice concepts (wisp, animated armor, bell-ringer construct,
 * dust-mote swarm, archive spirit, keep hound variant); ids are provisional
 * until Wave 4 writes their data entries. */
const bronze = hex('#7d5f33'), bronzeL = hex('#c9a44a'), bronzeD = hex('#4a3820');

function ashHound(frame, mode = 'run') {
  const px = new Px(mode === 'attack' ? 36 : 32, 24), R = rng(11 + frame);
  const bob = mode === 'idle' ? frame : 0;                    // breathing bob
  const lunge = mode === 'attack' ? (frame ? 4 : 0) : 0;      // lunge forward
  const ph = frame * Math.PI;
  // legs
  for (let i = 0; i < 4; i++) {
    const lx = [9, 13, 21, 25][i];
    const lift = mode === 'run' ? Math.max(0, Math.sin(ph + (i % 2) * Math.PI)) * 3 : 0;
    const fwd = mode === 'attack' && i > 1 ? 2 : 0;
    px.line(lx + fwd, 15 + bob, lx + fwd, 21 - lift + bob, PAL.ashD, 2);
    px.px(lx + fwd, 21 - lift + bob, PAL.ashD); px.px(lx + fwd + 1, 21 - lift + bob, PAL.ashD);
  }
  // tail
  px.line(7, 12 + bob, 3, 7 + bob + (frame ? 1 : -1), PAL.ashD, 2);
  px.px(3, 7 + bob + (frame ? 1 : -1), PAL.ember);
  // body
  px.ell(16, 13 + bob, 9, 5.5, PAL.ash);
  px.ell(16, 11.5 + bob, 9, 4, PAL.ashD);          // dark back
  px.ell(16, 15.5 + bob, 7, 3, shadeCol(PAL.ash, 1.15)); // pale belly
  for (let i = 0; i < 4; i++) px.tri(9 + i * 4, 8 + bob, 11 + i * 4, 8 + bob, 10 + i * 4, 5 + bob, PAL.ashD);
  // ember cracks on flank
  px.glowDisc(16, 13 + bob, 7, PAL.ember, 40);
  px.line(12, 12 + bob, 15, 14 + bob, PAL.ember, 1); px.line(15, 14 + bob, 14, 16 + bob, PAL.emberD, 1);
  px.line(18, 11 + bob, 20, 14 + bob, PAL.ember, 1); px.px(20, 14 + bob, PAL.emberH);
  // head
  const hx = 25 + lunge, hy = 10 + bob + (mode === 'attack' ? 2 : 0);
  px.disc(hx, hy, 4.5, PAL.ash);
  px.rect(hx + 2, hy, 4, 3, shadeCol(PAL.ash, 0.85)); // snout
  px.px(hx + 5, hy + 1, [15, 12, 12]);               // nose
  if (mode === 'attack') { px.rect(hx + 2, hy + 3, 4, 2, [20, 10, 10]); px.px(hx + 4, hy + 4, PAL.parchment); } // open jaw + fang
  px.tri(hx - 3, hy - 3, hx - 1, hy - 3, hx - 2, hy - 7, PAL.ashD); // ear
  px.px(hx + 1, hy - 1, PAL.emberH); px.px(hx + 2, hy - 1, PAL.ember); // ember eye
  return px;
}
function rustboundRevenant(frame, mode = 'idle') {
  const px = new Px(24, 36), bob = mode === 'idle' && frame ? 1 : 0;
  const y = o => o + bob, wph = frame * Math.PI;
  const lean = mode === 'attack' ? (frame ? 3 : -2) : 0;
  // legs: rusted greaves, wide stance (walk alternates)
  const legLift = i => mode === 'walk' ? Math.max(0, Math.sin(wph + i * Math.PI)) * 3 : 0;
  px.line(8 + lean, y(24), 7 + lean, y(33) - legLift(0), PAL.ironD, 4);
  px.line(15 + lean, y(24), 16 + lean, y(33) - legLift(1), PAL.ironD, 4);
  px.rect(5 + lean, y(32) - legLift(0), 5, 3, PAL.rustD); px.rect(14 + lean, y(32) - legLift(1), 5, 3, PAL.rustD);
  // torso: barrel cuirass, rusted plate
  px.rect(7 + lean, y(12), 10, 13, PAL.rust);
  px.rect(7 + lean, y(12), 3, 13, PAL.rustD);            // shade
  px.rect(14 + lean, y(12), 3, 13, shadeCol(PAL.rust, 1.2)); // worn highlight
  px.line(7 + lean, y(16), 16 + lean, y(16), PAL.ironD, 1); px.line(7 + lean, y(21), 16 + lean, y(21), PAL.ironD, 1);
  px.speckle(14, [PAL.rustD, PAL.ironD], 21 + frame, 7 + lean, y(12), 10, 13);
  // pauldrons
  px.ell(5 + lean, y(12), 3.5, 3, PAL.iron); px.ell(18 + lean, y(12), 3.5, 3, PAL.iron);
  px.px(4 + lean, y(10), PAL.ironL); px.px(17 + lean, y(10), PAL.ironL);
  // helmet: closed helm, faint slit-glow
  px.rect(8 + lean, y(4), 8, 8, PAL.ironD);
  px.rect(9 + lean, y(5), 6, 6, PAL.iron);
  px.rect(10 + lean, y(8), 4, 1, PAL.emberD); px.blend(12 + lean, y(8), PAL.ember, 120);
  px.rect(7 + lean, y(11), 10, 2, PAL.rustD);           // gorget
  // shield arm (front): heater shield, iron + rust rim
  const sx = 18 + lean + (mode === 'idle' && frame ? 1 : 0);
  px.line(16 + lean, y(15), sx - 2, y(19), PAL.ironD, 3);
  px.rect(sx - 3, y(14), 8, 12, PAL.iron);
  px.rect(sx - 3, y(14), 8, 2, PAL.rust); px.rect(sx - 3, y(24), 8, 2, PAL.rust);
  px.rect(sx - 3, y(14), 2, 12, PAL.rust);
  px.disc(sx + 1, y(20), 2, PAL.rustD); px.px(sx + 1, y(20), PAL.ironL);
  // back arm: notched short blade — overhead cleave in attack mode
  if (mode === 'attack' && !frame) {          // windup: blade raised
    px.line(7 + lean, y(15), 2 + lean, y(5), PAL.ironD, 3);
    px.line(2 + lean, y(5), 0 + lean, y(0), PAL.blade, 2);
  } else if (mode === 'attack') {            // cleave: blade swept down
    px.line(7 + lean, y(15), 13 + lean, y(24), PAL.ironD, 3);
    px.line(13 + lean, y(24), 17 + lean, y(29), PAL.blade, 2);
    drawSlashArc(px, 12 + lean, y(18), 12, -20, 70);
  } else {
    px.line(7 + lean, y(15), 4 + lean, y(21), PAL.ironD, 3);
    px.line(4 + lean, y(21), 2 + lean, y(16), PAL.blade, 2);
  }
  return px;
}
function cinderWisp(frame, mode = 'idle') {
  const px = new Px(26, 30), tall = frame ? 1 : 0;
  const charge = mode === 'attack' && !frame, lob = mode === 'attack' && frame;
  const bx = 13, by = 13 - tall + (charge ? 2 : 0) - (lob ? 2 : 0);
  const R = rng(31 + frame * 7);
  px.glowDisc(bx, by, charge ? 12 : 9, PAL.ember, charge ? 110 : 70);
  if (lob) { // ember lob: projectile blob rising above
    px.glowDisc(bx, by - 12, 6, PAL.ember, 80);
    px.disc(bx, by - 12, 3, PAL.ember); px.disc(bx, by - 13, 1.6, PAL.emberH);
    px.line(bx, by - 8, bx, by - 4, PAL.emberD, 2);
  }
  px.disc(bx, by, charge ? 6 : 5, PAL.emberD);           // dark coal body
  px.disc(bx, by - 2, 3, PAL.ember);                    // mid flame
  px.disc(bx, by - 3, 1.6, PAL.emberH);                  // hot core
  px.px(bx - 2, by - 1, [20, 8, 5]); px.px(bx + 2, by - 1, [20, 8, 5]); // eyes
  px.px(bx - 2, by - 2, [255, 230, 180]); px.px(bx + 2, by - 2, [255, 230, 180]); // glints
  // ragged flame licks, brighter than the body
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.5 + (R() - 0.5) * 0.3;
    const l = (charge ? 8 : 6) + R() * 3;
    px.line(bx, by - 4, bx + Math.cos(a) * l, by - 4 + Math.sin(a) * l, i % 2 ? PAL.flame : PAL.emberH, 1);
  }
  px.line(bx, by + 4, bx + (frame ? 2 : -2), by + 11, PAL.emberD, 2); // tail flick
  for (let i = 0; i < 5; i++) px.px(4 + R() * 18, by + 6 + R() * 8, i % 2 ? PAL.ember : PAL.emberH); // rising sparks
  return px;
}
function hollowSentinel(frame) {
  const px = new Px(24, 36), dy = frame ? -1 : 0, glow = frame ? 150 : 100;
  const y = o => o + dy;
  px.glowDisc(12, y(8), 8, hex('#7a4ae8'), 50);
  // hollow neck: violet void where a head should be
  px.rect(9, y(5), 6, 5, [8, 6, 12]);
  px.blend(12, y(7), hex('#9a6aff'), glow);
  px.rect(8, y(9), 8, 2, PAL.ironD); // gorget
  // breastplate with violet seams
  px.rect(7, y(11), 10, 13, PAL.iron);
  px.rect(7, y(11), 3, 13, PAL.ironD);
  px.line(15, y(12), 15, y(23), PAL.ironL, 1);
  px.line(9, y(14), 14, y(17), hex('#6a4ae0'), 1, 160); px.line(9, y(20), 14, y(17), hex('#6a4ae0'), 1, 160);
  // pauldrons + faulds
  px.ell(4, y(12), 3.5, 3.5, PAL.ironD); px.ell(20, y(12), 3.5, 3.5, PAL.ironD);
  px.tri(7, y(24), 17, y(24), 12, y(31), PAL.ironD);
  px.line(12, y(24), 12, y(30), PAL.iron, 1);
  // floating gauntlets
  px.rect(1, y(17) + (frame ? 1 : 0), 4, 6, PAL.iron);
  px.rect(19, y(15) + (frame ? -1 : 1), 4, 6, PAL.iron);
  px.px(2, y(19), PAL.ironL); px.px(20, y(17), PAL.ironL);
  return px;
}
function vesperChimer(frame) {
  const px = new Px(24, 32), sw = frame ? 2 : -2;
  // iron yoke frame
  px.rect(3, 1, 18, 3, PAL.ironD);
  px.rect(3, 1, 2, 12, PAL.ironD); px.rect(19, 1, 2, 12, PAL.ironD);
  px.px(4, 2, PAL.ironL); px.px(20, 2, PAL.ironL);
  const bx = 12 + sw;
  px.line(12, 4, bx, 8, PAL.ironD, 2); // hanger
  // bell body
  px.poly([[bx - 3, 8], [bx + 3, 8], [bx + 6, 22], [bx - 6, 22]], bronze);
  px.poly([[bx - 3, 8], [bx, 8], [bx, 22], [bx - 6, 22]], bronzeD);
  px.line(bx + 1, 9, bx + 4, 21, bronzeL, 1); // bronze sheen
  px.ell(bx, 22, 6, 2.5, bronzeD);
  px.ell(bx, 22, 4.5, 1.8, [10, 8, 10]);      // dark mouth
  px.disc(bx - sw, 23, 1.6, PAL.iron);        // clapper swings opposite
  // crack with light leaking
  px.line(bx - 1, 12, bx + 1, 16, [20, 14, 10], 1);
  px.line(bx + 1, 16, bx - 1, 20, [20, 14, 10], 1);
  px.blend(bx, 16, PAL.lanternGlow, 130);
  return px;
}
function moteSwarm(frame, mode = 'idle') {
  const px = new Px(34, 30), R = rng(41 + frame * 13);
  const gather = mode === 'attack' && !frame, pounce = mode === 'attack' && frame;
  const cx = 17 + (pounce ? 4 : 0), cy = 15;
  const spread = gather ? 0.55 : pounce ? 1.35 : 1;
  const motes = [];
  for (let i = 0; i < 16; i++) motes.push({ x: 17 + (R() - 0.5) * 26 * spread, y: 15 + (R() - 0.5) * 20 * spread, r: R() < 0.25 ? 2 : 1.2 });
  const drift = frame ? 1.5 : -1.5;
  px.glowDisc(cx, cy, gather ? 7 : 10, PAL.basaltH, 40);
  motes.forEach((m, i) => {
    const dx = Math.sin(i * 2.3 + (frame ? 1 : 0)) * drift + (pounce ? 3 : 0);
    const dy = Math.cos(i * 1.7 + (frame ? 1 : 0)) * drift;
    px.disc(m.x + dx, m.y + dy, m.r, i % 4 === 0 ? PAL.ash : PAL.basaltL);
  });
  if (pounce) for (let s = 0; s < 4; s++) // motion streaks
    px.line(cx - 14 - s * 3, cy - 4 + s * 2, cx - 8 - s * 3, cy - 4 + s * 2, PAL.ashD, 1);
  // three ember eyes in the cloud
  const ex = pounce ? 3 : drift, ey = pounce ? -1 : 0;
  px.disc(cx - 5 + ex, cy + ey, 2, PAL.emberH); px.disc(cx + ex, cy - 2 + ey, 2, PAL.emberH); px.disc(cx + 5 + ex, cy + ey, 2, PAL.emberH);
  px.blend(cx - 5 + ex, cy + ey, PAL.ember, 80); px.blend(cx + ex, cy - 2 + ey, PAL.ember, 80); px.blend(cx + 5 + ex, cy + ey, PAL.ember, 80);
  return px;
}
function vellumPhantom(frame, mode = 'idle') {
  const px = new Px(26, 38), wv = frame ? 1.5 : -1.5;
  const inhale = mode === 'attack' && !frame, burst = mode === 'attack' && frame;
  const cx = 13, pinch = inhale ? 3 : burst ? -3 : 0;
  px.glowDisc(cx, 14, inhale ? 12 : 10, hex('#6a5a9a'), inhale ? 80 : 50);
  // tattered parchment body, wider and more ragged
  px.poly([[cx - 7 + pinch, 4], [cx + 7 - pinch, 4], [cx + 8 - pinch + wv, 14], [cx + 5, 24],
    [cx + 7 + wv, 32], [cx + 2, 30], [cx, 36], [cx - 3, 30], [cx - 6, 34], [cx - 7, 26], [cx - 5, 18], [cx - 8 + pinch + wv, 10]], PAL.parchment);
  px.poly([[cx - 7 + pinch, 4], [cx - 3 + pinch, 4], [cx - 3, 28], [cx - 6, 34], [cx - 7, 26], [cx - 5, 18], [cx - 8 + pinch + wv, 10]], PAL.parchmentD);
  for (const ly of [9, 14, 19, 24]) { // script lines, faintly glowing
    px.line(cx - 4 + pinch / 2, ly, cx + 4 - pinch / 2 + (frame ? 1 : 0), ly, PAL.parchmentD, 1);
    if (frame) px.blend(cx, ly, hex('#8a6ae0'), 60);
  }
  px.rect(cx - 5, 8, 2.6, 3.4, [25, 20, 15]); px.rect(cx + 2.4, 8, 2.6, 3.4, [25, 20, 15]); // hollow eyes
  px.blend(cx - 4, 9, hex('#8a6ae0'), burst ? 170 : 70); px.blend(cx + 3.4, 9, hex('#8a6ae0'), burst ? 170 : 70);
  if (burst) { // spectral bolt streaking right
    px.line(cx + 8, 12, cx + 16, 12, hex('#b9a8ff'), 2);
    px.line(cx + 8, 12, cx + 14, 12, PAL.slashH, 1);
    px.glowDisc(cx + 16, 12, 5, hex('#9a6aff'), 90);
  }
  // trailing scraps
  px.rect(cx - 10 + wv, 26, 3, 5, PAL.parchmentD); px.rect(cx + 7 - wv, 28, 3, 4, PAL.parchment);
  px.rect(cx - 8 + wv, 32, 2, 3, PAL.parchment);
  return px;
}
function cinderMastiff(frame) {
  const px = new Px(36, 26), ph = frame * Math.PI;
  for (let i = 0; i < 4; i++) {
    const lx = [10, 14, 24, 28][i];
    const lift = Math.max(0, Math.sin(ph + (i % 2) * Math.PI)) * 3;
    px.line(lx, 16, lx, 23 - lift, PAL.ashD, 3);
  }
  px.line(8, 13, 3, 8 + (frame ? 1 : -1), PAL.ashD, 3);
  px.disc(3, 8 + (frame ? 1 : -1), 2, PAL.ember); // ember tail tuft
  px.ell(18, 14, 11, 6.5, PAL.ashD);              // heavy body
  px.ell(18, 16, 9, 4.5, PAL.ash);
  for (let i = 0; i < 6; i++) {                  // ember mane
    const mx = 9 + i * 3.4;
    px.tri(mx, 8.5, mx + 2.5, 8.5, mx + 1.2, 4.5, i % 2 ? PAL.ember : PAL.emberD);
  }
  px.glowDisc(18, 14, 10, PAL.ember, 45);
  px.line(14, 13, 17, 16, PAL.ember, 1); px.line(20, 12, 22, 15, PAL.emberD, 1); // cracks
  px.disc(29, 11, 5.5, PAL.ashD);                // massive head
  px.rect(31, 11, 5, 4, PAL.ash);                // jaw
  px.px(35, 12, [15, 12, 12]);
  px.tri(25, 8, 27, 8, 26, 4, PAL.ashD);
  px.px(29, 10, PAL.emberH); px.px(31, 10, PAL.ember); // ember eyes
  return px;
}

/* Enemy sheets follow the asset contract: assets/enemies/<id>_<anim>.png,
 * 64x64 frames (art centered bottom), 2-frame strips. The six provisional
 * ids are original names for the ENEMIES.md vertical-slice concepts. */
const E2 = (fn) => [() => fn(0), () => fn(1)];
const ENEMY_SHEETS = [
  { id: 'ash_hound', anim: 'idle', fps: 4, kind: 'idle', frames: E2(f => ashHound(f, 'idle')) },
  { id: 'ash_hound', anim: 'run', fps: 8, kind: 'walk', frames: E2(f => ashHound(f, 'run')) },
  { id: 'ash_hound', anim: 'attack', fps: 10, kind: 'attack', frames: E2(f => ashHound(f, 'attack')) },
  { id: 'rustbound_revenant', anim: 'idle', fps: 4, kind: 'idle', frames: E2(f => rustboundRevenant(f, 'idle')) },
  { id: 'rustbound_revenant', anim: 'walk', fps: 6, kind: 'walk', frames: E2(f => rustboundRevenant(f, 'walk')) },
  { id: 'rustbound_revenant', anim: 'attack', fps: 8, kind: 'attack', frames: E2(f => rustboundRevenant(f, 'attack')) },
  { id: 'cinder_wisp', anim: 'idle', fps: 6, kind: 'idle', data: false, frames: E2(f => cinderWisp(f, 'idle')) },
  { id: 'cinder_wisp', anim: 'attack', fps: 10, kind: 'attack', data: false, frames: E2(f => cinderWisp(f, 'attack')) },
  { id: 'hollow_sentinel', anim: 'idle', fps: 4, kind: 'idle', data: false, frames: E2(f => hollowSentinel(f)) },
  { id: 'vesper_chimer', anim: 'idle', fps: 4, kind: 'idle', data: false, frames: E2(f => vesperChimer(f)) },
  { id: 'mote_swarm', anim: 'idle', fps: 5, kind: 'drift', data: false, frames: E2(f => moteSwarm(f, 'idle')) },
  { id: 'mote_swarm', anim: 'attack', fps: 10, kind: 'attack', data: false, frames: E2(f => moteSwarm(f, 'attack')) },
  { id: 'vellum_phantom', anim: 'idle', fps: 5, kind: 'idle', data: false, frames: E2(f => vellumPhantom(f, 'idle')) },
  { id: 'vellum_phantom', anim: 'attack', fps: 10, kind: 'attack', data: false, frames: E2(f => vellumPhantom(f, 'attack')) },
  { id: 'cinder_mastiff', anim: 'idle', fps: 8, kind: 'walk', data: false, frames: E2(f => cinderMastiff(f)) },
];
function buildEnemies() {
  const index = { enemies: {}, frameContract: '64x64, art centered-bottom' };
  for (const s of ENEMY_SHEETS) {
    const key = `${s.id}_${s.anim}`;
    const sheet = new Px(128, 64);
    s.frames.forEach((fn, i) => {
      const f = fn();
      sheet.blit(f, i * 64 + ((64 - f.w) >> 1), 64 - f.h);
    });
    const rel = `enemies/${key}.png`;
    emit(sheet, rel, { kind: 'enemy' });
    index.enemies[key] = { id: s.id, anim: s.anim, file: `assets/${rel}`, frameWidth: 64, frameHeight: 64, frames: 2, fps: s.fps, kind: s.kind, inData: s.data !== false };
  }
  emitJSON('enemies/enemies.json', index);
}

/* ================= TILESETS — 16x16 tiles, 8x4 sheets ================= */
function bricks(px, ox, oy, cB, cD, cL, mortar, seed, mossy) {
  const R = rng(seed);
  px.rect(ox, oy, 16, 16, mortar);
  for (let r = 0; r < 2; r++) {
    const yy = oy + r * 8, off = r ? -4 : 0;
    for (let b = -1; b < 3; b++) {
      const xx = ox + off + b * 8, v = R();
      const c = v < 0.25 ? cD : v < 0.75 ? cB : cL;
      px.rect(Math.max(ox, xx), yy + 1, 6, 6, c);
      if (mossy && R() < 0.35) px.rect(Math.max(ox, xx), yy + 5, 6, 2, PAL.moss);
    }
  }
  px.speckle(12, [cD, cL], seed + 99, ox, oy, 16, 16);
}
function platTopEdge(px, ox, oy, cL, cD, hi, edge) {
  px.rect(ox, oy, 16, 4, cL);
  px.rect(ox, oy, 16, 1, hi);
  px.rect(ox, oy + 4, 16, 1, cD);
  if (edge === 'left' || edge === 'both') { px.rect(ox, oy, 3, 16, cL); px.rect(ox, oy, 1, 16, hi); }
  if (edge === 'right' || edge === 'both') { px.rect(ox + 13, oy, 3, 16, cL); px.rect(ox + 15, oy, 1, 16, hi); }
}
function platBottom(px, ox, oy, cD, cB) {
  px.rect(ox, oy, 16, 16, cD);
  px.rect(ox, oy + 13, 16, 3, cB);
  px.rect(ox, oy + 13, 16, 1, shadeCol(cB, 1.4));
}
function sideEdge(px, ox, oy, cL, cD, hi, side) {
  px.rect(ox, oy, 16, 16, cD);
  const x = side === 'left' ? ox : ox + 13;
  px.rect(x, oy, 3, 16, cL); px.rect(side === 'left' ? ox : ox + 15, oy, 1, 16, hi);
}

const MG = { b: PAL.stone, d: PAL.stoneD, l: PAL.stoneL, m: shadeCol(PAL.stoneD, 0.65), hi: PAL.stoneH };
function mgTile(i, px, ox, oy) {
  const R = rng(1000 + i);
  switch (i) {
    case 0: case 1: case 2: bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 100 + i); break;
    case 3: bricks(px, ox, oy, MG.d, shadeCol(MG.d, 0.7), MG.b, MG.m, 103); break;
    case 4: bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 104, true); break;
    case 5: bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 105);
      px.line(ox + 3, oy + 2, ox + 9, oy + 10, MG.d, 1); px.line(ox + 9, oy + 10, ox + 6, oy + 14, MG.d, 1); break;
    case 6: px.rect(ox, oy, 16, 16, MG.d); px.speckle(14, [MG.b, MG.m], 106, ox, oy, 16, 16); break;
    case 7: px.rect(ox, oy, 16, 16, MG.m); px.speckle(10, [MG.d], 107, ox, oy, 16, 16); break;
    case 8: bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 108); platTopEdge(px, ox, oy, MG.l, MG.d, PAL.silver, 'left'); break;
    case 9: bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 109); platTopEdge(px, ox, oy, MG.l, MG.d, PAL.silver, null); break;
    case 10: bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 110); platTopEdge(px, ox, oy, MG.l, MG.d, PAL.silver, 'right'); break;
    case 11: sideEdge(px, ox, oy, MG.l, MG.d, PAL.silver, 'left'); break;
    case 12: sideEdge(px, ox, oy, MG.l, MG.d, PAL.silver, 'right'); break;
    case 13: platBottom(px, ox, oy, MG.d, MG.b); px.rect(ox, oy, 3, 16, MG.l); break;
    case 14: platBottom(px, ox, oy, MG.d, MG.b); break;
    case 15: platBottom(px, ox, oy, MG.d, MG.b); px.rect(ox + 13, oy, 3, 16, MG.l); break;
    case 16: // arch jamb left
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 116);
      px.rect(ox + 2, oy, 6, 16, MG.l); px.rect(ox + 2, oy, 6, 2, PAL.silver);
      px.rect(ox + 8, oy, 3, 16, MG.m); break;
    case 17: // arch crown: voussoir band + keystone
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 117);
      px.rect(ox, oy, 16, 6, MG.l);
      for (let v = 0; v < 4; v++) px.line(ox + v * 4 + 2, oy, ox + v * 4, oy + 6, MG.d, 1);
      px.rect(ox + 6, oy, 4, 7, PAL.silver); px.rect(ox + 7, oy, 2, 7, MG.l);
      px.rect(ox, oy + 6, 16, 1, MG.d); break;
    case 18: // arch jamb right (mirror)
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 118);
      px.rect(ox + 8, oy, 6, 16, MG.l); px.rect(ox + 8, oy, 6, 2, PAL.silver);
      px.rect(ox + 5, oy, 3, 16, MG.m); break;
    case 19: { // arched chapel window, moonlit
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 119);
      px.poly([[ox + 4, oy + 14], [ox + 4, oy + 7], [ox + 8, oy + 3], [ox + 12, oy + 7], [ox + 12, oy + 14]], PAL.night1);
      px.poly([[ox + 5, oy + 13], [ox + 5, oy + 8], [ox + 8, oy + 5], [ox + 11, oy + 8], [ox + 11, oy + 13]], PAL.night2);
      px.disc(ox + 8, oy + 8, 2, PAL.moon); // moon seen through glass
      px.line(ox + 8, oy + 4, ox + 8, oy + 13, MG.l, 1);
      px.line(ox + 5, oy + 9, ox + 11, oy + 9, MG.l, 1);
      // silver stone rim around the opening
      px.line(ox + 3, oy + 14, ox + 3, oy + 7, PAL.silver, 1);
      px.line(ox + 3, oy + 7, ox + 8, oy + 2, PAL.silver, 1);
      px.line(ox + 8, oy + 2, ox + 13, oy + 7, PAL.silver, 1);
      px.line(ox + 13, oy + 7, ox + 13, oy + 14, PAL.silver, 1);
      break; }
    case 20: // pillar capital
      px.rect(ox, oy, 16, 16, MG.m);
      px.rect(ox + 1, oy + 6, 14, 10, MG.b);
      px.rect(ox, oy + 3, 16, 3, MG.l); px.rect(ox, oy + 3, 16, 1, PAL.silver);
      for (let f = 0; f < 3; f++) px.line(ox + 5 + f * 3, oy + 7, ox + 5 + f * 3, oy + 15, MG.d, 1);
      break;
    case 21: // pillar shaft
      px.rect(ox, oy, 16, 16, MG.m);
      px.rect(ox + 3, oy, 10, 16, MG.b); px.rect(ox + 3, oy, 2, 16, MG.l);
      for (let f = 0; f < 3; f++) px.line(ox + 6 + f * 3, oy, ox + 6 + f * 3, oy + 16, MG.d, 1);
      break;
    case 22: // pillar base
      px.rect(ox, oy, 16, 16, MG.m);
      px.rect(ox + 3, oy, 10, 10, MG.b);
      px.rect(ox + 1, oy + 10, 14, 6, MG.l); px.rect(ox, oy + 13, 16, 3, MG.d);
      break;
    case 23: { // banner of the Pale Hour: deep blue, silver crescent
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 123);
      px.rect(ox + 2, oy + 1, 12, 2, PAL.woodD); // rod
      px.poly([[ox + 4, oy + 3], [ox + 12, oy + 3], [ox + 12, oy + 14], [ox + 8, oy + 11], [ox + 4, oy + 14]], hex('#1d2a52'));
      px.poly([[ox + 4, oy + 3], [ox + 7, oy + 3], [ox + 7, oy + 13], [ox + 4, oy + 14]], hex('#162040'));
      px.disc(ox + 9, oy + 7, 2.4, PAL.silver); px.disc(ox + 10, oy + 6.4, 2, hex('#1d2a52')); // crescent
      break; }
    case 24: // step up (ascending left->right)
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 124);
      px.poly([[ox, oy + 16], [ox + 16, oy + 16], [ox + 16, oy + 6]], MG.l);
      px.line(ox, oy + 15, ox + 16, oy + 5, PAL.silver, 1); break;
    case 25: // step down
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 125);
      px.poly([[ox, oy + 16], [ox + 16, oy + 16], [ox, oy + 6]], MG.l);
      px.line(ox, oy + 5, ox + 16, oy + 15, PAL.silver, 1); break;
    case 26: // rubble
      px.rect(ox, oy, 16, 16, MG.m);
      px.poly([[ox + 2, oy + 12], [ox + 6, oy + 7], [ox + 9, oy + 12]], MG.b);
      px.poly([[ox + 7, oy + 13], [ox + 12, oy + 8], [ox + 14, oy + 13]], MG.l);
      px.px(ox + 5, oy + 8, MG.l); px.speckle(8, [MG.d], 126, ox, oy + 10, 16, 6); break;
    case 27: // grass tuft (transparent bg)
      for (let b = 0; b < 6; b++) {
        const gx = ox + 3 + b * 2, gh = 4 + ((b * 7) % 4);
        px.line(gx, oy + 15, gx + (b % 2 ? 1 : -1), oy + 15 - gh, b % 2 ? PAL.moss : MG.l, 1);
      }
      break;
    case 28: // wall bracket (iron)
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 128);
      px.rect(ox + 6, oy + 4, 4, 8, PAL.ironD);
      px.line(ox + 6, oy + 4, ox + 12, oy + 4, PAL.iron, 2);
      px.px(ox + 7, oy + 5, PAL.ironL); break;
    case 29: case 30: { // floor flagstones
      const R2 = rng(129 + i);
      px.rect(ox, oy, 16, 16, MG.m);
      for (let fy = 0; fy < 2; fy++) for (let fx = 0; fx < 2; fx++) {
        const c = R2() < 0.5 ? MG.b : MG.l;
        px.rect(ox + fx * 8 + 1, oy + fy * 8 + 1, 6, 6, c);
      }
      px.speckle(8, [MG.d], 130 + i, ox, oy, 16, 16); break; }
    case 31: { // rose window
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 131);
      px.disc(ox + 8, oy + 8, 6, PAL.night2);
      px.ring(ox + 8, oy + 8, 6, MG.l); px.ring(ox + 8, oy + 8, 4, MG.l);
      for (let s = 0; s < 6; s++) {
        const a = s * Math.PI / 3;
        px.line(ox + 8, oy + 8, ox + 8 + Math.cos(a) * 6, oy + 8 + Math.sin(a) * 6, MG.l, 1);
      }
      px.disc(ox + 8, oy + 8, 1.6, PAL.moon);
      break; }
    case 32: // stone inner, cracked
      px.rect(ox, oy, 16, 16, MG.d); px.speckle(14, [MG.b, MG.m], 132, ox, oy, 16, 16);
      px.line(ox + 2, oy + 1, ox + 8, oy + 9, MG.m, 1); px.line(ox + 8, oy + 9, ox + 5, oy + 15, MG.m, 1);
      px.line(ox + 8, oy + 9, ox + 13, oy + 12, MG.m, 1); break;
    case 33: // stone inner, mossy
      px.rect(ox, oy, 16, 16, MG.d); px.speckle(10, [MG.b], 133, ox, oy, 16, 16);
      px.dithRect(ox + 2, oy + 9, 9, 6, PAL.moss, shadeCol(PAL.moss, 0.6));
      px.dithRect(ox + 9, oy + 3, 5, 4, PAL.moss, shadeCol(PAL.moss, 0.7)); break;
    case 34: // platform top, cracked
      bricks(px, ox, oy, MG.b, MG.d, MG.l, MG.m, 134); platTopEdge(px, ox, oy, MG.l, MG.d, PAL.silver, null);
      px.line(ox + 4, oy + 1, ox + 9, oy + 8, MG.d, 1); px.line(ox + 9, oy + 8, ox + 7, oy + 13, MG.d, 1); break;
    case 35: // moss patch decal (transparent bg)
      for (let b = 0; b < 9; b++) {
        const mx = ox + 2 + ((b * 5) % 12), mh = 3 + ((b * 3) % 4);
        px.line(mx, oy + 15, mx + (b % 2 ? 1 : -1), oy + 15 - mh, b % 3 ? PAL.moss : shadeCol(PAL.moss, 0.6), 1);
      }
      px.dithRect(ox + 3, oy + 12, 10, 3, PAL.moss, shadeCol(PAL.moss, 0.55)); break;
    case 36: // big rubble decal (transparent bg)
      px.poly([[ox + 1, oy + 14], [ox + 6, oy + 7], [ox + 10, oy + 14]], MG.b);
      px.poly([[ox + 6, oy + 15], [ox + 12, oy + 9], [ox + 15, oy + 15]], MG.l);
      px.poly([[ox + 9, oy + 15], [ox + 11, oy + 12], [ox + 13, oy + 15]], MG.d);
      px.px(ox + 6, oy + 8, MG.l); px.px(ox + 12, oy + 10, MG.b); break;
    case 37: // floor slab, cracked
      px.rect(ox, oy, 16, 16, MG.m);
      px.rect(ox + 1, oy + 1, 14, 14, MG.b);
      px.line(ox + 1, oy + 8, ox + 15, oy + 8, MG.d, 1); px.line(ox + 8, oy + 1, ox + 8, oy + 15, MG.d, 1);
      px.line(ox + 3, oy + 3, ox + 7, oy + 7, MG.m, 1); px.line(ox + 10, oy + 9, ox + 13, oy + 13, MG.m, 1); break;
    case 38: // broken arch fragment decal (transparent bg)
      px.poly([[ox + 2, oy + 16], [ox + 2, oy + 8], [ox + 6, oy + 4], [ox + 5, oy + 9], [ox + 9, oy + 7], [ox + 8, oy + 12], [ox + 12, oy + 11], [ox + 10, oy + 16]], MG.l);
      px.poly([[ox + 2, oy + 16], [ox + 2, oy + 8], [ox + 5, oy + 5], [ox + 4, oy + 16]], MG.b);
      px.speckle(5, [PAL.moss], 138, ox + 2, oy + 4, 10, 4); break;
    case 39: // grass tuft, pale variant (transparent bg)
      for (let b = 0; b < 5; b++) {
        const gx = ox + 4 + b * 2, gh = 5 + ((b * 5) % 5);
        px.line(gx, oy + 15, gx + (b % 2 ? -1 : 1), oy + 15 - gh, b % 2 ? shadeCol(PAL.moss, 0.8) : PAL.star, 1);
      }
      break;
  }
}
const MG_TILE_NAMES = ['stone_brick_a','stone_brick_b','stone_brick_c','stone_brick_dark','stone_brick_moss','stone_brick_cracked','stone_inner','stone_inner_dark','plat_top_left','plat_top','plat_top_right','plat_edge_left','plat_edge_right','plat_bottom_left','plat_bottom','plat_bottom_right','arch_left','arch_top','arch_right','window_arch','pillar_top','pillar_mid','pillar_base','banner','step_up','step_down','rubble','grass_tuft','wall_bracket','floor_slab_a','floor_slab_b','rose_window','stone_inner_cracked','stone_inner_moss','plat_top_cracked','moss_patch','rubble_big','floor_slab_cracked','arch_broken','grass_tuft_b'];

const HK = { b: PAL.basalt, d: PAL.basaltD, l: PAL.basaltL, m: shadeCol(PAL.basaltD, 0.6), hi: PAL.basaltH };
function hkTile(i, px, ox, oy) {
  const R = rng(2000 + i);
  switch (i) {
    case 0: case 1: case 2: bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 200 + i); break;
    case 3: bricks(px, ox, oy, HK.d, shadeCol(HK.d, 0.7), HK.b, HK.m, 203); break;
    case 4: bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 204);
      px.line(ox + 2, oy + 3, ox + 8, oy + 12, HK.d, 1); px.line(ox + 8, oy + 12, ox + 13, oy + 9, HK.d, 1); break;
    case 5: // rubble fill
      px.rect(ox, oy, 16, 16, HK.m);
      px.poly([[ox + 1, oy + 13], [ox + 5, oy + 8], [ox + 8, oy + 13]], HK.b);
      px.poly([[ox + 6, oy + 14], [ox + 11, oy + 9], [ox + 14, oy + 14]], HK.l);
      px.speckle(10, [PAL.ashD], 205, ox, oy + 8, 16, 8); break;
    case 6: { // riveted iron plate
      px.rect(ox, oy, 16, 16, PAL.ironD);
      px.rect(ox + 1, oy + 1, 14, 14, PAL.iron);
      px.rect(ox + 1, oy + 1, 14, 2, PAL.ironL);
      for (const [rx, ry] of [[3, 3], [12, 3], [3, 12], [12, 12]]) { px.px(ox + rx, oy + ry, PAL.ironL); px.px(ox + rx, oy + ry + 1, PAL.ironD); }
      px.speckle(8, [PAL.rust], 206, ox, oy, 16, 16); break; }
    case 7: // iron trim band
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 207);
      px.rect(ox, oy + 6, 16, 4, PAL.ironD); px.rect(ox, oy + 6, 16, 4, PAL.iron);
      px.rect(ox, oy + 6, 16, 1, PAL.ironL);
      for (let rx = 2; rx < 16; rx += 5) px.px(ox + rx, oy + 8, PAL.ironL); break;
    case 8: bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 208);
      platTopEdge(px, ox, oy, PAL.iron, PAL.ironD, PAL.ironL, 'left');
      px.rect(ox, oy, 16, 4, PAL.ironD); px.rect(ox, oy, 16, 3, PAL.iron); px.rect(ox, oy, 16, 1, PAL.ironL); break;
    case 9: bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 209);
      px.rect(ox, oy, 16, 4, PAL.ironD); px.rect(ox, oy, 16, 3, PAL.iron); px.rect(ox, oy, 16, 1, PAL.ironL); break;
    case 10: bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 210);
      px.rect(ox, oy, 16, 4, PAL.ironD); px.rect(ox, oy, 16, 3, PAL.iron); px.rect(ox, oy, 16, 1, PAL.ironL);
      px.rect(ox + 13, oy, 3, 16, PAL.iron); break;
    case 11: sideEdge(px, ox, oy, HK.l, HK.d, HK.hi, 'left'); break;
    case 12: sideEdge(px, ox, oy, HK.l, HK.d, HK.hi, 'right'); break;
    case 13: platBottom(px, ox, oy, HK.d, HK.b); px.rect(ox, oy, 3, 16, HK.l); break;
    case 14: platBottom(px, ox, oy, HK.d, HK.b); break;
    case 15: platBottom(px, ox, oy, HK.d, HK.b); px.rect(ox + 13, oy, 3, 16, HK.l); break;
    case 16: // wood beam horizontal
      px.rect(ox, oy, 16, 16, HK.m);
      px.rect(ox, oy + 4, 16, 8, PAL.wood); px.rect(ox, oy + 4, 16, 2, PAL.woodL);
      px.line(ox, oy + 8, ox + 16, oy + 8, PAL.woodD, 1);
      px.rect(ox + 3, oy + 4, 2, 8, PAL.ironD); px.rect(ox + 11, oy + 4, 2, 8, PAL.ironD); break;
    case 17: // wood beam vertical
      px.rect(ox, oy, 16, 16, HK.m);
      px.rect(ox + 4, oy, 8, 16, PAL.wood); px.rect(ox + 4, oy, 2, 16, PAL.woodL);
      px.rect(ox + 3, oy + 3, 2, 10, PAL.ironD); px.rect(ox + 11, oy + 3, 2, 10, PAL.ironD); break;
    case 18: // beam joint
      px.rect(ox, oy, 16, 16, HK.m);
      px.rect(ox, oy + 4, 16, 8, PAL.wood); px.rect(ox + 4, oy, 8, 16, PAL.woodD);
      px.rect(ox + 4, oy + 4, 8, 8, PAL.ironD); px.rect(ox + 5, oy + 5, 6, 6, PAL.iron);
      px.px(ox + 8, oy + 8, PAL.ironL); break;
    case 19: // broken arch left
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 219);
      px.poly([[ox + 2, oy + 16], [ox + 2, oy + 6], [ox + 6, oy + 2], [ox + 5, oy + 6], [ox + 9, oy + 4], [ox + 8, oy + 9], [ox + 12, oy + 8], [ox + 10, oy + 16]], HK.l);
      px.poly([[ox + 12, oy + 16], [ox + 12, oy + 8], [ox + 16, oy + 8], [ox + 16, oy + 16]], [8, 6, 12]); break;
    case 20: // broken arch right (mirror)
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 220);
      px.poly([[ox + 14, oy + 16], [ox + 14, oy + 6], [ox + 10, oy + 2], [ox + 11, oy + 6], [ox + 7, oy + 4], [ox + 8, oy + 9], [ox + 4, oy + 8], [ox + 6, oy + 16]], HK.l);
      px.poly([[ox, oy + 16], [ox + 4, oy + 8], [ox, oy + 8]], [8, 6, 12]); break;
    case 21: // grate
      px.rect(ox, oy, 16, 16, [8, 6, 12]);
      for (let g = 0; g < 4; g++) { px.line(ox + 2 + g * 4, oy, ox + 2 + g * 4, oy + 16, PAL.iron, 1); px.line(ox, oy + 2 + g * 4, ox + 16, oy + 2 + g * 4, PAL.iron, 1); }
      px.line(ox + 2, oy, ox + 2, oy + 16, PAL.ironL, 1); break;
    case 22: // chain anchor
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 222);
      px.rect(ox + 5, oy, 6, 3, PAL.ironD);
      px.ell(ox + 8, oy + 6, 2.4, 1.8, PAL.iron); px.ell(ox + 8, oy + 6, 1.4, 0.9, HK.m);
      px.ell(ox + 8, oy + 11, 2.4, 1.8, PAL.iron); break;
    case 23: // chain links
      px.rect(ox, oy, 16, 16, HK.m);
      for (let cy = 2; cy < 16; cy += 5) { px.ell(ox + 8, oy + cy, 2.6, 2, PAL.iron); px.ell(ox + 8, oy + cy, 1.5, 1, HK.m); }
      break;
    case 24: { // carved slab: original angular rune, faint violet inlay
      px.rect(ox, oy, 16, 16, HK.m);
      px.rect(ox + 2, oy + 2, 12, 12, HK.l); px.rect(ox + 2, oy + 2, 12, 2, HK.hi);
      const rx = ox + 8, ry = oy + 8;
      px.line(rx - 3, ry - 3, rx, ry, hex('#8a6ae0'), 1); px.line(rx, ry, rx + 3, ry - 3, hex('#8a6ae0'), 1);
      px.line(rx - 3, ry + 3, rx, ry, hex('#8a6ae0'), 1); px.line(rx, ry, rx + 3, ry + 3, hex('#8a6ae0'), 1);
      px.line(rx, ry - 3, rx, ry + 3, hex('#8a6ae0'), 1);
      px.blend(rx, ry, hex('#9a6aff'), 90); break; }
    case 25: { // tattered banner: torn violet, ember diamond
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 225);
      px.rect(ox + 2, oy + 1, 12, 2, PAL.ironD);
      px.poly([[ox + 4, oy + 3], [ox + 12, oy + 3], [ox + 11, oy + 9], [ox + 12, oy + 15], [ox + 9, oy + 12], [ox + 6, oy + 15], [ox + 4, oy + 10]], hex('#2c1a3e'));
      px.line(ox + 8, oy + 6, ox + 10, oy + 8, PAL.ember, 1); px.line(ox + 10, oy + 8, ox + 8, oy + 10, PAL.ember, 1);
      px.line(ox + 8, oy + 10, ox + 6, oy + 8, PAL.ember, 1); px.line(ox + 6, oy + 8, ox + 8, oy + 6, PAL.ember, 1); break; }
    case 26: // ash pile (transparent bg)
      px.ell(ox + 8, oy + 12, 7, 3.5, PAL.ashD);
      px.ell(ox + 8, oy + 11, 5, 2.5, PAL.ash);
      px.speckle(8, [PAL.emberD], 226, ox + 3, oy + 9, 10, 4); break;
    case 27: // bones (transparent bg)
      px.line(ox + 4, oy + 12, ox + 9, oy + 10, PAL.parchment, 2);
      px.disc(ox + 4, oy + 12, 1.4, PAL.parchment); px.disc(ox + 9, oy + 10, 1.4, PAL.parchment);
      px.line(ox + 10, oy + 13, ox + 13, oy + 8, PAL.parchmentD, 2);
      px.disc(ox + 11, oy + 6, 1.8, PAL.parchment); break;
    case 28: { // ember sconce
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 228);
      px.rect(ox + 6, oy + 7, 4, 6, PAL.ironD);
      px.glowDisc(ox + 8, oy + 5, 6, PAL.ember, 70);
      px.disc(ox + 8, oy + 6, 2, PAL.emberD); px.disc(ox + 8, oy + 5, 1.3, PAL.emberH); break; }
    case 29: case 30: { // basalt floor slabs with ash dusting
      const R2 = rng(229 + i);
      px.rect(ox, oy, 16, 16, HK.m);
      for (let fy = 0; fy < 2; fy++) for (let fx = 0; fx < 2; fx++)
        px.rect(ox + fx * 8 + 1, oy + fy * 8 + 1, 6, 6, R2() < 0.5 ? HK.b : HK.d);
      px.speckle(10, [PAL.ashD], 230 + i, ox, oy, 16, 16); break; }
    case 31: // collapsed pillar
      px.rect(ox, oy, 16, 16, HK.m);
      px.rect(ox + 2, oy + 8, 12, 8, HK.b);
      px.poly([[ox + 2, oy + 8], [ox + 6, oy + 3], [ox + 8, oy + 8]], HK.l);
      px.poly([[ox + 8, oy + 8], [ox + 11, oy + 4], [ox + 14, oy + 8]], HK.l);
      px.line(ox + 2, oy + 12, ox + 14, oy + 12, HK.d, 1); break;
    case 32: // basalt cracked variant
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 232);
      px.line(ox + 3, oy + 2, ox + 9, oy + 11, HK.d, 1); px.line(ox + 9, oy + 11, ox + 6, oy + 15, HK.d, 1);
      px.line(ox + 9, oy + 11, ox + 14, oy + 13, HK.d, 1);
      px.blend(ox + 6, oy + 8, PAL.emberD, 40); break;
    case 33: // basalt rubble variant
      px.rect(ox, oy, 16, 16, HK.m);
      px.poly([[ox + 1, oy + 14], [ox + 5, oy + 9], [ox + 8, oy + 14]], HK.l);
      px.poly([[ox + 7, oy + 15], [ox + 11, oy + 10], [ox + 14, oy + 15]], HK.b);
      px.speckle(10, [PAL.ashD, PAL.emberD], 233, ox, oy + 8, 16, 8); break;
    case 34: // ash drift decal (transparent bg)
      px.ell(ox + 8, oy + 13, 7, 2.6, PAL.ashD, 200);
      px.ell(ox + 8, oy + 12, 5, 1.8, PAL.ash, 200);
      px.speckle(6, [PAL.ash], 234, ox + 2, oy + 9, 12, 5); break;
    case 35: // ember crack decal (transparent bg)
      px.line(ox + 2, oy + 12, ox + 7, oy + 8, PAL.emberD, 1);
      px.line(ox + 7, oy + 8, ox + 11, oy + 11, PAL.ember, 1);
      px.line(ox + 11, oy + 11, ox + 14, oy + 9, PAL.emberD, 1);
      px.blend(ox + 7, oy + 8, PAL.ember, 90); px.blend(ox + 11, oy + 11, PAL.emberH, 110);
      px.glowDisc(ox + 9, oy + 10, 5, PAL.ember, 40); break;
    case 36: // scattered bones decal (transparent bg)
      px.line(ox + 3, oy + 11, ox + 8, oy + 9, PAL.parchmentD, 2);
      px.disc(ox + 3, oy + 11, 1.4, PAL.parchmentD); px.disc(ox + 8, oy + 9, 1.4, PAL.parchmentD);
      px.line(ox + 10, oy + 12, ox + 12, oy + 7, PAL.parchment, 1);
      px.disc(ox + 12, oy + 6, 1.5, PAL.parchment); break;
    case 37: // iron platform top, cracked
      bricks(px, ox, oy, HK.b, HK.d, HK.l, HK.m, 237);
      px.rect(ox, oy, 16, 4, PAL.ironD); px.rect(ox, oy, 16, 3, PAL.iron); px.rect(ox, oy, 16, 1, PAL.ironL);
      px.line(ox + 5, oy + 1, ox + 9, oy + 9, PAL.ironD, 1); px.line(ox + 9, oy + 9, ox + 7, oy + 14, PAL.ironD, 1); break;
    case 38: // basalt floor slab, cracked
      px.rect(ox, oy, 16, 16, HK.m);
      px.rect(ox + 1, oy + 1, 14, 14, HK.b);
      px.line(ox + 1, oy + 8, ox + 15, oy + 8, HK.d, 1); px.line(ox + 8, oy + 1, ox + 8, oy + 15, HK.d, 1);
      px.line(ox + 2, oy + 4, ox + 6, oy + 8, HK.l, 1); px.line(ox + 11, oy + 8, ox + 14, oy + 12, HK.l, 1);
      px.speckle(6, [PAL.ashD], 238, ox, oy, 16, 16); break;
    case 39: // loose chain decal (transparent bg)
      for (let cy = 1; cy < 15; cy += 4) { px.ell(ox + 8, oy + cy, 2.2, 1.7, PAL.iron); px.ell(ox + 8, oy + cy, 1.2, 0.8, [8, 6, 12]); }
      px.rect(ox + 5, oy, 6, 2, PAL.ironD); break;
  }
}
const HK_TILE_NAMES = ['basalt_brick_a','basalt_brick_b','basalt_brick_c','basalt_dark','basalt_cracked','basalt_rubble','iron_plate','iron_trim_h','plat_top_left_iron','plat_top_iron','plat_top_right_iron','plat_edge_left','plat_edge_right','plat_bottom_left','plat_bottom','plat_bottom_right','beam_h','beam_v','beam_joint','arch_broken_left','arch_broken_right','grate','chain_top','chain_mid','carved_slab','tattered_banner','ash_pile','bones','sconce_ember','floor_basalt_a','floor_basalt_b','collapsed_pillar','basalt_cracked_b','basalt_rubble_b','ash_patch','ember_crack','bones_scattered','plat_top_iron_cracked','floor_basalt_cracked','chain_loose'];

/* Hollow Keep name aliases: Room.js paints with region-agnostic names, so the
 * keep tileset exposes the same names pointing at its own tile indices. */
const HK_TILE_ALIASES = {
  plat_top_left: 'plat_top_left_iron', plat_top: 'plat_top_iron', plat_top_right: 'plat_top_right_iron',
  stone_inner: 'basalt_brick_a', stone_brick_cracked: 'basalt_cracked',
};

function buildTilesets() {
  const defs = [
    { id: 'moonlit_gate', painter: mgTile, names: MG_TILE_NAMES },
    { id: 'hollow_keep', painter: hkTile, names: HK_TILE_NAMES, aliases: HK_TILE_ALIASES },
  ];
  for (const t of defs) {
    const sheet = new Px(128, 80);
    for (let i = 0; i < 40; i++) t.painter(i, sheet, (i % 8) * 16, ((i / 8) | 0) * 16);
    const rel = `tilesets/${t.id}_tiles.png`;
    emit(sheet, rel, { kind: 'tileset' });
    const tiles = {};
    t.names.forEach((n, i) => tiles[n] = { index: i, x: (i % 8) * 16, y: ((i / 8) | 0) * 16 });
    for (const [alias, target] of Object.entries(t.aliases ?? {})) tiles[alias] = { ...tiles[target] };
    emitJSON(`tilesets/${t.id}_tiles.json`, { tileset: t.id, file: `assets/${rel}`, tileWidth: 16, tileHeight: 16, columns: 8, tileCount: 40, tiles });
  }
}

/* ================= PROPS ================= */
function propCandle(frame) {
  const px = new Px(8, 16), fl = frame ? 1 : 0;
  px.rect(1, 13, 6, 2, bronzeD); px.rect(2, 12, 4, 1, bronze); // holder
  px.rect(3, 5, 2, 8, PAL.candle); px.rect(3, 5, 1, 8, PAL.candleD); // wax + drip
  px.px(4, 4, PAL.candleD);
  px.glowDisc(4, 2, 5, PAL.flame, 80);
  px.disc(4 + fl, 2, 1.8, PAL.flameD); px.disc(4 + fl, 1.6, 1, PAL.flame); px.px(4 + fl, 1, PAL.flameH);
  return px;
}
function propUrn() {
  const px = new Px(16, 20);
  px.rect(5, 1, 6, 3, PAL.basaltL); px.rect(4, 3, 8, 2, PAL.basaltH); // rim/neck
  px.ell(8, 11, 6, 7, PAL.basalt); px.ell(6.5, 10, 4, 5.5, PAL.basaltL); // body + shade
  px.line(11, 6, 12, 15, PAL.basaltH, 1); // rim light
  px.line(6, 8, 8, 12, PAL.basaltD, 1); px.line(8, 12, 6, 16, PAL.basaltD, 1); // crack
  px.rect(5, 17, 6, 2, PAL.basaltD); // foot
  return px;
}
function propChandelier() {
  const px = new Px(32, 24);
  px.line(16, 0, 16, 4, PAL.ironD, 2);
  px.line(16, 4, 6, 12, PAL.ironD, 1); px.line(16, 4, 26, 12, PAL.ironD, 1);
  px.ell(16, 14, 11, 4, PAL.ironD); px.ell(16, 13.4, 11, 4, PAL.iron);
  for (const cx of [7, 12, 16, 20, 25]) {
    px.rect(cx - 1, 6, 2, 5, PAL.candle);
    px.glowDisc(cx, 4, 4, PAL.flame, 60);
    px.disc(cx, 4, 1.4, PAL.flame); px.px(cx, 3, PAL.flameH);
  }
  return px;
}
function propBrazier(frame) {
  const px = new Px(16, 24), fl = frame ? 1 : -1;
  px.line(8, 14, 5, 23, PAL.ironD, 2); px.line(8, 14, 11, 23, PAL.ironD, 2); // stand
  px.rect(3, 21, 10, 2, PAL.ironD);
  px.ell(8, 12, 6.5, 3.5, PAL.ironD); px.ell(8, 11.4, 6.5, 3.5, PAL.iron); // bowl
  px.glowDisc(8, 7, 8, PAL.ember, 80);
  px.disc(8, 8, 3.4, PAL.emberD); px.disc(8 + fl, 7, 2.4, PAL.ember); px.disc(8 + fl, 6, 1.3, PAL.emberH);
  const R = rng(55 + frame);
  for (let i = 0; i < 3; i++) px.px(5 + R() * 7, 2 + R() * 3, PAL.emberH);
  return px;
}
function propTorchWall(frame) { // wall-mounted torch, 2-frame flicker
  const px = new Px(16, 22), fl = frame ? 1 : -1;
  px.rect(1, 9, 5, 6, PAL.ironD); // wall plate
  px.rect(1, 9, 5, 1, PAL.ironL); px.px(2, 12, PAL.ironL); px.px(4, 12, PAL.ironL);
  px.line(5, 12, 10, 16, PAL.ironD, 2); // angled arm
  px.line(10, 16, 10, 21, PAL.woodD, 3); // handle
  px.rect(8, 12, 4, 3, [30, 20, 12]);  // wrap
  px.glowDisc(10, 7, 7, PAL.flame, 70);
  px.tri(10, 2, 12 + fl, 8, 8 + fl, 8, PAL.flame); // teardrop flame
  px.disc(10 + fl, 7, 1.8, PAL.flameH);
  px.disc(10, 9, 1.6, PAL.flameD);
  return px;
}
function propDoor(frame) { // frame 0 = closed, 1 = open
  const px = new Px(24, 40);
  px.rect(0, 0, 24, 40, MG.d); px.rect(2, 0, 20, 40, MG.b); // stone surround
  px.rect(2, 0, 20, 3, MG.l); px.rect(2, 0, 20, 1, PAL.silver);
  if (!frame) {
    px.rect(5, 3, 14, 37, PAL.woodD); // closed door
    for (let p = 0; p < 3; p++) { px.rect(6 + p * 5, 4, 3, 35, PAL.wood); px.line(6 + p * 5, 4, 6 + p * 5, 39, PAL.woodD, 1); }
    px.rect(5, 12, 14, 3, PAL.ironD); px.rect(5, 28, 14, 3, PAL.ironD); // bands
    px.ring(15, 22, 2.4, PAL.ironL); // ring handle
  } else {
    px.rect(5, 3, 14, 37, [6, 5, 10]); // dark opening
    px.rect(5, 3, 3, 37, PAL.wood); px.rect(5, 3, 3, 37, PAL.woodD); // door swung edge-on
    px.line(5, 3, 5, 40, PAL.woodL, 1);
    px.blend(12, 20, PAL.lanternGlow, 40);
  }
  return px;
}
function propCrate() {
  const px = new Px(16, 16);
  px.rect(0, 0, 16, 16, PAL.woodD);
  px.rect(1, 1, 14, 14, PAL.wood);
  px.line(1, 1, 15, 15, PAL.woodD, 2); px.line(15, 1, 1, 15, PAL.woodD, 2); // cross brace
  px.rect(0, 0, 16, 2, PAL.woodD); px.rect(0, 14, 16, 2, PAL.woodD);
  px.rect(0, 0, 2, 16, PAL.woodD); px.rect(14, 0, 2, 16, PAL.woodD); // frame
  px.line(1, 1, 14, 1, PAL.woodL, 1); px.line(1, 1, 1, 14, PAL.woodL, 1);
  for (const [nx, ny] of [[3, 3], [12, 3], [3, 12], [12, 12]]) px.px(nx, ny, PAL.ironD);
  return px;
}
function propBarrel() {
  const px = new Px(16, 20);
  px.ell(8, 9, 6.5, 8, PAL.wood); px.ell(6, 9, 4.5, 7.5, PAL.woodL);
  for (let s = -1; s <= 1; s++) px.line(8 + s * 4, 2, 8 + s * 4, 16, PAL.woodD, 1); // staves
  px.rect(1, 4, 14, 2, PAL.ironD); px.rect(1, 13, 14, 2, PAL.ironD); // hoops
  px.px(2, 4, PAL.ironL); px.px(2, 13, PAL.ironL);
  px.ell(8, 2, 5.5, 1.8, PAL.woodD); px.ell(8, 2, 4, 1.2, PAL.woodL);
  return px;
}
function propSignpost() {
  const px = new Px(16, 24);
  px.rect(7, 4, 2, 20, PAL.woodD); px.line(7, 4, 7, 24, PAL.woodL, 1);
  px.poly([[9, 6], [15, 6], [15, 10], [9, 10]], PAL.wood); // right board
  px.tri(15, 6, 18 - 2, 8, 15, 10, PAL.wood);
  px.line(9, 6, 15, 6, PAL.woodL, 1);
  px.poly([[7, 12], [1, 12], [1, 16], [7, 16]], PAL.woodD); // left board
  px.tri(1, 12, -1 + 2, 14, 1, 16, PAL.woodD);
  px.line(2, 14, 6, 14, PAL.wood, 1); px.line(10, 8, 14, 8, PAL.woodD, 1); // carved grooves
  return px;
}
function propDais(frame) { // teleport dais, rune pulse
  const px = new Px(32, 16), pu = frame ? 1 : 0;
  px.ell(16, 11, 14, 4.5, PAL.basaltD); px.ell(16, 10.4, 14, 4.5, PAL.basalt);
  px.ell(16, 10, 10, 3, PAL.basaltL);
  px.ring(16, 10, 8 - pu * 0.6, hex('#8a6ae0'));
  px.ring(16, 10, 4.5, hex('#6a4ae0'));
  for (let s = 0; s < 6; s++) {
    const a = s * Math.PI / 3 + pu * 0.2;
    px.px(16 + Math.cos(a) * 6.2, 10 + Math.sin(a) * 2.4, hex('#b49aff'));
  }
  px.blend(16, 10, hex('#9a6aff'), 50 + pu * 40);
  return px;
}
function buildProps() {
  const defs = [
    { id: 'candle', w: 8, h: 16, frames: [propCandle(0), propCandle(1)], fps: 6 },
    { id: 'urn', w: 16, h: 20, frames: [propUrn()], fps: 0 },
    { id: 'chandelier', w: 32, h: 24, frames: [propChandelier()], fps: 0 },
    { id: 'brazier', w: 16, h: 24, frames: [propBrazier(0), propBrazier(1)], fps: 8 },
    { id: 'door', w: 24, h: 40, frames: [propDoor(0), propDoor(1)], fps: 0 },
    { id: 'crate', w: 16, h: 16, frames: [propCrate()], fps: 0 },
    { id: 'barrel', w: 16, h: 20, frames: [propBarrel()], fps: 0 },
    { id: 'signpost', w: 16, h: 24, frames: [propSignpost()], fps: 0 },
    { id: 'teleport_dais', w: 32, h: 16, frames: [propDais(0), propDais(1)], fps: 4 },
    { id: 'torch_wall', w: 16, h: 22, frames: [propTorchWall(0), propTorchWall(1)], fps: 7 },
  ];
  const index = { props: {} };
  for (const d of defs) {
    const sheet = new Px(d.w * d.frames.length, d.h);
    d.frames.forEach((f, i) => sheet.blit(f, i * d.w, 0));
    const rel = `environments/props/${d.id}.png`;
    emit(sheet, rel, { kind: 'prop' });
    index.props[d.id] = { file: `assets/${rel}`, frameWidth: d.w, frameHeight: d.h, frames: d.frames.length, fps: d.fps };
  }
  emitJSON('environments/props/props.json', index);
}

/* ================= PICKUPS + ITEM/WEAPON ICONS ================= */
function itemCoin(frame) {
  const px = new Px(12, 12), w = frame ? 6 : 10;
  const cx = 6;
  px.glowDisc(cx, 6, 6, PAL.gold, 40);
  px.ell(cx, 6, w / 2, 5, PAL.goldD); px.ell(cx, 5.6, w / 2 - 1, 4, PAL.gold);
  px.ell(cx - 1, 4.6, w / 2 - 2.5, 2.6, PAL.goldL);
  if (!frame) { px.disc(cx, 6, 2, PAL.goldD); px.disc(cx + 0.6, 5.6, 1.6, PAL.gold); } // crescent stamp
  return px;
}
function itemHeart() {
  const px = new Px(12, 12);
  px.disc(3.6, 4.6, 2.6, PAL.heart); px.disc(8.4, 4.6, 2.6, PAL.heart);
  px.tri(1.4, 5.4, 10.6, 5.4, 6, 11, PAL.heart);
  px.disc(3.4, 3.8, 1.2, PAL.heartL); px.tri(2.6, 6, 5, 6, 3.4, 9, PAL.heartD);
  px.px(3, 3, PAL.heartL);
  return px;
}
function itemManaShard() {
  const px = new Px(12, 12);
  px.glowDisc(6, 6, 6, PAL.mana, 50);
  px.poly([[6, 1], [10, 6], [6, 11], [2, 6]], PAL.mana);
  px.poly([[6, 1], [8, 4], [6, 11], [4.6, 6]], PAL.manaL);
  px.line(6, 1, 6, 11, PAL.manaD, 1);
  return px;
}
function itemKey() {
  const px = new Px(16, 12);
  px.ring(3, 6, 2.6, PAL.key); px.ring(3, 6, 2.6, PAL.keyL);
  px.rect(5, 5, 8, 2, PAL.key); px.rect(5, 5, 8, 1, PAL.keyL);
  px.rect(11, 7, 2, 3, PAL.key); px.rect(8, 7, 2, 2, PAL.keyD);
  return px;
}
function itemFlask(liquid, liquidD) {
  const px = new Px(12, 16);
  px.rect(5, 0, 2, 3, PAL.woodD); // cork
  px.poly([[4, 3], [8, 3], [10, 9], [9, 14], [3, 14], [2, 9]], [150, 170, 200, 255]);
  px.poly([[4.6, 6], [7.4, 6], [8.6, 9], [8, 13], [4, 13], [3.4, 9]], liquid);
  px.line(4.6, 6.6, 7.4, 6.6, shadeCol(liquid, 1.35), 1);
  px.line(3.4, 4, 3, 12, [220, 235, 245, 255], 1); // glass shine
  return px;
}
function itemWaybread() { // small golden loaf
  const px = new Px(20, 14);
  px.ell(10, 8, 9, 5.5, hex('#b98a3e'));
  px.ell(10, 7, 9, 5, hex('#d9a94e'));
  px.ell(8, 6, 4, 2.4, hex('#e8c06a')); // top highlight
  for (const sx of [6, 10, 14]) px.line(sx, 5, sx + 1, 9, hex('#8a6230'), 1); // slashes
  px.ell(10, 11, 8, 2.6, hex('#8a6230')); // bottom shade
  return px;
}
function weaponIcon(kind) {
  const px = new Px(24, 10);
  if (kind === 'recruit_blade') { // plain arming sword, diagonal
    px.line(2, 8, 5, 5, PAL.grip, 3);
    px.line(3, 6, 8, 1, PAL.guard, 2);
    px.line(6, 4, 20, 0, PAL.blade, 3);
    px.line(6, 3, 20, -1, PAL.bladeH, 1);
    px.tri(20, -1, 23, 1, 20, 2, PAL.blade);
  } else { // moonsteel sabre: curved, moonlit edge
    px.glowDisc(14, 5, 8, PAL.mana, 40);
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, x = 5 + t * 16, y = 7 - Math.sin(t * 1.2) * 5 - t * 1.5;
      px.disc(x, y, 1.7, PAL.blade); px.px(x, y - 1, PAL.bladeH);
    }
    px.line(2, 8, 6, 6, PAL.grip, 3);
    px.disc(5, 6.6, 2, PAL.guard);
    px.disc(19.5, 1.6, 1.2, PAL.moon);
  }
  return px;
}
function pad32(src) { const px = new Px(32, 32); px.blit(src, (32 - src.w) >> 1, (32 - src.h) >> 1); return px; }
/* original icons for the remaining data icon fields (armor/accessories/abilities) */
function iconCoat() {
  const px = new Px(32, 32);
  px.poly([[10, 6], [22, 6], [24, 27], [8, 27]], PAL.coatD);
  px.poly([[13, 6], [19, 6], [20, 27], [12, 27]], PAL.coat);
  px.poly([[13, 6], [19, 6], [18, 13], [14, 13]], PAL.liningD);
  px.line(16, 6, 16, 27, PAL.coatL, 1);
  px.line(10, 7, 8, 26, PAL.coatRim, 1);
  return px;
}
function iconHood() {
  const px = new Px(32, 32);
  px.poly([[8, 27], [8, 14], [16, 5], [24, 14], [24, 27]], PAL.coatD);
  px.poly([[11, 27], [11, 15], [16, 9], [21, 15], [21, 27]], PAL.coat);
  px.poly([[13, 27], [13, 17], [16, 13], [19, 17], [19, 27]], [9, 7, 15]);
  px.line(11, 15, 16, 9, PAL.coatRim, 1);
  return px;
}
function iconCharm() {
  const px = new Px(32, 32);
  px.glowDisc(16, 18, 10, PAL.mana, 50);
  px.ring(16, 6, 2.5, PAL.gold);
  px.line(16, 8, 16, 11, PAL.gold, 1);
  archSeg(px, 16, 18, 7, -70, 70, 4, PAL.manaL); // crescent
  px.disc(16, 18, 2, PAL.manaD);
  return px;
}
function iconSignet() {
  const px = new Px(32, 32);
  px.ring(16, 19, 8, PAL.iron); px.ring(16, 19, 8, PAL.ironL);
  px.rect(11, 4, 10, 8, PAL.ironD); px.rect(12, 5, 8, 6, PAL.iron);
  px.line(13, 6, 19, 10, PAL.rust, 1); px.line(19, 6, 13, 10, PAL.rust, 1);
  return px;
}
function iconLeap() {
  const px = new Px(32, 32);
  px.glowDisc(16, 8, 9, PAL.moon, 40);
  px.disc(16, 7, 4, PAL.moon);
  px.disc(15, 6, 1.4, PAL.moonDim); px.disc(17.5, 8, 1, PAL.moonDim); // craters
  for (let i = 0; i < 3; i++) {
    const y = 28 - i * 5;
    px.line(10, y, 16, y - 4, PAL.slash, 2); px.line(16, y - 4, 22, y, PAL.slash, 2);
  }
  return px;
}
function iconDash() {
  const px = new Px(32, 32);
  for (let i = 0; i < 3; i++) { const y = 10 + i * 6; px.line(4, y, 21 - i * 3, y, PAL.slash, 2, 210 - i * 50); }
  px.line(4, 26, 14, 26, shadeCol(PAL.slash, 0.55), 2);
  archSeg(px, 23, 16, 6, -80, 80, 2, PAL.manaL);
  return px;
}
function iconWave() {
  const px = new Px(32, 32);
  px.glowDisc(16, 18, 11, PAL.ember, 50);
  for (let i = 0; i < 5; i++) {
    const x = 7 + i * 4.5;
    px.tri(x, 27, x + 2.2, 27, x + 1.1, 10 + (i % 2) * 4, i % 2 ? PAL.ember : PAL.emberD);
  }
  px.tri(14, 27, 18, 27, 16, 8, PAL.emberH);
  return px;
}
function iconPulse() {
  const px = new Px(32, 32);
  px.glowDisc(16, 16, 11, PAL.heart, 55);
  px.rect(14, 8, 4, 16, PAL.heart); px.rect(8, 14, 16, 4, PAL.heart);
  px.rect(15, 9, 2, 14, PAL.heartL); px.rect(9, 15, 14, 2, PAL.heartL);
  px.rect(13, 7, 6, 1, PAL.heartD); px.rect(7, 13, 1, 6, PAL.heartD); // shade accents
  return px;
}
function buildItems() {
  const defs = [
    { id: 'coin', frames: [itemCoin(0), itemCoin(1)] },
    { id: 'heart', frames: [itemHeart()] },
    { id: 'mana_shard', frames: [itemManaShard()] },
    { id: 'key', frames: [itemKey()] },
    { id: 'ember_tonic', frames: [itemFlask(PAL.heart, PAL.heartD)] },
    { id: 'vesper_draught', frames: [itemFlask(PAL.mana, PAL.manaD)] },
    { id: 'ashward_draught', frames: [itemFlask(PAL.ash, PAL.ashD)] },
    { id: 'waybread', frames: [itemWaybread()] },
    { id: 'wayfarer_coat', frames: [iconCoat()] },
    { id: 'dusk_hood', frames: [iconHood()] },
    { id: 'moonstone_charm', frames: [iconCharm()] },
    { id: 'iron_signet', frames: [iconSignet()] },
    { id: 'moonrise_leap', frames: [iconLeap()] },
    { id: 'gale_dash', frames: [iconDash()] },
    { id: 'cinder_wave', frames: [iconWave()] },
    { id: 'mending_pulse', frames: [iconPulse()] },
  ];
  const index = { items: {}, iconContract: '32x32' };
  for (const d of defs) {
    const frames = d.frames.map(f => (f.w === 32 && f.h === 32) ? f : pad32(f));
    const sheet = new Px(32 * frames.length, 32);
    frames.forEach((f, i) => sheet.blit(f, i * 32, 0));
    const rel = `items/${d.id}.png`;
    emit(sheet, rel, { kind: 'item' });
    index.items[d.id] = { file: `assets/${rel}`, frameWidth: 32, frameHeight: 32, frames: frames.length };
  }
  emitJSON('items/items.json', index);
  const windex = { weapons: {}, iconContract: '32x32' };
  for (const id of ['recruit_blade', 'moonsteel_sabre']) {
    const icon = pad32(weaponIcon(id));
    const rel = `weapons/${id}.png`;
    emit(icon, rel, { kind: 'weapon' });
    windex.weapons[id] = { file: `assets/${rel}`, frameWidth: 32, frameHeight: 32 };
  }
  emitJSON('weapons/weapons.json', windex);
}

/* ================= BACKDROP PAINTING HELPERS ================= */
function stars(px, n, seed, yMax) {
  const R = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = (R() * px.w) | 0, y = (R() * yMax) | 0, b = R();
    px.px(x, y, b < 0.2 ? PAL.star : shadeCol(PAL.star, 0.55));
    if (b > 0.92) { px.px(x + 1, y, shadeCol(PAL.star, 0.5)); px.px(x, y + 1, shadeCol(PAL.star, 0.5)); }
  }
}
function moon(px, cx, cy, r) {
  px.glowDisc(cx, cy, r * 2.4, PAL.halo, 55);
  px.disc(cx, cy, r, PAL.moon);
  const R = rng(5);
  for (let i = 0; i < 8; i++) {
    const a = R() * 6.28, d = R() * r * 0.72;
    px.disc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1 + R() * 2.4, PAL.moonDim);
  }
  for (let b = -1; b <= 1; b++) // drifting veil bands
    for (let x = cx - r * 1.7; x < cx + r * 1.7; x += 2) {
      const y = Math.round(cy + b * 11 + (x - cx) * 0.22);
      px.blend(x, y, PAL.halo, 55); px.blend(x, y + 1, PAL.halo, 35);
    }
}
function tower(px, x, w, h, baseY, color, opts = {}) {
  const top = baseY - h;
  if (opts.jagged) {
    const pts = [[x, baseY], [x, top]], n = opts.jagged;
    for (let i = 0; i <= n; i++) pts.push([x + (w * i) / n, top - (i % 2 ? 7 : 0)]);
    pts.push([x + w, baseY]);
    px.poly(pts, color);
  } else px.rect(x, top, w, h, color);
  if (opts.spire) px.tri(x - 1, top, x + w + 1, top, x + w / 2, top - w * 1.15, color);
  if (opts.crenel) for (let cx = x; cx < x + w - 2; cx += 7) px.rect(cx, top - 5, 4, 5, color);
  if (opts.windows) {
    const R = rng(x * 31 + 7);
    const n = Math.floor((w * h) / 1100);
    for (let i = 0; i < n; i++) if (R() < 0.55) px.px(x + 3 + R() * (w - 6), top + 5 + R() * (h - 10), opts.winColor || PAL.lantern);
  }
}
function fogBand(px, y, h, color, alpha, seed) {
  const R = rng(seed);
  for (let j = 0; j < h; j++) {
    const edge = Math.min(j, h - 1 - j) / (h / 2);
    for (let x = 0; x < px.w; x += 2) {
      if (R() < 0.3 + 0.45 * edge) {
        const a = Math.round(alpha * (0.35 + 0.65 * edge));
        px.blend(x + (R() < 0.5 ? 0 : 1), y + j, color, a);
      }
    }
  }
}
function bareTree(px, x, baseY, s, color) {
  px.line(x, baseY, x, baseY - 34 * s, color, 3);
  const R = rng(x * 7 + 1);
  for (let i = 0; i < 7; i++) {
    const by = baseY - (8 + i * 4.5) * s, dir = i % 2 ? 1 : -1, len = (9 + R() * 11) * s;
    px.line(x, by, x + dir * len, by - (7 + R() * 9) * s, color, 2);
  }
}
function archSeg(px, cx, cy, r, a0, a1, w, color) {
  let px0 = null, py0 = null;
  for (let a = a0; a <= a1; a += 8) {
    const q = (a * Math.PI) / 180, x = cx + Math.cos(q) * r, y = cy + Math.sin(q) * r;
    if (px0 !== null) px.line(px0, py0, x, y, color, w);
    px0 = x; py0 = y;
  }
}
function chainHang(px, x, y0, y1, color) {
  for (let y = y0; y < y1; y += 5) { px.ell(x, y, 2.4, 3.2, color); }
}

/* ================= PARALLAX (480x270, original compositions) ================= */
function parallaxMoonlitFar() {
  const px = new Px(480, 270);
  px.vgrad([[0, PAL.night0], [0.45, PAL.night1], [0.75, PAL.night2], [1, PAL.night3]]);
  stars(px, 150, 21, 175);
  moon(px, 348, 58, 32);
  const sil = hex('#0e1526');
  px.rect(0, 205, 480, 65, shadeCol(sil, 0.7)); // ground mass
  tower(px, 30, 46, 78, 208, sil, { crenel: true, windows: true });
  tower(px, 76, 20, 56, 208, sil, {});
  px.rect(96, 190, 120, 18, sil); // wall
  tower(px, 216, 34, 64, 208, sil, { spire: true, windows: true });
  tower(px, 268, 90, 40, 208, sil, { crenel: true }); // chapel mass
  px.tri(268, 168, 358, 168, 313, 108, sil); // chapel spire
  px.rect(310, 120, 6, 48, sil);
  tower(px, 372, 26, 70, 208, sil, { spire: true, windows: true });
  tower(px, 420, 40, 52, 208, sil, { crenel: true });
  fogBand(px, 196, 34, PAL.halo, 46, 77);
  return px;
}
function parallaxMoonlitNear() {
  const px = new Px(480, 270), sil = hex('#080d1a');
  tower(px, 18, 60, 108, 252, sil, { crenel: true, spire: false });
  px.tri(18, 144, 78, 144, 48, 108, sil);
  px.poly([[30, 252], [30, 210], [48, 192], [66, 210], [66, 252]], [4, 6, 12]); // gate arch opening
  px.rect(78, 200, 110, 52, sil); // curtain wall
  for (let cx = 78; cx < 188; cx += 9) px.rect(cx, 194, 5, 6, sil);
  tower(px, 300, 70, 84, 252, sil, {});
  px.tri(300, 168, 370, 168, 335, 96, sil); // chapel roof
  px.disc(335, 150, 9, sil); px.ring(335, 150, 9, hex('#131c33')); // rose window hint
  px.rect(392, 210, 88, 42, sil); // ruined wall
  px.poly([[392, 210], [410, 192], [420, 210]], sil); px.poly([[430, 210], [452, 196], [462, 210]], sil);
  bareTree(px, 262, 252, 1.1, sil); bareTree(px, 452, 252, 0.8, sil);
  px.rect(0, 244, 480, 26, hex('#05080f'));
  // moonbeams: faint diagonal shafts of cold moonlight through the ruins
  const R = rng(414);
  for (let b = 0; b < 5; b++) {
    const bx = 60 + b * 95 + R() * 30, bw = 12 + R() * 14;
    for (let y = 0; y < 220; y += 2) {
      const xoff = Math.round((y / 220) * 52);
      for (let x = 0; x < bw; x += 2) {
        const edge = Math.min(x, bw - 1 - x) / (bw / 2);
        if (R() < 0.3 * edge) px.blend(bx + x + xoff, y, PAL.halo, Math.round(13 * edge));
      }
    }
  }
  fogBand(px, 158, 44, PAL.halo, 30, 78);
  return px;
}
function parallaxHollowFar() {
  const px = new Px(480, 270);
  px.vgrad([[0, PAL.keep0], [0.5, PAL.keep1], [0.8, PAL.keep2], [1, PAL.keep3]]);
  // ember glow on the horizon
  for (let y = 190; y < 230; y++) for (let x = 0; x < 480; x += 3)
    px.blend(x, y, PAL.emberD, Math.round(26 * (1 - Math.abs(y - 208) / 22)));
  const sil = hex('#120b1a');
  px.rect(0, 208, 480, 62, shadeCol(sil, 0.7));
  tower(px, 40, 50, 92, 210, sil, { jagged: 7 });
  tower(px, 110, 30, 64, 210, sil, { jagged: 5 });
  tower(px, 200, 66, 110, 210, sil, { jagged: 9, windows: true, winColor: PAL.ember });
  px.ell(320, 208, 70, 34, sil); // fallen dome mass
  px.poly([[280, 208], [300, 150], [312, 208]], sil); px.poly([[340, 208], [360, 158], [372, 208]], sil);
  tower(px, 400, 44, 80, 210, sil, { jagged: 6, windows: true, winColor: PAL.ember });
  const R = rng(99); // drifting ash
  for (let i = 0; i < 90; i++) px.px(R() * 480, R() * 200, R() < 0.5 ? PAL.ashD : shadeCol(PAL.ash, 0.7));
  for (let i = 0; i < 14; i++) px.blend(R() * 480, 200 + R() * 12, PAL.ember, 90); // distant fires
  fogBand(px, 192, 36, hex('#4a3560'), 50, 79);
  return px;
}
function parallaxHollowNear() {
  const px = new Px(480, 270), sil = hex('#0a0712');
  px.rect(0, 226, 480, 44, hex('#070510')); // floor
  // collapsed colonnade left
  px.rect(36, 120, 30, 106, sil); px.rect(150, 132, 30, 94, sil);
  archSeg(px, 108, 190, 72, 200, 340, 14, sil); // broken arch between
  px.poly([[180, 226], [230, 120], [246, 126], [200, 226]], sil); // fallen column
  // right: shattered wall + hanging chains
  px.poly([[330, 226], [330, 140], [360, 110], [352, 150], [380, 130], [372, 170], [410, 150], [410, 226]], sil);
  chainHang(px, 300, 0, 120, sil); chainHang(px, 440, 0, 90, sil); chainHang(px, 250, 0, 70, sil);
  // rubble mounds
  px.ell(120, 224, 46, 12, sil); px.ell(330, 226, 60, 14, sil); px.ell(240, 228, 34, 9, hex('#0e0a16'));
  // dust shafts
  px.poly([[150, 0], [190, 0], [120, 226], [80, 226]], hex('#3a2c50'), 26);
  px.poly([[330, 0], [356, 0], [300, 226], [274, 226]], hex('#3a2c50'), 22);
  const R = rng(123); // floating dust
  for (let i = 0; i < 60; i++) px.px(R() * 480, R() * 226, shadeCol(PAL.ash, 0.6));
  fogBand(px, 200, 34, hex('#4a3560'), 44, 80);
  return px;
}
function buildParallax() {
  const defs = [
    ['moonlit_gate_far', parallaxMoonlitFar()], ['moonlit_gate_near', parallaxMoonlitNear()],
    ['hollow_keep_far', parallaxHollowFar()], ['hollow_keep_near', parallaxHollowNear()],
  ];
  const index = { layers: {} };
  for (const [id, px] of defs) {
    const rel = `environments/bg_${id}.png`;
    emit(px, rel, { kind: 'parallax' });
    index.layers[`bg_${id}`] = { file: `assets/${rel}`, width: 480, height: 270 };
  }
  emitJSON('environments/parallax/parallax.json', index);
}

/* ================= TITLE BACKDROP (480x270) ================= */
function buildTitle() {
  const px = new Px(480, 270);
  px.vgrad([[0, PAL.night0], [0.4, PAL.night1], [0.72, PAL.night2], [1, hex('#1a2340')]]);
  stars(px, 170, 31, 150);
  moon(px, 336, 60, 30);
  const sil = hex('#0d1322');
  px.rect(0, 208, 480, 62, shadeCol(sil, 0.65));
  tower(px, 120, 40, 66, 210, sil, { crenel: true, windows: true });
  tower(px, 170, 84, 96, 210, sil, { spire: true, windows: true }); // great keep
  px.tri(170, 114, 254, 114, 212, 66, sil);
  tower(px, 264, 30, 58, 210, sil, { windows: true });
  px.rect(294, 192, 90, 18, sil);
  tower(px, 384, 36, 74, 210, sil, { spire: true, windows: true });
  // foreground ruined framing: slim broken towers, not blobs
  const fg = hex('#04060c');
  px.rect(0, 120, 26, 150, fg);
  px.poly([[0, 120], [26, 120], [20, 104], [14, 112], [8, 100], [2, 110]], fg); // jagged crown
  px.poly([[0, 150], [26, 150], [26, 158], [0, 158]], hex('#0a0e18')); // ledge band
  archSeg(px, 470, 262, 66, 200, 268, 10, fg); // right ruined arch rib
  archSeg(px, 452, 268, 44, 205, 262, 8, fg);  // inner rib
  px.rect(440, 210, 14, 60, fg);
  px.poly([[440, 210], [454, 210], [450, 196], [446, 202], [442, 192]], fg);
  // drifting ash catching the moonlight
  const RA = rng(913);
  for (let i = 0; i < 60; i++) {
    const ax = RA() * 480, ay = RA() * 220;
    px.px(ax, ay, RA() < 0.3 ? PAL.moonDim : shadeCol(PAL.halo, 0.8));
  }
  fogBand(px, 196, 36, PAL.halo, 50, 81);
  fogBand(px, 228, 26, PAL.halo, 36, 82);
  px.vignette(150);
  emit(px, 'environments/bg_title.png', { kind: 'title' });
  emitJSON('title/title.json', { title: { file: 'assets/environments/bg_title.png', width: 480, height: 270 } });
}

/* ================= EFFECTS + TITLE LOGO ================= */
function fxHitSpark() {
  const px = new Px(16, 16);
  px.glowDisc(8, 8, 7, PAL.goldL, 90);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, l = i % 2 ? 4 : 7;
    px.line(8, 8, 8 + Math.cos(a) * l, 8 + Math.sin(a) * l, PAL.slashH, 1);
  }
  px.disc(8, 8, 2, PAL.flameH);
  return px;
}
function fxSlashArc() {
  const px = new Px(48, 24);
  for (let a = -80; a <= 30; a += 6) { // faint outer echo
    const q = (a * Math.PI) / 180;
    px.disc(24 + Math.cos(q) * 30, 36 + Math.sin(q) * 30, 1.4, shadeCol(PAL.slash, 0.7), 150);
  }
  drawSlashArc(px, 24, 36, 26, -80, 30);
  return px;
}
function fxDustPuff() {
  const px = new Px(16, 16);
  px.disc(6, 10, 4, PAL.ashD); px.disc(10, 9, 4.5, PAL.ashD); px.disc(8, 7, 3.5, PAL.ash);
  px.disc(7, 8, 1.6, shadeCol(PAL.ash, 1.25));
  return px;
}
function logoVesper() { // original emblem mark: crescent + keep tower (no wordmark)
  const px = new Px(320, 120), dark = hex('#10182c');
  px.glowDisc(58, 60, 40, PAL.halo, 28);
  archSeg(px, 58, 60, 32, -64, 64, 9, PAL.uiTrimL); // crescent
  px.rect(150, 46, 40, 54, dark);                  // keep tower
  px.tri(148, 46, 192, 46, 170, 18, dark);
  px.line(150, 46, 150, 100, PAL.uiTrimL, 1); px.line(190, 46, 190, 100, PAL.uiTrimL, 1);
  px.line(148, 46, 192, 46, PAL.uiTrim, 1);
  px.px(164, 62, PAL.lantern); px.px(176, 74, PAL.lantern);
  px.rect(120, 70, 30, 30, dark); px.rect(190, 70, 30, 30, dark); // flanking walls
  for (let cx = 120; cx < 148; cx += 8) px.rect(cx, 64, 5, 6, dark);
  for (let cx = 190; cx < 218; cx += 8) px.rect(cx, 64, 5, 6, dark);
  px.line(110, 108, 230, 108, PAL.uiTrim, 1);      // divider
  px.line(170, 103, 174, 108, PAL.uiTrimL, 1); px.line(174, 108, 170, 113, PAL.uiTrimL, 1);
  px.line(170, 113, 166, 108, PAL.uiTrimL, 1); px.line(166, 108, 170, 103, PAL.uiTrimL, 1);
  const R = rng(9);
  for (let i = 0; i < 12; i++) px.px(232 + R() * 68, 20 + R() * 80, PAL.star);
  return px;
}
function buildEffects() {
  const index = { effects: {} };
  for (const [id, fn] of [['fx_hit_spark', fxHitSpark], ['fx_slash_arc', fxSlashArc], ['fx_dust_puff', fxDustPuff]]) {
    const fpx = fn();
    const rel = `effects/${id}.png`;
    emit(fpx, rel, { kind: 'effect' });
    index.effects[id] = { file: `assets/${rel}`, width: fpx.w, height: fpx.h };
  }
  emitJSON('effects/effects.json', index);
}

/* ================= UI CHROME ================= */
function uiPanelPiece(kind) {
  const px = new Px(8, 8);
  px.rect(0, 0, 8, 8, PAL.uiBg);
  px.speckle(7, [PAL.uiBgL], kind.length * 13 + 5, 0, 0, 8, 8);
  if (kind === 'center') px.speckle(4, [shadeCol(PAL.uiBg, 0.7)], 4242, 0, 0, 8, 8);
  const outer = (x0, y0, x1, y1) => px.line(x0, y0, x1, y1, PAL.uiTrim, 1);
  const hi = (x0, y0, x1, y1) => px.line(x0, y0, x1, y1, PAL.uiTrimL, 1);
  if (kind === 'corner_tl') { outer(0, 0, 7, 0); outer(0, 0, 0, 7); hi(1, 1, 6, 1); hi(1, 1, 1, 6); px.px(0, 0, PAL.uiTrimL); }
  if (kind === 'corner_tr') { outer(0, 0, 7, 0); outer(7, 0, 7, 7); hi(1, 1, 6, 1); hi(6, 1, 6, 6); px.px(7, 0, PAL.uiTrimL); }
  if (kind === 'corner_bl') { outer(0, 7, 7, 7); outer(0, 0, 0, 7); hi(1, 6, 6, 6); hi(1, 1, 1, 6); px.px(0, 7, PAL.uiTrimL); }
  if (kind === 'corner_br') { outer(0, 7, 7, 7); outer(7, 0, 7, 7); hi(1, 6, 6, 6); hi(6, 1, 6, 6); px.px(7, 7, PAL.uiTrimL); }
  if (kind === 'edge_h') { outer(0, 0, 7, 0); hi(0, 1, 7, 1); }
  if (kind === 'edge_v') { outer(0, 0, 0, 7); hi(1, 0, 1, 7); }
  return px;
}
function uiButton(state) {
  const px = new Px(64, 20);
  const fill = state === 'pressed' ? PAL.btnB : state === 'hover' ? shadeCol(PAL.btnT, 1.4) : PAL.btnT;
  px.rect(0, 0, 64, 20, PAL.uiTrim);
  px.rect(1, 1, 62, 18, fill);
  px.speckle(20, [PAL.uiBgL], state.length * 17 + 2, 2, 2, 60, 16);
  if (state === 'hover') { px.rect(2, 2, 60, 16, PAL.uiTrimL); px.rect(3, 3, 58, 14, fill); }
  if (state === 'pressed') { px.line(1, 19, 63, 19, PAL.uiBg, 1); px.line(63, 1, 63, 19, PAL.uiBg, 1); }
  else { px.line(2, 2, 61, 2, shadeCol(fill, 1.6), 1); }
  // rivets
  for (const [rx, ry] of [[4, 4], [59, 4], [4, 15], [59, 15]]) px.px(rx, ry, PAL.uiTrim);
  return px;
}
function uiCursor() {
  const px = new Px(12, 12);
  const pts = [[1, 1], [1, 10], [4, 7.4], [6, 11], [7.6, 10], [5.8, 6.4], [10, 6]];
  px.poly(pts.map(p => [p[0] + 0.6, p[1] + 0.6]), [18, 14, 26]);
  px.poly(pts, PAL.uiTrimL);
  px.line(1, 1, 1, 9, PAL.uiTrim, 1); px.line(1, 1, 8, 6, PAL.uiTrim, 1);
  return px;
}
function buildUI() {
  const index = { ui: {} };
  for (const k of ['corner_tl', 'corner_tr', 'corner_bl', 'corner_br', 'edge_h', 'edge_v', 'center']) {
    const rel = `ui/panel_${k}.png`;
    emit(uiPanelPiece(k), rel, { kind: 'ui' });
    index.ui[`panel_${k}`] = { file: `assets/${rel}`, slice: k.startsWith('corner') ? 8 : 0 };
  }
  for (const s of ['normal', 'hover', 'pressed']) {
    const rel = `ui/button_${s}.png`;
    emit(uiButton(s), rel, { kind: 'ui' });
    index.ui[`button_${s}`] = { file: `assets/${rel}`, width: 64, height: 20 };
  }
  emit(uiCursor(), 'ui/cursor.png', { kind: 'ui' });
  index.ui.cursor = { file: 'assets/ui/cursor.png', width: 12, height: 12 };
  emit(logoVesper(), 'ui/logo_vesper.png', { kind: 'ui' });
  index.ui.logo_vesper = { file: 'assets/ui/logo_vesper.png', width: 320, height: 120, note: 'emblem mark, no wordmark' };
  emitJSON('ui/ui.json', index);
}

/* ================= VERIFY + MAIN ================= */
/* ================= BOSSES (128x128 frames, art authored smaller, centered-bottom) =================
 * Chapel Warden — hulking candle-golem warden: melted-wax body, iron bands,
 * candle clusters on cowl + shoulders. Sable Matriarch — tall mourning-queen:
 * black sable gown, long train, veiled pale face, lantern held aloft. */
const wax = hex('#e6d9b8'), waxD = hex('#a8946a'), waxDD = hex('#6e5f42');
const wardenIron = hex('#2e2e38'), wardenIronL = hex('#5a5a6a');

/** candle cluster + flames; spots = [[tipX, tipY], ...] */
function wardenFlames(px, spots, big) {
  for (const [fx, fy] of spots) {
    px.rect(fx - 1, fy, 3, 7, wax); px.rect(fx - 1, fy + 5, 3, 2, waxD);
    px.px(fx, fy - 1, [40, 26, 14]);
    const fr = big ? 2.6 : 1.8;
    px.disc(fx, fy - 3, fr + 1, PAL.flameD);
    px.disc(fx, fy - 3, fr, PAL.flame);
    px.disc(fx, fy - 3.6, fr * 0.55, PAL.flameH);
    px.glowDisc(fx, fy - 3, big ? 11 : 7, PAL.lanternGlow, big ? 95 : 60);
  }
}

function wardenBody(px, o = {}) {
  const xo = o.xoff ?? 0, yo = o.yoff ?? 0, X = (x) => x + xo, Y = (y) => y + yo;
  const hurt = !!o.hurt, big = o.flameBig ?? !hurt;
  // legs: thick wax columns
  for (const lx of [26, 44]) {
    px.rect(X(lx), Y(66), 12, 28, wax);
    px.rect(X(lx), Y(66), 4, 28, waxD);
    px.rect(X(lx - 3), Y(92), 18, 8, waxD); // foot slab
    px.rect(X(lx - 3), Y(92), 18, 3, waxDD);
  }
  // torso: hulking wax mass
  px.rect(X(16), Y(28), 44, 40, wax);
  px.ell(X(38), Y(32), 24, 8, wax);
  px.rect(X(16), Y(28), 10, 40, waxD);                    // left shade
  px.rect(X(52), Y(30), 4, 36, shadeCol(wax, 1.12));      // right rim
  for (const dx of [20, 34, 48]) {                        // wax drips
    const dl = 5 + ((dx * 7) % 5);
    px.rect(X(dx), Y(66), 3, dl, wax); px.rect(X(dx), Y(66 + dl - 2), 3, 2, waxD);
  }
  // iron bands + rivets
  for (const by of [38, 54]) {
    px.rect(X(15), Y(by), 46, 4, wardenIron);
    for (let rx = 19; rx <= 57; rx += 8) px.px(X(rx), Y(by + 1), wardenIronL);
    px.rect(X(15), Y(by + 3), 46, 1, hex('#17171d'));
  }
  if (hurt) { // glowing cracks
    px.line(X(24), Y(32), X(30), Y(48), PAL.ember, 1); px.line(X(30), Y(48), X(26), Y(62), PAL.emberD, 1);
    px.line(X(46), Y(34), X(42), Y(52), PAL.ember, 1);
    px.blend(X(28), Y(44), PAL.ember, 90); px.blend(X(44), Y(46), PAL.ember, 90);
  } else {
    px.line(X(24), Y(34), X(29), Y(50), waxDD, 1); px.line(X(47), Y(36), X(43), Y(54), waxDD, 1);
  }
  // shoulder mounds
  px.ell(X(12), Y(34), 9, 8, wax); px.ell(X(64), Y(34), 9, 8, wax);
  px.ell(X(10), Y(32), 5, 4, waxD); px.ell(X(66), Y(32), 5, 4, waxD);
  // arms
  const pose = o.arms ?? 'down';
  const armWax = (x0, y0, x1, y1) => { px.line(X(x0), Y(y0), X(x1), Y(y1), wax, 9); px.line(X(x0) - 3, Y(y0), X(x1) - 3, Y(y1), waxD, 3); };
  const fist = (fx, fy) => {
    px.disc(X(fx), Y(fy), 8, wax); px.disc(X(fx) - 2, Y(fy) - 2, 5, waxD);
    px.rect(X(fx) - 8, Y(fy) - 2, 16, 4, wardenIron);
    px.px(X(fx) - 4, Y(fy), wardenIronL); px.px(X(fx) + 4, Y(fy), wardenIronL);
  };
  if (pose === 'up') {          // windup: both arms raised
    armWax(10, 34, 4, 12); armWax(66, 34, 72, 12); fist(3, 4); fist(73, 4);
  } else if (pose === 'slam') { // slam: arms driven down-forward
    armWax(10, 34, 16, 66); armWax(66, 34, 60, 66); fist(17, 76); fist(59, 76);
  } else if (pose === 'cross') { // hurt: guard across torso
    armWax(10, 34, 8, 58); px.line(X(8), Y(58), X(52), Y(50), wax, 8); fist(56, 49);
    armWax(66, 34, 60, 60); fist(60, 68);
  } else if (pose === 'sprawl') { // death: arms out flat
    px.line(X(4), Y(66), X(30), Y(72), wax, 8); px.line(X(46), Y(72), X(72), Y(66), wax, 8);
    fist(0, 70); fist(76, 70);
  } else {                      // idle: heavy arms at sides
    armWax(10, 34, 8, 58); armWax(66, 34, 68, 58); fist(8, 66); fist(68, 66);
  }
  // head: iron cowl, ember slit
  px.rect(X(30), Y(12), 16, 16, wardenIron);
  px.rect(X(31), Y(13), 14, 14, hex('#23232b'));
  px.rect(X(30), Y(12), 16, 3, wardenIronL);
  px.rect(X(33), Y(19), 10, 2, [12, 8, 6]);
  px.blend(X(36), Y(20), PAL.ember, hurt ? 170 : 110); px.blend(X(40), Y(20), PAL.emberD, 90);
  px.rect(X(28), Y(26), 20, 3, waxD); // wax collar
  // candle clusters: cowl crown + shoulders
  const spots = [[34, 8], [38, 6], [42, 8]];
  if (pose !== 'sprawl') { spots.push([12, 24], [64, 24]); }
  wardenFlames(px, spots.map(([sx, sy]) => [X(sx), Y(sy)]), big);
  return { xo, yo };
}

function chapelWarden(frame, mode = 'idle') {
  const px = new Px(76, 100);
  const sway = mode === 'idle' ? frame : 0;
  if (mode === 'idle') {
    wardenBody(px, { xoff: sway, flameBig: frame === 1 });
    px.glowDisc(38 + sway, 46, 26, PAL.lanternGlow, 28); // ambient candlelight
  } else if (mode === 'attack') {
    if (!frame) { // windup: arms high, flames flaring
      wardenBody(px, { arms: 'up', yoff: -2, flameBig: true });
      px.glowDisc(38, 30, 30, PAL.lanternGlow, 55);
    } else {      // slam: shockwave + dust
      wardenBody(px, { arms: 'slam', yoff: 3, flameBig: true });
      px.ell(38, 96, 32, 6, PAL.ash, 170); px.ell(38, 96, 22, 4, PAL.ashD, 200);
      px.ring(38, 97, 30, PAL.flame, 120); px.ring(38, 97, 24, PAL.flameD, 150);
      px.speckle(16, [PAL.ash, PAL.stoneH], 501 + frame, 8, 86, 60, 10);
    }
  } else if (mode === 'hurt') {
    wardenBody(px, { arms: 'cross', xoff: -5, hurt: true, flameBig: false });
  } else if (mode === 'die') {
    if (frame === 0) { // buckling
      wardenBody(px, { yoff: 16, arms: 'down', flameBig: false });
    } else if (frame === 1) { // collapsed
      wardenBody(px, { yoff: 30, arms: 'sprawl', flameBig: false });
      px.rect(28, 42, 20, 3, wardenIron); // fallen cowl
    } else { // wax puddle
      px.ell(38, 93, 30, 7, wax); px.ell(38, 91, 22, 5, waxD);
      px.ell(10, 95, 6, 3, wax); px.ell(66, 96, 5, 2.5, wax);
      for (const [ex, ey] of [[30, 90], [44, 92], [52, 89]]) px.disc(ex, ey, 1.6, PAL.ember);
      px.blend(30, 90, PAL.ember, 120);
      for (let s = 0; s < 3; s++) { // smoke wisps
        const sx = 26 + s * 12;
        px.blend(sx, 78, PAL.ashD, 90); px.blend(sx + 1, 72, PAL.ashD, 60); px.blend(sx - 1, 66, PAL.ashD, 40);
      }
      px.rect(60, 84, 3, 8, wax); // one surviving candle stub
      wardenFlames(px, [[61, 84]], false);
    }
  }
  return px;
}

/* ---- Sable Matriarch: tall mourning-queen, lantern aloft, flowing train ---- */
const gown = hex('#16121f'), gownD = hex('#0d0a14'), gownL = hex('#352844'), gownSheen = hex('#4a3a5e');
const veilC = hex('#b9ac93'), paleSkin = hex('#e3d5b8'), silverC = hex('#c7d2e8');

function matriarchLantern(px, lx, ly, bright) {
  px.rect(lx - 6, ly - 3, 12, 3, wardenIron);       // cap
  px.rect(lx - 6, ly + 10, 12, 3, wardenIron);      // base
  px.rect(lx - 6, ly, 2, 13, wardenIron); px.rect(lx + 4, ly, 2, 13, wardenIron);
  px.px(lx - 6, ly - 3, silverC); px.px(lx + 5, ly - 3, silverC);
  if (bright) {
    px.rect(lx - 3, ly + 1, 6, 8, PAL.lantern);
    px.disc(lx, ly + 5, 2.6, PAL.flameH); px.disc(lx, ly + 5, 1.4, [255, 255, 255]);
    px.glowDisc(lx, ly + 5, 13, PAL.lanternGlow, 110);
  } else {
    px.rect(lx - 3, ly + 1, 6, 8, PAL.emberD);
    px.glowDisc(lx, ly + 5, 7, PAL.emberD, 50);
  }
}

function matriarchBody(px, o = {}) {
  const xo = o.xoff ?? 0, yo = o.yoff ?? 0, X = (x) => x + xo, Y = (y) => y + yo;
  const bright = o.lanternBright ?? true, lift = o.trainLift ?? 0;
  // train: flowing layers trailing left
  const sway = o.trainSway ?? 0;
  px.poly([[X(30), Y(78)], [X(2 - sway), Y(94 - lift)], [X(10 - sway), Y(102 - lift)], [X(34), Y(92)]], gownD);
  px.poly([[X(30), Y(74)], [X(8 - sway), Y(88 - lift)], [X(16 - sway), Y(98 - lift)], [X(34), Y(88)]], gown);
  px.line(X(24), Y(80), X(10 - sway), Y(92 - lift), gownL, 1);
  px.line(X(28), Y(84), X(16 - sway), Y(96 - lift), gownSheen, 1);
  // skirt: tall bell
  px.poly([[X(24), Y(44)], [X(44), Y(44)], [X(58), Y(96)], [X(10), Y(96)]], gown);
  px.poly([[X(24), Y(44)], [X(32), Y(44)], [X(24), Y(96)], [X(10), Y(96)]], gownD);
  for (const fx of [30, 38, 46]) px.line(X(fx), Y(50), X(fx - 4), Y(94), gownD, 1);
  px.line(X(40), Y(48), X(46), Y(94), gownSheen, 1); px.line(X(26), Y(48), X(20), Y(94), gownL, 1);
  // tattered hem
  for (let hx = 12; hx < 58; hx += 7) px.tri(X(hx), Y(96), X(hx + 6), Y(96), X(hx + 3), Y(90 + ((hx * 3) % 5)), gown);
  // bodice
  px.rect(X(26), Y(26), 16, 20, gown);
  px.rect(X(26), Y(26), 5, 20, gownD);
  px.line(X(34), Y(28), X(34), Y(44), gownSheen, 1);
  px.disc(X(34), Y(32), 1.6, silverC); // clasp
  // sleeves: right arm raised with lantern, left arm low
  const armUp = o.armUp ?? true;
  if (armUp) {
    px.line(X(40), Y(30), X(50), Y(12), gown, 5);
    px.rect(X(47), Y(8), 6, 5, paleSkin); // hand
    matriarchLantern(px, 50, 0, bright);
  } else {
    px.line(X(40), Y(30), X(48), Y(44), gown, 5);
    px.rect(X(45), Y(42), 6, 5, paleSkin);
    matriarchLantern(px, 48, 46, bright);
  }
  px.line(X(28), Y(30), X(22), Y(52), gown, 4);
  px.rect(X(19), Y(50), 5, 5, paleSkin);
  px.glowDisc(X(20), Y(58), 5, hex('#7a4ae8'), 70); // violet wisp trail
  px.glowDisc(X(16), Y(64), 3.5, hex('#7a4ae8'), 50);
  // head: pale face, sheer veil streaks, tall sable crown
  px.rect(X(32), Y(14), 7, 10, paleSkin);
  px.rect(X(32), Y(22), 7, 2, [150, 115, 90]); // jaw shade
  px.px(X(34), Y(18), [25, 18, 14]); px.px(X(37), Y(18), [25, 18, 14]); // shadowed eyes
  px.rect(X(33), Y(21), 5, 1, [110, 75, 65]); // mouth shadow
  const vw = o.veilFlare ? 5 : 3; // sheer veil: streaks at the sides, face stays readable
  for (let vy = 8; vy < 38; vy += 1) {
    for (const vx of [32 - vw, 39 + vw, 32 - vw + 1, 39 + vw - 1])
      if (((vx + vy) & 1) === 0) px.blend(X(vx), Y(vy), veilC, 60);
    if (vy > 24 && ((vy) & 1) === 0) px.blend(X(35) + ((vy % 4) - 2), Y(vy), veilC, 40);
  }
  px.rect(X(29), Y(24), 14, 2, gownD); // veil fall behind shoulders
  for (let s = 0; s < 5; s++) { // tall crown spires
    const cx = 29 + s * 3;
    px.tri(X(cx), Y(12), X(cx + 2.6), Y(12), X(cx + 1.3), Y(0 + (s % 2) * 2.5), gownD);
    px.px(X(cx) + 1, Y(2 + (s % 2) * 2), silverC);
  }
  px.rect(X(29), Y(11), 13, 2, silverC); // circlet
  px.disc(X(35), Y(12), 1.4, PAL.flameH); // circlet jewel
  // hover shadow
  px.ell(X(34), Y(101), 20, 4, [0, 0, 0], 110);
  return { xo, yo };
}

function sableMatriarch(frame, mode = 'idle') {
  const px = new Px(68, 104);
  const bob = mode === 'idle' ? (frame ? -2 : 0) : 0;
  if (mode === 'idle') {
    matriarchBody(px, { yoff: bob, trainSway: frame ? 3 : -1, lanternBright: true });
    if (frame) px.glowDisc(50, 5, 16, PAL.lanternGlow, 40); // pulse
  } else if (mode === 'attack') {
    if (!frame) { // grief volley: lantern high, light gathering
      matriarchBody(px, { yoff: -3, armUp: true, trainLift: 4, lanternBright: true });
      px.glowDisc(50, 5, 20, PAL.lanternGlow, 130);
      px.ring(50, 5, 16, PAL.flameH, 90);
    } else {      // matriarch's sweep: train dragged across, violet arc
      const q = new Px(68, 104);
      // redraw body with train swept forward (right)
      matriarchBody(q, { yoff: 2, armUp: false, trainLift: 0, lanternBright: true });
      q.poly([[34, 78], [64, 88], [62, 100], [34, 94]], gown);
      q.poly([[36, 74], [60, 84], [58, 94], [36, 90]], gownD);
      q.line(38, 80, 60, 90, gownSheen, 1);
      for (let a = -30; a <= 60; a += 6) { // violet echo under the slash
        const qq = a * Math.PI / 180;
        q.disc(40 + Math.cos(qq) * 26, 90 + Math.sin(qq) * 26, 1.8, hex('#7a4ae8'), 170);
      }
      drawSlashArc(q, 40, 88, 26, -30, 60);
      q.blend(52, 90, hex('#9a6aff'), 120);
      return q;
    }
  } else if (mode === 'hurt') {
    matriarchBody(px, { xoff: -5, yoff: 1, veilFlare: true, lanternBright: false, trainSway: -4 });
    px.line(24, 50, 20, 90, gownSheen, 1); // gown ripple
  } else if (mode === 'die') {
    if (frame === 0) { // sinking: hover fails
      matriarchBody(px, { yoff: 8, trainSway: 6, lanternBright: true });
      px.ell(34, 102, 26, 5, [0, 0, 0], 150);
    } else if (frame === 1) { // collapsed
      const q = new Px(68, 104);
      q.poly([[14, 78], [54, 78], [62, 100], [6, 100]], gown); // skirt spread flat
      q.poly([[14, 78], [30, 78], [24, 100], [6, 100]], gownD);
      q.rect(26, 58, 16, 20, gown); q.rect(26, 58, 5, 20, gownD); // bodice low
      q.rect(30, 48, 10, 12, paleSkin); // fallen head
      q.px(33, 53, [25, 18, 14]); q.px(37, 53, [25, 18, 14]);
      for (let vy = 44; vy < 62; vy += 1) // sheer veil streaks
        for (const vx of [26, 27, 43, 44])
          if (((vx + vy) & 1) === 0) q.blend(vx, vy, veilC, 60);
      q.tri(30, 48, 42, 48, 36, 40, gownD); // fallen crown
      q.line(30, 47, 42, 47, silverC, 1);
      matriarchLantern(q, 60, 88, false); // dropped lantern, dim
      return q;
    } else { // dissolving into embers
      const q = new Px(68, 104);
      q.poly([[16, 84], [52, 84], [58, 100], [10, 100]], gown);
      q.poly([[16, 84], [32, 84], [28, 100], [10, 100]], gownD);
      q.speckle(40, [gownL, gownSheen], 777, 14, 82, 42, 16);
      q.line(24, 86, 46, 86, gownSheen, 1);
      const R = rng(778);
      for (let i = 0; i < 14; i++) { // violet embers rising
        const ex = 16 + R() * 36, ey = 80 - R() * 46;
        q.disc(ex, ey, 1.4, i % 3 ? hex('#9a6aff') : PAL.emberH);
        q.blend(ex, ey, hex('#9a6aff'), 80);
      }
      q.rect(58, 90, 10, 8, wardenIron); // dark lantern shell
      return q;
    }
  }
  return px;
}

/* Boss sheets: assets/bosses/<id>_<anim>.png, 128x128 frames. */
const BOSS_SHEETS = [
  { id: 'chapel_warden', anim: 'idle', fps: 6, frames: [() => chapelWarden(0, 'idle'), () => chapelWarden(1, 'idle')] },
  { id: 'chapel_warden', anim: 'attack', fps: 8, frames: [() => chapelWarden(0, 'attack'), () => chapelWarden(1, 'attack')] },
  { id: 'chapel_warden', anim: 'hurt', fps: 8, frames: [() => chapelWarden(0, 'hurt')] },
  { id: 'chapel_warden', anim: 'die', fps: 5, frames: [() => chapelWarden(0, 'die'), () => chapelWarden(1, 'die'), () => chapelWarden(2, 'die')] },
  { id: 'sable_matriarch', anim: 'idle', fps: 6, frames: [() => sableMatriarch(0, 'idle'), () => sableMatriarch(1, 'idle')] },
  { id: 'sable_matriarch', anim: 'attack', fps: 8, frames: [() => sableMatriarch(0, 'attack'), () => sableMatriarch(1, 'attack')] },
  { id: 'sable_matriarch', anim: 'hurt', fps: 8, frames: [() => sableMatriarch(0, 'hurt')] },
  { id: 'sable_matriarch', anim: 'die', fps: 5, frames: [() => sableMatriarch(0, 'die'), () => sableMatriarch(1, 'die'), () => sableMatriarch(2, 'die')] },
];
function buildBosses() {
  const index = { bosses: {}, frameContract: '128x128, art centered-bottom' };
  for (const s of BOSS_SHEETS) {
    const key = `${s.id}_${s.anim}`;
    const sheet = new Px(128 * s.frames.length, 128);
    s.frames.forEach((fn, i) => {
      const f = fn();
      sheet.blit(f, i * 128 + ((128 - f.w) >> 1), 128 - f.h);
    });
    const rel = `bosses/${key}.png`;
    emit(sheet, rel, { kind: 'boss' });
    index.bosses[key] = { id: s.id, anim: s.anim, file: `assets/${rel}`, frameWidth: 128, frameHeight: 128, frames: s.frames.length, fps: s.fps };
  }
  emitJSON('bosses/bosses.json', index);
}

/* ================= NPCS (64x64 frames, 2-frame idle strips) =================
 * Distinctive silhouettes per data/npcs.json: Old Tam (stooped keeper w/
 * staff), Sister Ansel (habit + lantern), Corvus Vane (peddler w/ pack),
 * Maribel Quill (scholar w/ scrolls), Wren Aldervale (provisioner w/ apron),
 * Gideon Hollow (tall chartmaker w/ map tube). All face right. */
const npcSkin = hex('#d9b48f'), npcSkinD = hex('#9c744f');

function npcHead(px, cx, cy, skin, opts = {}) {
  px.rect(cx - 4, cy - 5, 8, 10, skin);
  px.rect(cx - 4, cy + 3, 8, 2, opts.beard ? hex('#cfc8bb') : npcSkinD); // jaw/beard hint
  px.px(cx + 1, cy - 1, [25, 20, 16]); px.px(cx + 3, cy - 1, [25, 20, 16]); // eyes
  if (opts.spectacles) { px.px(cx, cy - 1, PAL.silver); px.px(cx + 4, cy - 1, PAL.silver); }
  if (opts.beard) { // long gray beard
    px.poly([[cx - 4, cy + 4], [cx + 4, cy + 4], [cx + 2, cy + 14], [cx - 2, cy + 14]], hex('#cfc8bb'));
    px.line(cx - 1, cy + 6, cx - 1, cy + 12, hex('#a8a094'), 1);
  }
}
function npcLantern(px, x, y, s = 1) {
  px.rect(x - 2 * s, y - 1, 4 * s, 2 * s, wardenIron);
  px.rect(x - 2 * s, y + 4 * s, 4 * s, 2 * s, wardenIron);
  px.disc(x, y + 2 * s, 2.4 * s, PAL.lantern);
  px.glowDisc(x, y + 2 * s, 6 * s, PAL.lanternGlow, 70);
}
function npcLegs(px, cx, y0, y1, c, stride) {
  px.line(cx - 3, y0, cx - 3 + stride, y1, c, 3);
  px.line(cx + 3, y0, cx + 3 - stride, y1, c, 3);
  px.rect(cx - 6 + stride, y1 - 2, 6, 3, PAL.boot); px.rect(cx + 1 - stride, y1 - 2, 6, 3, PAL.boot);
}

function oldTam(frame) {
  const px = new Px(26, 44), bob = frame ? 1 : 0, y = (o) => o + bob;
  const cloak = hex('#4e5a80'), cloakD = hex('#313a56');
  npcLegs(px, 13, y(30), y(42), cloakD, 0);
  px.poly([[7, y(14)], [19, y(14)], [21, y(32)], [5, y(32)]], cloak); // stooped cloak
  px.poly([[7, y(14)], [11, y(14)], [9, y(32)], [5, y(32)]], cloakD);
  px.line(6, y(15), 5, y(31), hex('#aab6d8'), 1); // moonlit rim
  px.line(9, y(16), 8, y(30), hex('#8b98b8'), 1); // clasp cord
  npcHead(px, 13, y(9), npcSkinD, { beard: true });
  px.poly([[6, y(10)], [20, y(10)], [18, y(2)], [8, y(2)]], cloakD); // hood
  px.line(20, y(12), 22, y(40), PAL.woodD, 2); // staff
  px.line(20, y(12), 23, y(10), PAL.woodL, 2);
  px.rect(4, y(24), 3, 5, wardenIron); px.disc(5, y(29), 1.6, PAL.lantern); // belt lantern
  px.glowDisc(5, y(29), 5, PAL.lanternGlow, 50);
  return px;
}
function sisterAnsel(frame) {
  const px = new Px(26, 44), sw = frame ? 1 : -1, y = (o) => o;
  const habit = hex('#414c72'), habitD = hex('#2a3350'), wimple = hex('#cfc8bb');
  npcLegs(px, 13, 32, 42, habitD, 0);
  px.poly([[8, 14], [18, 14], [20, 34], [6, 34]], habit); // gown
  px.poly([[8, 14], [12, 14], [10, 34], [6, 34]], habitD);
  px.line(6, 16, 5, 32, hex('#aab6d8'), 1); // moonlit rim
  px.line(13, 16, 13, 32, wimple, 1); // front panel
  npcHead(px, 13, 9, npcSkin, {});
  px.poly([[5, 12], [21, 12], [19, 2], [7, 2]], habitD);   // veil
  px.rect(6, 4, 14, 8, wimple); px.rect(8, 6, 10, 6, habitD); // wimple frame
  npcHead(px, 13, 9, npcSkin, {});
  px.rect(9, 20 + sw, 8, 4, npcSkin); // hands clasped
  npcLantern(px, 13, 24 + sw, 1);
  return px;
}
function corvusVane(frame) {
  const px = new Px(30, 44), bob = frame ? 1 : 0, y = (o) => o + bob;
  const coat = hex('#5a5232'), coatD = hex('#3a3620');
  npcLegs(px, 14, y(30), y(42), coatD, frame ? 1 : 0);
  px.rect(8, y(14), 12, 17, coat); // patched coat
  px.rect(8, y(14), 4, 17, coatD);
  px.px(16, y(20), hex('#7a6a3a')); px.px(11, y(26), hex('#6e5a34')); // patches
  px.line(8, y(22), 20, y(22), coatD, 1); // belt
  px.rect(16, y(21), 5, 4, hex('#8a6a2a')); // coin pouch
  npcHead(px, 14, y(9), npcSkin, {});
  px.rect(6, y(4), 16, 3, hex('#4a3820'));  // wide-brim hat
  px.rect(10, y(-1), 8, 5, hex('#5a4828')); px.rect(10, y(3), 8, 1, hex('#8a6a2a'));
  // bulging backpack with trinkets
  px.ell(4, y(22), 6, 9, hex('#6e4c2e')); px.ell(4, y(22), 4, 6, hex('#4a3220'));
  px.line(1, y(16), 7, y(27), hex('#33261a'), 2); // pack strap
  px.line(1, y(28), 7, y(17), hex('#33261a'), 1);
  px.rect(1, y(12), 3, 4, PAL.candle); px.disc(2, y(11), 1.4, PAL.flame);
  px.rect(5, y(13), 4, 3, PAL.ironL); // pot
  px.line(2, y(28), 8, y(30), hex('#33261a'), 2); // bedroll strap
  return px;
}
function maribelQuill(frame) {
  const px = new Px(26, 44), sw = frame ? 1 : -1, y = (o) => o;
  const coat = hex('#6e3527'), coatD = hex('#431f16');
  npcLegs(px, 13, 30, 42, coatD, 0);
  px.rect(7, 13, 12, 19, coat); // long scholar's coat
  px.rect(7, 13, 4, 19, coatD);
  px.line(13, 15, 13, 30, hex('#c9a44a'), 1); // brass clasp line
  px.tri(7, 32, 19, 32, 13 + sw, 40, coat);   // coat tails
  npcHead(px, 13, 8, npcSkin, { spectacles: true });
  px.poly([[6, 8], [20, 8], [18, 0], [8, 0]], hex('#3a2c1c')); // hair bun wrap
  px.rect(17, 2, 2, 6, hex('#e8e2d2')); // quill tucked at shoulder
  px.line(17, 2, 19, -1, hex('#fff'), 1);
  px.rect(3, 22, 6, 8, hex('#4a3220')); // scroll satchel
  px.rect(4, 20, 2, 4, PAL.parchment); px.rect(6, 20, 2, 3, PAL.parchmentD); // scroll tops
  px.rect(18, 24 + sw, 5, 7, PAL.parchment); // held notes
  px.line(19, 26 + sw, 22, 26 + sw, PAL.parchmentD, 1); px.line(19, 28 + sw, 22, 28 + sw, PAL.parchmentD, 1);
  return px;
}
function wrenAldervale(frame) {
  const px = new Px(26, 44), bob = frame ? 1 : 0, y = (o) => o + bob;
  const tunic = hex('#4c5a44'), apron = hex('#8a7a5a'), apronD = hex('#5f5340');
  npcLegs(px, 13, y(30), y(42), hex('#2c352a'), frame ? 1 : 0);
  px.rect(8, y(14), 10, 17, tunic);
  px.rect(9, y(15), 8, 15, apron); // canvas apron
  px.rect(9, y(15), 8, 3, apronD); // bib top
  px.px(13, y(22), hex('#3a2f22')); // apron stain
  px.line(6, y(16), 4, y(24), npcSkin, 3); // rolled sleeves: forearms
  px.line(20, y(16), 22, y(24), npcSkin, 3);
  npcHead(px, 13, y(9), npcSkin, {});
  px.poly([[6, y(8)], [20, y(8)], [19, y(1)], [7, y(1)]], hex('#2e2620')); // damp hair
  px.line(7, y(8), 6, y(14), hex('#2e2620'), 1);
  px.rect(18, y(26), 5, 6, hex('#6e4c2e')); // hip satchel
  px.rect(4, y(28), 6, 5, hex('#5a4828'));  // held parcel
  return px;
}
function gideonHollow(frame) {
  const px = new Px(28, 46), sw = frame ? 1 : -1, y = (o) => o;
  const coat = hex('#3c3850'), coatD = hex('#232030');
  npcLegs(px, 14, 32, 44, coatD, 0);
  px.rect(8, 12, 12, 22, coat); // long chartmaker's coat
  px.rect(8, 12, 4, 22, coatD);
  px.tri(8, 34, 20, 34, 14 + sw, 43, coat); // coat tails
  px.line(8, 13, 8, 33, hex('#8b98c8'), 1); // moonlit rim
  px.line(14, 14, 14, 32, hex('#565172'), 1);
  npcHead(px, 14, 7, npcSkinD, {});
  px.poly([[7, 8], [21, 8], [19, 1], [9, 1]], coatD); // low hood
  // map tube across the back
  px.line(4, 30, 24, 14, hex('#6e4c2e'), 4);
  px.line(4, 30, 24, 14, hex('#8a6238'), 1);
  px.rect(21, 11, 4, 4, hex('#c9a44a')); // brass cap
  px.line(20, 16, 22, 26, npcSkin, 3);   // arm holding lantern low
  npcLantern(px, 23, 28 + sw, 1);
  return px;
}

const NPC_SHEETS = [
  { id: 'old_tam', fn: oldTam }, { id: 'sister_ansel', fn: sisterAnsel },
  { id: 'corvus_vane', fn: corvusVane }, { id: 'maribel_quill', fn: maribelQuill },
  { id: 'wren_aldervale', fn: wrenAldervale }, { id: 'gideon_hollow', fn: gideonHollow },
];
function buildNpcs() {
  const index = { npcs: {}, frameContract: '64x64, art centered-bottom' };
  for (const s of NPC_SHEETS) {
    const key = `${s.id}_idle`;
    const sheet = new Px(128, 64);
    [0, 1].forEach((fr) => {
      const f = s.fn(fr);
      sheet.blit(f, fr * 64 + ((64 - f.w) >> 1), 64 - f.h);
    });
    const rel = `npcs/${key}.png`;
    emit(sheet, rel, { kind: 'npc' });
    index.npcs[key] = { id: s.id, anim: 'idle', file: `assets/${rel}`, frameWidth: 64, frameHeight: 64, frames: 2, fps: 4 };
  }
  emitJSON('npcs/npcs.json', index);
}

function verify() {
  console.log('\n=== ART VERIFICATION ===');
  let fail = 0, n = 0;
  for (const m of MANIFEST) {
    if (m.json) continue;
    n++;
    const buf = fs.readFileSync(path.join(ROOT, m.file));
    try {
      const px = decodePNG(buf);
      const st = pixelStats(px);
      const ok = px.w === m.w && px.h === m.h && st.alphaPx > 0 && st.colors >= 3;
      if (!ok) fail++;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${m.file} ${px.w}x${px.h} colors=${st.colors} drawn=${(st.coverage * 100).toFixed(1)}%`);
    } catch (e) { fail++; console.log(`FAIL ${m.file}: ${e.message}`); }
  }
  console.log(fail ? `\n${fail}/${n} FAILURES` : `\nAll ${n} PNGs verified OK.`);
  if (fail) process.exitCode = 1;
}
function main() {
  console.log('painting original art for THE CITADEL OF VESPER...');
  buildPlayer();
  buildEnemies();
  buildBosses();
  buildNpcs();
  buildTilesets();
  buildProps();
  buildItems();
  buildParallax();
  buildTitle();
  buildUI();
  buildEffects();
  verify();
  console.log('done.');
}
main();
