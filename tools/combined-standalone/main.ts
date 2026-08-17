/** Standalone combined IPvGO driver: stripped playbook first, neural fallback.
 *
 * This is the isolated proof build (`go:combined:standalone`): one Bitburner
 * script bundling the neural-stripped merged phase playbook, the deployed
 * small5 WebGPU model, and the production decision engine — no web worker, no
 * RAM planning, no other game features. A certified playbook hit plays the
 * proven line; any miss (including entries stripped because the network
 * already reproduces them) falls through to the exact production neural
 * decision on the live tick and the playbook is consulted again next turn.
 *
 * The production integration lives in `game/`; this file exists so the
 * combined approach can be tested and shared in isolation.
 */
import {
  packCombinedBoard as packPlaybookBoard,
  validateMergedPlaybook,
} from "../../shared/strategy/go/playbook-facade.ts";
import {
  decideGoNeural,
  GoNeuralEngine,
} from "../../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import { loadGoValueWeights } from "../../shared/strategy/go/neural/artifact.ts";
import { SMALL5_GO_MODEL } from "../../shared/strategy/go/neural/models/small5.ts";
import { goOpponentSeedCandidates } from "../../shared/strategy/go/rng.ts";
import { GO_REWARD_RULES } from "../../shared/strategy/go/rewards.ts";
import type { GoRewardOpponent, GoView } from "../../shared/strategy/go/rules.ts";
import { planNextGame } from "./auto-planner.ts";

interface NsLike {
  disableLog(name: string): void;
  print(message: string): void;
  sleep(ms: number): Promise<void>;
  getPlayer(): { totalPlaytime: number };
  go: {
    getGameState(): { currentPlayer: string; blackScore: number; whiteScore: number;
      komi: number; bonusCycles?: number };
    getBoardState(): string[];
    getMoveHistory(): string[][];
    getOpponent(): string;
    makeMove(x: number, y: number): Promise<{ type: string; x: number | null; y: number | null }>;
    passTurn(): Promise<{ type: string; x: number | null; y: number | null }>;
    opponentNextTurn(): Promise<{ type: string; x: number | null; y: number | null }>;
    resetBoardState(opponent: string, size: number): string[] | undefined;
    analysis?: {
      getStats?(): Partial<Record<string, { wins?: number }>>;
    };
  };
  ui?: { openTail?(): void };
}

const STATS = {
  games: 0, wins: 0, losses: 0,
  certifiedTurns: 0, neuralTurns: 0, playbookMisses: 0,
  neuralMsTotal: 0,
};

