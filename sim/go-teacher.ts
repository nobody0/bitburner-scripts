/** Slow, simulator-only terminal teacher for IPvGO.
 *
 * The deployed controller never imports this file. It replays independently
 * vendored Illuminati games, then asks the pure clean-room terminal solver how
 * far back each loss is still recoverable. Increasing --nodes trades offline
 * time for more exact labels; an exhausted search is reported, never guessed.
 */
import { solveGoEndgame } from "../shared/strategy/go/decide.ts";
import {
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  playGoArenaGame,
  type GoArenaTurnTrace,
} from "./go-arena.ts";

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function emptyPoints(trace: GoArenaTurnTrace): number {
  let count = 0;
  for (const column of trace.board) for (let point = 0; point < column.length; point++) {
    if (column[point] === ".") count++;
  }
  return count;
}

function sameAction(
  expected: GoArenaTurnTrace["black"],
  actual: { type: "move"; x: number; y: number } | { type: "pass" },
): boolean {
  return expected.type === actual.type
    && (expected.type === "pass" || actual.type === "move" && expected.x === actual.x && expected.y === actual.y);
}

async function main(): Promise<void> {
  const count = Math.max(1, Math.floor(numberFlag("--games", 8)));
  const start = numberFlag("--seed", 1_000);
  const maxEmpty = Math.max(0, Math.floor(numberFlag("--max-empty", 6)));
  const nodeLimit = Math.max(1, Math.floor(numberFlag("--nodes", 20_000)));
  const opponent = GO_ARENA_OPPONENTS.find(({ name }) => name === "Illuminati")!;
  const games = [];
  for (const seed of goArenaSeeds(count, start)) games.push(await playGoArenaGame(opponent, seed, 0.5, true));

  const labels = [];
  let searchedStates = 0;
  let exactStates = 0;
  let recoverableLosses = 0;
  for (const game of games) {
    if (game.won) continue;
    let earliestExact: Record<string, unknown> | undefined;
    for (const turn of game.trace ?? []) {
      const empties = emptyPoints(turn);
      if (empties > maxEmpty) continue;
      searchedStates++;
      const started = performance.now();
      const solution = solveGoEndgame({
        board: { size: game.size, rows: turn.board },
        previousBoards: turn.previousBoards,
        opponent: game.opponent,
        komi: opponent.komi,
        consecutivePasses: turn.consecutivePasses,
      }, turn.dispatchPlaytime, 0, nodeLimit);
      const elapsedMs = performance.now() - started;
      if (!solution) continue;
      exactStates++;
      earliestExact ??= {
        turn: turn.turn,
        empties,
        value: solution.value,
        nodes: solution.nodes,
        elapsedMs,
        action: solution.action,
        currentAction: turn.black,
        changesAction: !sameAction(turn.black, solution.action),
      };
    }
    if (earliestExact && Number(earliestExact.value) > 0) recoverableLosses++;
    labels.push({
      seed: game.seed,
      margin: game.score.X - game.score.O,
      ...(earliestExact ? { earliestExact } : { unresolvedBelowEmptyThreshold: maxEmpty }),
    });
  }
  console.log(JSON.stringify({
    games: games.length,
    losses: labels.length,
    maxEmpty,
    nodeLimit,
    searchedStates,
    exactStates,
    recoverableLosses,
    labels,
  }));
}

if (import.meta.main) await main();
