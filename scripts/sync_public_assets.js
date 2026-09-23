#!/usr/bin/env node
/**
 * sync_public_assets.js — copy game-ready art from assets/ (authoring
 * sources) to public/assets/ (Vite-served runtime files).
 *
 * The AssetManager manifest (src/config/assets.js) uses repo-relative URLs
 * like 'assets/player/lucien_idle.png' resolved against BASE_URL, which Vite
 * serves from public/. Run after `node scripts/make_art.js`:
 *
 *   node scripts/make_art.js && node scripts/sync_public_assets.js
 *
 * Only image/data files are synced (*.png, *.json sidecars). READMEs and
 * docs stay in assets/ only.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'assets');
const DEST = path.join(ROOT, 'public', 'assets');
const SYNC_EXTS = new Set(['.png', '.json']);

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && SYNC_EXTS.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

let copied = 0;
for await (const srcFile of walk(SRC)) {
  const rel = path.relative(SRC, srcFile);
  const destFile = path.join(DEST, rel);
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  await fs.copyFile(srcFile, destFile);
  copied += 1;
}
console.log(`sync_public_assets: copied ${copied} file(s) to public/assets/`);
