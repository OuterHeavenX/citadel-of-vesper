/**
 * Shared test helpers: load a schema + data file and validate.
 * Used by test/*.test.js — one test file per schema.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ajv = new Ajv({ allErrors: true, strict: false });

export function loadJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
}

/**
 * Register a schema-validation test suite for one data file.
 * @param {string} schemaFile e.g. 'weapon.schema.json'
 * @param {string} dataFile e.g. 'weapons.json'
 * @param {'array'|'object'} kind
 */
export function schemaSuite(schemaFile, dataFile, kind = 'array') {
  const schema = loadJson(`data/schemas/${schemaFile}`);
  const data = loadJson(`data/${dataFile}`);
  const validate = ajv.compile(schema);

  describe(`${dataFile} validates against ${schemaFile}`, () => {
    it('has the expected top-level shape', () => {
      if (kind === 'array') expect(Array.isArray(data)).toBe(true);
      else expect(typeof data).toBe('object');
    });

    it('contains at least one example entry', () => {
      const items = kind === 'array' ? data : [data];
      expect(items.length).toBeGreaterThan(0);
    });

    it('every entry passes the schema', () => {
      const items = kind === 'array' ? data : [data];
      for (const [i, item] of items.entries()) {
        const ok = validate(item);
        expect(validate.errors ?? [], `entry ${i} (${item.id ?? 'n/a'}) errors`).toEqual([]);
        expect(ok).toBe(true);
      }
    });

    it('ids are unique and well-formed', () => {
      if (kind !== 'array') return;
      const ids = data.map((d) => d.id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
    });
  });
}
