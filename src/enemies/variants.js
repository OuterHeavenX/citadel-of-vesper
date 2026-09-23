/**
 * src/enemies/variants.js — the 8 vertical-slice enemy subclasses.
 *
 * All designs are ORIGINAL (ARCHITECTURE.md §0). Each subclass tunes the
 * base Enemy state machine via instance fields and overrides pickAttack /
 * strikeAttack / state updates. Per-enemy constants are named at the top of
 * each class — no magic numbers scattered through logic.
 *
 * Self-registers with EnemyFactory on import (see src/enemies/index.js for
 * import order; no import cycles: this module imports EnemyFactory, never
 * the reverse).
 */
import { Enemy } from './Enemy.js';
import { EnemyFactory } from './EnemyFactory.js';

// ---------------------------------------------------------------------------
// 1. Ash Hound — fast quadruped charger (Moonlit Gate).
//    Patrols, crouch-growl telegraph, then an arcing pounce.
// ---------------------------------------------------------------------------
export class AshHound extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 195;
    this.attackRange = 85; // pounce triggers from a short run-up
    this.patrolSpeed = 55;
    this.cooldown = 1.6;
    this.recoverTime = 0.5;
    this.leapMult = 1.0; // the pounce itself is the damage
    this.contactMult = 0.6;
    this.flashColor = 0xffa030; // ember amber
  }

  _moveAnim() {
    return 'run';
  }

  pickAttack() {
    return 'pounce';
  }

  strikeAttack() {
    // arcing leap at the player's position; contact during the leap hits
    this.startLeap(this.facing * 340, -215);
    this._playSfx('swing_sabre', { volume: 0.6 });
  }
}

// ---------------------------------------------------------------------------
// 2. Rustbound Revenant — slow armored swordsman (Moonlit Gate).
//    Sometimes raises its shield to negate frontal hits; overhead cleave
//    with a long, readable windup.
// ---------------------------------------------------------------------------
const REVENANT_BLOCK_CHANCE = 0.35;

