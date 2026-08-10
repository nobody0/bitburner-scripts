import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum, fmtPct } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { GoMove } from "../../../shared/strategy/go/decide.ts";
import type { GoResponse, GoState } from "../../../shared/telemetry/topics/go.ts";
import type { Tab } from "./index.ts";

/** Go (IPvGO). Game coordinates are column-major, with y increasing upward. */

type PointColor = "black" | "white";

const POINT_CLASS: Record<string, string> = { X: "black", O: "white", ".": "empty", "#": "dead" };
const STONE_COLOR: Partial<Record<string, PointColor>> = { X: "black", O: "white" };
const DIRECTIONS = [
  { name: "north", dx: 0, dy: 1 },
  { name: "east", dx: 1, dy: 0 },
  { name: "south", dx: 0, dy: -1 },
  { name: "west", dx: -1, dy: 0 },
] as const;
const GO_COLUMNS = "ABCDEFGHJKLMNOPQRST";

function coordinate(x: number | null, y: number | null): string {
  return x === null || y === null ? "pass" : `${x},${y}`;
}

function predictions(move: GoMove): string {
  const replies = move.predictedReplies ?? [];
  const total = replies.reduce((sum, reply) => sum + reply.count, 0);
  if (!total) return "-";
  return replies
    .map((reply) => `${coordinate(reply.x, reply.y)} ${fmtNum(reply.count, 2)}/${fmtNum(total, 0)}`)
    .join("; ");
}

function pointAt(board: readonly string[], x: number, y: number): string {
  return board[x]?.[y] ?? "#";
}

/** Assign empty regions only when every bordering stone has one colour. This
 * mirrors the useful part of IPvGO's controlled-space presentation without
 * asking telemetry for another probe: it is derived from the exact board the
 * viewer already holds. */
function territoryOwners(board: readonly string[]): Map<string, PointColor> {
  const owners = new Map<string, PointColor>();
  const visited = new Set<string>();
  const size = board.length;

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const startKey = `${x}:${y}`;
      if (visited.has(startKey) || pointAt(board, x, y) !== ".") continue;

      const region: [number, number][] = [];
      const border = new Set<PointColor>();
      const queue: [number, number][] = [[x, y]];
      visited.add(startKey);

      for (let cursor = 0; cursor < queue.length; cursor++) {
        const [qx, qy] = queue[cursor]!;
        region.push([qx, qy]);
        for (const direction of DIRECTIONS) {
          const nx = qx + direction.dx;
          const ny = qy + direction.dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const neighbor = pointAt(board, nx, ny);
          const stone = STONE_COLOR[neighbor];
          if (stone) {
            border.add(stone);
            continue;
          }
          if (neighbor !== ".") continue;
          const key = `${nx}:${ny}`;
          if (visited.has(key)) continue;
          visited.add(key);
          queue.push([nx, ny]);
        }
      }

      if (border.size !== 1) continue;
      const owner = border.values().next().value;
      if (owner) for (const [rx, ry] of region) owners.set(`${rx}:${ry}`, owner);
    }
  }
  return owners;
}

function linkColor(
  board: readonly string[],
  owners: ReadonlyMap<string, PointColor>,
  x: number,
  y: number,
  dx: number,
  dy: number,
): PointColor | undefined {
  const size = board.length;
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= size || ny >= size) return undefined;

  const point = pointAt(board, x, y);
  const neighbor = pointAt(board, nx, ny);
  if (neighbor === "#") return undefined;
  const stone = STONE_COLOR[point];
  // A stone's network reaches allies and open liberties. The opposite half of
  // a contested empty node may use the other colour, as it does in the game.
  if (stone && (neighbor === point || neighbor === ".")) return stone;

  const owner = point === "." ? owners.get(`${x}:${y}`) : undefined;
  if (!owner) return undefined;
  const neighborOwner = STONE_COLOR[neighbor] ?? (neighbor === "." ? owners.get(`${nx}:${ny}`) : undefined);
  return neighborOwner === owner ? owner : undefined;
}

