/** Champion-versus-derivative decision parity over replayed arena states.
 *
 * Plays traced production games with the champion artifact, then replays every
 * Black decision state through two engines — champion module and derivative
 * module — and compares proposal logits and every decision field. A lossless
 * derivative (strip-neutral-value-v1) must agree exactly on all of them.
 */
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goProfileArenaSeedCases,
  playGoArenaGame,
  type GoArenaTurnTrace,
} from "../../sim/go-arena.ts";
import {
  finalizeNeuralGoDecision,
  GoNeuralEngine,
  prepareNeuralGoDecision,
} from "../../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import type { GoValueModelArtifact } from "../../shared/strategy/go/neural/artifact.ts";
import type {
  GoProposalRaw,
  GoValueBackend,
  GoValueBatch,
} from "../../shared/strategy/go/neural/backend.ts";
import type { GoView } from "../../shared/strategy/go/rules.ts";
import { alignedAiSeed } from "../../shared/strategy/go/rng.ts";

interface ParityConfig {
  profile: "small5" | "daemon19";
  games: number;
  seed: number;
  handicapSeed: number;
  defenseSeed: number;
  championArtifact: GoValueModelArtifact;
  derivativeArtifact: GoValueModelArtifact;
  /** "exact" fails on any difference; "report" only reports agreement rates. */
  mode: "exact" | "report";
}

class RecordingBackend implements GoValueBackend {
  lastProposal: GoProposalRaw | undefined;

  constructor(readonly inner: GoValueBackend) {}
  get extent(): number { return this.inner.extent; }
  get behaviorFeatures(): number { return this.inner.behaviorFeatures; }
  get inputChannels(): 8 | 16 | undefined { return this.inner.inputChannels; }
  get valuePath(): "trained" | "absent" | undefined { return this.inner.valuePath; }
  evaluateBatch(batch: GoValueBatch): Promise<Float32Array> {
    return this.inner.evaluateBatch(batch);
  }
  async evaluateProposal(batch: GoValueBatch): Promise<GoProposalRaw> {
    const result = await this.inner.evaluateProposal(batch);
    this.lastProposal = {
      value: new Float32Array(result.value),
      moves: new Float32Array(result.moves),
    };
    return result;
  }
  dispose(): void { this.inner.dispose(); }
}

async function main(): Promise<unknown> {
  const config = globalThis.__goDerivativeParityConfig;
  if (!config) throw new Error("missing __goDerivativeParityConfig");
  const opponentEntries = GO_ARENA_OPPONENTS.filter((opponent) =>
    config.profile === "daemon19" ? opponent.name === "????????????" : opponent.requestedSize === 5);

  // 1. Traced battery games through the champion module on the recorded corpus.
  configureGoArenaEngine((weights) => createRequiredWebGpuGoValueBackend(weights),
    { [config.profile]: config.championArtifact });
  const traces: { opponent: string; komi: number; turn: GoArenaTurnTrace }[] = [];
  const corpora = goProfileArenaSeedCases(
    config.profile, config.games, config.seed, config.handicapSeed, config.defenseSeed);
  for (const corpus of corpora) {
    const opponent = opponentEntries.find((value) => value.name === corpus.opponent)!;
    for (const { seed, handicapSeed, defenseSeed } of corpus.cases) {
      const game = await playGoArenaGame(opponent, seed, undefined, true, {
        handicapSeed, defenseSeed });
      for (const turn of game.trace ?? []) {
        traces.push({ opponent: opponent.name, komi: opponent.komi, turn });
      }
    }
  }

  // 2. Replay every state through both modules in one session.
  const backends = {
    champion: new RecordingBackend(await createRequiredWebGpuGoValueBackend(
      (await import("../../shared/strategy/go/neural/artifact.ts"))
        .loadGoValueWeights(config.championArtifact))),
    derivative: new RecordingBackend(await createRequiredWebGpuGoValueBackend(
      (await import("../../shared/strategy/go/neural/artifact.ts"))
        .loadGoValueWeights(config.derivativeArtifact))),
  };
  const championEngine = new GoNeuralEngine(() => backends.champion);
  const derivativeEngine = new GoNeuralEngine(() => backends.derivative);

  let states = 0;
  let actionMismatches = 0;
  let finalistMismatches = 0;
  let scoreMismatches = 0;
  let forecastMismatches = 0;
  let logitMaxAbsDiff = 0;
  const examples: unknown[] = [];
  const actionKey = (action: { type: string; [key: string]: unknown }): string =>
    JSON.stringify(action);
  for (const { opponent, komi, turn } of traces) {
    const view: GoView = {
      board: { size: turn.board.length, rows: turn.board },
      currentPlayer: "Black",
      opponent: opponent as GoView["opponent"],
      status: "inProgress",
      previousBoards: turn.previousBoards,
      consecutivePasses: turn.consecutivePasses,
      komi,
    };
    const seeds = [alignedAiSeed(turn.dispatchPlaytime, 0)];
    const championDecision = await finalizeNeuralGoDecision(
      prepareNeuralGoDecision(view), seeds, championEngine);
    const championLogits = backends.champion.lastProposal?.moves;
    const derivativeDecision = await finalizeNeuralGoDecision(
      prepareNeuralGoDecision(view), seeds, derivativeEngine);
    const derivativeLogits = backends.derivative.lastProposal?.moves;
    states++;
    if (championLogits && derivativeLogits && championLogits.length === derivativeLogits.length) {
      for (let index = 0; index < championLogits.length; index++) {
        logitMaxAbsDiff = Math.max(logitMaxAbsDiff,
          Math.abs(championLogits[index]! - derivativeLogits[index]!));
      }
    }
    const mismatch = {
      action: actionKey(championDecision.action) !== actionKey(derivativeDecision.action),
      finalists: championDecision.finalists !== derivativeDecision.finalists,
      score: championDecision.ranked[0]?.score !== derivativeDecision.ranked[0]?.score
        || championDecision.ranked[0]?.powerPerRound !== derivativeDecision.ranked[0]?.powerPerRound,
      forecast: JSON.stringify(championDecision.forecast)
        !== JSON.stringify(derivativeDecision.forecast),
    };
    if (mismatch.action) actionMismatches++;
    if (mismatch.finalists) finalistMismatches++;
    if (mismatch.score) scoreMismatches++;
    if (mismatch.forecast) forecastMismatches++;
    if ((mismatch.action || mismatch.finalists || mismatch.score || mismatch.forecast)
      && examples.length < 20) {
      examples.push({ opponent, turn: turn.turn, dispatchPlaytime: turn.dispatchPlaytime,
        mismatch, champion: championDecision.action, derivative: derivativeDecision.action });
    }
  }
  backends.champion.dispose();
  backends.derivative.dispose();

  const exact = actionMismatches === 0 && finalistMismatches === 0
    && scoreMismatches === 0 && forecastMismatches === 0 && logitMaxAbsDiff === 0;
  return {
    ok: config.mode === "exact" ? exact && states > 0 : states > 0,
    backend: "webgpu",
    mode: config.mode,
    games: config.games,
    states,
    actionAgreement: (states - actionMismatches) / Math.max(1, states),
    finalistAgreement: (states - finalistMismatches) / Math.max(1, states),
    scoreAgreement: (states - scoreMismatches) / Math.max(1, states),
    forecastAgreement: (states - forecastMismatches) / Math.max(1, states),
    logitMaxAbsDiff,
    exact,
    examples,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __goDerivativeParityConfig: ParityConfig | undefined;
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false, backend: "webgpu", error: String(error),
}));
export {};
