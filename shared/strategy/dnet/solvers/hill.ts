import { whrng } from "../../../rng/whrng.ts";
import type { PasswordFacts } from "../models.ts";
import { candidateMatchesEvidence } from "../evidence.ts";
import { SOLVER_CODES, freshState, type Solver, type SolverObservation, type SolverState, type SolverStep } from "./types.ts";

interface HillSample { x: number; altitude: number }
const SUMMIT = 10_000;

function widthFor(length: number): number {
  return 10 ** Math.max(length - 2, 0) + 1;
}

/** Integer probes whose strict +/-3% bands cover every legal password. */
function hillCover(length: number): number[] {
  if (length <= 1) return Array.from({ length: 10 }, (_, value) => value);
  const high = 10 ** length - 1;
  let low = 10 ** (length - 1);
  const probes: number[] = [];
  while (low <= high) {
    const probe = Math.min(high, Math.ceil(low * 1.03) - 1);
    probes.push(probe);
    low = Math.ceil(probe / 0.97);
  }
  return probes;
}

/** Exact upstream landscape; its random stream is seeded by the password. */
function predictedHillAltitude(password: number, x: number, length: number, difficulty: number): number {
  const hillCount = Math.min(Math.floor(difficulty / 8), 4) * 2 + 1;
  const random = whrng(password, 1 + hillCount * 2);
  const passwordHillIndex = Math.floor(random[0]! * (hillCount - 2)) + 1;
  const width = widthFor(length);
  if (Math.abs((x - password) / password) < 0.03) {
    return SUMMIT * Math.exp(-((x - password) ** 2 / width ** 2));
  }
  let altitude = 0;
  for (let index = 0; index < hillCount; index++) {
    const locationOffset = (index - passwordHillIndex) * width * 3 * (random[index * 2 + 1]! * 0.2 + 0.9);
    const heightOffset = Math.abs((index - passwordHillIndex) * 2600) * (random[index * 2 + 2]! * 0.1 + 0.95);
    const height = SUMMIT - heightOffset;
    altitude += height * Math.exp(-((x - (password + locationOffset)) ** 2 / width ** 2));
  }
  return altitude;
}

function altitudeFrom(seen: SolverObservation): number | undefined {
  const value = Number((seen.oracle?.data ?? "").trim());
  return Number.isFinite(value) ? value : undefined;
}

function legal(candidate: number, length: number): boolean {
  if (!Number.isInteger(candidate)) return false;
  if (length <= 1) return candidate >= 0 && candidate <= 9;
  return candidate >= 10 ** (length - 1) && candidate < 10 ** length;
}

function closeEnough(actual: number, predicted: number): boolean {
  return Math.abs(actual - predicted) <= Math.max(1e-300, Math.abs(actual) * 1e-10);
}

function candidatesFrom(sample: HillSample, previous: readonly number[], samples: readonly HillSample[], facts: PasswordFacts): number[] {
  const length = facts.passwordLength ?? 0;
  const width = widthFor(length);
  const possible = new Set<number>(previous);
  if (sample.altitude > 0 && sample.altitude < SUMMIT) {
    const distance = width * Math.sqrt(Math.log(SUMMIT / sample.altitude));
    if (Number.isFinite(distance)) {
      for (const raw of [sample.x - distance, sample.x + distance]) {
        for (const candidate of [Math.floor(raw), Math.round(raw), Math.ceil(raw)]) {
          if (legal(candidate, length)) possible.add(candidate);
        }
      }
    }
  }
  const difficulty = facts.difficulty;
  if (difficulty === undefined) return [...possible]
    .filter((candidate) => candidateMatchesEvidence(String(candidate), facts.evidence));
  return [...possible].filter((candidate) => samples.every((sample) =>
    closeEnough(sample.altitude, predictedHillAltitude(candidate, sample.x, length, difficulty))))
    .filter((candidate) => candidateMatchesEvidence(String(candidate), facts.evidence));
}

function tryCandidate(state: SolverState, candidates: readonly number[], at: number): SolverStep {
  if (at >= candidates.length) {
    return { kind: "give-up", code: SOLVER_CODES.SolverExhausted, reason: "KingOfTheHill: predicted candidates were refused" };
  }
  return {
    kind: "attempt",
    password: String(candidates[at]),
    state: { ...state, phase: "try", scratch: { ...state.scratch, candidates: [...candidates], candidateIndex: at } },
    needsOracle: false,
    note: `predicted summit ${at + 1}/${candidates.length}`,
  };
}

const kingOfTheHillSolver: Solver = {
  needsOracle: true,
  budget: (facts) => hillCover(facts.passwordLength ?? 1).length + 4,

  first(facts): SolverStep {
    const length = facts.passwordLength;
    if (length === undefined || length < 1) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: "KingOfTheHill: needs passwordLength" };
    }
    const cover = hillCover(length);
    const state = freshState("KingOfTheHill", facts, length === 1 ? "try" : "cover");
    if (length === 1) return tryCandidate(state, cover, 0);
    state.scratch["cover"] = cover;
    state.scratch["coverIndex"] = 0;
    state.scratch["samples"] = [];
    state.scratch["possible"] = [];
    return { kind: "attempt", password: String(cover[0]), state, needsOracle: true, note: `3% cover 1/${cover.length}` };
  },

  next(facts, state, seen): SolverStep {
    if (seen.success) return { kind: "answer", password: seen.attempted, note: "KingOfTheHill: opened" };
    if (state.phase === "try") {
      const candidates = state.scratch["candidates"] as number[];
      return tryCandidate({ ...state, spent: state.spent + 1 }, candidates, Number(state.scratch["candidateIndex"] ?? 0) + 1);
    }
    if (!seen.oracle) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnavailable, reason: "KingOfTheHill: needs the log ring", state };
    }
    const altitude = altitudeFrom(seen);
    if (altitude === undefined) {
      return { kind: "give-up", code: SOLVER_CODES.OracleUnparsed, reason: "KingOfTheHill: response is not an altitude" };
    }
    const sample = { x: Number(seen.attempted), altitude };
    const samples = [...(state.scratch["samples"] as HillSample[]), sample];
    const previous = (state.scratch["possible"] as number[] | undefined) ?? [];
    const candidates = candidatesFrom(sample, previous, samples, facts);
    if (candidates.length === 1) {
      return { kind: "answer", password: String(candidates[0]), note: `WHRNG prediction from ${samples.length} samples` };
    }
    const cover = state.scratch["cover"] as number[];
    const next = Number(state.scratch["coverIndex"] ?? 0) + 1;
    if (next >= cover.length) return tryCandidate({ ...state, scratch: { ...state.scratch, samples } }, candidates, 0);
    return {
      kind: "attempt",
      password: String(cover[next]),
      state: {
        ...state,
        spent: state.spent + 1,
        scratch: { ...state.scratch, coverIndex: next, samples, possible: candidates },
      },
      needsOracle: true,
      note: `3% cover ${next + 1}/${cover.length}`,
    };
  },
};

export const HILL_SOLVERS = { kingOfTheHill: kingOfTheHillSolver } as const;
