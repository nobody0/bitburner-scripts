/** Outcome comparison for aggressive playbook pruning.
 *
 * For each divergence state (the deployed net would play a different move than
 * the certificate), play both branches to completion under the certificate's
 * seeded timing: the certified move first, continuing on its line through the
 * playbook, versus the neural move first.
 *
 * The neural branch deliberately runs with the playbook DISABLED. Its purpose
 * is to answer "is this entry needed?", and a branch that leans on other
 * entries answers that question against a playbook which the same pass is
 * still pruning — the assumption then expires the moment one of those entries
 * is dropped. A pure-neural counterfactual is independent of every other prune
 * decision, and conservative: a playbook can only add wins to it.
 *
 * Each branch is replayed over `draws` independent defense/timing streams. The
 * environment is stochastic (White's tie-breaks and the sub-tick timing
 * offset), so a single draw proves nothing about a certificate whose guarantee
 * is "wins under every draw".
 */
import { validateMergedPlaybook } from "../../shared/strategy/go/playbook-facade.ts";
import {
  playCombinedContinuation,
} from "../../sim/go-combined-arena.ts";
import {
  decideGoNeural,
  GoNeuralEngine,
} from "../../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import { goOpponentSeedCandidates } from "../../shared/strategy/go/rng.ts";
import type { GoRewardOpponent, GoView } from "../../shared/strategy/go/rules.ts";

interface OutcomeState {
  enemy: string;
  komi: number;
  phase: number;
  boardRows: string[];
  /** Oldest first, matching the certificate history column. */
  historyRows: string[][];
  passes: number;
  certAction: number;
  defenseSeed: number;
}

interface BranchSummary {
  /** True only when the branch won every draw. */
  wonAll: boolean;
  draws: number;
  wins: number;
  meanPowerPerTurn: number;
}

function describe(action: number): { kind: "move"; x: number; y: number } | { kind: "pass" } {
  return action === 25 ? { kind: "pass" }
    : { kind: "move", x: Math.floor(action / 5), y: action % 5 };
}

async function main(): Promise<unknown> {
  const config = globalThis.__goPlaybookOutcomeCheck;
  if (!config?.states?.length) throw new Error("missing __goPlaybookOutcomeCheck states");
  const injected = globalThis as {
    __combinedPlaybook?: unknown; __combinedPlaybookReady?: Promise<unknown> };
  await injected.__combinedPlaybookReady;
  const playbook = validateMergedPlaybook(injected.__combinedPlaybook);
  const engine = new GoNeuralEngine((weights) => createRequiredWebGpuGoValueBackend(weights));

  const draws = Math.max(1, Math.floor(config.draws ?? 4));
  const results: { neural: BranchSummary; cert: BranchSummary; neuralAction: number }[] = [];
  for (const state of config.states) {
    const board = { size: 5, rows: state.boardRows };
    const dispatchPlaytime = playbook.modelFor(state.enemy).playtimeEpoch * 30_000_000
      + state.phase * 200;
    const view: GoView = {
      board,
      currentPlayer: "Black",
      opponent: state.enemy as GoRewardOpponent,
      status: "inProgress",
      previousBoards: [...state.historyRows].reverse(),
      consecutivePasses: state.passes,
      komi: state.komi,
      bonusCycles: 0,
    };
    const decision = await decideGoNeural(
      view, goOpponentSeedCandidates(dispatchPlaytime, 0), engine, dispatchPlaytime);
    const neuralAction = decision.action.type === "pass" ? 25
      : decision.action.type === "move" ? decision.action.x * 5 + decision.action.y : -1;
    const branch = async (first: number, neuralOnly: boolean): Promise<BranchSummary> => {
      let wins = 0;
      let powerPerTurnTotal = 0;
      let played = 0;
      for (let draw = 0; draw < draws; draw++) {
        const defenseSeed = (state.defenseSeed + Math.imul(draw, 0x9e37_79b9)) >>> 0;
        const game = await playCombinedContinuation(playbook, engine, {
          enemy: state.enemy,
          phase: state.phase,
          board,
          history: state.historyRows,
          passes: state.passes,
          forcedFirstAction: describe(first),
        }, {
          // Draw 0 keeps the deterministic minimum-latency replay the
          // certificate itself was proven under; later draws sample the
          // ordinary stochastic timing the live game actually sees.
          timing: draw === 0 ? "minimum" : "random",
          defenseSeed,
          timingSeed: (defenseSeed ^ 0x5bf0_3635) >>> 0,
          neuralOnly,
        });
        played++;
        if (game.won) wins++;
        powerPerTurnTotal += (game.won ? game.blackScore : game.blackScore * 0.5)
          / Math.max(1, game.policyRounds);
        // One loss already settles "wins every draw"; the caller's rule needs
        // no more from this branch, and the remaining replays are the bulk of
        // the cost on a corpus where most divergences lose.
        if (!game.won) break;
      }
      return { wonAll: wins === played && played === draws, draws: played, wins,
        meanPowerPerTurn: powerPerTurnTotal / Math.max(1, played) };
    };
    const cert = await branch(state.certAction, false);
    // Identical first moves cannot diverge on the first ply, but the branches
    // still differ afterwards (this one has no playbook), so both are played.
    const neural = await branch(neuralAction, true);
    results.push({ neural, cert, neuralAction });
  }
  return { ok: true, results };
}

declare global {
  // eslint-disable-next-line no-var
  var __goPlaybookOutcomeCheck: { states: OutcomeState[]; draws?: number } | undefined;
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false, error: String(error),
}));
export {};
