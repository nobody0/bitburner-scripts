import { nowFor } from "../lib/clock.ts";
import { NONE, card, note, rankedTable, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtMs, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import { territoryOwners } from "../../../shared/strategy/go/rules.ts";
import type { GoGameCandidate } from "../../../shared/strategy/go/rewards.ts";
import type { GoDispatchBreakdown } from "../../../shared/strategy/go/tick.ts";
import type { GoActionDigest, GoResponse, GoState } from "../../../shared/telemetry/topics/go.ts";
import type { GoMove } from "../../../shared/strategy/go/rules.ts";
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
  // Keep rendering the board rather than falling back to `waiting`: the rows are
  // the last position we believed in, and blanking them hides the very state the
  // reader needs to see.
  const trust = g.boardUnverified
    ? note("board unverified — the last turn's outcome was not confirmed; re-reading the game board before the next move")
    : "";
  return `${trust}<div class="go-snapshot">${gridMarkup(g.board, chosen, actual)}</div>${legend}${territory}`;
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
  //
  // That microtask is also why the played action is read from `result.action`
  // and never from `plan.action`: for the whole dispatch window `plan` is the
  // move being sent (or, briefly, the one just sent) while `lastTurn` answers
  // the PREVIOUS move, so a tile labelled "selected" beside "actual reply"
  // invited reading White's reply as the answer to a move that had not landed.
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
  // the unseeded fallback has none, so it says so and gives the duration
  // alone; reading engine latency into a turn that never aligned is wrong.
  // The action is not repeated here — the tile's value already carries it.
  const timingDetail = !result
    ? "waiting"
    : prediction
      ? `${prediction.boundaryRetries ? "boundary-replan" : "same-slot"}; full turn ${fmtMs(result.durationMs)}`
      : `unseeded; took ${fmtMs(result.durationMs)}`;
  // The verification runs between turns, so its cost lands in the NEXT turn's
  // admit segment. Publishing it here is the only thing that explains that.
  const verify = result?.boardVerify;
  // A persistence note cannot use the sub-5s suppression above, which returns
  // nothing: here "recent" and "unknown" have to read differently.
  const since = (at: number): string => {
    const age = staleAge(at);
    return age ? `${age} ago` : "just now";
  };
  // Survives the unverified flag clearing, so a corrected desync stays visible
  // instead of healing silently. Which is exactly why each counter carries its
  // own age: both are monotonic and never cleared, so without one the note read
  // identically for a resync on this turn and one hundreds of turns ago.
  //
  // Built with html`` rather than a concatenated string: `note` is a TEXT slot
  // and escapes what it is given, so the esc() this replaced escaped the reason
  // twice and printed `&amp;quot;` at the operator — and the reason is a game
  // error string (`turn refused: ${detail}`), the one input here that can carry
  // a quote or an ampersand.
  const resyncNote = g.boardResyncs
    ? note(html`board resynced ${g.boardResyncs}x${
      g.lastBoardResyncAt ? `, last ${since(g.lastBoardResyncAt)}` : ""}${
      g.boardDrifts ? ` (${g.boardDrifts} verified drift${
        g.lastBoardDriftAt ? `, ${since(g.lastBoardDriftAt)}` : ""})` : ""}${
      g.lastBoardResyncReason ? `: ${g.lastBoardResyncReason}` : ""}`)
    : "";
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
        // "planned", not "next move": between the turn merge and the re-plan
        // this is the move that was just played, and after it the one being
        // dispatched — never reliably the next one.
        label: "planned",
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
      result
        ? { label: "played", value: describeAction(result.action), sub: `reply ${response}; ${timingDetail}` }
        : { label: "played", value: "waiting", sub: "no turn has landed yet" },
      latencyTile,
      { label: "forecast support", value: support, sub: "forecast weight on the reply that arrived" },
    ]) +
    modelNote +
    workerNote +
    constantsNote +
    paddedNote +
    note(`next game ${plan.selection.preferred.opponent} ${plan.selection.preferred.observedBoardSize}x${plan.selection.preferred.observedBoardSize}; ${fmtNum(plan.selection.preferred.utilityPerSec * 60, 2)} seconds saved/minute`) +
    (result
      ? note(`${result.ok ? "completed" : "failed"}${turnAge ? ` ${turnAge} ago` : ""}: ${result.detail}`
        + (verify ? `; board ${verify.result}${verify.ms ? ` in ${fmtMs(verify.ms)}` : ""}` : ""))
      : "") +
    resyncNote
  );
}

