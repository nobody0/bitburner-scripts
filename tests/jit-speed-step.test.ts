import { describe, expect, test } from "bun:test";
import {
  growTimeSeconds,
  hackTimeSeconds,
  makeHackContext,
  weakenTimeSeconds,
  type HackContext,
} from "../shared/formulas.ts";
import {
  JIT_LAUNCH_GUARD_MS,
  MINIMUM_LANDING_GAP_MS,
  latestJitStart,
} from "../shared/strategy/jit.ts";

/** What an IPvGO win against Illuminati does to a landing grid.
 *
 * Illuminati Node Power multiplies `Player.mults.hacking_speed`
 * (shared/strategy/go/rules.ts, matching upstream Go/effects/effect.ts
 * calculateMults), and `hacking_speed` sits in the time DENOMINATOR
 * (`speedDenom`). Every win therefore shortens hack, grow and weaken at once,
 * as a discrete step at the instant the game ends
 * (Go/boardAnalysis/scoring.ts calls Player.applyEntropy -> updateGoMults).
 *
 * The engine freezes an operation's duration at the moment hack/grow/weaken is
 * invoked (NetscriptHelpers.tsx: calculateHackingTime(server, Player) +
 * additionalMsec, then netscriptDelay), and our worker resolves `delayUntil`
 * into `additionalMsec` and calls immediately, so the whole padding wait lives
 * INSIDE the native call. An operation that has been invoked is therefore
 * immune to the step: its landing does not move.
 *
 * That leaves exactly one exposure, which is what this file pins: an operation
 * PLANNED against a stale `speedDenom`. The dispatcher sends
 * `additionalMsec = landing - now - duration`, so an overstated duration
 * understates the padding and the effect lands EARLY by the duration error --
 * and that error is proportional to the operation's own length, so a batch does
 * not shift, it SHEARS.
 *
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L537-L561 */

/** Intelligence 0 makes `intBonus` exactly 1 (1 + pow(0, 0.8) / 600), so
 * `speedDenom` IS the hacking_speed multiplier and every duration below is an
 * exact decimal rather than a float with a tail. */
function ctxAtSpeed(hackingSpeed: number): HackContext {
  return makeHackContext({
    skill: 2_450,
    intelligence: 0,
    mults: {
      hacking_chance: 1,
      hacking_money: 1,
      hacking_speed: hackingSpeed,
      hacking_exp: 1,
      hacking_grow: 1,
    },
  });
}

// skillFactor = (2.5 * 500 * 20 + 500) / (2450 + 50) = 25500 / 2500 = 10.2,
// so hackTime = 5 * 10.2 / speedDenom = 51 / speedDenom seconds. At
// hacking_speed 3.4 that is exactly 15 s, and grow/weaken are 3.2x and 4x it.
const REQUIRED_SKILL = 500;
const DIFFICULTY = 20;
const BEFORE = ctxAtSpeed(3.4);
/** A matured Illuminati bonus: Node Power accumulates across wins and
 * CalculateEffect has no ceiling, so a quarter is a step a long BN14 run
 * reaches. The proportionality assertions below hold for any step size. */
const AFTER = ctxAtSpeed(3.4 * 1.25);

const hackMs = (ctx: HackContext) => hackTimeSeconds(ctx, DIFFICULTY, REQUIRED_SKILL) * 1_000;
const growMs = (ctx: HackContext) => growTimeSeconds(ctx, DIFFICULTY, REQUIRED_SKILL) * 1_000;
const weakenMs = (ctx: HackContext) => weakenTimeSeconds(ctx, DIFFICULTY, REQUIRED_SKILL) * 1_000;

describe("a hacking_speed step under a fixed landing grid", () => {
  test("shortens hack, grow and weaken by the same ratio", () => {
    expect(hackMs(BEFORE)).toBe(15_000);
    expect(growMs(BEFORE)).toBe(48_000);
    expect(weakenMs(BEFORE)).toBe(60_000);
    // 1 / 1.25 = 0.8 of the old duration, exactly, for all three.
    expect(hackMs(AFTER)).toBe(12_000);
    // 3.2x a non-terminating binary fraction, so grow alone carries a float tail.
    expect(growMs(AFTER)).toBeCloseTo(38_400, 6);
    expect(weakenMs(AFTER)).toBe(48_000);
  });

  test("planning on the stale speed lands every op early by its own duration error", () => {
    // What the dispatcher sends: additionalMsec = landing - now - duration,
    // with `duration` from the context it planned on. What the engine then
    // does: land at (call time + true duration + additionalMsec).
    const landing = 1_000_000;
    const now = 0;
    const landedAt = (planned: number, actual: number) => now + actual + (landing - now - planned);

    expect(landedAt(hackMs(BEFORE), hackMs(AFTER))).toBe(landing - 3_000);
    expect(landedAt(growMs(BEFORE), growMs(AFTER))).toBeCloseTo(landing - 9_600, 6);
    expect(landedAt(weakenMs(BEFORE), weakenMs(AFTER))).toBe(landing - 12_000);
  });

  test("shears the batch rather than shifting it, by 3x the hack's own error", () => {
    // A batch is only correct as an ORDER. Hack and W2 are planned three
    // spacers apart; a stale plan pulls W2 forward 12 s and the hack only 3 s,
    // so W2 now lands 9 s BEFORE the hack it was covering.
    const hackError = hackMs(AFTER) - hackMs(BEFORE);
    const weakenError = weakenMs(AFTER) - weakenMs(BEFORE);
    expect(weakenError).toBe(4 * hackError);
    expect(weakenError - hackError).toBe(-9_000);
    // Which is the number that matters: the grid it has to survive is 5 ms.
    expect((weakenError - hackError) / MINIMUM_LANDING_GAP_MS).toBe(-1_800);
  });

  test("weaken drifts exactly 4x the hack however small the step", () => {
    // The shear is proportional, not a threshold effect: a single early win
    // whose bonus is a fraction of a percent still splits the batch by far
    // more than one landing gap.
    const nudged = ctxAtSpeed(3.4 * 1.001);
    const hackError = hackMs(nudged) - hackMs(BEFORE);
    const weakenError = weakenMs(nudged) - weakenMs(BEFORE);
    expect(weakenError / hackError).toBeCloseTo(4, 12);
    expect(Math.abs(weakenError - hackError)).toBeGreaterThan(MINIMUM_LANDING_GAP_MS);
  });

  test("a fresh context reproduces the same landing, so the input was the only thing wrong", () => {
    // The grid invariant the dispatcher already holds: `landing` is fixed at
    // plan time and `startAt` is re-derived from the live context. Given the
    // NEW speed, latestJitStart returns a launch deadline that still lands the
    // op on its original slot -- no regridding, no cancellation.
    const landing = 1_000_000;
    const startAt = latestJitStart({
      now: 0,
      landing,
      currentDifficulty: DIFFICULTY,
      minDifficulty: DIFFICULTY,
      events: [],
      durationMs: (difficulty) => weakenTimeSeconds(AFTER, difficulty, REQUIRED_SKILL) * 1_000,
      launchGuardMs: JIT_LAUNCH_GUARD_MS,
    });
    expect(startAt).toBe(landing - 48_000 - JIT_LAUNCH_GUARD_MS);
    // Launched at that deadline, padding covers exactly the launch guard and
    // the op lands on the slot it was planned for before the step.
    expect(startAt + JIT_LAUNCH_GUARD_MS + weakenMs(AFTER)).toBe(landing);
  });
});