export class RustboundRevenant extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 165;
    this.attackRange = 52;
    this.patrolSpeed = 30;
    this.cooldown = 2.1;
    this.recoverTime = 0.65;
    this.blockChance = REVENANT_BLOCK_CHANCE;
    this.contactMult = 0.7;
    this.flashColor = 0xc0c8e0; // cold steel
  }

  _moveAnim() {
    return 'walk';
  }

  pickAttack() {
    return 'overhead_cleave';
  }

  strikeAttack(p) {
    this.dealMelee(p, {
      range: 62,
      arcH: 34,
      mult: 1.25,
      type: 'physical',
      knockback: { x: this.facing * 170, y: -70 },
      hitStun: 0.35,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Cinder Wisp — floating ember spirit (Hollow Keep).
//    Drifts on a hover sine, keeps its distance, lobs arcing fire.
// ---------------------------------------------------------------------------
export class CinderWisp extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 230;
    this.attackRange = 260; // casts from afar
    this.cooldown = 2.4;
    this.recoverTime = 0.4;
    this.contactMult = 0.5;
    this.flashColor = 0xff7020; // bright ember
  }

  updatePursue(dt, p) {
    if (!p) {
      this._setState('idle');
      return;
    }
    if (this.distTo(p) > this.aggroRange * 1.6) {
      this._setState('idle');
      return;
    }
    // keep a mid-range band: drift away when crowded, close in when far
    const d = this.distTo(p);
    const dx = p.x - this.x;
    const dy = (p.y - 46) - this.y;
    const speed = this.def.stats?.speed ?? 70;
    if (d < 130) {
      const away = Math.sign(dx) || 1;
      this.vx = -away * speed;
    } else if (d > 215) {
      this.vx = Math.sign(dx) * speed;
    } else {
      this.vx *= 1 - Math.min(1, dt * 4);
    }
    this.vy = Math.max(-80, Math.min(80, dy * 2)) + Math.sin(this.stateT * 2.6) * 14;
    if (this.cooldownT <= 0) {
      this.beginAttack(this.pickAttack());
      return;
    }
    this.playAnim('idle');
  }

  updateIdle(dt, p) {
    // hover in place; aggro from farther than grounded enemies
    this.vx *= 1 - Math.min(1, dt * 4);
    this.vy = Math.sin(this.stateT * 2.2) * 14;
    if (this.inAggro(p)) this._setState('pursue');
  }

  pickAttack() {
    return 'ember_lob';
  }

  strikeAttack() {
    this.castProjectile({
      vx: this.facing * 150,
      vy: -175,
      gravity: 520,
      mult: 1.0,
      type: 'fire',
      knockback: { x: this.facing * 90, y: -50 },
      hitStun: 0.3,
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Hollow Sentinel — headless animated armor (Hollow Keep).
//    Slow patrol, long-reach sweeping spear poke, very hard to stagger.
// ---------------------------------------------------------------------------
export class HollowSentinel extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 175;
    this.attackRange = 92; // spear reach
    this.patrolSpeed = 28;
    this.cooldown = 2.2;
    this.recoverTime = 0.6;
    this.contactMult = 0.7;
    this.flashColor = 0xb070ff; // violet hollow-light
    // defense 8 already grants high poise via the base formula;
    // sentinels are extra-planted:
    this.maxPoise = this.maxPoise * 1.6;
  }

  _moveAnim() {
    return 'walk';
  }

  pickAttack() {
    return 'spear_sweep';
  }

  strikeAttack(p) {
    this.dealMelee(p, {
      range: 98,
      arcH: 28,
      mult: 1.2,
      type: 'physical',
      knockback: { x: this.facing * 230, y: -30 },
      hitStun: 0.4,
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Vellum Phantom — possessed flying tome (Hollow Keep).
//    Plays dead (ambush) until approached, teleports to reposition, fires
//    spectral bolts. Fragile but slippery.
// ---------------------------------------------------------------------------
const PHANTOM_AMBUSH_RANGE = 150;
const PHANTOM_TELEPORT_EVERY = 3.4;

export class VellumPhantom extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 210;
    this.attackRange = 240;
    this.cooldown = 2.0;
    this.recoverTime = 0.4;
    this.contactMult = 0.5;
    this.flashColor = 0xe8e0ff; // pale page-light
    this.teleportT = PHANTOM_TELEPORT_EVERY;
    this.teleporting = 0; // >0 while mid-blink
  }

  updateIdle(dt, p) {
    // AMBUSH: lie dormant, pages barely stirring, until the player is close
    this.vx *= 1 - Math.min(1, dt * 5);
    this.vy = Math.sin(this.stateT * 1.4) * 6;
    if (p && this.distTo(p) < PHANTOM_AMBUSH_RANGE) {
      // the ambush burst IS the bolt telegraph — no free hit
      this._setState('pursue');
      if (this.cooldownT <= 0) this.beginAttack(this.pickAttack());
    }
  }

  updatePursue(dt, p) {
    if (!p) {
      this._setState('idle');
      return;
    }
    if (this.distTo(p) > this.aggroRange * 1.6) {
      this._setState('idle');
      return;
    }
    // TELEPORT reposition: flicker out, reappear at a flank near the player
    this.teleportT -= dt;
    if (this.teleportT <= 0 && this.teleporting <= 0) {
      this.teleporting = 0.32;
      this.invulnT = Math.max(this.invulnT, 0.55);
      this._playSfx('page_rustle');
    }
    if (this.teleporting > 0) {
      this.teleporting -= dt;
      this.vx = 0;
      this.vy = 0;
      if (this.sprite) {
        try {
          this.sprite.setAlpha(0.25 + 0.75 * Math.abs(Math.sin(this.teleporting * 40)));
        } catch {
          /* ignore */
        }
      }
      if (this.teleporting <= 0) {
        const a = this.ctx.rng() * Math.PI * 2;
        const r = 130 + this.ctx.rng() * 60;
        this.x = p.x + Math.cos(a) * r;
        this.y = p.y - 40 + Math.sin(a) * r * 0.55;
        this.teleportT = PHANTOM_TELEPORT_EVERY * (0.8 + this.ctx.rng() * 0.4);
        if (this.sprite) {
          try {
            this.sprite.setAlpha(1);
          } catch {
            /* ignore */
          }
        }
        this._playSfx('page_rustle', { volume: 0.7 });
      }
      return;
    }
    // drift to a firing lane, never sitting still
    const d = this.distTo(p);
    const speed = this.def.stats?.speed ?? 85;
    if (d < 150) {
      this.vx = -Math.sign(p.x - this.x || 1) * speed;
    } else if (d > 230) {
      this.vx = Math.sign(p.x - this.x || 1) * speed;
    } else {
      this.vx = Math.sin(this.stateT * 1.8) * speed * 0.5;
    }
    this.vy = Math.max(-90, Math.min(90, (p.y - 50 - this.y) * 2)) + Math.sin(this.stateT * 3.1) * 12;
    if (this.cooldownT <= 0) {
      this.beginAttack(this.pickAttack());
      return;
    }
    this.playAnim('idle');
  }

  pickAttack() {
    return 'spectral_bolt';
  }

  strikeAttack() {
    this.castProjectile({
      vx: this.facing * 230,
      vy: 0,
      gravity: 0,
      w: 10,
      h: 10,
      life: 2.2,
      mult: 1.0,
      type: 'shadow',
      knockback: { x: this.facing * 70, y: -20 },
      hitStun: 0.25,
    });
  }
}

// ---------------------------------------------------------------------------
// 6. Vesper Chimer — bell construct (Hollow Keep).
//    Near-stationary; slow drift, then a long chiming windup into a radial
//    shockwave. Punishes greed, rewards patience.
// ---------------------------------------------------------------------------
export class VesperChimer extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 200;
    this.attackRange = 112;
    this.cooldown = 3.0;
    this.recoverTime = 0.8;
    this.contactMult = 0.8;
    this.flashColor = 0xffd76b; // bell-brass
  }

  updatePursue(dt, p) {
    if (!p) {
      this._setState('idle');
      return;
    }
    if (this.distTo(p) > this.aggroRange * 1.6) {
      this._setState('idle');
      return;
    }
    // ponderous drift — it wants you close, not the other way around
    const speed = this.def.stats?.speed ?? 20;
    if (this.distTo(p) > 150) {
      this.vx = Math.sign(p.x - this.x || 1) * speed;
    } else {
      this.vx = 0;
    }
    this.vy = 0;
    if (this.cooldownT <= 0 && this.inAttackRange(p)) {
      this.beginAttack(this.pickAttack());
      return;
    }
    this.playAnim('idle');
  }

  pickAttack() {
    return 'resonance_ring';
  }

  strikeAttack(p) {
    this._playSfx('bell_chime');
    this.dealRadial(p, {
      radius: 118,
      mult: 1.35,
      type: 'lightning',
      knockback: { x: 0, y: -120 }, // radial handled per-side below
      hitStun: 0.5,
    });
  }

  dealRadial(p, opts = {}) {
    // chimer-specific: knockback always pushes AWAY from the bell
    const target = p?.ref ?? (p ? this.ctx.getPlayer() : null);
    if (!target) return null;
    const px = p?.x ?? target.x;
    const away = Math.sign(px - this.x) || 1;
    return super.dealRadial(p, {
      ...opts,
      knockback: { x: away * 200, y: -100 },
    });
  }
}

// ---------------------------------------------------------------------------
// 7. Mote Swarm — crawling insect cluster (Hollow Keep).
//    Skitters fast and erratically along the ground; quick weak pounces.
// ---------------------------------------------------------------------------
export class MoteSwarm extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 180;
    this.attackRange = 70;
    this.patrolSpeed = 90;
    this.cooldown = 1.1;
    this.recoverTime = 0.35;
    this.leapMult = 0.6; // many small bites, not one big one
    this.contactMult = 0.5;
    this.flashColor = 0xd8cf9a; // dust-pale
    this._jitterT = 0;
  }

  updatePatrol(dt, p) {
    if (this.inAggro(p)) {
      this._setState('pursue');
      return;
    }
    // erratic skitter: jitter direction on a short timer
    this._jitterT -= dt;
    if (this._jitterT <= 0) {
      this._jitterT = 0.3 + this.ctx.rng() * 0.4;
      this.patrolDir = this.ctx.rng() < 0.5 ? -1 : 1;
      if (Math.abs(this.x - this.spawnX) > 170) this.patrolDir = Math.sign(this.spawnX - this.x) || 1;
    }
    this.vx = this.patrolDir * this.patrolSpeed;
    this.facing = this.patrolDir;
    this.playAnim('idle');
  }

  updatePursue(dt, p) {
    if (!p) {
      this._setState('idle');
      return;
    }
    if (this.distTo(p) > this.aggroRange * 1.6) {
      this._setState('patrol');
      return;
    }
    if (this.cooldownT <= 0 && this.inAttackRange(p)) {
      this.beginAttack(this.pickAttack());
      return;
    }
    // skitter with a sideways wobble — hard to line up against
    const speed = this.def.stats?.speed ?? 135;
    this.vx = Math.sign(p.x - this.x || 1) * speed;
    this.vy = 0;
    this.x += Math.sin(this.stateT * 9) * 24 * dt; // wobble without breaking vx steering
    this.playAnim('idle');
  }

  pickAttack() {
    return 'skitter_pounce';
  }

  strikeAttack() {
    this.startLeap(this.facing * 265, -150);
    this._playSfx('swarm_chitter', { volume: 0.7 });
  }
}

// ---------------------------------------------------------------------------
// 8. Cinder Mastiff — elite brute (Hollow Keep).
//    Opens with a room-crossing charge (locked direction), backs off, then
//    follows with twin rends. The `charge` + `retreat` showcase.
// ---------------------------------------------------------------------------
const MASTIFF_CHARGE_SPEED = 380;
const MASTIFF_CHARGE_TIME = 0.85;

export class CinderMastiff extends Enemy {
  constructor(scene, def, instanceId, x, y, ctx = {}) {
    super(scene, def, instanceId, x, y, ctx);
    this.aggroRange = 230;
    this.attackRange = 150; // charge triggers from mid-range
    this.patrolSpeed = 45;
    this.cooldown = 2.6;
    this.contactMult = 0.8;
    this.flashColor = 0xff5020; // deep ember
    this._combo = 0; // cycles charge -> rend -> rend
    this._chargeT = 0;
    this._charging = false;
    this._rendStep = 0;
    this._rendT = 0;
  }

  _moveAnim() {
    return 'run';
  }

  pickAttack() {
    const seq = ['savage_charge', 'twin_rend', 'twin_rend'];
    const name = seq[this._combo % seq.length];
    this._combo += 1;
    return name;
  }

  beginAttack(attackName) {
    super.beginAttack(attackName);
    if (attackName === 'savage_charge') {
      this._charging = false;
      this._chargeT = 0;
    } else {
      this._rendStep = 0;
      this._rendT = 0;
    }
  }

  updatePursue(dt, p) {
    if (!p) {
      this._setState('idle');
      return;
    }
    if (this.distTo(p) > this.aggroRange * 1.7) {
      this._setState('idle');
      return;
    }
    // charge needs space: only trigger savage_charge when the player is
    // actually away; twin_rend wants close range
    const next = this._peekNextAttack();
    const wantRange = next === 'savage_charge' ? 150 : 62;
    if (this.cooldownT <= 0 && Math.abs(p.x - this.x) < wantRange) {
      this.beginAttack(this.pickAttack());
      return;
    }
    const speed = this.def.stats?.speed ?? 95;
    this.vx = Math.sign(p.x - this.x || 1) * speed;
    this.playAnim(this._moveAnim());
  }

  _peekNextAttack() {
    return ['savage_charge', 'twin_rend', 'twin_rend'][this._combo % 3];
  }

  updateAttack(dt, p) {
    if (this.attackName === 'savage_charge') {
      this._updateChargeAttack(dt, p);
      return;
    }
    if (this.attackName === 'twin_rend') {
      this._updateRendAttack(dt, p);
      return;
    }
    super.updateAttack(dt, p);
  }

  _updateChargeAttack(dt, p) {
    this.attackT -= dt;
    if (this.attackPhase === 'windup') {
      // paw the ground: shudder in place, ember flash
      this.vx = 0;
      this.x += Math.sin(this.stateT * 60) * 8 * dt;
      this._flashT -= dt;
      if (this._flashT <= 0) {
        this._flashOn = !this._flashOn;
        this._setFlash(this._flashOn);
        this._flashT = 0.08;
      }
      if (this.attackT <= 0) {
        this._setFlash(false);
        if (this.sprite) {
          try {
            this.sprite.setScale(1, 1);
          } catch {
            /* ignore */
          }
        }
        // LOCK direction and go — no steering mid-charge (fair dodge window)
        this.attackPhase = 'strike';
        this.attackT = MASTIFF_CHARGE_TIME;
        this._charging = true;
        this.vx = this.facing * MASTIFF_CHARGE_SPEED;
        this._playSfx('hound_growl', { volume: 1, rate: 0.7 });
      }
      return;
    }
    if (this.attackPhase === 'strike') {
      // contact during the charge hits hard (via contactT-gated contact damage)
      this.contactMult = 1.3;
      this.vx = this.facing * MASTIFF_CHARGE_SPEED;
      if (this.attackT <= 0) {
        this._charging = false;
        this.contactMult = 0.8;
        this.vx = 0;
        this.attackPhase = 'recover';
        this.attackT = 0.35;
      }
      return;
    }
    if (this.attackT <= 0) this._endAttack(p);
  }

  _updateRendAttack(dt, p) {
    this.attackT -= dt;
    if (this.attackPhase === 'windup') {
      this._flashT -= dt;
      if (this._flashT <= 0) {
        this._flashOn = !this._flashOn;
        this._setFlash(this._flashOn);
        this._flashT = 0.09;
      }
      if (this.attackT <= 0) {
        this._setFlash(false);
        if (this.sprite) {
          try {
            this.sprite.setScale(1, 1);
          } catch {
            /* ignore */
          }
        }
        this.attackPhase = 'strike';
        this.attackT = 0.42; // two swipes inside the strike window
        this._rendStep = 0;
        this._rendT = 0.21; // second swipe lands halfway through
      }
      return;
    }
    if (this.attackPhase === 'strike') {
      this._rendT -= dt;
      if (this._rendStep === 0) {
        this._rendStep = 1;
        this._doRend(p);
      } else if (this._rendStep === 1 && this._rendT <= 0) {
        this._rendStep = 2;
        this._doRend(p);
      }
      if (this.attackT <= 0) {
        this.attackPhase = 'recover';
        this.attackT = 0.5;
      }
      return;
    }
    if (this.attackT <= 0) this._endAttack(p);
  }

  _doRend(p) {
    this._playSfx('swing_sabre');
    this.dealMelee(p, {
      range: 68,
      arcH: 32,
      mult: 1.1,
      type: 'physical',
      knockback: { x: this.facing * 150, y: -50 },
      hitStun: 0.3,
    });
  }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------
EnemyFactory.register('ash_hound', AshHound);
EnemyFactory.register('rustbound_revenant', RustboundRevenant);
EnemyFactory.register('cinder_wisp', CinderWisp);
EnemyFactory.register('hollow_sentinel', HollowSentinel);
EnemyFactory.register('vellum_phantom', VellumPhantom);
EnemyFactory.register('vesper_chimer', VesperChimer);
EnemyFactory.register('mote_swarm', MoteSwarm);
EnemyFactory.register('cinder_mastiff', CinderMastiff);
