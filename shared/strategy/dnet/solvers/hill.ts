/** `KingOfTheHill`: a genuine global optimisation, made cheap by one exemption.
 *
 * The response is an altitude, and the password is the summit — 10 000 m. The
 * landscape is a sum of up to nine gaussians whose positions and heights are
 * drawn from a generator seeded by the password itself, so it cannot be
 * predicted, only probed (`authentication.ts:215-243`).
 *
 * What makes it tractable is the exemption upstream wrote into the middle of it:
 *
 *     if (Math.abs((x - password) / password) < 0.03)
 *       return getAltitudeGivenHillSpecs(x, password, 10000, width);
 *
 * Within 3% of the answer the side hills are switched OFF and the reading is a
 * single clean gaussian centred exactly on the password. That is invertible in
 * closed form:
 *
 *     a = 10000 * exp(-((x - P) / width)^2)   =>   |x - P| = width * sqrt(ln(10000 / a))
 *
 * So the attack is: sweep coarsely to find the tallest hill — the password's is
 * always tallest, since every other peak is `10000 - |offset| * 2600` — then
 * invert to jump straight at it, resolving the sign by trying both. The sweep
 * step is a multiple of `width`, and `width` scales with the password's own
 * magnitude, so the number of samples is roughly constant however long the
 * password is.
 *
 * Every probe is also a real attempt at the password, which is why the climb is
 * not wasted effort even when it misses.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/authentication.ts:119-126, 215-243
 *   src/DarkNet/controllers/ServerGenerator.ts:402-409 */

import type { PasswordFacts } from "../models.ts";
import {
  SOLVER_CODES,
  freshState,
  type Solver,
  type SolverObservation,
  type SolverState,
  type SolverStep,
} from "./types.ts";

/** `10 ** max(L - 2, 0) + 1` — upstream's own hill width, and the natural unit
 * for every distance in this solver. */
export function hillWidth(passwordLength: number): number {
  return 10 ** Math.max(passwordLength - 2, 0) + 1;
}

/** The altitude out of `"<number>"`, which is how the arm renders it.
 *
 * It can be NEGATIVE, and rejecting that was a real bug. Far from the answer the
 * hills carry `heightOffset = |i - passwordHillIndex| * 2600`, which at high
 * difficulty exceeds 10 000 — so those gaussians contribute downward and the sum
 * dips below sea level. A negative reading is still a reading, and still says
 * "colder". */
