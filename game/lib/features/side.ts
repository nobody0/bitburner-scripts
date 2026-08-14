import type { NS } from "@ns";
import {
  canSolve,
  CONTRACT_BATCH_SIZE,
  CONTRACT_QUEUE_LIMIT,
  CONTRACT_REPORT_LIMIT,
  CONTRACT_SOLVER_VERSION,
  solve,
  SOLVERS,
} from "../../../shared/strategy/side/contracts.ts";
import type { ContractFailure } from "../../../shared/telemetry/topics/side.ts";
import { merge, type GameState } from "../state.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

const CONTRACT_REPLAY_LIMIT = 4_096;
const CONTRACT_REASON_LIMIT = 512;
const CLAIM_ID = "action:contract";

type Result = { action: string; ok: boolean; detail: string; at: number };

interface ContractRef {
  host: string;
  file: string;
}

interface InspectedContract extends ContractRef {
  type: string;
  triesBefore: number;
}

interface ContractJob extends InspectedContract {
  data: unknown;
  answer: unknown;
}

type ContractInspectionResult = InspectedContract | (ContractRef & { error: string });
type ContractDataResult = (InspectedContract & { data: unknown }) | (InspectedContract & { error: string });
type ContractAttemptResult = { key: string; reward: string } | { key: string; error: string };

/** Queued broker stages retain their data-dependent inputs. A ready getData
 * lease must resume getData, not restart inspection with the wrong budget. */
let pipelineBatch: ContractRef[] | undefined;
let pipelineInspection: ContractInspectionResult[] | undefined;
let pipelineData: ContractDataResult[] | undefined;

/** The exact solver boundary shipped to the game. Simulator parity tests use
 * this export so they verify deployed wiring as well as the pure registry. */
export const CONTRACT_SOLVERS = SOLVERS;
export const solveContract = solve;

function record(ok: boolean, detail: string): Result {
  return { action: "contract", ok, detail, at: Date.now() };
}

function contractKey(contract: ContractRef): string {
  return `${contract.host}\0${contract.file}`;
}

function replayValue(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length <= CONTRACT_REPLAY_LIMIT
    ? rendered
    : `${rendered.slice(0, CONTRACT_REPLAY_LIMIT)}… (${rendered.length} chars)`;
}

function compactReason(reason: string): string {
  return reason.length <= CONTRACT_REASON_LIMIT
    ? reason
    : `${reason.slice(0, CONTRACT_REASON_LIMIT)}… (${reason.length} chars)`;
}

function quarantineContract(
  ctx: DriverContext,
  contract: ContractRef,
  type: string,
  reason: string,
  data?: unknown,
  answer?: unknown,
  triesBefore?: number,
): ContractFailure {
  const failure: ContractFailure = {
    host: contract.host,
    file: contract.file,
    type,
    data: replayValue(data),
    answer: replayValue(answer),
    ...(triesBefore !== undefined ? { triesBefore } : {}),
    reason: compactReason(reason),
    at: Date.now(),
  };
  (ctx.state.contractQuarantine ??= {})[contractKey(contract)] = failure;
  return failure;
}

