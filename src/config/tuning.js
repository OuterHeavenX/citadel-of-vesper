/**
 * TUNING CONTRACT — src/config/tuning.js
 * =======================================
 * ALL player movement/physics/combat-feel numbers live here. Player code
 * (src/player/*) must read these values; NEVER hardcode movement constants
 * in Player.js. The game-feel pass (master prompt §67) tunes this file,
 * not game logic.
 *
 * Units: pixels, seconds. Internal resolution is 480x270.
 *
 * Ownership: W2-PLAYER (Wave 2). Section shapes:
 * - movement {acceleration, deceleration, maxSpeed, walkSpeed, airAcceleration,
 *   airDeceleration, turnBoost, crouchSpeedMult}
 * - jump     {jumpVelocity, gravity, jumpGravity, jumpCutGravity, maxFallSpeed,
 *   coyoteTime, jumpBuffer, landTime, landMinFallSpeed, turnTime}
 * - dash     {dashSpeed, dashTime, dashCooldown, dashIframes, airDashes}
 * - combat   {attackBuffer, iframesAfterHit, hitPauseMs, hitStunLight, hitStunHeavy}
 * - knockback{takenKnockbackX, takenKnockbackY, knockbackDecay}
 * - camera   {lookaheadX, lookaheadY, lerp, shakeLight, shakeHeavy}
 * - bosses   {gravity, walkSpeed, driftSpeed, hoverAmp, hoverFreq, hoverRange,
 *   attackGap, gapJitter, contactMult, contactCooldown, contactW, contactH,
 *   phaseShiftTime, deathTime, minionCap, aggroRange}
 * - audio    {stepIntervalWalk, stepIntervalRun, stepRateByRegion, stepVolume,
 *   landVolume, jumpVolume, dashVolume, hitVolume} (Wave 5 audio-feel)
 *
 * Feel targets: responsive (coyote + buffers), heavy but never floaty,
 * gothic stride (deliberate walk, committed run).
 */
export const tuning = {
  movement: {
    walkSpeed: 90,        // px/s — below this, locomotion reads 'walk'
    maxSpeed: 150,        // px/s — full run speed (× derived moveSpeed)
    acceleration: 1100,  // px/s^2 — ground accel toward target speed
    deceleration: 1400,  // px/s^2 — ground decel on input release
    airAcceleration: 700,  // px/s^2 — reduced air control (never floaty)
    airDeceleration: 350,  // px/s^2 — air drag on release
    turnBoost: 1.8,      // accel multiplier when reversing direction
    crouchSpeedMult: 0.35, // grounded crouch-walk speed multiplier
  },
  jump: {
    jumpVelocity: 340,    // px/s — initial upward velocity (apex ≈ 72px held)
    gravity: 1100,        // px/s^2 — falling gravity (heavy, responsive)
    jumpGravity: 800,     // px/s^2 — rising gravity while jump held
    jumpCutGravity: 1700, // px/s^2 — rising gravity after early release
    maxFallSpeed: 430,    // px/s — terminal velocity
    coyoteTime: 0.09,     // s — grace after leaving a ledge
    jumpBuffer: 0.12,     // s — input buffered before landing
    doubleJumpVelocityMult: 0.95, // × — moonrise_leap bonus jump vs jumpVelocity
    landTime: 0.09,       // s — 'land' state duration (cosmetic, input live)
    landMinFallSpeed: 260, // px/s — land state only above this impact speed
    turnTime: 0.12,       // s — 'turn' state duration on hard reversal
    dropThroughTime: 0.22, // s — one-way platform ignored after down+jump
  },
  dash: {
    dashSpeed: 260,       // px/s — backdash velocity (opposite facing)
    dashTime: 0.18,       // s — dash duration (horizontal locked)
    dashCooldown: 0.45,   // s
    dashIframes: 0.14,    // s — invulnerability during backdash
    airDashes: 0,         // base air dashes; gale_dash ability grants more (Wave 4)
  },
  combat: {
    attackBuffer: 0.15,   // s — attack input buffered during recovery
    iframesAfterHit: 0.8, // s — player invulnerability after taking damage
    hitPauseMs: 60,       // ms — hit pause budget on landing a hit (≤90 per spec §17)
    hitStunLight: 0.18,   // s — player hitstun, light hits
    hitStunHeavy: 0.35,   // s — player hitstun, heavy hits
  },
  knockback: {
    takenKnockbackX: 160, // px/s — default horizontal knockback taken (no data)
    takenKnockbackY: 120, // px/s — default upward knockback taken (no data)
    knockbackDecay: 900,  // px/s^2 — knockback velocity decay during hitstun
  },
  camera: {
    lookaheadX: 24,       // px — horizontal lookahead toward facing
    lookaheadY: 10,       // px — vertical lookahead
    lerp: 0.12,           // follow smoothing (0-1)
    shakeLight: 0.0015,   // trauma units (screenshake system, Wave 2+)
    shakeHeavy: 0.004,
  },
  bosses: {
    gravity: 1400,        // px/s^2 — grounded bosses (warden)
    walkSpeed: 55,        // px/s — warden advance toward the player
    driftSpeed: 48,       // px/s — matriarch hover drift
    hoverAmp: 7,          // px — matriarch hover bob amplitude
    hoverFreq: 2.2,       // rad/s — matriarch hover bob frequency
    hoverRange: 150,      // px — matriarch preferred distance to player
    attackGap: 0.7,       // s — minimum pause between boss attacks
    gapJitter: 0.5,       // s — random extra pause added to attackGap
    contactMult: 0.4,     // × boss attack stat for contact damage
    contactCooldown: 1.0, // s between contact-damage ticks
    contactW: 44,         // px — contact box half-width
    contactH: 80,         // px — contact box height above feet
    phaseShiftTime: 1.4,  // s — invulnerable roar on phase change
    deathTime: 1.8,       // s — death animation before rewards land
    minionCap: 3,         // default max live summoned minions (lantern_call)
    aggroRange: 9999,     // bosses fight on sight once the encounter starts
  },
  economy: {
    sellRate: 0.5,        // × — sell price = floor(item value × sellRate)
    minBuyPrice: 1,       // coins — buy prices never round below this
  },
  audio: {
    stepIntervalWalk: 0.42, // s — footstep cadence while walking
    stepIntervalRun: 0.3,   // s — footstep cadence while running
    // Footstep timber per region (playbackRate on the 'step' sfx):
    // moonlit_gate reads softer night gravel, hollow_keep harder stone.
    stepRateByRegion: { moonlit_gate: 0.92, hollow_keep: 1.12 },
    stepVolume: 0.3,      // 0..1 — footsteps stay subtle under everything
    landVolume: 0.55,     // 0..1 — landing thump
    jumpVolume: 0.4,      // 0..1 — jump whoosh
    dashVolume: 0.45,     // 0..1 — dash air rush
    hitVolume: 0.65,      // 0..1 — player weapon impact
  },
};

/**
 * Deep-merge helper for debug-time overrides. DebugOverlay (src/debug) may
 * call setTuning() to live-tune; production code must not mutate `tuning`.
 */
export function setTuning(patch) {
  const merge = (dst, src) => {
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        dst[k] = dst[k] || {};
        merge(dst[k], src[k]);
      } else {
        dst[k] = src[k];
      }
    }
  };
  merge(tuning, patch);
}
