/** Generated 19x19 "playbook": KataGo-evaluated exact-reply lookahead.
 *
 * A certificate search cannot scale to 19x19, but the opponent can still be
 * predicted exactly, and that is what matters. White never branches: its reply
 * to any candidate is a function of the board and the known dispatch seed, so
 * the tree branches only at Black nodes and depth d costs b^d leaves rather
 * than (b*w)^d.
 *
 * The immediate reply uses the exactly known current seed. The *next* dispatch
 * tick is narrowed to two candidates by `goSuccessorDispatchCandidates`, the
 * shipping analogue of ipvgobruteforce's runtime uncertainty window, so the
 * second reply needs a two-way branch rather than a sampled phase average.
 *
 * KataGo is used only where it is strong: as a static leaf evaluator. Because
 * it selects moves assuming a strong opponent while the World Daemon is a fixed
 * exploitable policy, any root where the backed-up best move differs from
 * KataGo's own choice is a measured enemy-AI exploit.
 *
 * Output is evidence, not authority: entries are emitted as `novel-hypothesis`
 * with their measured margin, for a later paired same-stream comparison to
 * promote. Leaf evaluations are emitted separately as candidate value targets.
 */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { KataGoAdvisor, KATAGO_MODELS, type KataGoMove } from "../katago/advisor.ts";
import { GO_ARENA_OPPONENTS, playGoArenaPolicyGame,
  type ArenaBlackInput, type ArenaBlackPolicy } from "./arena.ts";
import { finalizeNeuralGoDecision, GoNeuralEngine,
  prepareNeuralGoDecision } from "../../shared/strategy/go/neural/engine.ts";
import { PythonV9Backend } from "./python-v9-backend.ts";
import { predictOpponentReplies } from "../../shared/strategy/go/opponent.ts";
import { alignedAiSeed, goOpponentSeedCandidates,
  goSuccessorDispatchCandidates } from "../../shared/strategy/go/rng.ts";
import { legalMoves, playMove, type GoBoard } from "./strategy/decide.ts";

type Json = Record<string, any>;

function flag(name: string, fallback?: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`missing ${name}`);
    return fallback;
  }
  return value;
}
const num = (name: string, fallback: number): number => Number(flag(name, String(fallback)));

interface Position {
  board: GoBoard;
  previousBoards: readonly string[][];
  consecutivePasses: number;
  dispatchPlaytime: number;
  bonusCycles: number;
}

const key = (move: KataGoMove): string => move === "pass" ? "pass" : `${move[0]},${move[1]}`;
const pointKey = (point: { x: number; y: number } | undefined): string =>
  point ? `${point.x},${point.y}` : "pass";

/** Apply black, then the exact seeded white reply. Returns undefined when the
 * black move is illegal. A white reply our rules reject is the documented
 * upstream no-op: the board simply advances unchanged. */
function applyBlackThenWhite(
  position: Position, move: { x: number; y: number } | undefined, seed: number,
  opponent: typeof GO_ARENA_OPPONENTS[number],
): { position: Position; wait: any } | undefined {
  let board = position.board;
  const history = position.previousBoards.map((rows) => rows.join(""));
  let previous = [...position.previousBoards];
  let passes = position.consecutivePasses;
  if (move) {
    const played = playMove(board, move.x, move.y, "X", new Set(history));
    if (!played) return undefined;
    previous = [board.rows, ...previous];
    board = played.board;
    passes = 0;
  } else {
    passes += 1;
  }
  const forecast = predictOpponentReplies(
    board, opponent.name, seed, previous, passes);
  const reply = [...forecast.replies].sort((a, b) => b.probability - a.probability)[0];
  if (!reply) return undefined;
  if (reply.move) {
    const played = playMove(board, reply.move.x, reply.move.y, "O",
      new Set(previous.map((rows) => rows.join(""))));
    if (played) {
      previous = [board.rows, ...previous];
      board = played.board;
      passes = 0;
    }
    // else: exact upstream no-op, board unchanged and not a pass
  } else {
    passes += 1;
  }
  return {
    position: { board, previousBoards: previous, consecutivePasses: passes,
      dispatchPlaytime: position.dispatchPlaytime, bonusCycles: position.bonusCycles },
    wait: reply.wait,
  };
}