const side: FeatureDriver = {
  id: "side",
  everyMs: 5_000,
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.side;
    if (!topic) return;

    // A hot handoff keeps game state. A solver change is the one safe reason
    // to release the old build's quarantine and try those contracts again.
    if (ctx.state.contractSolverVersion !== CONTRACT_SOLVER_VERSION) {
      ctx.state.contractSolverVersion = CONTRACT_SOLVER_VERSION;
      ctx.state.contractQuarantine = {};
    }
    const quarantine = ctx.state.contractQuarantine ??= {};

    const queue = (ctx.state.contractQueue ?? topic.contracts.map(({ host, file }) => ({ host, file })))
      .slice(0, CONTRACT_QUEUE_LIMIT);
    ctx.state.contractQueue = queue;

    const solvable = queue.filter((contract) => !quarantine[contractKey(contract)]);
    const solvableTotal = topic.solvableTotal ?? solvable.length;

    const batch = pipelineBatch
      ?? solvable.slice(0, CONTRACT_BATCH_SIZE).map(({ host, file }) => ({ host, file }));
    if (batch.length === 0) return;
    pipelineBatch = batch;

    // Three separate dodges keep getData's RAM out of attempt's peak. Each
    // method is paid once for the whole batch, regardless of its file count.
    const inspection = pipelineInspection
      ? { ok: true as const, value: pipelineInspection }
      : await featureDodge(
      ctx,
      "side",
      `${CLAIM_ID}:inspect`,
      ["codingcontract.getContractType", "codingcontract.getNumTriesRemaining"],
      (stubNs: NS) => batch.map((contract): ContractInspectionResult => {
        try {
          return {
            ...contract,
            type: stubNs.codingcontract.getContractType(contract.file, contract.host),
            triesBefore: stubNs.codingcontract.getNumTriesRemaining(contract.file, contract.host),
          };
        } catch (error) {
          return { ...contract, error: String(error) };
        }
      }),
    );
    if (!inspection.ok) {
      if (inspection.queued) return;
      pipelineBatch = undefined;
      merge(ctx.state, "side", { lastResult: record(false, inspection.reason) });
      return;
    }
    pipelineInspection = inspection.value;

    const inspected: InspectedContract[] = [];
    const failures: ContractFailure[] = [];
    const finished = new Set<string>();
    for (const result of inspection.value) {
      if ("error" in result) {
        finished.add(contractKey(result));
        if (!result.error.includes("Cannot find contract")) {
          failures.push(quarantineContract(ctx, result, "unknown", result.error));
        }
      } else if (!canSolve(result.type)) {
        finished.add(contractKey(result));
        failures.push(quarantineContract(ctx, result, result.type, "no solver registered", undefined, undefined, result.triesBefore));
      } else inspected.push(result);
    }

    const jobs: ContractJob[] = [];
    if (inspected.length > 0) {
      const dataResult = pipelineData
        ? { ok: true as const, value: pipelineData }
        : await featureDodge(
        ctx,
        "side",
        `${CLAIM_ID}:data`,
        ["codingcontract.getData"],
        (stubNs: NS) => inspected.map((contract): ContractDataResult => {
          try {
            return { ...contract, data: stubNs.codingcontract.getData(contract.file, contract.host) };
          } catch (error) {
            return { ...contract, error: String(error) };
          }
        }),
      );
      if (!dataResult.ok) {
        if (dataResult.queued) return;
        pipelineBatch = undefined;
        pipelineInspection = undefined;
        merge(ctx.state, "side", { lastResult: record(false, dataResult.reason) });
        return;
      }
      pipelineData = dataResult.value;
      for (const result of dataResult.value) {
        if ("error" in result) {
          finished.add(contractKey(result));
          if (!result.error.includes("Cannot find contract")) {
            failures.push(quarantineContract(ctx, result, result.type, result.error, undefined, undefined, result.triesBefore));
          }
          continue;
        }
        const answer = solveContract(result.type, result.data);
        if (answer === undefined) {
          finished.add(contractKey(result));
          failures.push(quarantineContract(ctx, result, result.type, "solver returned no answer", result.data, undefined, result.triesBefore));
        } else jobs.push({ ...result, answer });
      }
    }

    let solved = 0;
    const rewards: string[] = [];
    if (jobs.length > 0) {
      const attemptResult = await featureDodge(
        ctx,
        "side",
        `${CLAIM_ID}:attempt`,
        ["codingcontract.attempt"],
        (stubNs: NS) => jobs.map((job): ContractAttemptResult => {
          try {
            return { key: contractKey(job), reward: stubNs.codingcontract.attempt(job.answer as never, job.file, job.host) };
          } catch (error) {
            return { key: contractKey(job), error: String(error) };
          }
        }),
      );
      if (!attemptResult.ok) {
        if (attemptResult.queued) return;
        pipelineBatch = undefined;
        pipelineInspection = undefined;
        pipelineData = undefined;
        merge(ctx.state, "side", { lastResult: record(false, attemptResult.reason) });
        return;
      }
      const byKey = new Map(jobs.map((job) => [contractKey(job), job]));
      for (const result of attemptResult.value) {
        const job = byKey.get(result.key)!;
        finished.add(result.key);
        if ("error" in result) {
          if (!result.error.includes("Cannot find contract")) {
            failures.push(quarantineContract(ctx, job, job.type, result.error, job.data, job.answer, job.triesBefore));
          }
        } else if (result.reward === "") {
          failures.push(quarantineContract(ctx, job, job.type, "answer rejected", job.data, job.answer, job.triesBefore));
        } else {
          solved++;
          if (rewards.length < 3) rewards.push(compactReason(result.reward));
        }
      }
    }

    const allFailures = Object.values(quarantine).sort((a, b) => b.at - a.at);
    const remaining = queue.filter((contract) => !finished.has(contractKey(contract)));
    ctx.state.contractQueue = remaining;
    const rewardDetail = rewards.length > 0
      ? `; rewards: ${rewards.join("; ")}${solved > rewards.length ? `; +${solved - rewards.length} more` : ""}`
      : "";
    const result = record(
      failures.length === 0,
      `${solved} solved, ${failures.length} quarantined from a batch of ${batch.length}${rewardDetail}`,
    );
    merge(ctx.state, "side", {
      contracts: remaining.slice(0, CONTRACT_REPORT_LIMIT),
      contractTotal: Math.max(0, (topic.contractTotal ?? topic.contracts.length) - solved),
      solvableTotal: Math.max(0, solvableTotal - solved - failures.length),
      failures: allFailures
        .slice(0, 8)
        .map(({ data: _data, answer: _answer, ...summary }) => summary),
      quarantinedTotal: allFailures.length,
      lastResult: result,
    });
    pipelineBatch = undefined;
    pipelineInspection = undefined;
    pipelineData = undefined;
  },
};

export const sideModule: FeatureModule = {
  driver: side,
  reset: (state: GameState) => {
    delete state.topics.side;
    state.contractQuarantine = {};
    delete state.contractQueue;
    state.contractSolverVersion = CONTRACT_SOLVER_VERSION;
    pipelineBatch = undefined;
    pipelineInspection = undefined;
    pipelineData = undefined;
  },
  claims: (ctx) => (ctx.state.contractQueue?.length ?? ctx.state.topics.side?.contracts?.length)
    ? [actionRamClaim(ctx, "side", CLAIM_ID, ["codingcontract.attempt"], "side contract")]
    : [],
};
