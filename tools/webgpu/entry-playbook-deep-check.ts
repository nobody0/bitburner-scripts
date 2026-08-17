/** Production-decision check for playbook residual calibration.
 *
 * For each sampled certificate state, run the deployed small5 stack — the
 * installed artifact, the profile candidate limit, and the production
 * deep-search finalizer — at both proven dispatch ticks (the certificate
 * covers White seeds `phase+1` and `phase+2`). The state agrees only when
 * both decisions select the certified action, which is exactly what the
 * combined runtime's neural fallback would reproduce after the entry is
 * stripped.
 */
import { decideGoNeural, GoNeuralEngine } from "../../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import { goOpponentSeedCandidates } from "../../shared/strategy/go/rng.ts";
import type { GoView } from "../../shared/strategy/go/rules.ts";

interface CheckState {
  opponent: GoView["opponent"];
  komi: number;
  phase: number;
  boardRows: string[];
  previousBoards: string[][];
  passes: number;
  action: number;
}

async function main(): Promise<unknown> {
  const config = globalThis.__goPlaybookDeepCheck;
  if (!config?.states?.length) throw new Error("missing __goPlaybookDeepCheck states");
  const engine = new GoNeuralEngine((weights) => createRequiredWebGpuGoValueBackend(weights));
  const agreements: boolean[] = [];
  for (const state of config.states) {
    const view: GoView = {
      board: { size: 5, rows: state.boardRows },
      currentPlayer: "Black",
      opponent: state.opponent,
      status: "inProgress",
      previousBoards: state.previousBoards,
      consecutivePasses: state.passes,
      komi: state.komi,
      bonusCycles: 0,
    };
    let agreed = true;
    for (const tick of [0, 1]) {
      const dispatchPlaytime = (state.phase + tick) * 200;
      const decision = await decideGoNeural(
        view, goOpponentSeedCandidates(dispatchPlaytime, 0), engine, dispatchPlaytime);
      const action = decision.action.type === "pass" ? 25
        : decision.action.type === "move" ? decision.action.x * 5 + decision.action.y : -1;
      if (action !== state.action) { agreed = false; break; }
    }
    agreements.push(agreed);
  }
  return { ok: true, agreements };
}

declare global {
  // eslint-disable-next-line no-var
  var __goPlaybookDeepCheck: { states: CheckState[] } | undefined;
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false, error: String(error),
}));
export {};
