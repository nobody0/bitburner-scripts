/** Persistent KataGo sidecar for the native population trainer.
 *
 * The native process owns IPvGO rules, opening generation, opponent forecasts,
 * terminal scoring and episode admission. This worker owns only KataGo I/O and
 * move ranking. One JSON request and one tab-delimited response are exchanged
 * per Black decision so KataGo never receives the WHRNG seed.
 */
import type { GoBoard } from "../teacher/strategy/decide.ts";
import { KataGoAdvisor, type KataGoMove } from "./advisor.ts";
import { PredictiveKataGoAdvisor } from "./predictive-advisor.ts";

interface WireCandidate {
  move: string;
  predictedWhite: string;
  after: string;
  exactScore?: { X: number; O: number };
  exactRemainingRounds?: 1 | 2;
}

interface WireRequest {
  size: number;
  board: string;
  history: string[];
  consecutivePasses: number;
  elapsedRounds: number;
  komi: number;
  candidates: WireCandidate[];
}

function stringFlag(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function boardFromHash(size: number, hash: string): GoBoard {
  if (hash.length !== size * size) throw new Error(`invalid ${size}x${size} board hash`);
  return {
    size,
    rows: Array.from({ length: size }, (_, x) => hash.slice(x * size, (x + 1) * size)),
  };
}

function moveFromKey(key: string): KataGoMove {
  if (key === "pass") return "pass";
  const match = /^(\d+),(\d+)$/.exec(key);
  if (!match) throw new Error(`invalid move key ${key}`);
  return [Number(match[1]), Number(match[2])];
}

function moveKey(move: KataGoMove): string {
  return move === "pass" ? "pass" : `${move[0]},${move[1]}`;
}

function cleanError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/[\t\r\n]+/g, " ");
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield line;
    }
  }
  const tail = (buffered + decoder.decode()).trim();
  if (tail) yield tail;
}

async function main(): Promise<void> {
  const binary = stringFlag("--binary");
  const model = stringFlag("--model");
  const config = stringFlag("--config");
  const mode = stringFlag("--mode");
  if (mode !== "plain" && mode !== "predictive") throw new Error(`invalid mode ${mode}`);
  const visits = Math.max(2, Math.floor(numberFlag("--visits", 8)));
  const policyVisits = Math.max(2, Math.floor(numberFlag("--policy-visits", 2)));
  const candidateLimit = Math.max(1, Math.floor(numberFlag("--candidates", 6)));
  const kata = new KataGoAdvisor(binary, model, config);
  const predictive = mode === "predictive" ? new PredictiveKataGoAdvisor(kata) : undefined;
  try {
    for await (const line of lines(Bun.stdin.stream())) {
      try {
        const request = JSON.parse(line) as WireRequest;
        const board = boardFromHash(request.size, request.board);
        const history = request.history.map((hash) => boardFromHash(request.size, hash).rows);
        const byMove = new Map(request.candidates.map((candidate) => [candidate.move, candidate]));
        let selected: KataGoMove;
        let ranked: KataGoMove[];
        if (predictive) {
          const advice = await predictive.advise({
            board,
            previousBoards: history,
            consecutivePasses: request.consecutivePasses,
            elapsedRounds: request.elapsedRounds,
            komi: request.komi,
            policyVisits,
            replyVisits: visits,
            candidates: candidateLimit,
            predict: async (move) => {
              const candidate = byMove.get(moveKey(move));
              if (!candidate) throw new Error(`native request omitted ${moveKey(move)}`);
              return {
                move: moveFromKey(candidate.predictedWhite),
                after: boardFromHash(request.size, candidate.after),
                ...(candidate.exactScore ? { exactScore: candidate.exactScore } : {}),
                ...(candidate.exactRemainingRounds
                  ? { exactRemainingRounds: candidate.exactRemainingRounds } : {}),
              };
            },
          });
          selected = advice.move;
          ranked = advice.candidates.map((candidate) => candidate.move);
        } else {
          const shortlist = await kata.shortlist(
            board, history, request.komi, visits, candidateLimit,
            new Set(request.candidates.map((candidate) => candidate.move)),
          );
          if (!shortlist[0]) throw new Error("KataGo returned an empty shortlist");
          selected = shortlist[0].move;
          ranked = shortlist.map((candidate) => candidate.move);
        }
        console.log(`OK\t${moveKey(selected)}\t${ranked.map(moveKey).join(";")}`);
      } catch (cause) {
        console.log(`ERR\t${cleanError(cause)}`);
      }
    }
  } finally {
    await kata.close();
  }
}

if (import.meta.main) await main();