export function readAltitude(seen: SolverObservation): number | undefined {
  const raw = (seen.oracle?.data ?? "").trim();
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** The peak is 10 000 m. A reading at or above it means we are standing on the
 * answer, give or take the rounding upstream applies. */
const SUMMIT = 10_000;

/** Sweep step, in hill widths. Four is measured rather than chosen: the reading
 * stays above `toFixed(5)`'s resolution out to about 4.55 widths, so a wider
 * step starts returning zeros and a narrower one only costs calls. */
const SWEEP_STEP_WIDTHS = 4;

/** How many climb iterations before admitting the landscape is not cooperating.
 * Each one is still a real attempt at the password, so this is a cost bound
 * rather than a correctness one. */
const MAX_CLIMB = 64;

/** A floor no real altitude can reach, and one JSON can carry. See where it is
 * set for why `-Infinity` cannot be used here. */
const BELOW_ANY_ALTITUDE = Number.MIN_SAFE_INTEGER;

interface Best {
  x: number;
  a: number;
}

const kingOfTheHillSolver: Solver = {
  needsOracle: true,

  budget: (facts) => {
    const length = facts.passwordLength ?? 4;
    const width = hillWidth(length);
    const span = length <= 1 ? 10 : 9 * 10 ** (length - 1);
    return Math.ceil(span / (SWEEP_STEP_WIDTHS * width)) + MAX_CLIMB + 8;
  },

  first(facts): SolverStep {
    const length = facts.passwordLength;
    if (length === undefined || length < 1) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: "KingOfTheHill: needs passwordLength" };
    }
    // A numeric password of length >= 2 has no leading zero, so the range is
    // exact rather than a guess.
    const lo = length === 1 ? 0 : 10 ** (length - 1);
    const hi = length === 1 ? 9 : 10 ** length - 1;
    const step = SWEEP_STEP_WIDTHS * hillWidth(length);

    const samples: number[] = [];
    for (let x = lo; x <= hi; x += step) samples.push(Math.round(x));
    if (samples.length === 0) samples.push(lo);

    const state = freshState("KingOfTheHill", facts, "sweep");
    state.scratch["samples"] = samples;
    state.scratch["at"] = 0;
    // Below any real reading, since an altitude may be negative — and a JSON
    // NUMBER, because `SolverState.scratch` is declared plain JSON and this
    // state is written to the ledger and read back. `JSON.stringify(-Infinity)`
    // is `null`: after one round trip `altitude > best.a` would read as
    // `altitude > 0`, so every negative altitude would be discarded and `best`
    // would never advance — and `best.a.toFixed(2)` below would then throw,
    // killing the agent PROCESS rather than failing the attempt. Negative
    // altitudes are real above difficulty 24.
    state.scratch["best"] = { x: samples[0]!, a: BELOW_ANY_ALTITUDE };
    state.scratch["tried"] = [];
    return {
      kind: "attempt",
      password: String(samples[0]),
      state,
      needsOracle: true,
      note: `sweeping ${samples.length} samples`,
    };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "KingOfTheHill: opened" };
    if (!seen.oracle) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnavailable,
        reason: "KingOfTheHill: needs the log ring, which was not readable",
        state,
      };
    }
    const altitude = readAltitude(seen);
    if (altitude === undefined) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.OracleUnparsed,
        reason: `KingOfTheHill: response ${JSON.stringify(seen.oracle.data ?? "")} is not an altitude`,
      };
    }

    const length = facts.passwordLength ?? seen.attempted.length;
    const width = hillWidth(length);
    const tried = new Set(state.scratch["tried"] as string[]);
    tried.add(seen.attempted);

    let best = state.scratch["best"] as Best;
    const here = Number(seen.attempted);
    let improved = false;
    if (Number.isFinite(here) && altitude > best.a) {
      best = { x: here, a: altitude };
      improved = true;
    }
    // A better peak means the old stride and the queued candidates describe
    // somewhere we have left. Start the descent of the step size again from one
    // hill width, or a hop onto a taller hill would be immediately undone by a
    // stride that had already shrunk to nothing.
    if (improved && state.phase === "climb") {
      state = { ...state, scratch: { ...state.scratch, step: width, queue: [] } };
    }

    if (state.phase === "sweep") {
      const samples = state.scratch["samples"] as number[];
      const at = Number(state.scratch["at"] ?? 0) + 1;
      if (at < samples.length) {
        return {
          kind: "attempt",
          password: String(samples[at]),
          state: {
            ...state,
            spent: state.spent + 1,
            scratch: { ...state.scratch, at, best, tried: [...tried] },
          },
          needsOracle: true,
          note: `sweeping ${at + 1}/${samples.length}`,
        };
      }
      // The sweep is done; start the climb from the tallest thing it found,
      // with a stride of one hill width.
      return climb({ ...state, scratch: { ...state.scratch, step: width, queue: [] } }, best, width, tried, 0);
    }

    const climbed = Number(state.scratch["climbed"] ?? 0) + 1;
    if (climbed > MAX_CLIMB) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverBudget,
        reason: `KingOfTheHill: ${MAX_CLIMB} climbs did not reach the summit; best altitude ${best.a.toFixed(2)}m`,
        state,
      };
    }
    return climb(state, best, width, tried, climbed);
  },
};

