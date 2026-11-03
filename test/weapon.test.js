import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { schemaSuite } from './helpers.js';
import { AssetPacks } from '../src/config/assets.js';
import { SfxDefinitions } from '../src/audio/index.js';

schemaSuite('weapon.schema.json', 'weapons.json');

// ---------------------------------------------------------------------------
// Pale Hour Blade — the quick slashing sword whose blade is never drawn on
// the swing (only its detached slash). Cross-file contract checks.
// ---------------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

describe('Pale Hour Blade (quick slashing sword)', () => {
  const weapons = readJson('data/weapons.json');
  const blade = weapons.find((w) => w.id === 'pale_hour_blade');
  const manifestKeys = new Set(Object.values(AssetPacks).flat().map((e) => e.key));

  it('is a sword with a quick, slash-fx attack profile', () => {
    expect(blade).toBeTruthy();
    expect(blade.family).toBe('sword');
    const ap = blade.attackProfile;
    const recruit = weapons.find((w) => w.id === 'recruit_blade').attackProfile;
    expect(ap.attackSpeed).toBeGreaterThan(recruit.attackSpeed);
    expect(ap.recovery).toBeLessThan(recruit.recovery);
    expect(ap.slashFx?.texture).toBe('fx_slash_quick');
  });

  it('swings with a staged clip that is distinct from the blade-drawing sword clip', () => {
    const key = blade.attackProfile.animationKey;
    expect(key).toBe('lucien_attack_quick');
    const layout = readJson('assets/player/lucien.json');
    expect(layout.animations[key.replace(/^lucien_/, '')]).toBeTruthy();
    expect(manifestKeys.has(key)).toBe(true);
  });

  it('its slash sheet has frames + a pivot and is in the asset manifest', () => {
    const meta = readJson('assets/effects/effects.json').effects.fx_slash_quick;
    expect(meta.frames).toBeGreaterThan(1);
    expect(meta.pivot).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    const entry = Object.values(AssetPacks).flat().find((e) => e.key === 'fx_slash_quick');
    expect(entry).toMatchObject({ type: 'spritesheet', frameWidth: meta.frameWidth, frameHeight: meta.frameHeight });
  });

  it('has a synthesized swing sound and an icon', () => {
    expect(SfxDefinitions[blade.attackProfile.soundId]).toBeTruthy();
    expect(manifestKeys.has(blade.icon)).toBe(true);
  });

  it('waits in the Sable Sanctum until the Sable Matriarch falls', () => {
    const rooms = readJson('data/rooms.json');
    const spots = rooms.flatMap((r) => (r.pickups ?? []).map((p) => ({ room: r.id, ...p })))
      .filter((p) => p.itemId === 'pale_hour_blade');
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({
      room: 'hollow_keep_010', chest: true, requiresFlag: 'boss_defeated_sable_matriarch',
    });
  });
});
