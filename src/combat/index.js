/**
 * src/combat — damage, hitboxes, projectiles, status. Public API surface:
 *
 *   DamageSystem.js      DamageSystem.applyDamage(source, target, opts) — the ONLY damage path
 *   HitboxSystem.js      class HitboxSystem — spawnHitbox / registerHurtbox /
 *                          update / drawDebug / despawnHitbox / forEachHurtbox
 *   ProjectileSystem.js  class ProjectileSystem — pooled fire()/update()/clear();
 *                          collides via the HitboxSystem hurtbox registry when
 *                          one is provided, else its own registerTarget() list
 *   StatusEffects.js     statusEffects singleton + StatusEffects class —
 *                          apply/remove/has/update; local EFFECT_DEFS
 *                          (Wave 4 migrates defs to data/abilities.json)
 *
 * Rules: combat never reads tuning directly except via PlayerStats/EnemyStats.
 * Damage numbers, hit pause, screenshake are triggered from 'combat:hitLanded'
 * by src/effects and src/ui — not from inside DamageSystem.
 */
export { DamageSystem, CRIT_MULTIPLIER, MAX_MITIGATION } from './DamageSystem.js';
export { HitboxSystem } from './HitboxSystem.js';
export { ProjectileSystem } from './ProjectileSystem.js';
export { StatusEffects, statusEffects } from './StatusEffects.js';
