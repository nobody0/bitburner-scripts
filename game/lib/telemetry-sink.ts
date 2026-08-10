import { stateKey } from "../../shared/telemetry/schema.ts";
import type { StateKey } from "../../shared/telemetry/state-map.ts";
import type { GameState } from "./state.ts";
import type { Telemetry } from "./telemetry.ts";

/** The only place the game-state store reaches the wire.
 *
 * Everything upstream of here runs unconditionally and writes to the store; a
 * --perf build simply never constructs a sink, and esbuild drops this module
 * along with the telemetry client. That is the whole design: telemetry is an
 * extra send, never a reason to read.
 *
 * Every call site of this module sits inside `TELEMETRY: if (__TELEMETRY__)`. */

export interface TelemetrySink {
  /** Publish everything written since the last call. */
  flush(state: GameState): void;
}

export function makeSink(tel: Telemetry): TelemetrySink {
  // Report-once bookkeeping. The store holds the current facts; the sink holds
  // what it has already said about them, so a permanently unaffordable probe
  // reports once per PRICE and a permanently failing one once per MESSAGE,
  // rather than crowding everything else out of the event feed every sweep.
  const sentSkips = new Map<string, number>();
  const sentFailures = new Map<string, string>();
  const sentContractFailures = new Set<string>();
  let sentBatch: string | undefined;
  let sentInfrastructureDecision: string | undefined;
  let sentHacknetDecision: string | undefined;
  let sentHashDecision: string | undefined;
  let sentFactionDecision: string | undefined;
  let sentInfrastructureResultAt: number | undefined;
  let sentHacknetResultAt: number | undefined;
  let sentHashResultAt: number | undefined;
  let sentFactionResultAt: number | undefined;

  return {
    flush(state: GameState): void {
      const dirty = new Set(state.dirty);
      for (const key of state.dirty) {
        const value = state.topics[key];
        if (value === undefined) continue;
        tel.state(key, value as never);
        // Compat alias: shared/goals/evaluate.ts reduces the getter-mirror key
        // space, and ui/app/project.ts charts money from either. Emitting both
        // keeps goals, sim replays and the UI working off one acquisition.
        if (key === "player") tel.mirror(stateKey("getPlayer"), value);
      }
      state.dirty.clear();

      // Topic state remains the complete, high-frequency audit trail. These
      // transition events are its compact index: replays and the live UI can
      // answer "what changed?" without diffing thousands of snapshots. The
      // signatures intentionally ignore continuously moving inputs such as
      // cash and the horizon; a new winner, eligibility or funding outcome is
      // a decision transition, another second passing is not.
      const moneyArbitration = state.topics.progression?.arbitration
        ? {
            grants: state.topics.progression.arbitration.grants.filter((grant) => grant.resource === "money"),
            denied: state.topics.progression.arbitration.denied.filter((denial) => denial.resource === "money"),
            remaining: state.topics.progression.arbitration.remaining.money,
          }
        : undefined;
      const moneyArbitrationDecision = moneyArbitration
        ? { grants: moneyArbitration.grants, denied: moneyArbitration.denied }
        : undefined;
      if (dirty.has("fleet")) {
        const plan = state.topics.fleet?.infrastructurePlan;
        if (plan) {
          const signature = JSON.stringify({
            buy: plan.buy,
            funded: plan.buy ? plan.moneyGranted >= plan.buy.cost : false,
            arbitration: moneyArbitrationDecision,
          });
          if (signature !== sentInfrastructureDecision) {
            sentInfrastructureDecision = signature;
            tel.event("investment.decision", { subsystem: "infrastructure", plan, arbitration: moneyArbitration });
          }
          if (plan.lastResult && plan.lastResult.at !== sentInfrastructureResultAt) {
            sentInfrastructureResultAt = plan.lastResult.at;
            tel.event("investment.result", { subsystem: "infrastructure", result: plan.lastResult });
          }
        }
      }

      if (dirty.has("hacknet")) {
        const plan = state.topics.hacknet?.plan;
        if (plan) {
          const signature = JSON.stringify({
            candidate: plan.candidate,
            buy: plan.buy,
            funded: plan.candidate ? plan.moneyGranted >= plan.candidate.cost : false,
            arbitration: moneyArbitrationDecision,
          });
          if (signature !== sentHacknetDecision) {
            sentHacknetDecision = signature;
            tel.event("investment.decision", { subsystem: "hacknet", plan, arbitration: moneyArbitration });
          }
          if (plan.lastResult && plan.lastResult.at !== sentHacknetResultAt) {
            sentHacknetResultAt = plan.lastResult.at;
            tel.event("investment.result", { subsystem: "hacknet", result: plan.lastResult });
          }

          const hashes = plan.hashes;
          if (hashes) {
            const hashSignature = JSON.stringify({
              spend: hashes.spend,
              reserve: hashes.reserve,
              capacityTarget: hashes.capacityTarget,
            });
            if (hashSignature !== sentHashDecision) {
              sentHashDecision = hashSignature;
              tel.event("hash.decision", { plan: hashes });
            }
            if (hashes.lastResult && hashes.lastResult.at !== sentHashResultAt) {
              sentHashResultAt = hashes.lastResult.at;
              tel.event("hash.result", hashes.lastResult);
            }
          }
        }
      }

      if (dirty.has("factions")) {
        const plan = state.topics.factions?.plan;
        if (plan) {
          const signature = JSON.stringify({
            intent: plan.objective?.intent
              ? {
                  faction: plan.objective.intent.faction,
                  repTarget: plan.objective.intent.repTarget,
                  augmentations: plan.objective.intent.augmentations,
                }
              : undefined,
            runner: plan.objective?.runnerUp
              ? {
                  faction: plan.objective.runnerUp.faction,
                  repTarget: plan.objective.runnerUp.repTarget,
                }
              : undefined,
            action: {
              type: plan.action.type,
              faction: plan.action.faction,
              augmentation: plan.action.augmentation,
              city: plan.action.city,
              amount: plan.action.amount,
            },
            blocked: plan.blocked,
            recommendInstall: Boolean(plan.recommendInstall),
          });
          if (signature !== sentFactionDecision) {
            sentFactionDecision = signature;
            tel.event("faction.decision", { plan });
          }
          if (plan.lastResult && plan.lastResult.at !== sentFactionResultAt) {
            sentFactionResultAt = plan.lastResult.at;
            tel.event("faction.result", plan.lastResult);
          }
        }
      }

      for (const key of state.mirrorDirty) {
        tel.mirror(key, state.mirrors[key]);
      }
      state.mirrorDirty.clear();

      for (const [id, skip] of Object.entries(state.probeSkips)) {
        if (sentSkips.get(id) === skip.cost) continue;
        sentSkips.set(id, skip.cost);
        tel.event("probe.skipped", { id, cost: skip.cost, budget: skip.budget });
      }
      for (const id of sentSkips.keys()) {
        if (state.probeSkips[id] === undefined) sentSkips.delete(id);
      }

      for (const [id, error] of Object.entries(state.probeFailures)) {
        if (sentFailures.get(id) === error) continue;
        sentFailures.set(id, error);
        tel.event("probe.failed", { id, error });
      }
      for (const id of sentFailures.keys()) {
        if (state.probeFailures[id] === undefined) sentFailures.delete(id);
      }

      // Full contract inputs/answers are useful exactly once: when a file is
      // quarantined. Repeating them in every Side state record made a single
      // stubborn failure dominate JSONL. The topic carries compact summaries;
      // this event preserves the reproducible replay.
      const quarantine = state.contractQuarantine ?? {};
      for (const [key, failure] of Object.entries(quarantine)) {
        if (sentContractFailures.has(key)) continue;
        sentContractFailures.add(key);
        tel.event("contract.quarantined", failure);
      }
      for (const key of sentContractFailures) {
        if (quarantine[key] === undefined) sentContractFailures.delete(key);
      }

      // In steady state the same handful of probes runs every sweep forever;
      // repeating that trace would be pure noise.
      const batch = state.probeBatch;
      if (batch) {
        const signature = batch.ids.join(",");
        if (signature !== sentBatch) {
          sentBatch = signature;
          tel.debug("probe.batch", { ids: batch.ids, cost: batch.cost, budget: batch.budget });
        }
      }
    },
  };
}

/** Mark every known topic for republication — used after a BitNode reset, when
 * the store has been rebuilt from scratch and the UI is still showing the
 * previous node's world. */
export function republish(state: GameState): void {
  for (const key of Object.keys(state.topics) as StateKey[]) state.dirty.add(key);
}
