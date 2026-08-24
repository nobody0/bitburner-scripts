import type { NS } from "@ns";
import {
  canSolve,
  CONTRACT_BATCH_SIZE,
  CONTRACT_QUEUE_LIMIT,
  CONTRACT_REPORT_LIMIT,
  CONTRACT_SOLVE_RING,
  solve,
  SOLVERS,
} from "../../../shared/strategy/side/contracts.ts";
import { roundSigFigs } from "../../../shared/format.ts";
import { parseContractReward, type ContractReward } from "../../../shared/strategy/side/rewards.ts";
import type {
  ContractFailure,
  ContractOrigin,
  ContractOriginTotals,
  ContractSolveReport,
} from "../../../shared/telemetry/topics/side.ts";
import {
  contractKey,
  contractOrigin,
  darknetContractIsActionable,
  type ContractQueueEntry,
} from "../contracts.ts";
import { merge, type GameState } from "../state.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

const CONTRACT_REPLAY_LIMIT = 4_096;
const CONTRACT_REASON_LIMIT = 512;
const CLAIM_ID = "action:contract";

type Result = { action: string; ok: boolean; detail: string; at: number };

interface InspectedContract extends ContractQueueEntry {
  type: string;
  triesBefore: number;
}

interface ContractJob extends InspectedContract {
  data: unknown;
  answer: unknown;
}

type ContractInspectionResult = InspectedContract | (ContractQueueEntry & { error: string });
type ContractDataResult = (InspectedContract & { data: unknown }) | (InspectedContract & { error: string });
type ContractAttemptResult = { key: string; reward: string } | { key: string; error: string };

/** Queued broker stages retain their data-dependent inputs. A ready getData
 * lease must resume getData, not restart inspection with the wrong budget. */
let pipelineBatch: ContractQueueEntry[] | undefined;
let pipelineInspection: ContractInspectionResult[] | undefined;
let pipelineData: ContractDataResult[] | undefined;

function clearContractPipeline(): void {
  pipelineBatch = undefined;
  pipelineInspection = undefined;
  pipelineData = undefined;
}

/** The exact solver boundary shipped to the game. Simulator parity tests use
 * this export so they verify deployed wiring as well as the pure registry. */
export const CONTRACT_SOLVERS = SOLVERS;
export const solveContract = solve;

