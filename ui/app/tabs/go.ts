import { NONE, card, note, table, tiles, waiting } from "../lib/dom.ts";
import { esc, fmtMs, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import { territoryOwners } from "../../../shared/strategy/go/rules.ts";
import type { GoDispatchBreakdown } from "../../../shared/strategy/go/tick.ts";
import type { GoActionDigest, GoMoveDigest, GoResponse, GoState } from "../../../shared/telemetry/topics/go.ts";
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

function predictions(move: GoMoveDigest): string {
  const replies = move.predictedReplies ?? [];
  const total = replies.reduce((sum, reply) => sum + reply.count, 0);
  if (!total) return NONE;
  return replies
    .map((reply) => `${coordinate(reply.x, reply.y)} ${fmtNum(reply.count, 2)}/${fmtNum(total, 0)}`)
    .join("; ");
}

function pointAt(board: readonly string[], x: number, y: number): string {
  return board[x]?.[y] ?? "#";
}

/** Controlled empty space, from the same routine that produces the territory
 * counts telemetry publishes. Shading and caption cannot disagree. */
function ownersOf(board: readonly string[]): ReadonlyMap<string, PointColor> {
  const owners = new Map<string, PointColor>();
  for (const [key, stone] of territoryOwners({ rows: [...board], size: board.length })) {
    const colour = STONE_COLOR[stone];
    if (colour) owners.set(key, colour);
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

  const owner = point === "." ? owners.get(`${x},${y}`) : undefined;
  if (!owner) return undefined;
  const neighborOwner = STONE_COLOR[neighbor] ?? (neighbor === "." ? owners.get(`${nx},${ny}`) : undefined);
  return neighborOwner === owner ? owner : undefined;
}

function gridMarkup(
  board: string[],
  chosen: { x: number; y: number } | undefined,
  actual: Extract<GoResponse, { type: "move" }> | undefined,
): string {
  const owners = ownersOf(board);
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
        .join(" — ");
      const owner = cell === "." ? owners.get(`${x},${y}`) : undefined;
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

/** One board: the live position, with our selected move and the observed
 * reply marked on it. A second grid of the pre-move position would differ by
 * exactly those two stones, so it reads as an accidental duplicate. */
function boardMarkup(g: GoState): string {
  if (!g.board?.length) return waiting("the board probe");
  const chosen = g.plan?.action.type === "move" ? g.plan.action : undefined;
  const response = g.lastTurn?.opponentResponse;
  const actual = response?.type === "move" ? response : undefined;
  const legend = `<div class="barkey"><span class="go-mark chosen"></span>selected move` +
    `<span class="go-mark reply"></span>observed reply</div>`;
  const territory = g.territory
    ? note(`controlled empty nodes — black ${g.territory.black}, white ${g.territory.white}`)
    : "";
  return `<div class="go-snapshot">${gridMarkup(g.board, chosen, actual)}</div>${legend}${territory}`;
}

function describeAction(action: GoActionDigest): string {
  switch (action.type) {
    case "move":
      return `move ${coordinate(action.x, action.y)}`;
    case "cheatTwoMoves":
      return `cheat two moves ${action.x1},${action.y1} + ${action.x2},${action.y2}`;
    case "cheatRemoveRouter":
      return `cheat remove router ${coordinate(action.x, action.y)}`;
    case "cheatDestroyNode":
      return `cheat destroy node ${coordinate(action.x, action.y)}`;
    case "cheatRepairNode":
      return `cheat repair node ${coordinate(action.x, action.y)}`;
    case "newGame":
      return `new game ${action.opponent} ${action.boardSize}x${action.boardSize}`;
    default:
      return action.type;
  }
}

/** Disjoint, ordered segments, so reading them in order shows where the turn
 * went. `align` is time we chose to spend landing on the intended engine tick;
 * every other segment is cost we would rather not pay, which is the whole
 * reason the total alone is not enough — and why the slowest call-out skips
 * it rather than blaming the one segment working as intended. */
function breakdownMarkup(breakdown: GoDispatchBreakdown): string {
  const segments: [label: string, ms: number][] = [
    ["admit", breakdown.admitMs],
    ["plan", breakdown.prepareMs],
    ["lease", breakdown.leaseMs],
    ["exact", breakdown.finalizeMs],
    ["align", breakdown.alignMs],
    ["dispatch", breakdown.dispatchMs],
    ["other", breakdown.residualMs],
  ];
  const [worstLabel, worstMs] = segments
    .filter(([label]) => label !== "align")
    .reduce((slowest, segment) => (segment[1] > slowest[1] ? segment : slowest));
  const rendered = segments
    .map(([label, ms]) => `${label} ${fmtMs(ms)}${label === "align" ? " (deliberate)" : ""}`)
    .join(" · ");
  return `${rendered}${worstMs > 0 ? ` — slowest ${worstLabel}` : ""}`;
}

function decisionMarkup(g: GoState, reference: number): string {
  const plan = g.plan;
  if (!plan) return waiting("a Go decision");
  const result = g.lastTurn;
  // The digest belongs to the completed turn. Go replaces the plan object on
  // the microtask that starts the next one, so a copy parked there would
  // rarely survive long enough to be read.
  const prediction = result?.prediction;
  // Ages earn their space only once something has stalled; at roughly a turn a
  // second they would otherwise read "0s ago" forever.
  const staleAge = (at: number): string | undefined =>
    reference - at >= 5_000 ? fmtTime(reference - at) : undefined;
  const planAge = staleAge(plan.input.at);
  const turnAge = result ? staleAge(result.at) : undefined;
  const firstSeed = prediction?.seedCandidates[0];
  const lastSeed = prediction?.seedCandidates.at(-1);
  const seedRange = prediction && firstSeed !== undefined
    ? prediction.seedCandidates.length === 1
      ? `exact seed ${(firstSeed / 1_000).toFixed(3)}s`
      : `${prediction.seedCandidates.length} reachable seeds ${(firstSeed / 1_000).toFixed(3)}-${((lastSeed ?? firstSeed) / 1_000).toFixed(3)}s`
    : undefined;
  const response = result?.opponentResponse
    ? `${result.opponentResponse.type}${result.opponentResponse.type === "move" ? ` ${coordinate(result.opponentResponse.x, result.opponentResponse.y)}` : ""}`
    : result
      ? "no reply"
      : "none";
  const support = result?.predictionSupport
    ? `${fmtNum(result.predictionSupport.matching, 2)}/${fmtNum(result.predictionSupport.total, 0)}`
    : "not applicable";
  const selectedAction = plan.action.type === "move" ? plan.action : undefined;
  const selectedMove = selectedAction
    ? plan.ranked.find((move) => move.x === selectedAction.x && move.y === selectedAction.y)
    : undefined;
  // Only a seed-assured turn has an alignment to report. A reset, a resume or
  // the unseeded fallback has none, and showing its bare duration under
  // "actual reply" invited reading engine latency into what is neither.
  const timingDetail = !result
    ? "waiting"
    : prediction
      ? `${prediction.boundaryRetries ? "boundary-replan" : "same-slot"}; full turn ${fmtMs(result.durationMs)}`
      : `${describeAction(result.action)} took ${fmtMs(result.durationMs)}`;
  const breakdown = prediction?.dispatchBreakdown;
  const latencyTile = breakdown
    ? { label: "ready to play", value: fmtMs(breakdown.totalMs), sub: breakdownMarkup(breakdown) }
    : { label: "ready to play", value: "pending", sub: "no preceding turn boundary to time from" };
  const source = prediction?.playbook ? "certified playbook" : "neural";
  const cacheDetail = prediction
    ? [
      prediction.pushedPredictionHit ? "pushed hit" : "foreground",
      prediction.positionCacheHit ? "position cached" : "position prepared",
      prediction.seedCacheHit ? "seeds cached" : "seeds evaluated",
    ].join(" · ")
    : undefined;
  const modelNote = prediction
    ? note(
      `${source} — ${prediction.model}`
      + `${prediction.modelProfile ? ` ${prediction.modelProfile}` : ""}`
      + `${prediction.backend ? ` on ${prediction.backend}` : ""}`
      + `${seedRange ? `; ${seedRange}` : ""}`
      + `; dispatch tick ${(prediction.dispatchPlaytime / 1_000).toFixed(3)}s`
      + `${cacheDetail ? `; ${cacheDetail}` : ""}`
      + `${prediction.boundaryRetries ? `; ${prediction.boundaryRetries} boundary retries` : ""}`,
    )
    : "";
  // Worker cost, kept apart from the engine constants below it so a fixed
  // game parameter is never read as something we measured.
  const workerNote = prediction
    ? note(
      `worker — ${prediction.preparationMs === undefined
        ? "preparation cached"
        : `${fmtMs(prediction.preparationMs)} preparation`}`
      + `; ${fmtMs(prediction.finalizationMs)} evaluation`
      + `${prediction.pushedPredictionHit ? " (measured when pushed, not on this turn)" : ""}`
      + `${prediction.rolloverMarginMs === undefined ? "" : `; ${fmtMs(prediction.rolloverMarginMs)} cycle headroom`}`
      + `${prediction.waitedForRollover ? "; waited for the next cycle" : ""}`,
    )
    : "";
  const constantsNote = prediction
    ? note(`engine constants — ${prediction.engineCycleMs} ms cycle, ${prediction.aiWaitMs} ms AI wait`)
    : "";
  const paddedNote = prediction?.paddedToExtent !== undefined
    ? note(
      `out of distribution: rated by weights trained at `
      + `${prediction.paddedToExtent}x${prediction.paddedToExtent}, padded from this board`,
    )
    : "";
  return (
    tiles([
      {
        label: "selected",
        value: describeAction(plan.action),
        sub: selectedMove ? `win ${fmtPct(selectedMove.score)} · ${selectedMove.captures} capture(s)` : undefined,
      },
      {
        label: "planner",
        value: `${plan.planning.finalistCount} finalists`,
        // A plan that keeps refreshing while the turn record does not is the
        // signature of a dispatch that cannot get admitted, so both ages show.
        sub: `position win ${fmtPct(plan.planning.positionValue)}; history ${plan.input.previousBoards.length}`
          + (planAge ? `; computed ${planAge} ago` : ""),
      },
      { label: "actual reply", value: response, sub: timingDetail },
      latencyTile,
      { label: "forecast support", value: support, sub: "forecast weight on the reply that arrived" },
    ]) +
    modelNote +
    workerNote +
    constantsNote +
    paddedNote +
    note(`next game ${plan.selection.preferred.opponent} ${plan.selection.preferred.observedBoardSize}x${plan.selection.preferred.observedBoardSize}; ${fmtNum(plan.selection.preferred.utilityPerSec * 60, 2)} seconds saved/minute`) +
    (result
      ? note(`${result.ok ? "completed" : "failed"}${turnAge ? ` ${turnAge} ago` : ""}: ${result.detail}`)
      : "")
  );
}

function rankingMarkup(g: GoState): string {
  const ranked = g.plan?.ranked ?? [];
  return table(
    ["#", "move", "win", "power/round", "certainty", "take", "predicted reply"],
    ranked.map((move, index) => [
      String(index + 1),
      esc(coordinate(move.x, move.y)),
      fmtPct(move.score),
      fmtNum(move.powerPerRound, 2),
      move.forecastCertainty ?? NONE,
      String(move.captures),
      esc(predictions(move)),
    ]),
    { empty: "no legal candidates for this decision", wrap: [6] },
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
        {
          label: "opponents with ETA demand",
          value: String(Object.keys(context.demands).length),
          sub: `of ${candidates.length} candidates`,
        },
      ])
    : "";
  const schedule = g.plan?.selection.schedule;
  const scheduleNote = schedule && schedule.kind !== "play"
    ? note(`schedule: ${schedule.kind}${schedule.kind === "filler" && schedule.fillerOpponent ? ` (${schedule.fillerOpponent})` : ""}${schedule.kind === "hold" && schedule.holdSec !== undefined ? ` ${fmtNum(schedule.holdSec, 0)}s` : ""} — ${schedule.why}`)
    : "";
  return evidence + scheduleNote + table(
    ["opponent", "board", "wait", "win", "streak", "horizon", "node power", "transient saved", "favor event", "favor gain", "favor saved", "saved/min"],
    candidates.map((candidate) => [
      esc(candidate.opponent),
      `${candidate.observedBoardSize}x${candidate.observedBoardSize}`,
      candidate.aligned ? `${fmtNum(candidate.waitSec, 0)}s aligned` : "now",
      fmtPct(candidate.winProbability),
      String(candidate.currentWinStreak),
      `${candidate.planningGames} games / ${fmtNum(candidate.planningGames * candidate.expectedGameSec, 0)}s`,
      `${fmtNum(candidate.expectedNodePower, 1)} now / ${fmtNum(candidate.horizonNodePower, 1)} horizon`,
      `${fmtNum(candidate.transientSecSaved, 1)}s now / ${fmtNum(candidate.horizonTransientSecSaved, 1)}s horizon`,
      fmtPct(candidate.favorEventProbability),
      fmtNum(candidate.expectedFavorGain, 2),
      `${fmtNum(candidate.favorSecSaved, 1)}s now / ${fmtNum(candidate.horizonFavorSecSaved, 1)}s horizon`,
      `${fmtNum(candidate.utilityPerSec * 60, 2)}s`,
    ]),
    { empty: "waiting for ETA-valued game candidates" },
  );
}

export const goTab: Tab = {
  id: "go",
  render(state: ProjectedState) {
    const g = state.topics.go;
    if (!g) return waiting("the Go probe");

    const summary = tiles([
      { label: "opponent", value: g.opponent ?? "waiting" },
      { label: "status", value: g.status ?? "waiting" },
      { label: "to move", value: g.currentPlayer ?? "waiting" },
      { label: "black", value: fmtNum(g.blackScore, 1) },
      { label: "white", value: fmtNum(g.whiteScore, 1), sub: g.komi === undefined ? undefined : `komi ${fmtNum(g.komi, 1)}` },
      ...(g.boardSize ? [{ label: "board", value: `${g.boardSize}x${g.boardSize}` }] : []),
      ...(g.moveCount !== undefined ? [{ label: "positions", value: String(g.moveCount) }] : []),
      ...(g.bonusCycles !== undefined ? [{ label: "bonus cycles", value: fmtNum(g.bonusCycles, 0) }] : []),
      ...(g.cheat?.unlocked
        ? [{
          label: "cheats used",
          value: String(g.cheat.count),
          sub: `next succeeds ${fmtPct(g.cheat.successChance)}`,
        }]
        : []),
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
      `<div class="col wide">` +
      card("Opponent reward choice", opponentMarkup(g)) +
      card("Record", stats) +
      card("Candidate analysis", rankingMarkup(g)) +
      `</div>` +
      `<div class="col">` +
      card("Subnet", summary + boardMarkup(g)) +
      card("Latest turn", decisionMarkup(g, state.lastT || Date.now())) +
      `</div>`
    );
  },
};