/** The bounded search ranking, with the dispatched action marked.
 *
 * Row 1 is the network's top move, which is not always the move that was
 * sent: a certified-playbook dispatch overrides the action and keeps this
 * ranking, so the marker is the only thing in the card that says which option
 * was acted on. When the action is absent from the ranking the caption says
 * exactly that and no more — `GoPlan` carries no playbook flag, and the flag
 * that exists belongs to the COMPLETED turn, so naming the playbook as the
 * cause would attribute turn N's override to turn N+1's ranking. */
function rankingMarkup(g: GoState): string {
  const ranked = g.plan?.ranked ?? [];
  const action = g.plan?.action;
  const selectedAction = action?.type === "move" ? action : undefined;
  const selected = (index: number): boolean => {
    const move = ranked[index];
    return move !== undefined && move.x === selectedAction?.x && move.y === selectedAction?.y;
  };
  // A pass, a resume, a new game or a cheat is absent structurally — the
  // ranking holds moves only — so that case is worded as a fact about the
  // table rather than as an override.
  const unmarked = ranked.length > 0 && action !== undefined && !ranked.some((_, index) => selected(index))
    ? selectedAction
      ? note(`selected ${describeAction(action)} is not in this ranking`)
      : note(`${describeAction(action)} was dispatched; this ranking lists moves only`)
    : "";
  return rankedTable(
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
    { selected, empty: "no legal candidates for this decision", wrap: [6] },
  ) + unmarked;
}

/** The demand a candidate is priced against, and why the saving beside it is
 * so much smaller.
 *
 * `GoEtaDemand.seconds` is UNSHARED and UNCLIPPED by contract: the ranking
 * clips it against the install runway left after the alignment wait, and only
 * then applies `share` and the relative multiplier gain. Printing the seconds
 * and the share alone put "6000s x 12%" beside a transient saving of 9s with
 * nothing on the panel bridging them, so the cell now names the clip and the
 * multiplier transition the gain comes from.
 *
 * It deliberately does NOT recompute the saving. Both clamps live in
 * `demandGain` (shared/strategy/go/rewards.ts) and a copy here would drift
 * from the ranker; the product is already published as the "transient saved"
 * column — whose horizon half is priced over the bounded continuation tree
 * and does not decompose this way at all. */
function demandCell(candidate: GoGameCandidate, installRemainingSec: number | undefined): string {
  const demand = candidate.transientDemand;
  if (!demand) return `<span class="dim">none</span>`;
  const runway = installRemainingSec === undefined
    ? undefined
    : Math.max(0, installRemainingSec - candidate.waitSec);
  // Never 0s for a missing runway: the forecast is optional on the wire, and a
  // zero would read as "this reward has run out of time" rather than as "we do
  // not know how much time is left".
  const clip = runway === undefined
    ? " (runway unknown)"
    : runway < demand.seconds
      ? ` clipped to ${fmtNum(runway, 0)}s`
      : "";
  const cap = demand.gainCap === undefined ? "" : ` cap ${fmtPct(demand.gainCap)}`;
  const tip = "unclipped bottleneck seconds; the ranking prices"
    + " min(seconds, install runway - alignment wait) x share x the capped multiplier gain,"
    + " and publishes the product as the transient saved column";
  return `<span title="${esc(tip)}">`
    + esc(`${fmtNum(demand.seconds, 0)}s${clip} x ${fmtPct(demand.share)}${cap}`
      + ` x mult ${fmtNum(candidate.multiplierBefore, 3)}→${fmtNum(candidate.multiplierAfter, 3)}`)
    + `</span>`;
}