function record(ok: boolean, detail: string): Result {
  return { action: "contract", ok, detail, at: Date.now() };
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

/** Recipients named on a solve report. Capped because the all-factions award
 * lists every membership — around 30 names late in a run — and a ring of
 * those is a dump, not a digest. `toTotal` keeps the real count. */
const CONTRACT_RECIPIENT_LIMIT = 4;

function emptyTotals(): ContractOriginTotals {
  return {
    attempted: 0,
    solved: 0,
    unrewarded: 0,
    quarantined: 0,
    moneyApprox: 0,
    moneySolves: 0,
    factionRep: 0,
    companyRep: 0,
    unparsed: 0,
  };
}

/** The exact private ledger. An origin's row is created only when that origin
 * actually does something, so an absent row means "never seen" rather than
 * "measured zero" — the distinction the topic doc requires. */
function ledgerFor(ctx: DriverContext, origin: ContractOrigin): ContractOriginTotals {
  const ledger = ctx.state.contractLedger ??= { totals: {}, recent: [] };
  ledger.since ??= Date.now();
  return ledger.totals[origin] ??= emptyTotals();
}

function quarantineContract(
  ctx: DriverContext,
  contract: ContractQueueEntry,
  type: string,
  reason: string,
  data?: unknown,
  answer?: unknown,
  triesBefore?: number,
): ContractFailure {
  const origin = contractOrigin(contract);
  ledgerFor(ctx, origin).quarantined++;
  const failure: ContractFailure = {
    host: contract.host,
    file: contract.file,
    origin,
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

/** Fold one solve into the exact ledger and onto the ring.
 *
 * Money and reputation are kept in separate fields on purpose: they are
 * different currencies, and summing them would invent an exchange rate the game
 * does not have. `moneySolves` is what separates "paid a zero" from "never paid
 * money", which a BitNode that zeroes contract money makes a real distinction.
 *
 * Returns the reward kind so the caller can describe its own batch. */
function recordReward(
  ctx: DriverContext,
  totals: ContractOriginTotals,
  job: ContractJob & { type: string },
  reward: string,
): ContractReward["kind"] {
  const parsed = parseContractReward(reward);
  const report: ContractSolveReport = {
    at: Date.now(),
    origin: contractOrigin(job),
    host: job.host,
    file: job.file,
    type: job.type,
    reward: compactReason(reward),
    currency: parsed.kind,
  };

  switch (parsed.kind) {
    case "none":
      totals.unrewarded++;
      break;
    case "money":
      totals.moneyApprox += parsed.money;
      totals.moneySolves++;
      report.moneyApprox = parsed.money;
      break;
    case "factionRep":
      totals.factionRep += parsed.rep;
      report.rep = parsed.rep;
      report.to = parsed.to.slice(0, CONTRACT_RECIPIENT_LIMIT);
      if (parsed.to.length > CONTRACT_RECIPIENT_LIMIT) report.toTotal = parsed.to.length;
      break;
    case "companyRep":
      totals.companyRep += parsed.rep;
      report.rep = parsed.rep;
      report.to = parsed.to.slice(0, CONTRACT_RECIPIENT_LIMIT);
      break;
    case "unparsed":
      // Counted, never absorbed: the money total is now short by an unknown
      // amount and the viewer has to be able to say so.
      totals.unparsed++;
      break;
  }

  const ledger = ctx.state.contractLedger ??= { totals: {}, recent: [] };
  ledger.recent.push(report);
  if (ledger.recent.length > CONTRACT_SOLVE_RING) {
    ledger.recent.splice(0, ledger.recent.length - CONTRACT_SOLVE_RING);
  }
  return parsed.kind;
}

/** The rounded projection of the private ledger. Rounded here and not in the
 * ledger so a republish never rounds an already-rounded total; omitted entirely
 * until something has been attempted, because `merge` keeps a `{}` and an empty
 * record would assert "both origins at zero". */
function publishedLedger(ctx: DriverContext): {
  rewards?: Partial<Record<ContractOrigin, ContractOriginTotals>>;
  rewardsSince?: number;
  recentSolves?: ContractSolveReport[];
} {
  const ledger = ctx.state.contractLedger;
  if (!ledger || Object.keys(ledger.totals).length === 0) return {};
  const rewards: Partial<Record<ContractOrigin, ContractOriginTotals>> = {};
  for (const [origin, totals] of Object.entries(ledger.totals) as [ContractOrigin, ContractOriginTotals][]) {
    // Six significant figures: the money figure never carried more than four,
    // and a drifting tail would rewrite this record on every tick.
    rewards[origin] = { ...totals, moneyApprox: roundSigFigs(totals.moneyApprox, 6) };
  }
  return {
    rewards,
    ...(ledger.since !== undefined ? { rewardsSince: ledger.since } : {}),
    // Copied, not aliased: the ledger keeps pushing onto `recent`, and a
    // published record that mutates after its topic was marked clean would
    // change what a reader sees without ever being republished.
    recentSolves: ledger.recent.slice(),
  };
}

const side: FeatureDriver = {
  id: "side",
  everyMs: 5_000,
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.side;
    if (!topic) return;

    const quarantine = ctx.state.contractQuarantine ??= {};

    const now = Date.now();
    if (pipelineBatch?.some((contract) =>
      !darknetContractIsActionable(contract, ctx.state.darknetContractListings, now))) {
      clearContractPipeline();
    }
    const queue = (ctx.state.contractQueue ?? topic.contracts.map(({ host, file }) => ({ host, file })))
      .filter((contract) => darknetContractIsActionable(contract, ctx.state.darknetContractListings, now))
      .slice(0, CONTRACT_QUEUE_LIMIT);
    ctx.state.contractQueue = queue;

    const solvable = queue.filter((contract) => !quarantine[contractKey(contract)]);
    const solvableTotal = topic.solvableTotal ?? solvable.length;

    const batch: ContractQueueEntry[] = pipelineBatch
      ?? solvable.slice(0, CONTRACT_BATCH_SIZE);
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
      clearContractPipeline();
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
        clearContractPipeline();
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
    let darknetSolved = 0;
    let unreadable = 0;
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
        clearContractPipeline();
        merge(ctx.state, "side", { lastResult: record(false, attemptResult.reason) });
        return;
      }
      // The attempts have been SUBMITTED, so resuming this pipeline is never
      // correct again — release it before anything below can throw. The
      // controller swallows a driver throw, and with the resume vars still set
      // the next tick would skip inspect/getData and re-attempt contracts the
      // game has already answered, burning a try on a one-try contract like
      // Array Jumping Game. Everything from here on uses locals and ctx.state.
      clearContractPipeline();
      const byKey = new Map(jobs.map((job) => [contractKey(job), job]));
      for (const result of attemptResult.value) {
        const job = byKey.get(result.key)!;
        const origin = contractOrigin(job);
        const totals = ledgerFor(ctx, origin);
        totals.attempted++;
        finished.add(result.key);
        if ("error" in result) {
          if (!result.error.includes("Cannot find contract")) {
            failures.push(quarantineContract(ctx, job, job.type, result.error, job.data, job.answer, job.triesBefore));
          }
        } else if (result.reward === "") {
          failures.push(quarantineContract(ctx, job, job.type, "answer rejected", job.data, job.answer, job.triesBefore));
        } else {
          solved++;
          totals.solved++;
          if (origin === "darknet") darknetSolved++;
          if (recordReward(ctx, totals, job, result.reward) === "unparsed") unreadable++;
        }
      }
    }

    const allFailures = Object.values(quarantine).sort((a, b) => b.at - a.at);
    for (const contract of batch) {
      if (contract.dnet && finished.has(contractKey(contract))) {
        (ctx.state.darknetContractHandledAt ??= {})[contractKey(contract)] = contract.dnet.observedAt;
      }
    }
    const remaining = queue.filter((contract) => !finished.has(contractKey(contract)));
    ctx.state.contractQueue = remaining;
    // The line describes THIS batch. Cumulative earnings are published as
    // structured per-origin totals, so restating them here would be both a
    // second rendering and the wrong altitude for a per-batch summary.
    const origins = darknetSolved > 0 ? ` (${darknetSolved} darknet)` : "";
    const unread = unreadable > 0 ? `, ${unreadable} reward(s) unreadable` : "";
    const result = record(
      failures.length === 0,
      `${solved} solved${origins}, ${failures.length} quarantined from a batch of ${batch.length}${unread}`,
    );
    merge(ctx.state, "side", {
      contracts: remaining
        .slice(0, CONTRACT_REPORT_LIMIT)
        // Origin only — never the darknet identity, which stays off the wire.
        .map((contract) => ({ host: contract.host, file: contract.file, origin: contractOrigin(contract) })),
      contractTotal: Math.max(0, (topic.contractTotal ?? topic.contracts.length) - solved),
      solvableTotal: Math.max(0, solvableTotal - solved - failures.length),
      failures: allFailures
        .slice(0, 8)
        .map(({ data: _data, answer: _answer, ...summary }) => summary),
      quarantinedTotal: allFailures.length,
      ...publishedLedger(ctx),
      lastResult: result,
    });
    clearContractPipeline();
  },
};

export const sideModule: FeatureModule = {
  driver: side,
  reset: (state: GameState) => {
    delete state.topics.side;
    state.contractQuarantine = {};
    delete state.contractQueue;
    // Both, and in this order matters only in that neither may be skipped:
    // dropping the topic while keeping the ledger republishes pre-prestige
    // earnings as post-prestige, and clearing the ledger while keeping the
    // topic leaves the old numbers on the wire until the next tick. Neither
    // money nor reputation survives an install, so `kind` is irrelevant.
    delete state.contractLedger;
    clearContractPipeline();
  },
  claims: (ctx) => (ctx.state.contractQueue?.length ?? ctx.state.topics.side?.contracts?.length)
    ? [actionRamClaim(ctx, "side", CLAIM_ID, ["codingcontract.attempt"])]
    : [],
};