function gridMarkup(
  board: string[],
  chosen: { x: number; y: number } | undefined,
  actual: Extract<GoResponse, { type: "move" }> | undefined,
): string {
  const owners = territoryOwners(board);
  const cells = Array.from({ length: board.length }, (_, row) => board.length - 1 - row)
    .map((y) => board.map((column, x) => {
      const cell = column[y] ?? "#";
      const flags = [
        chosen?.x === x && chosen.y === y ? "chosen" : "",
        actual?.x === x && actual.y === y ? "reply" : "",
      ].filter(Boolean);
      const coordinateLabel = `${GO_COLUMNS[x] ?? x}${y + 1} (${x},${y})`;
      const pointLabel = cell === "X" ? "black stone" : cell === "O" ? "white stone" : cell === "." ? "empty node" : "no signal";
      const title = [coordinateLabel, pointLabel, flags.includes("chosen") ? "our selected move" : "", flags.includes("reply") ? "observed reply" : ""]
        .filter(Boolean)
        .join(" - ");
      const owner = cell === "." ? owners.get(`${x}:${y}`) : undefined;
      const links = DIRECTIONS.map((direction) => {
        const color = linkColor(board, owners, x, y, direction.dx, direction.dy);
        return color ? `<span class="go-link ${direction.name} ${color}" aria-hidden="true"></span>` : "";
      }).join("");
      const markers =
        (flags.includes("chosen") ? `<span class="go-marker chosen" aria-hidden="true"></span>` : "") +
        (flags.includes("reply") ? `<span class="go-marker reply" aria-hidden="true"></span>` : "");
      const classes = ["go-point", POINT_CLASS[cell] ?? "empty", owner ? `territory-${owner}` : "", ...flags]
        .filter(Boolean)
        .join(" ");
      return `<span class="${classes}" role="img" aria-label="${esc(title)}" title="${esc(title)}">${links}<span class="go-core" aria-hidden="true"></span>${markers}</span>`;
    }).join(""))
    .join("");
  return `<div class="goboard" role="group" aria-label="${board.length} by ${board.length} IPvGO board" style="grid-template-columns:repeat(${board.length},1fr)">${cells}</div>`;
}

function boardMarkup(g: GoState): string {
  if (!g.board?.length) return note("waiting for the board probe");
  const chosen = g.plan?.action.type === "move" ? g.plan.action : undefined;
  const response = g.lastTurn?.opponentResponse;
  const actual = response?.type === "move" ? response : undefined;
  const input = g.plan?.input.board;
  const comparison = input
    ? `<div class="gocompare"><div class="go-snapshot input"><h3>decision input</h3>${gridMarkup(input, chosen, undefined)}</div>` +
      `<div class="go-snapshot current"><h3>after turn</h3>${gridMarkup(g.board, chosen, actual)}</div></div>`
    : `<div class="go-snapshot current">${gridMarkup(g.board, chosen, actual)}</div>`;
  const legend = `<div class="barkey"><span class="go-mark chosen"></span>selected move` +
    `<span class="go-mark reply"></span>observed reply</div>`;
  const territory = g.territory
    ? note(`controlled empty nodes - black ${g.territory.black}, white ${g.territory.white}`)
    : "";
  return `${comparison}${legend}${territory}`;
}

function decisionMarkup(g: GoState): string {
  const plan = g.plan;
  if (!plan) return note("waiting for a Go decision");
  const action = plan.action.type === "move"
    ? `${plan.action.type} ${coordinate(plan.action.x, plan.action.y)}`
    : plan.action.type;
  const prediction = plan.prediction;
  const firstSeed = prediction?.seedCandidates[0];
  const lastSeed = prediction?.seedCandidates.at(-1);
  const seedDetail = prediction && firstSeed !== undefined
    ? `${prediction.model}; ${prediction.seedCandidates.length === 1 ? "exact seed " + (firstSeed / 1_000).toFixed(3) : prediction.seedCandidates.length + " reachable seeds " + (firstSeed / 1_000).toFixed(3) + "-" + (lastSeed! / 1_000).toFixed(3)} s on ${prediction.engineCycleMs} ms cycles; same-slot dispatch ${(prediction.dispatchPlaytime / 1_000).toFixed(3)} s; plan ${prediction.totalPlanningMs.toFixed(1)} ms (${prediction.preparationMs.toFixed(1)} prepare + ${prediction.finalizationMs.toFixed(1)} exact); ${prediction.boundaryRetries} boundary retries; AI cycle ${prediction.aiWaitMs} ms`
    : "no playtime sample available";
  const result = g.lastTurn;
  const response = result?.opponentResponse
    ? `${result.opponentResponse.type}${result.opponentResponse.type === "move" ? ` ${coordinate(result.opponentResponse.x, result.opponentResponse.y)}` : ""}`
    : "none";
  const support = result?.predictionSupport
    ? `${fmtNum(result.predictionSupport.matching, 2)}/${fmtNum(result.predictionSupport.total, 0)} expected seed support`
    : "not applicable";
  const timing = result?.timing;
  const timingDetail = timing
    ? `${timing.alignment}; dispatch ${timing.dispatchPlaytime === undefined ? "-" : (timing.dispatchPlaytime / 1_000).toFixed(3) + "s"}; seed ${timing.seed === undefined ? "-" : (timing.seed / 1_000).toFixed(3) + "s"}; full turn ${result!.durationMs.toFixed(0)} ms`
    : result ? `${result.durationMs.toFixed(0)} ms` : "waiting";
  return (
    tiles([
      { label: "selected", value: action, sub: plan.action.why },
      { label: "planner", value: `${plan.planning.finalistCount} finalists`, sub: `position ${fmtNum(plan.planning.positionValue, 2)}; history ${plan.input.previousBoards.length}` },
      { label: "actual reply", value: response, sub: timingDetail },
      { label: "forecast support", value: support, sub: seedDetail },
    ]) +
    note(`${plan.why}; next game ${plan.selection.preferred.opponent} ${plan.selection.preferred.observedBoardSize}x${plan.selection.preferred.observedBoardSize}`) +
    (result ? note(`${result.ok ? "completed" : "failed"}: ${result.detail}`) : "")
  );
}

