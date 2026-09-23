/**
 * Art manifest tests (Wave 5 art pass).
 *
 * Verifies that every image referenced by the generated art manifests
 * actually exists on disk — in BOTH the authoring tree (assets/) and the
 * runtime tree (public/assets/) — and that PNG dimensions match the
 * manifest's frame contract. Catches the classic "forgot to run
 * sync_public_assets.js" and "frame size drift" failures.
 *
 * Pure Node: reads PNG headers directly (no image decoding libs).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetPacks } from '../src/config/assets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal PNG header reader: returns { width, height }. */
function pngSize(path) {
  const buf = readFileSync(path);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`not a PNG: ${path}`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

/** Collect { key, file, frameWidth, frameHeight, frames } from a manifest. */
function manifestEntries() {
  const out = [];
  const push = (source, key, e) => {
    if (!e || typeof e.file !== 'string') return;
    out.push({
      source: `${source}:${key}`,
      file: e.file,
      frameWidth: e.frameWidth ?? null,
      frameHeight: e.frameHeight ?? null,
      frames: e.frames ?? 1,
    });
  };
  const bosses = loadJson('assets/bosses/bosses.json').bosses ?? {};
  for (const [k, v] of Object.entries(bosses)) push('bosses.json', k, v);
  const npcs = loadJson('assets/npcs/npcs.json').npcs ?? {};
  for (const [k, v] of Object.entries(npcs)) push('npcs.json', k, v);
  const enemies = loadJson('assets/enemies/enemies.json').enemies ?? {};
  for (const [k, v] of Object.entries(enemies)) push('enemies.json', k, v);
  const props = loadJson('assets/environments/props/props.json').props ?? {};
  for (const [k, v] of Object.entries(props)) push('props.json', k, v);
  for (const region of ['moonlit_gate', 'hollow_keep']) {
    const ts = loadJson(`assets/tilesets/${region}_tiles.json`);
    if (typeof ts.file === 'string') {
      out.push({
        source: `tiles:${region}`,
        file: ts.file,
        frameWidth: ts.tileWidth,
        frameHeight: ts.tileHeight,
        frames: ts.tileCount,
        columns: ts.columns,
      });
    }
  }
  const title = loadJson('assets/title/title.json').title;
  if (title?.file) out.push({ source: 'title.json', file: title.file, frames: 1 });
  return out;
}

/** Every AssetPacks image/spritesheet entry -> expected public file. */
function packEntries() {
  const out = [];
  for (const [packId, entries] of Object.entries(AssetPacks)) {
    for (const e of entries ?? []) {
      if (e.type !== 'image' && e.type !== 'spritesheet') continue;
      out.push({ source: `AssetPacks:${packId}:${e.key}`, ...e });
    }
  }
  return out;
}

describe('art manifests: files exist in assets/ and public/assets/', () => {
  const entries = manifestEntries();

  it('discovers manifest entries', () => {
    expect(entries.length).toBeGreaterThan(30);
  });

  for (const e of entries) {
    it(`${e.source} -> ${e.file}`, () => {
      for (const base of ['assets', 'public/assets']) {
        const rel = e.file.replace(/^assets\//, `${base}/`);
        const abs = join(ROOT, rel);
        expect(existsSync(abs), `missing ${rel}`).toBe(true);
      }
    });
  }
});

describe('art manifests: PNG dimensions match the frame contract', () => {
  for (const e of manifestEntries()) {
    if (!e.frameWidth || !e.frameHeight) continue;
    it(`${e.source} dimensions`, () => {
      const { width, height } = pngSize(join(ROOT, e.file));
      if (e.columns) {
        // tileset: grid of columns x ceil(frames/columns)
        const rows = Math.ceil(e.frames / e.columns);
        expect(width).toBe(e.frameWidth * e.columns);
        expect(height).toBe(e.frameHeight * rows);
      } else {
        // strip: frames laid out horizontally, one row
        expect(width).toBe(e.frameWidth * e.frames);
        expect(height).toBe(e.frameHeight);
      }
    });
  }
});

describe('AssetPacks: every image/spritesheet resolves to a public file', () => {
  const entries = packEntries();

  it('discovers pack entries', () => {
    expect(entries.length).toBeGreaterThan(40);
  });

  for (const e of entries) {
    it(`${e.source} -> ${e.file ?? e.url}`, () => {
      const url = e.file ?? e.url;
      const abs = join(ROOT, 'public', url);
      expect(existsSync(abs), `missing public/${url}`).toBe(true);
      if (e.type === 'spritesheet') {
        const { width, height } = pngSize(abs);
        expect(width % e.frameWidth).toBe(0);
        expect(height % e.frameHeight).toBe(0);
        expect(width / e.frameWidth >= 1).toBe(true);
      }
    });
  }
});

describe('Wave 5 art: expected sheets are present', () => {
  const files = manifestEntries().map((e) => e.file);
  const has = (f) => files.includes(f);

  it('both bosses ship idle/attack/hurt/die', () => {
    for (const id of ['chapel_warden', 'sable_matriarch']) {
      for (const anim of ['idle', 'attack', 'hurt', 'die']) {
        expect(has(`assets/bosses/${id}_${anim}.png`), `${id}_${anim}`).toBe(true);
      }
    }
  });

  it('all six NPCs ship idle sheets', () => {
    for (const id of [
      'old_tam',
      'sister_ansel',
      'corvus_vane',
      'maribel_quill',
      'wren_aldervale',
      'gideon_hollow',
    ]) {
      expect(has(`assets/npcs/${id}_idle.png`), id).toBe(true);
    }
  });

  it('weak enemies ship attack sheets', () => {
    for (const id of ['cinder_wisp', 'mote_swarm', 'vellum_phantom']) {
      expect(has(`assets/enemies/${id}_attack.png`), id).toBe(true);
    }
  });

  it('torch_wall prop ships', () => {
    expect(has('assets/environments/props/torch_wall.png')).toBe(true);
  });
});
