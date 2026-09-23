/**
 * WeaponData — loads + queries data/weapons.json (spec §15, §19, §20, §21).
 *
 * CONTRACT:
 * - get(id): full weapon definition (schema: data/schemas/weapon.schema.json).
 * - listByFamily(family): e.g. 'sword'|'greatsword'|'dagger'|'axe'|'spear'|
 *   'chain'|'fist'|'magic'|'relic'.
 * - compare(aId, bId): returns { atkDelta, statDeltas, speedDelta } for the
 *   EQUIPPED-vs-candidate comparison UI (spec §19 example format).
 * - Weapons change more than numbers: each definition carries attackProfile
 *   { animationKey, reach, activeFrames, recovery, attackSpeed, knockback,
 *   soundId, effectId, hitbox {w,h}, specials[] } consumed by PlayerCombat.
 * - Special properties (§21): `specials` entries like
 *   { trigger: 'hold_attack', effect: 'charged_slash' },
 *   { trigger: 'low_hp', effect: 'glow_reach' },
 *   { trigger: 'moonlit_room', effect: 'magic_damage' }.
 *   Implemented by PlayerCombat/abilities in later waves; DATA lives here.
 * - Data is loaded once at boot (AssetManager 'boot' stage) and cached.
 *
 * Wave 2 implements the loader; weapon content grows in Wave 4.
 */
export class WeaponData {
  /** @param {object[]} weaponsArray parsed data/weapons.json */
  constructor(weaponsArray = []) {
    /** @type {Map<string, object>} */
    this.byId = new Map(weaponsArray.map((w) => [w.id, w]));
  }

  /** @param {string} id @returns {object} throws on unknown id */
  get(id) {
    const w = this.byId.get(id);
    if (!w) throw new Error(`unknown weapon id '${id}'`);
    return w;
  }

  /** @param {string} family @returns {object[]} */
  listByFamily(family) {
    return [...this.byId.values()].filter((w) => w.family === family);
  }

  /**
   * Compare candidate vs currently equipped (for UI compare view).
   * Missing equippedId = bare fists (all zeros).
   * @param {string} candidateId @param {string|null} equippedId
   * @returns {{atkDelta:number, statDeltas:object, speedDelta:number, critDelta:number}}
   */
  compare(candidateId, equippedId) {
    const cand = this.get(candidateId);
    const eq = equippedId ? this.byId.get(equippedId) ?? null : null;
    const stat = (w, k) => w?.stats?.[k] ?? 0;
    const atkDelta = stat(cand, 'atk') - stat(eq, 'atk');
    const critDelta = stat(cand, 'crit') - stat(eq, 'crit');
    const statDeltas = {};
    const keys = new Set([
      ...Object.keys(cand.stats ?? {}),
      ...Object.keys(eq?.stats ?? {}),
    ]);
    for (const k of keys) {
      if (k === 'atk' || k === 'crit') continue;
      const d = stat(cand, k) - stat(eq, k);
      if (d !== 0) statDeltas[k] = d;
    }
    const speed = (w) => w?.attackProfile?.attackSpeed ?? 1;
    return {
      atkDelta,
      statDeltas,
      speedDelta: speed(cand) - speed(eq),
      critDelta,
    };
  }
}