function rankingMarkup(g: GoState): string {
  const ranked = g.plan?.ranked ?? [];
  return table(
    ["#", "move", "blended", "tactical", "forecast", "certainty", "take", "predicted reply", "reason"],
    ranked.map((move, index) => [
      String(index + 1),
      esc(coordinate(move.x, move.y)),
      fmtNum(move.score, 2),
      fmtNum(move.tacticalScore, 2),
      move.forecastScore === undefined ? "-" : fmtNum(move.forecastScore, 2),
      move.forecastCertainty ?? "-",
      String(move.captures),
      esc(predictions(move)),
      esc(move.why),
    ]),
    { empty: "no legal candidates for this decision", wrap: [7, 8] },
  );
}

function opponentMarkup(g: GoState): string {
  const candidates = g.plan?.selection.candidates ?? [];
  const context = g.plan?.selection.context;
  const evidence = context
    ? tiles([
        { label: "GoPower", value: `${fmtNum(context.goPower, 2)}x`, sub: context.hasSourceFile14 ? "SF14 effect doubled" : "base effect" },
        { label: "install runway", value: context.installRemainingSec === undefined ? "unknown" : `${fmtNum(context.installRemainingSec, 0)}s` },
        { label: "favor cap", value: fmtNum(context.favorRepCap, 0), sub: `${context.joinedFactions.length} joined factions` },
        { label: "ETA demands", value: String(Object.keys(context.demands).length) },
      ])
    : "";
  return evidence + table(
    ["opponent", "board", "win", "streak", "horizon", "node power", "transient saved", "favor event", "favor gain", "favor saved", "saved/min", "reason"],
    candidates.map((candidate) => [
      esc(candidate.opponent),
      `${candidate.observedBoardSize}x${candidate.observedBoardSize}`,
      fmtPct(candidate.winProbability),
      String(candidate.currentWinStreak),
      `${candidate.planningGames} games / ${fmtNum(candidate.planningGames * candidate.expectedGameSec, 0)}s`,
      `${fmtNum(candidate.expectedNodePower, 1)} now / ${fmtNum(candidate.horizonNodePower, 1)} horizon`,
      `${fmtNum(candidate.transientSecSaved, 1)}s now / ${fmtNum(candidate.horizonTransientSecSaved, 1)}s horizon`,
      fmtPct(candidate.favorEventProbability),
      fmtNum(candidate.expectedFavorGain, 2),
      `${fmtNum(candidate.favorSecSaved, 1)}s now / ${fmtNum(candidate.horizonFavorSecSaved, 1)}s horizon`,
      `${fmtNum(candidate.utilityPerSec * 60, 2)}s`,
      esc(candidate.why),
    ]),
    { empty: "waiting for ETA-valued game candidates", wrap: [11] },
  );
}

export const goTab: Tab = {
  id: "go",
  render(state: ProjectedState) {
    const g = state.topics.go;
    if (!g) return note("waiting for the Go probe");

    const summary = tiles([
      { label: "opponent", value: g.opponent ?? "waiting" },
      { label: "status", value: g.status ?? "waiting" },
      { label: "to move", value: g.currentPlayer ?? "waiting" },
      { label: "black", value: fmtNum(g.blackScore, 1) },
      { label: "white", value: fmtNum(g.whiteScore, 1), sub: g.komi === undefined ? undefined : `komi ${fmtNum(g.komi, 1)}` },
      ...(g.boardSize ? [{ label: "board", value: `${g.boardSize}x${g.boardSize}` }] : []),
      ...(g.moveCount !== undefined ? [{ label: "positions", value: String(g.moveCount) }] : []),
      ...(g.bonusCycles !== undefined ? [{ label: "bonus cycles", value: fmtNum(g.bonusCycles, 0) }] : []),
    ]);

    const opponentStats = g.stats ?? [];
    const stats = opponentStats.length
      ? table(
          ["opponent", "W", "L", "streak", "best", "rep", "bonus"],
          opponentStats.slice().sort((a, b) => b.wins - a.wins).map((s) => [
            esc(s.opponent),
            String(s.wins),
            String(s.losses),
            String(s.winStreak),
            String(s.highestWinStreak),
            fmtNum(s.rep, 0),
            `${fmtPct(s.bonusPercent / 100)} ${esc(s.bonusDescription)}`,
          ]),
        )
      : note("no games played yet");

    return (
      `<div class="col">` +
      card("Subnet", summary + boardMarkup(g)) +
      card("Latest turn", decisionMarkup(g)) +
      `</div>` +
      `<div class="col go-analysis">` +
      card("Candidate analysis", rankingMarkup(g)) +
      card("Opponent reward choice", opponentMarkup(g)) +
      card("Record", stats) +
      `</div>`
    );
  },
};
