/** Frequency- and impact-pruned faction policy-book distillation.
 *
 * Discovery runs the deployed policy against the independently vendored AI.
 * Only public positions which recur are eligible. For each eligible early or
 * midgame position, candidate actions are replayed from the exact public
 * board, superko history, pass count and dispatch phase. An entry survives
 * only if it regresses no sampled win and either converts a loss with at least
 * a two-thirds continuation win rate or preserves every win while materially
 * increasing score. The final decisions are deliberately excluded because
 * bounded live forecasting already covers them and exact keys rarely recur.
 */
import {
  GO_ARENA_OPPONENTS,
  decideGoArenaBlack,
  goArenaSeeds,
  playGoArenaGame,
  playGoArenaPosition,
  type GoArenaInitialState,
} from "./go-arena.ts";
import type { GoBoard } from "../shared/strategy/go/decide.ts";
import {
  GO_POLICY_BOOK_CAPACITY,
  type GoPolicyBookOpponent,
} from "../shared/strategy/go/policy-book.ts";
import type { GoArenaOpponent } from "./go-arena.ts";

interface Occurrence {
  seed: number;
  state: GoArenaInitialState;
  action: readonly [number, number];
  depth: number;
  won: boolean;
  margin: number;
}

interface CandidateStats {
  x: number;
  y: number;
  samples: number;
  wins: number;
  conversions: number;
  regressions: number;
  marginDelta: number;
}

interface BookEntry extends CandidateStats {
  board: string;
  visits: number;
  minDepth: number;
  maxDepth: number;
  winRate: number;
  meanMarginDelta: number;
  impact: number;
}

