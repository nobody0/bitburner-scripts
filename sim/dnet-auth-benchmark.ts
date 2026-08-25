import { generateSecret, passwordRng } from "./features/dnet-generators.ts";
import { checkPassword, type PacketWorld } from "./features/dnet-feedback.ts";
import {
  describeModel,
  planAttempt,
  type ModelId,
  type PasswordFacts,
} from "../shared/strategy/dnet/models.ts";
import { solverFor } from "../shared/strategy/dnet/solvers/index.ts";
import type { PasswordEvidence } from "../shared/strategy/dnet/evidence.ts";
import type { SolverObservation } from "../shared/strategy/dnet/solvers/types.ts";

/** The difficulty samples used by both the correctness ratchet and the CPU
 * benchmark. They cover every band in which each model can be drawn. */
export const DNET_AUTH_CASES: readonly {
  model: Exclude<ModelId, "(The Labyrinth)">;
  difficulties: readonly number[];
}[] = [
  { model: "ZeroLogon", difficulties: [0, 1, 2, 4] },
  { model: "FreshInstall_1.0", difficulties: [0, 1, 2, 4, 6, 8] },
  { model: "Laika4", difficulties: [4, 6, 8, 12, 16] },
  { model: "TopPass", difficulties: [10, 14, 18, 24, 30] },
  { model: "EuroZone Free", difficulties: [10, 14, 18, 24, 30] },
  { model: "DeskMemo_3.1", difficulties: [0, 1, 2, 4, 6, 8] },
  { model: "CloudBlare(tm)", difficulties: [0, 1, 2, 4, 6, 8] },
  { model: "110100100", difficulties: [10, 14, 18, 24, 30] },
  { model: "OrdoXenos", difficulties: [10, 14, 18, 24, 30] },
  { model: "PrimeTime 2", difficulties: [10, 14, 18, 24, 30] },
  { model: "OctantVoxel", difficulties: [4, 8, 12, 16, 20] },
  { model: "MathML", difficulties: [10, 14, 18, 22, 30] },
  { model: "Pr0verFl0", difficulties: [4, 6, 8, 12] },
  { model: "AccountsManager_4.2", difficulties: [4, 6, 8, 12, 16] },
  { model: "BigMo%od", difficulties: [10, 14, 18, 24, 30] },
  { model: "BellaCuore", difficulties: [2, 4, 6, 7, 10, 14, 18, 24] },
  { model: "PHP 5.4", difficulties: [4, 8, 14, 21, 28] },
  { model: "NIL", difficulties: [4, 6, 8, 12] },
  { model: "Factori-Os", difficulties: [4, 8, 12, 16, 20, 28, 36] },
  { model: "DeepGreen", difficulties: [4, 8, 14, 20, 28] },
  { model: "RateMyPix.Auth", difficulties: [8, 14, 20, 28] },
  { model: "OpenWebAccessPoint", difficulties: [4, 8, 12, 16, 20, 26] },
  { model: "KingOfTheHill", difficulties: [8, 14, 20, 28, 36] },
  { model: "2G_cellular", difficulties: [10, 14, 18, 24] },
];

export interface DnetAuthHost {
  password: string;
  facts: PasswordFacts;
  server: {
    modelId: string;
    hostname: string;
    password: string;
    passwordHint: string;
    data: string;
    difficulty: number;
  };
}

export interface DnetAuthOutcome {
  opened: boolean;
  calls: number;
  budget?: number;
  decisionNs: bigint;
  detail: string;
}

export interface DnetAuthRunOptions {
  evidence?: readonly PasswordEvidence[];
  /** Omit in correctness tests. The benchmark supplies hrtime so only pure
   * decision calls, never generation or oracle simulation, are charged. */
  nowNs?: () => bigint;
  cap?: number;
}

export type DnetHintProfile = "contains" | "placement" | "combined";

/** Deterministic, valid examples of every generic hint the log harvester can
 * attach to a host. They are derived from the minted password only because the
 * simulator is standing in for hints the game generated from that password. */
export function benchmarkHintEvidence(password: string, profile: DnetHintProfile): PasswordEvidence[] {
  const contains: PasswordEvidence = {
    kind: "contains",
    chars: password.length === 0 ? [] : [password[0]!, password.at(-1)!],
    at: 1,
  };
  const placements: PasswordEvidence[] = password.length === 0
    ? [{ kind: "placement", attempted: "!", placed: [], at: 2 }]
    : [
        {
          kind: "placement",
          attempted: `${"!".repeat(password.length - 1)}${password.at(-1)!}`,
          placed: [password.at(-1)!],
          at: 2,
        },
        { kind: "placement", attempted: "!".repeat(password.length), placed: [], at: 3 },
      ];
  if (profile === "contains") return [contains];
  if (profile === "placement") return placements;
  return [contains, ...placements];
}