/** Choose the next place to stand, from the best reading so far.
 *
 * Two regimes, and the solver does not know which it is in — so it uses both.
 *
 * **Outside the 3% band** the reading is a sum of up to nine hills, and the
 * closed-form inversion is only a heuristic: it points uphill but lands short or
 * long. So the primary move is an ordinary step-halving climb — probe `best +/- step`,
 * halve `step`, repeat — which starts at one hill width and converges on the
 * local summit in about `log2(width)` rounds. The sweep put us in the tallest
 * hill's basin, and the tallest hill is the password's.
 *
 * **Inside the band** the side hills switch off, the reading is one clean
 * gaussian centred on the answer, and the inversion is exact. Its two candidates
 * bracket the password and one of them is it.
 *
 * Both sets of candidates are queued every round. An inversion that was
 * meaningless costs one attempt — and an attempt here is a live shot at the
 * password, not a probe. */
function climb(state: SolverState, best: Best, width: number, tried: Set<string>, climbed: number): SolverStep {
  const queue = [...((state.scratch["queue"] as number[]) ?? [])];
  let step = Number(state.scratch["step"] ?? width);

  while (queue.length === 0) {
    const candidates: number[] = [];

    // The exact move, valid once we are close enough for the engine to drop the
    // side hills.
    if (best.a > 0 && best.a < SUMMIT) {
      const distance = width * Math.sqrt(Math.log(SUMMIT / best.a));
      if (Number.isFinite(distance) && distance >= 1) {
        candidates.push(Math.round(best.x + distance), Math.round(best.x - distance));
      }
    }

    // The move that always makes progress.
    const stride = Math.max(1, Math.round(step));
    candidates.push(Math.round(best.x + stride), Math.round(best.x - stride));

    // The move that escapes a SIDE hill.
    //
    // The landscape is not one peak with noise: upstream lays the hills out at
    // `(i - passwordHillIndex) * width * 3 * (0.9..1.1)` with heights
    // `10000 - |i - passwordHillIndex| * 2600` (`authentication.ts:234-240`), so
    // they sit about three widths apart and step down 2600 m per hill away from
    // the answer. A plain step-halving climb happily converges on the nearest
    // one and stops, several thousand metres short.
    //
    // The altitude says how far off that is: a peak near `10000 - k * 2600` is k
    // hills from the password. So hop by whole hill spacings and let the local
    // climb refine whichever is taller.
    if (best.a > 0 && best.a < SUMMIT * 0.99) {
      const hillsAway = Math.max(1, Math.round((SUMMIT - best.a) / 2600));
      for (let k = 1; k <= Math.min(hillsAway + 1, 4); k++) {
        candidates.push(Math.round(best.x + k * 3 * width), Math.round(best.x - k * 3 * width));
      }
    }

    // At integer resolution the altitude can no longer separate neighbours, so
    // walk them directly.
    if (stride <= 1) {
      for (const offset of [0, 1, -1, 2, -2, 3, -3]) candidates.push(Math.round(best.x) + offset);
    }

    for (const candidate of candidates) {
      if (candidate >= 0 && !tried.has(String(candidate)) && !queue.includes(candidate)) queue.push(candidate);
    }

    step = step / 2;
    // Everything within reach has been stood on. The password is not on this
    // hill, and no further probe would say anything new.
    if (queue.length === 0 && step < 0.5) {
      return {
        kind: "give-up",
        code: SOLVER_CODES.SolverStalled,
        reason: `KingOfTheHill: the climb converged on ${best.x} at ${best.a.toFixed(2)}m and stopped improving`,
        state,
      };
    }
  }

  const next = queue.shift()!;
  return {
    kind: "attempt",
    password: String(next),
    state: {
      ...state,
      phase: "climb",
      spent: state.spent + 1,
      scratch: { ...state.scratch, best, tried: [...tried], queue, climbed, step },
    },
    needsOracle: true,
    note: `climbing from ${best.a.toFixed(2)}m`,
  };
}

export const HILL_SOLVERS = { kingOfTheHill: kingOfTheHillSolver } as const;