interface ActivatedEntry {
  board: string;
  x: number;
  y: number;
  visits: number;
  minDepth: number;
  maxDepth: number;
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function sampled<T>(values: readonly T[], count: number): T[] {
  if (values.length <= count) return [...values];
  if (count <= 1) return [values[0]!];
  return Array.from({ length: count }, (_, index) =>
    values[Math.round(index * (values.length - 1) / (count - 1))]!,
  );
}

function candidateDecision(
  board: GoBoard,
  occurrence: Occurrence,
  opponent: GoArenaOpponent,
) {
  return decideGoArenaBlack(
    board,
    occurrence.state.previousBoards,
    opponent.name,
    opponent.komi,
    occurrence.state.dispatchPlaytime,
    occurrence.state.consecutivePasses,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  );
}

async function main(): Promise<void> {
  const count = Math.max(1, Math.floor(numberFlag("--games", 1_024)));
  const start = numberFlag("--seed", 7_654_321);
  const width = Math.max(1, Math.floor(numberFlag("--width", 3)));
  const phaseSamples = Math.max(1, Math.floor(numberFlag("--phase-samples", 3)));
  const minVisits = Math.max(1, Math.floor(numberFlag("--min-visits", 3)));
  const minPolicyVisits = Math.max(1, Math.floor(numberFlag("--min-policy-visits", 1)));
  const opponentQuery = stringFlag("--opponent", "Illuminati").toLowerCase();
  const opponent = GO_ARENA_OPPONENTS.find(({ name }) => name.toLowerCase().includes(opponentQuery));
  if (!opponent || opponent.name === "????????????") {
    throw new Error(`unknown or unsupported policy-book opponent ${opponentQuery}`);
  }
  const bookOpponent = opponent.name as GoPolicyBookOpponent;
  const maxEntries = Math.max(1, Math.floor(numberFlag(
    "--max-entries",
    GO_POLICY_BOOK_CAPACITY[bookOpponent],
  )));
  const minMarginDelta = Math.max(0, numberFlag("--min-margin-delta", 5));
  const excludeFinal = Math.max(0, Math.floor(numberFlag("--exclude-final", 2)));
  const outputIndex = Bun.argv.indexOf("--out");
  const output = outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined;
  const observations = new Map<string, Occurrence[]>();
  const activations = new Map<string, ActivatedEntry>();

  for (const seed of goArenaSeeds(count, start)) {
    const game = await playGoArenaGame(opponent, seed, 0.5, true);
    const trace = game.trace ?? [];
    const limit = Math.max(0, trace.length - excludeFinal);
    for (let depth = 0; depth < limit; depth++) {
      const turn = trace[depth]!;
      if (turn.black.type !== "move") continue;
      const board: GoBoard = { size: turn.board.length, rows: [...turn.board] };
      const key = board.rows.join("");
      const occurrences = observations.get(key) ?? [];
      occurrences.push({
        seed,
        state: {
          board,
          previousBoards: turn.previousBoards.map((position) => [...position]),
          consecutivePasses: turn.consecutivePasses,
          dispatchPlaytime: turn.dispatchPlaytime,
        },
        action: [turn.black.x, turn.black.y],
        depth,
        won: game.won,
        margin: game.score.X - game.score.O,
      });
      observations.set(key, occurrences);
      if (turn.policyBook) {
        const activated = activations.get(key) ?? {
          board: key,
          x: turn.black.x,
          y: turn.black.y,
          visits: 0,
          minDepth: depth,
          maxDepth: depth,
        };
        activated.visits++;
        activated.minDepth = Math.min(activated.minDepth, depth);
        activated.maxDepth = Math.max(activated.maxDepth, depth);
        activations.set(key, activated);
      }
    }
  }

  const entries: BookEntry[] = [];
  let evaluatedStates = 0;
  let rollouts = 0;
  for (const [boardKey, allOccurrences] of observations) {
    if (allOccurrences.length < minVisits) continue;
    evaluatedStates++;
    const occurrences = sampled(allOccurrences, phaseSamples);
    const representative = occurrences[0]!;
    const decision = candidateDecision(representative.state.board, representative, opponent);
    const candidates = new Map<string, readonly [number, number]>();
    for (const move of decision.ranked.slice(0, width)) candidates.set(`${move.x},${move.y}`, [move.x, move.y]);
    // A seed-sensitive deployed action can fall outside the representative's
    // first few candidates. Retain every action actually observed at this
    // public position so the teacher can compare it fairly.
    for (const occurrence of occurrences) {
      candidates.set(`${occurrence.action[0]},${occurrence.action[1]}`, occurrence.action);
    }

    const stats: CandidateStats[] = [];
    for (const [x, y] of candidates.values()) {
      const candidate: CandidateStats = {
        x,
        y,
        samples: 0,
        wins: 0,
        conversions: 0,
        regressions: 0,
        marginDelta: 0,
      };
      for (const occurrence of occurrences) {
        const game = await playGoArenaPosition(opponent, occurrence.seed, 0.5, occurrence.state, [x, y]);
        rollouts++;
        candidate.samples++;
        candidate.wins += Number(game.won);
        candidate.conversions += Number(!occurrence.won && game.won);
        candidate.regressions += Number(occurrence.won && !game.won);
        candidate.marginDelta += game.score.X - game.score.O - occurrence.margin;
      }
      stats.push(candidate);
    }

    const best = stats.sort((a, b) =>
      b.conversions - a.conversions
      || a.regressions - b.regressions
      || b.wins - a.wins
      || b.marginDelta - a.marginDelta
      || a.x - b.x
      || a.y - b.y,
    )[0]!;
    const winCorrection = best.conversions >= 1
      && best.regressions === 0
      && best.wins / best.samples >= 2 / 3;
    const scoreCorrection = best.regressions === 0
      && best.wins === best.samples
      && best.marginDelta / best.samples >= minMarginDelta;
    if (!winCorrection && !scoreCorrection) continue;
    const visits = allOccurrences.length;
    entries.push({
      board: boardKey,
      ...best,
      visits,
      minDepth: Math.min(...allOccurrences.map(({ depth }) => depth)),
      maxDepth: Math.max(...allOccurrences.map(({ depth }) => depth)),
      winRate: best.wins / best.samples,
      meanMarginDelta: best.marginDelta / best.samples,
      impact: visits * (
        (best.conversions - best.regressions) / best.samples
        + Math.max(0, best.marginDelta / best.samples) / 100
      ),
    });
  }

  entries.sort((a, b) =>
    b.impact - a.impact
    || b.conversions - a.conversions
    || b.meanMarginDelta - a.meanMarginDelta
    || b.visits - a.visits
    || a.board.localeCompare(b.board),
  );
  const selectedCorrections = entries.slice(0, maxEntries);
  const retained = [...selectedCorrections].sort((a, b) => a.board.localeCompare(b.board));
  const activatedEntries = [...activations.values()]
    .filter(({ visits }) => visits >= minPolicyVisits)
    .sort((a, b) => a.board.localeCompare(b.board));
  const policy = new Map<string, { board: string; x: number; y: number }>();
  // Corrections have direct paired evidence, so they consume the capacity
  // first. Frequently activated deployed entries fill only the remaining
  // slots. This makes iterative passes replace weaker entries rather than
  // silently growing a larger runtime table.
  for (const entry of selectedCorrections) policy.set(entry.board, entry);
  for (const entry of [...activatedEntries].sort((a, b) => b.visits - a.visits || a.board.localeCompare(b.board))) {
    if (policy.size >= maxEntries) break;
    if (!policy.has(entry.board)) policy.set(entry.board, entry);
  }
  const policyEntries = [...policy.values()].sort((a, b) => a.board.localeCompare(b.board));
  const artifact = JSON.stringify({
    opponent: opponent.name,
    games: count,
    start,
    width,
    phaseSamples,
    minVisits,
    minPolicyVisits,
    minMarginDelta,
    maxEntries,
    excludeFinal,
    observedStates: observations.size,
    evaluatedStates,
    rollouts,
    activatedEntries,
    entries: retained,
    policyEntries,
  });
  if (output) await Bun.write(output, `${artifact}\n`);
  else console.log(artifact);
}

if (import.meta.main) await main();