export function mintDnetAuthHost(
  modelId: Exclude<ModelId, "(The Labyrinth)">,
  difficulty: number,
  seed: number,
  evidence?: readonly PasswordEvidence[],
): DnetAuthHost {
  const hostname = `depth${difficulty}_h${seed}`;
  const secret = generateSecret(modelId, difficulty, passwordRng((seed * 977 + 13) / 4096, hostname));
  return {
    password: secret.password,
    facts: {
      passwordLength: secret.passwordLength,
      passwordFormat: secret.passwordFormat,
      passwordHint: secret.hint,
      data: secret.data,
      difficulty,
      ...(evidence ? { evidence } : {}),
    },
    server: {
      modelId,
      hostname,
      password: secret.password,
      passwordHint: secret.hint,
      data: secret.data,
      difficulty,
    },
  };
}

/** Drive the same public decision surfaces used by the deployed attempt job:
 * dictionaries through planAttempt, conversations through solverFor. */
export function runDnetAuthentication(
  model: Exclude<ModelId, "(The Labyrinth)">,
  difficulty: number,
  seed: number,
  options: DnetAuthRunOptions = {},
): DnetAuthOutcome {
  const host = mintDnetAuthHost(model, difficulty, seed, options.evidence);
  const world = packetWorld(mixSeed(model, difficulty, seed));
  const cap = options.cap ?? 600;
  const entry = describeModel(model);
  let decisionNs = 0n;
  const decide = <T>(fn: () => T): T => {
    if (!options.nowNs) return fn();
    const before = options.nowNs();
    const result = fn();
    decisionNs += options.nowNs() - before;
    return result;
  };

  if (entry.candidates) {
    const attempted: string[] = [];
    for (let calls = 0; calls < cap; calls++) {
      const step = decide(() => planAttempt(entry, host.facts, calls, 0, 1, attempted));
      if (step.kind !== "candidate") {
        const detail = "reason" in step ? step.reason : step.note;
        return { opened: false, calls, decisionNs, detail: `${step.kind}: ${detail}` };
      }
      attempted.push(step.password);
      if (checkPassword(host.server, step.password, 1_000, world).ok) {
        return { opened: true, calls: calls + 1, budget: step.total, decisionNs, detail: "dictionary candidate" };
      }
    }
    return { opened: false, calls: cap, decisionNs, detail: "ran past the cap" };
  }

  const solver = solverFor(model);
  if (!solver) return { opened: false, calls: 0, decisionNs, detail: "no solver registered" };
  const budget = solver.budget(host.facts);
  let step = decide(() => solver.first(host.facts));
  let calls = 0;
  while (calls < cap) {
    if (step.kind === "give-up") {
      return { opened: false, calls, budget, decisionNs, detail: `gave up ${step.code}: ${step.reason}` };
    }
    const attempt = step.password;
    calls++;
    const response = checkPassword(host.server, attempt, 1_000, world);
    if (response.ok) {
      return { opened: true, calls, budget, decisionNs, detail: step.kind === "answer" ? "answered" : "attempted" };
    }
    if (step.kind === "answer") {
      return { opened: false, calls, budget, decisionNs, detail: `asserted ${JSON.stringify(attempt)} and was refused` };
    }
    const seen: SolverObservation = {
      attempted: attempt,
      code: 401,
      success: false,
      oracle: {
        kind: "oracle",
        code: 401,
        message: response.message,
        data: response.data,
        passwordAttempted: attempt,
      },
    };
    const attemptedStep = step;
    step = decide(() => solver.next(host.facts, attemptedStep.state, seen));
  }
  return {
    opened: false,
    calls,
    budget,
    decisionNs,
    detail: `ran past the cap in ${step.kind === "attempt" ? step.state.phase : step.kind}`,
  };
}

function packetWorld(seed: number): PacketWorld {
  let state = seed >>> 0;
  return {
    movablePasswords: () => [],
    serverNames: () => ["darkweb"],
    lastAttempted: () => null,
    rand: () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

function mixSeed(model: string, difficulty: number, seed: number): number {
  let value = (difficulty * 0x9e3779b1) ^ seed;
  for (let index = 0; index < model.length; index++) value = Math.imul(value ^ model.charCodeAt(index), 0x85ebca6b);
  return value >>> 0;
}