async function main(): Promise<void> {
  const out = flag("--out");
  const studentPath = flag("--student");
  const games = num("--games", 32);
  const stride = num("--stride", 12);
  const rootsPerGame = num("--roots-per-game", 6);
  const rootCandidates = num("--root-candidates", 8);
  const followUps = num("--follow-ups", 4);
  const visits = num("--visits", 16);
  const rootVisits = num("--root-visits", 16);
  const minMargin = num("--min-margin", 0.02);
  const liveLow = num("--winrate-low", 0.05);
  const liveHigh = num("--winrate-high", 0.95);
  const seedStart = num("--seed", 202_608_2401);
  const handicapStart = num("--handicap-seed", 202_608_2402);
  if (await Bun.file(out).exists()) throw new Error(`output already exists: ${out}`);

  const opponent = GO_ARENA_OPPONENTS[6]!;   // World Daemon
  const studentBytes = new Uint8Array(await Bun.file(studentPath).arrayBuffer());
  const studentSha256 = createHash("sha256").update(studentBytes).digest("hex");

  // 1. Outcome-blind root collection from the frozen champion's own routes.
  const backend = await PythonV9Backend.create(studentPath, flag("--device", "mps"));
  const engine = new GoNeuralEngine(() => backend);
  const roots: Array<Position & { shortlist: string[]; routeIndex: number; elapsed: number }> = [];
  try {
    for (let routeIndex = 0; routeIndex < games; routeIndex++) {
      const seed = seedStart + routeIndex * 20_003;
      const handicapSeed = handicapStart + routeIndex * 104_729;
      let elapsed = 0;
      let taken = 0;
      const policy: ArenaBlackPolicy = async (input: ArenaBlackInput) => {
        // Routes must be the champion's *production* distribution. daemon19
        // plays strict K=1; at K>1 its deliberately neutral value head selects
        // near-arbitrarily among candidates, producing a weaker player's states
        // (measurably longer games) that it never actually visits.
        const prepared = prepareNeuralGoDecision({
          board: input.board, currentPlayer: "Black", opponent: input.opponent,
          status: "inProgress", previousBoards: input.previousBoards,
          candidateLimit: 1, consecutivePasses: input.consecutivePasses,
          komi: input.komi,
        });
        const decision = await finalizeNeuralGoDecision(
          prepared, [alignedAiSeed(input.dispatchPlaytime, 0)], engine, input.dispatchPlaytime);
        if (!prepared.immediate && taken < rootsPerGame && elapsed >= taken * stride) {
          roots.push({
            board: input.board, previousBoards: input.previousBoards,
            consecutivePasses: input.consecutivePasses,
            dispatchPlaytime: input.dispatchPlaytime, bonusCycles: 0, elapsed,
            // At K=1 the champion commits to one action; that action is kept as
            // a candidate so the search always contains what it would really
            // play. Breadth comes from KataGo's shortlist at search time.
            shortlist: [pointKey((decision.action as Json)?.type === "move"
              ? decision.action as any : undefined)],
            routeIndex,
          });
          taken++;
        }
        elapsed++;
        return decision;
      };
      const game = await playGoArenaPolicyGame(
        opponent, seed, 0.5, false, policy, handicapSeed, null);
      console.error(JSON.stringify({ phase: "roots", route: routeIndex + 1, games,
        roots: roots.length, turns: game.turns, won: game.won }));
    }
  } finally {
    await engine.dispose();
  }

  // 2. KataGo-evaluated exact-reply lookahead at each root.
  const kata = new KataGoAdvisor(
    flag("--katago", "go-ai/.deps/KataGo/build/ipvgo-opencl/katago"),
    flag("--katago-model", KATAGO_MODELS.daemon19.file),
    flag("--katago-config", "go-ai/katago/config/analysis.cfg"));
  const entries: Json[] = [];
  const leafValues: Json[] = [];
  let examined = 0;
  let skippedSaturated = 0;
  try {
    for (const root of roots) {
      const legal = new Set(legalMoves(root.board, "X", root.previousBoards)
        .map((point) => `${point[0]},${point[1]}`));
      legal.add("pass");
      // Root filter: only search live positions. KataGo's static read of the
      // root is not the route outcome, so this stays outcome-blind, and it
      // avoids the saturated-winrate trap that killed the depth-1 attempt.
      const rootEval = await kata.evaluatePosition(
        root.board, root.previousBoards, opponent.komi, rootVisits);
      if (rootEval.winrate < liveLow || rootEval.winrate > liveHigh) {
        skippedSaturated++;
        continue;
      }
      const kataShortlist = await kata.shortlist(
        root.board, root.previousBoards, opponent.komi, rootVisits, rootCandidates, legal);
      const kataBest = kataShortlist[0] ? key(kataShortlist[0].move) : undefined;
      const candidates = [...new Set([
        ...kataShortlist.map((advice) => key(advice.move)),
        ...root.shortlist.filter((value) => legal.has(value)),
      ])].slice(0, rootCandidates);

      const rootSeed = alignedAiSeed(root.dispatchPlaytime, root.bonusCycles);
      const scored: Array<{ move: string; win: number; score: number }> = [];
      for (const candidate of candidates) {
        const move = candidate === "pass" ? undefined
          : { x: Number(candidate.split(",")[0]), y: Number(candidate.split(",")[1]) };
        const first = applyBlackThenWhite(root, move, rootSeed, opponent);
        if (!first) continue;
        // Two exact successor seeds, from the reply's own wait trace.
        const { timing, candidates: ticks } = goSuccessorDispatchCandidates(
          root.dispatchPlaytime, root.bonusCycles, first.wait, 1);
        const successorSeeds = [...new Set(ticks.flatMap((tick) =>
          goOpponentSeedCandidates(tick, timing.bonusCycles)))];
        const followLegal = new Set(legalMoves(
          first.position.board, "X", first.position.previousBoards)
          .map((point) => `${point[0]},${point[1]}`));
        followLegal.add("pass");
        const followShortlist = await kata.shortlist(
          first.position.board, first.position.previousBoards, opponent.komi,
          visits, followUps, followLegal);
        let bestFollow = { win: -1, score: -Infinity };
        for (const follow of followShortlist) {
          const followMove = follow.move === "pass" ? undefined
            : { x: follow.move[0], y: follow.move[1] };
          // Conservative over the two-seed window: take the worse branch, so a
          // retained entry survives whichever successor tick actually fires.
          let worst = { win: Infinity, score: Infinity };
          for (const successorSeed of successorSeeds) {
            const second = applyBlackThenWhite(
              { ...first.position, dispatchPlaytime: successorSeed },
              followMove, successorSeed, opponent);
            if (!second) { worst = { win: -1, score: -Infinity }; break; }
            const leaf = await kata.evaluatePosition(
              second.position.board, second.position.previousBoards, opponent.komi, visits);
            leafValues.push({
              schema: "bitburner-go-lookahead-leaf-value-v1",
              profile: "daemon19",
              originatingStudentSha256: studentSha256,
              route: root.routeIndex, rootElapsed: root.elapsed,
              rootBoard: root.board.rows, rootDispatchPlaytime: root.dispatchPlaytime,
              candidate, follow: key(follow.move), successorSeed,
              board: second.position.board.rows,
              previousBoards: second.position.previousBoards,
              consecutivePasses: second.position.consecutivePasses,
              // Two black moves and two white replies have been applied.
              elapsed: root.elapsed + 2,
              author: "katago-leaf-evaluation-v1",
              winrate: leaf.winrate, scoreLead: leaf.scoreLead, visits: leaf.visits,
            });
            if (leaf.winrate < worst.win) worst = { win: leaf.winrate, score: leaf.scoreLead };
          }
          if (worst.win > bestFollow.win
            || (worst.win === bestFollow.win && worst.score > bestFollow.score)) {
            bestFollow = { win: worst.win, score: worst.score };
          }
        }
        if (bestFollow.win >= 0) {
          scored.push({ move: candidate, win: bestFollow.win, score: bestFollow.score });
        }
      }
      examined++;
      if (!scored.length || !kataBest) continue;
      scored.sort((a, b) => b.win - a.win || b.score - a.score);
      const best = scored[0]!;
      const kataRow = scored.find((row) => row.move === kataBest);
      if (best.move === kataBest || !kataRow) continue;
      const margin = best.win - kataRow.win;
      if (margin < minMargin) continue;
      entries.push({
        schema: "bitburner-go-lookahead-playbook-v1",
        profile: "daemon19",
        classification: "novel-hypothesis",
        originatingStudentSha256: studentSha256,
        route: root.routeIndex,
        board: root.board.rows,
        previousBoards: root.previousBoards,
        consecutivePasses: root.consecutivePasses,
        dispatchPlaytime: root.dispatchPlaytime,
        rootElapsed: root.elapsed,
        rootSeed,
        rootWinrate: rootEval.winrate,
        kataGoAction: kataBest,
        lookaheadAction: best.move,
        winMargin: margin,
        scoreMargin: best.score - kataRow.score,
        candidates: scored,
        evaluator: { model: KATAGO_MODELS.daemon19.file, visits, rootVisits,
          depth: 2, successorWindow: 2, aggregation: "worst-of-successor-window" },
      });
      console.error(JSON.stringify({ phase: "search", examined, roots: roots.length,
        entries: entries.length, skippedSaturated }));
    }
  } finally {
    await kata.close();
  }

  const payload = new TextEncoder().encode(
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const partial = `${out}.partial`;
  try {
    await Bun.write(partial, Bun.gzipSync(payload));
    await rename(partial, out);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
  const leavesOut = `${out.replace(/\.jsonl\.gz$/, "")}.leaves.jsonl.gz`;
  const encoder = new TextEncoder();
  const leafChunks: Uint8Array[] = [];
  let leafBytes = 0;
  for (const value of leafValues) {
    const chunk = encoder.encode(`${JSON.stringify(value)}\n`);
    leafChunks.push(chunk);
    leafBytes += chunk.length;
  }
  const leafPayload = new Uint8Array(leafBytes);
  let leafOffset = 0;
  for (const chunk of leafChunks) { leafPayload.set(chunk, leafOffset); leafOffset += chunk.length; }
  const leafPartial = `${leavesOut}.partial`;
  try {
    await Bun.write(leafPartial, Bun.gzipSync(leafPayload));
    await rename(leafPartial, leavesOut);
  } catch (error) {
    await unlink(leafPartial).catch(() => undefined);
    throw error;
  }
  const summary = {
    leaves: leavesOut,
    leavesSha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(leavesOut).arrayBuffer())).digest("hex"),
    out, outSha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(out).arrayBuffer())).digest("hex"),
    studentSha256, games, roots: roots.length, examined, skippedSaturated,
    entries: entries.length, leafEvaluations: leafValues.length,
    exploitRate: examined ? entries.length / examined : 0,
    settings: { stride, rootsPerGame, rootCandidates, followUps, visits, rootVisits,
      minMargin, liveLow, liveHigh },
  };
  await Bun.write(`${out}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