function incomeShareSummary(shares: Record<string, number> | undefined): string | undefined {
  const ranked = Object.entries(shares ?? {})
    .filter(([, share]) => share > 0)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return undefined;
  // Unescaped on purpose: the only consumer is a tile value, a TEXT slot that
  // escapes for us. An esc() here would print `&amp;` at the operator.
  return ranked.map(([source, share]) => `${source} ${fmtPct(share)}`).join(" · ");
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
        {
          label: "income shares",
          value: incomeShareSummary(context.incomeShares) ?? "unmeasured",
          sub: "what each producer earns, and so how much of a money bottleneck its reward may claim",
        },
      ])
    : "";
  const schedule = g.plan?.selection.schedule;
  const scheduleNote = schedule && schedule.kind !== "play"
    ? note(`schedule: ${schedule.kind}${schedule.kind === "filler" && schedule.fillerOpponent ? ` (${schedule.fillerOpponent})` : ""}${schedule.kind === "hold" && schedule.holdSec !== undefined ? ` ${fmtNum(schedule.holdSec, 0)}s` : ""}`)
    : "";
  // Only worth the line when it REFUSES: a passing gate is the ordinary case
  // and says nothing a reader needs, while a refusal is the whole explanation
  // for a Go that has stopped starting games.
  const ramGate = g.plan?.selection.ramGate;
  const ramNote = ramGate && !ramGate.pays
    ? note(`no new game: ${ramGate.opponent} at ${fmtNum(ramGate.utilityPerSec * 60, 2)}s saved/min against ${fmtNum(ramGate.displacedGb, 1)} GB displaced of ${fmtNum(ramGate.usableGb, 0)} GB usable`)
    : "";
  // Rank order is the saving rate, which is not always the game we will start:
  // a filler schedule deliberately prefers a shorter game that fits inside the
  // leader's certified entry window. Records arrive as JSON, so the chosen row
  // is found by the tuple `rankGoGames` keys on — object identity can never
  // match across the wire.
  const preferred = g.plan?.selection.preferred;
  const isPreferred = (index: number): boolean => {
    const candidate = candidates[index];
    return candidate !== undefined && preferred !== undefined
      && candidate.opponent === preferred.opponent
      && candidate.boardSize === preferred.boardSize
      && candidate.aligned === preferred.aligned;
  };
  return evidence + scheduleNote + ramNote + rankedTable(
    ["opponent", "board", "wait", "win", "streak", "horizon", "node power", "demand", "transient saved", "favor event", "favor gain", "favor saved", "saved/min"],
    candidates.map((candidate) => [
      esc(candidate.opponent),
      `${candidate.observedBoardSize}x${candidate.observedBoardSize}`,
      candidate.aligned ? `${fmtNum(candidate.waitSec, 0)}s aligned` : "now",
      fmtPct(candidate.winProbability),
      String(candidate.currentWinStreak),
      `${candidate.planningGames} games / ${fmtNum(candidate.planningGames * candidate.expectedGameSec, 0)}s`,
      // The one column with no visible derivation. Every term is on the wire,
      // so the tooltip names them instead of leaving the number unexplained; a
      // cell is a RAW slot, so the attribute is escaped here.
      `<span title="${esc(`${fmtNum(candidate.expectedBlackScore, 1)} expected score × ${fmtNum(candidate.difficultyMultiplier, 2)} difficulty`
        + ` → win ${fmtNum(candidate.powerIfWin, 1)} / loss ${fmtNum(candidate.powerIfLoss, 1)} at ${fmtPct(candidate.winProbability)}`)}">`
        + `${fmtNum(candidate.expectedNodePower, 1)} now / ${fmtNum(candidate.horizonNodePower, 1)} horizon</span>`,
      demandCell(candidate, context?.installRemainingSec),
      `${fmtNum(candidate.transientSecSaved, 1)}s now / ${fmtNum(candidate.horizonTransientSecSaved, 1)}s horizon`,
      fmtPct(candidate.favorEventProbability),
      fmtNum(candidate.expectedFavorGain, 2),
      `${fmtNum(candidate.favorSecSaved, 1)}s now / ${fmtNum(candidate.horizonFavorSecSaved, 1)}s horizon`,
      `${fmtNum(candidate.utilityPerSec * 60, 2)}s`,
    ]),
    { selected: isPreferred, empty: "waiting for ETA-valued game candidates" },
  );
}

export const goTab: Tab = {
  id: "go",
  render(state: ProjectedState) {
    const g = state.topics.go;
    if (!g) return waitingPanel("Go", "the Go probe");

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
      card("Latest turn", decisionMarkup(g, nowFor(state))) +
      `</div>`
    );
  },
};