export async function main(ns: NsLike): Promise<void> {
  ns.disableLog("ALL");
  ns.ui?.openTail?.();
  // The generated playbook is prepended to this bundle as a wrapped classic
  // script by go:combined:standalone (its module form is too large for
  // esbuild); its packed tables inflate asynchronously.
  const injected = globalThis as {
    __combinedPlaybook?: unknown; __combinedPlaybookReady?: Promise<unknown> };
  await injected.__combinedPlaybookReady;
  const playbook = validateMergedPlaybook(injected.__combinedPlaybook) as ReturnType<
      typeof validateMergedPlaybook> & {
    beginCommittedGame(ns: NsLike, requestedEnemy: string | undefined, progress: unknown,
      replaceSignature: unknown, telemetry: (kind: string, detail: string) => void):
      Promise<{ enemy: string; signature: unknown }>;
    advanceOnePhase(ns: NsLike): Promise<unknown>;
  };
  ns.print("combined playbook+neural driver: loading WebGPU model");
  const backend = await createRequiredWebGpuGoValueBackend(loadGoValueWeights(SMALL5_GO_MODEL));
  const engine = new GoNeuralEngine(() => backend);
  ns.print(`model ready (${SMALL5_GO_MODEL.byteLength.toLocaleString()} B payload); entering game loop`);
  let replaceSignature: unknown;
  // Automatic target selection: spread wins across every opponent while
  // minimizing dodges. Local tallies back up the live lifetime stats, and the
  // expected game length per enemy is a driver-measured rolling mean; a plan
  // is recomputed before every game, so missed windows and overruns recover
  // by construction.
  const localWins = new Map<string, number>();
  const expectedPhases = new Map<string, number>();
  const winsFor = (enemy: string): number => {
    const live = ns.go.analysis?.getStats?.()?.[enemy]?.wins;
    return typeof live === "number" ? live : localWins.get(enemy) ?? 0;
  };

  for (;;) {
    const planPhase = playbook.phaseNow(ns.getPlayer().totalPlaytime);
    const decision = planNextGame({
      enemies: playbook.OPPONENTS,
      routeFor: (enemy) => {
        try {
          const route = playbook.selectRoot(planPhase, enemy);
          return route?.enemy === enemy ? route : undefined;
        } catch {
          return undefined;
        }
      },
      winsFor,
      expectedGamePhases: (enemy) => expectedPhases.get(enemy) ?? 30,
      maxDodgePhases: 30_000,
    });
    ns.print(`[plan] ${decision.kind}: ${decision.reason}`);
    const route = await playbook.beginCommittedGame(
      ns, decision.enemy, undefined, replaceSignature,
      (kind: string, detail: string) => ns.print(`[playbook] ${kind} ${detail}`));
    replaceSignature = undefined;
    const enemy = route.enemy as GoRewardOpponent;
    const komi = GO_REWARD_RULES[enemy].komi;
    const gameStartPhase = playbook.phaseNow(ns.getPlayer().totalPlaytime);
    let credit = 0;
    let passes = 0;

    game: for (;;) {
      const snapshot = ns.go.getGameState();
      if (snapshot.currentPlayer === "White") {
        await ns.go.opponentNextTurn();
        continue;
      }
      if (snapshot.currentPlayer === "None") break;
      const playtime = ns.getPlayer().totalPlaytime;
      const phase = playbook.phaseNow(playtime);
      const bonus = snapshot.bonusCycles ?? 0;
      const boardRows = ns.go.getBoardState();
      const historyNewest = ns.go.getMoveHistory();
      const packedBoard = packPlaybookBoard(boardRows);
      const packedHistory = historyNewest.slice().reverse().map(packPlaybookBoard);
      const certified = playbook.certifiedAction(
        enemy, phase, bonus, packedBoard, passes, credit, packedHistory);

      let action: { kind: "move"; x: number; y: number } | { kind: "pass" };
      if (certified) {
        credit = certified.alignmentCredit;
        const described = certified.action as { kind: string; x?: number; y?: number; variant?: number };
        if (described.kind === "align") {
          await playbook.advanceOnePhase(ns);
          credit = playbook.modelFor(enemy).alignmentBoards;
          STATS.certifiedTurns++;
          continue;
        }
        if (described.kind === "sleep") {
          for (let advance = 0; advance < (described.variant ?? 1); advance++) {
            await playbook.advanceOnePhase(ns);
          }
          STATS.certifiedTurns++;
          continue;
        }
        action = described.kind === "move"
          ? { kind: "move", x: described.x!, y: described.y! }
          : { kind: "pass" };
        STATS.certifiedTurns++;
      } else {
        // Off the certified line (a genuine miss or a neural-stripped entry):
        // the production decision on the live tick takes over, and the
        // playbook is consulted again next turn. The alignment credit carries
        // through: it is part of an entry's key, so dropping it would strand
        // the rest of a line whose stripped move the network just reproduced.
        STATS.playbookMisses++;
        const view: GoView = {
          board: { size: 5, rows: boardRows },
          currentPlayer: "Black",
          opponent: enemy,
          status: "inProgress",
          previousBoards: historyNewest,
          consecutivePasses: passes,
          komi,
          bonusCycles: bonus,
        };
        const started = performance.now();
        const decision = await decideGoNeural(
          view, goOpponentSeedCandidates(playtime, bonus), engine, playtime);
        STATS.neuralMsTotal += performance.now() - started;
        STATS.neuralTurns++;
        if (decision.action.type === "move") {
          action = { kind: "move", x: decision.action.x, y: decision.action.y };
        } else {
          action = { kind: "pass" };
        }
      }

      const historyBefore = ns.go.getMoveHistory().length;
      const response = action.kind === "move"
        ? await ns.go.makeMove(action.x, action.y)
        : await ns.go.passTurn();
      if (response.type === "gameOver") break game;
      const ourPass = action.kind === "pass" ? 1 : 0;
      if (response.type === "pass") {
        passes = ourPass + 1;
      } else {
        // A White priority move rejected by positional superko is reported as
        // a move but changes nothing; derive the streak from history growth.
        const whiteContributed = ns.go.getMoveHistory().length - historyBefore - (1 - ourPass);
        passes = whiteContributed > 0 ? 0 : ourPass;
      }
      if (passes >= 2) break;
      if (credit > 0) credit--;
    }

    const finished = ns.go.getGameState();
    STATS.games++;
    const won = finished.blackScore > finished.whiteScore;
    if (won) {
      STATS.wins++;
      localWins.set(enemy, (localWins.get(enemy) ?? 0) + 1);
    } else STATS.losses++;
    // Rolling per-enemy game length in phases, feeding the planner's
    // fits-before-the-target-window estimate. Ring-delta, clamped so a
    // pathological overrun cannot poison future plans.
    const endPhase = playbook.phaseNow(ns.getPlayer().totalPlaytime);
    const measured = Math.min(2_000, Math.max(5,
      ((endPhase - gameStartPhase) % playbook.PHASES + playbook.PHASES) % playbook.PHASES));
    const previous = expectedPhases.get(enemy) ?? measured;
    expectedPhases.set(enemy, 0.7 * previous + 0.3 * measured);
    const meanNeuralMs = STATS.neuralTurns ? (STATS.neuralMsTotal / STATS.neuralTurns).toFixed(1) : "0";
    ns.print(`game ${STATS.games} vs ${enemy}: ${won ? "WIN" : "LOSS"} `
      + `${finished.blackScore}-${finished.whiteScore} in ~${measured} phases | `
      + `totals ${STATS.wins}W/${STATS.losses}L, `
      + `${STATS.certifiedTurns} certified / ${STATS.neuralTurns} neural turns `
      + `(${STATS.playbookMisses} misses, mean neural ${meanNeuralMs} ms)`);
    await ns.sleep(200);
  }
}
