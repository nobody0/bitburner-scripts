import {
  ahead,
  decideLab,
  emptyField,
  emptyMaze,
  LAB_FIRST_PROBE,
  LAB_TUNING,
  labPrior,
  markBlocked,
  observeLab,
  readSurroundings,
  refuseEdge,
  routePrior,
  stepMaze,
  type Cell,
  type Direction,
  type LabField,
  type LabPrior,
  type LabRouteBias,
  type LabTuning,
  type MazeKnowledge,
} from "../shared/strategy/dnet/maze.ts";
import { expForSkill, skillFromExp } from "../shared/formulas.ts";
import { LAB_LADDER, type LabStage } from "../shared/strategy/dnet/rates.ts";
import { mulberry32 } from "./core/rng.ts";
import { generateMaze, MAZE_PATH, surroundingsVisualized } from "./features/dnet-maze.ts";

/**
 * Lab-only route arena.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/labyrinth.ts:112-215,236-382
 *   src/DarkNet/effects/effects.ts:60-89,113-120
 *   src/NetscriptFunctions/Darknet.ts:93-177,637-703
 */

/** A labyrinth with everything outside the minigame deliberately removed.
 *
 * `seed` drives the same random DFS maze generation and, on the deep labs, the
 * same independent 0/2/4 offsets for the endpoint and start. A route sees none
 * of these fields; they are held by the arena and used only to answer actions.
 */
export interface LabCase {
  id: string;
  stage: LabStage;
  maze: readonly string[];
  start: Cell;
  exit: Cell;
}

const offset = (random: () => number, enabled: boolean): Cell => enabled
  ? [Math.floor(random() * 3) * 2, Math.floor(random() * 3) * 2]
  : [0, 0];

export function generateLabCase(stage: LabStage, seed: number): LabCase {
  const random = mulberry32(seed);
  const maze = generateMaze(stage.mazeWidth, stage.mazeHeight, random);
  const [exitX, exitY] = offset(random, stage.offsetStartAndEnd);
  const [startX, startY] = offset(random, stage.offsetStartAndEnd);
  return {
    id: `${stage.hostname}:${seed}`,
    stage,
    maze,
    start: [1 + startX, 1 + startY],
    exit: [maze[0]!.length - 2 - exitX, maze.length - 2 - exitY],
  };
}

export function generateLabCorpus(
  seeds: Iterable<number>,
  stages: readonly LabStage[] = LAB_LADDER,
): LabCase[] {
  const heldSeeds = [...seeds];
  // Equal-sized late rungs are separate mazes in game. Mix the rung into each
  // corpus seed so they do not become five copies of one 60x40 observation.
  return stages.flatMap((stage, stageIndex) => heldSeeds.map((seed) =>
    generateLabCase(stage, (seed ^ Math.imul(stageIndex + 1, 0x9e37_79b1)) >>> 0)));
}

/** What `authenticate(lab, direction)` reveals after an unsuccessful attempt.
 * The exit is deliberately absent: upstream renders it only for `labradar()`.
 */
export interface LabMoveObservation {
  kind: "move";
  at: Cell;
  surroundings: string;
  moved: boolean;
}

export interface LabRadarObservation {
  kind: "radar";
  /** Radius 3, player and exit shown. The API does not return coordinates. */
  surroundings: string;
}

export interface LabReportObservation {
  kind: "report";
  at: Cell;
  open: Record<Direction, boolean>;
}

export type LabObservation = LabMoveObservation | LabRadarObservation | LabReportObservation;

export type LabDecision =
  | { kind: "move"; direction: Direction }
  | { kind: "radar" }
  | { kind: "report" }
  | { kind: "stop"; reason: string };

/** A route is stateful because the real walk is stateful and PID-bound. It gets
 * the real maze dimensions and the public stage facts — exactly what `walkJob`
 * reads out of `labStage` — but never the maze, start, or endpoint. */
export interface LabRoute {
  name: string;
  start(context: { width: number; height: number; stage: LabStage }): {
    next(last?: LabObservation): LabDecision;
  };
}

/** Adapter for the route deployed by `game/dnet/jobs.ts`.
 *
 * The first direction is blind. Every later decision is the production
 * corner-biased DFS, including its handling of a rendered-open move that the
 * engine refuses at an out-of-bounds edge.
 */
export function biasedDfsRoute(firstDirection: Direction = "north"): LabRoute {
  return {
    name: `biased-dfs:${firstDirection}`,
    start: (bounds) => {
      let known: MazeKnowledge = emptyMaze();
      let at: Cell | undefined;
      let pending: { from?: Cell; direction: Direction; known: MazeKnowledge } | undefined;
      return {
        next: (last) => {
          if (last !== undefined) {
            if (last.kind !== "move") return { kind: "stop", reason: `biased DFS cannot read a ${last.kind} response` };
            if (!pending) return { kind: "stop", reason: "an observation arrived without a pending move" };
            if (pending.from !== undefined && !last.moved) {
              // Match walkJob: a refused move did not earn the proposed trail
              // entry, but its edge must be remembered as blocked.
              known = markBlocked({ ...pending.known, trail: known.trail }, pending.from, pending.direction);
            } else {
              known = pending.known;
            }
            at = last.at;
          }

          if (at === undefined) {
            pending = { direction: firstDirection, known };
            return { kind: "move", direction: firstDirection };
          }

          const step = stepMaze(known, at, last?.surroundings ?? "", bounds);
          if (step.kind !== "go") return { kind: "stop", reason: step.reason };
          pending = { from: at, direction: step.direction, known: step.known };
          return { kind: "move", direction: step.direction };
        },
      };
    },
  };
}

/** Adapter for the planning walker in `shared/strategy/dnet/maze.ts`, wired
 * exactly the way `walkJob` drives it: observe every response's render, mark a
 * refused edge, then ask `decideLab` for the next paid action. The first move
 * is a blind probe — the position is unknown until the first response — and it
 * probes TOWARD the exit's corner, where the DFS probes north, because a probe
 * that happens to land is a free step in the right direction. */
export function plannerRoute(tuning?: Partial<LabTuning>, firstDirection: Direction = LAB_FIRST_PROBE): LabRoute {
  const held: LabTuning = { ...LAB_TUNING, ...tuning };
  return {
    name: `planner:w${held.unknownCost}:r${held.radarMinCover}:d${held.radarDoorCover}:${firstDirection}`,
    start: ({ stage }) => {
      const prior = labPrior(stage);
      let field: LabField = emptyField();
      let at: Cell | undefined;
      let pending: Direction | undefined;
      return {
        next: (last) => {
          if (last !== undefined) {
            if (last.kind === "report") return { kind: "stop", reason: "the planner never files a report" };
            const centre = last.kind === "move" ? last.at : at;
            if (centre === undefined) return { kind: "stop", reason: "a radar render arrived before a position" };
            const seen = observeLab(field, centre, last.surroundings, prior);
            if (seen === undefined) return { kind: "stop", reason: "unreadable render" };
            field = seen;
            if (last.kind === "move") {
              if (!last.moved && at !== undefined && pending !== undefined) {
                field = refuseEdge(field, last.at, pending);
              }
              at = last.at;
            }
          }
          if (at === undefined) {
            pending = firstDirection;
            return { kind: "move", direction: firstDirection };
          }
          const plan = decideLab(field, at, prior, held);
          if (plan.kind === "lost") return { kind: "stop", reason: plan.reason };
          field = plan.field;
          if (plan.kind === "radar") {
            pending = undefined;
            return { kind: "radar" };
          }
          pending = plan.direction;
          return { kind: "move", direction: plan.direction };
        },
      };
    },
  };
}

export interface LabRun {
  caseId: string;
  route: string;
  solved: boolean;
  attempts: number;
  moves: number;
  blocked: number;
  radars: number;
  reports: number;
  elapsedMs: number;
  shortestMoves: number;
  reason?: string;
}

/** Execute only the labyrinth protocol. There is no network, server mutation,
 * cache reward, session, telemetry, or virtual clock here. Every move, radar,
 * and report pays the authentication delay. Failed moves also award the same
 * charisma experience as the game, which can shorten later calls. */
export function runLabCase(
  lab: LabCase,
  route: LabRoute,
  timing: number | LabTiming = {},
  attemptCap = 20_000,
): LabRun {
  const player = labPlayer(lab.stage, timing);
  const session = route.start({ width: lab.maze[0]!.length, height: lab.maze.length, stage: lab.stage });
  const shortestMoves = shortestLabPath(lab.maze, lab.start, lab.exit);
  let at = lab.start;
  let last: LabObservation | undefined;
  let elapsedMs = 0;
  let attempts = 0;
  let moves = 0;
  let blocked = 0;
  let radars = 0;
  let reports = 0;

  const result = (solved: boolean, reason?: string): LabRun => ({
    caseId: lab.id,
    route: route.name,
    solved,
    attempts,
    moves,
    blocked,
    radars,
    reports,
    elapsedMs,
    shortestMoves,
    ...(reason !== undefined ? { reason } : {}),
  });

  while (attempts < attemptCap) {
    const decision = session.next(last);
    if (decision.kind === "stop") return result(false, decision.reason);

    attempts++;
    elapsedMs += player.authMs();
    if (decision.kind === "radar") {
      radars++;
      last = {
        kind: "radar",
        surroundings: surroundingsVisualized(lab.maze, at[0], at[1], 3, true, true, lab.exit),
      };
      continue;
    }
    if (decision.kind === "report") {
      reports++;
      const surroundings = surroundingsVisualized(lab.maze, at[0], at[1], 1, true, false, lab.exit);
      last = { kind: "report", at, open: readSurroundings(surroundings)! };
      continue;
    }

    const to = ahead(at, decision.direction);
    const wall: Cell = [(at[0] + to[0]) / 2, (at[1] + to[1]) / 2];
    if (lab.maze[wall[1]]?.[wall[0]] !== MAZE_PATH) {
      blocked++;
      player.failedMove();
      last = {
        kind: "move",
        at,
        moved: false,
        surroundings: surroundingsVisualized(lab.maze, at[0], at[1], 1, true, false, lab.exit),
      };
      continue;
    }

    at = to;
    moves++;
    if (at[0] === lab.exit[0] && at[1] === lab.exit[1]) return result(true);
    player.failedMove();
    last = {
      kind: "move",
      at,
      moved: true,
      surroundings: surroundingsVisualized(lab.maze, at[0], at[1], 1, true, false, lab.exit),
    };
  }

  return result(false, `exceeded ${attemptCap} attempts`);
}

/** One walker in a party: a planner policy plus the two things that make a
 * SECOND walker a different creature from the first — the route it commits to,
 * and whether it is allowed to die. */
export interface LabPartyMember {
  name: string;
  /** Which macro-route this member's prior commits to. The finisher should
   *  stay "any"; a scout is worth most on the route the finisher is not on.
   *  A bias that ever proves unroutable falls back to the unbiased prior. */
  route?: LabRouteBias;
  tuning?: Partial<LabTuning>;
  firstDirection?: Direction;
  /** An UNPINNED walker's expected survival: after this long the member is
   *  killed — a mutation moved or ate its host — and restarts as a NEW PID at
   *  a freshly drawn offset start, keeping nothing but the shared field. The
   *  respawn itself is modelled as free: a resident re-plants in seconds
   *  against authentications that cost several each. Omit for a stasis-linked
   *  walker, which mutations cannot touch. */
  lifetimeMs?: number;
}

export interface LabPartyMemberReport {
  name: string;
  attempts: number;
  moves: number;
  blocked: number;
  radars: number;
  deaths: number;
  elapsedMs: number;
  /** Set when this member stopped for good, with the planner's reason. */
  stuck?: string;
}

export interface LabPartyRun {
  caseId: string;
  solved: boolean;
  winner?: string;
  /** The elapsed clock of whichever member stood on the exit — members pay
   *  their delays in PARALLEL, so this is the party's real wall-clock. */
  wallClockMs: number;
  /** Total authentications across the party: the serial cost, for judging what
   *  the parallelism actually bought. */
  attempts: number;
  shortestMoves: number;
  members: LabPartyMemberReport[];
  reason?: string;
}

/** FNV-1a, for deriving a member's private offset stream from the case id. */
const hashLabId = (id: string): number => {
  let held = 0x811c_9dc5;
  for (let index = 0; index < id.length; index++) {
    held ^= id.charCodeAt(index);
    held = Math.imul(held, 0x0100_0193);
  }
  return held >>> 0;
};

/** Several PID-bound walkers in ONE maze, sharing a knowledge field.
 *
 * This is the arena for the question `runLabCase` cannot ask: what is a second
 * adjacent host WORTH? The engine facts it leans on, each verified upstream:
 * the maze is global (`DarknetState.labyrinth`) while positions are per PID;
 * each PID's `authenticate` delays run in parallel; every failed attempt from
 * ANY pid feeds the one charisma pool; and whichever PID reaches the endpoint
 * roots the lab for everyone. Knowledge sharing stands in for the production
 * realm plumbing (`mergeLabFields` through the overseer): here the members
 * simply read and write one field, which is the same thing with the copying
 * elided.
 *
 * Member 0 starts at the case's own start cell, exactly as `runLabCase` seeds
 * its single walker; later members draw their own start offsets, because
 * `getPositionInLab` rolls `getRandomOffset` per PID. A party of one is
 * step-for-step identical to `runLabCase` with `plannerRoute()` — the tests
 * assert it — so solo numbers and party numbers share a ruler. */
export function runLabParty(
  lab: LabCase,
  party: readonly LabPartyMember[],
  timing: number | LabTiming = {},
  attemptCap = 40_000,
): LabPartyRun {
  if (party.length === 0) throw new Error("a lab party needs at least one member");
  const player = labPlayer(lab.stage, timing);
  const basePrior = labPrior(lab.stage);
  const shortestMoves = shortestLabPath(lab.maze, lab.start, lab.exit);

  interface Walker {
    spec: LabPartyMember;
    tuning: LabTuning;
    prior: LabPrior;
    draw: () => number;
    pos: Cell;
    at: Cell | undefined;
    attempts: number;
    moves: number;
    blocked: number;
    radars: number;
    deaths: number;
    elapsedMs: number;
    stuck?: string;
  }

  const freshStart = (draw: () => number): Cell => lab.stage.offsetStartAndEnd
    ? [1 + Math.floor(draw() * 3) * 2, 1 + Math.floor(draw() * 3) * 2]
    : [1, 1];

  const walkers: Walker[] = party.map((spec, index) => {
    const draw = mulberry32(hashLabId(lab.id) ^ Math.imul(index + 1, 0x9e37_79b1));
    return {
      spec,
      tuning: { ...LAB_TUNING, ...spec.tuning },
      prior: routePrior(basePrior, spec.route ?? "any"),
      draw,
      pos: index === 0 ? lab.start : freshStart(draw),
      at: undefined,
      attempts: 0,
      moves: 0,
      blocked: 0,
      radars: 0,
      deaths: 0,
      elapsedMs: 0,
    };
  });

  let shared: LabField = emptyField();
  let attempts = 0;

  const report = (): LabPartyMemberReport[] => walkers.map((walker) => ({
    name: walker.spec.name,
    attempts: walker.attempts,
    moves: walker.moves,
    blocked: walker.blocked,
    radars: walker.radars,
    deaths: walker.deaths,
    elapsedMs: walker.elapsedMs,
    ...(walker.stuck !== undefined ? { stuck: walker.stuck } : {}),
  }));
  const result = (solved: boolean, wallClockMs: number, winner?: string, reason?: string): LabPartyRun => ({
    caseId: lab.id,
    solved,
    ...(winner !== undefined ? { winner } : {}),
    wallClockMs,
    attempts,
    shortestMoves,
    members: report(),
    ...(reason !== undefined ? { reason } : {}),
  });

  while (attempts < attemptCap) {
    const live = walkers.filter((walker) => walker.stuck === undefined);
    if (live.length === 0) {
      return result(false, Math.max(...walkers.map((w) => w.elapsedMs)), undefined, "every member is stuck");
    }
    const walker = live.reduce((best, held) => (held.elapsedMs < best.elapsedMs ? held : best));

    // A mortal member past its lifetime dies here: fresh PID, fresh offset
    // start, nothing kept but the shared field. Checked BEFORE acting, so an
    // action never straddles the death.
    if (walker.spec.lifetimeMs !== undefined
      && walker.elapsedMs >= (walker.deaths + 1) * walker.spec.lifetimeMs) {
      walker.deaths++;
      walker.pos = freshStart(walker.draw);
      walker.at = undefined;
    }

    let action: { kind: "move"; direction: Direction } | { kind: "radar" };
    if (walker.at === undefined) {
      action = { kind: "move", direction: walker.spec.firstDirection ?? LAB_FIRST_PROBE };
    } else {
      let plan = decideLab(shared, walker.at, walker.prior, walker.tuning);
      if (plan.kind === "lost" && walker.prior !== basePrior) {
        // The route bias closed every remaining path — hand the member the
        // unbiased prior for good and let it help wherever it is needed.
        walker.prior = basePrior;
        plan = decideLab(shared, walker.at, walker.prior, walker.tuning);
      }
      if (plan.kind === "lost") {
        walker.stuck = plan.reason;
        continue;
      }
      shared = plan.field;
      action = plan.kind === "radar" ? { kind: "radar" } : { kind: "move", direction: plan.direction };
    }

    attempts++;
    walker.attempts++;
    walker.elapsedMs += player.authMs();

    if (action.kind === "radar") {
      walker.radars++;
      const render = surroundingsVisualized(lab.maze, walker.pos[0], walker.pos[1], 3, true, true, lab.exit);
      shared = observeLab(shared, walker.pos, render, basePrior) ?? shared;
      continue;
    }

    const to = ahead(walker.pos, action.direction);
    const wall: Cell = [(walker.pos[0] + to[0]) / 2, (walker.pos[1] + to[1]) / 2];
    const open = lab.maze[wall[1]]?.[wall[0]] === MAZE_PATH;
    if (open) {
      walker.pos = to;
      walker.moves++;
      if (to[0] === lab.exit[0] && to[1] === lab.exit[1]) {
        return result(true, walker.elapsedMs, walker.spec.name);
      }
    } else {
      walker.blocked++;
    }
    player.failedMove();
    const render = surroundingsVisualized(lab.maze, walker.pos[0], walker.pos[1], 1, true, false, lab.exit);
    const seen = observeLab(shared, walker.pos, render, basePrior);
    if (seen === undefined) {
      walker.stuck = "unreadable render";
      continue;
    }
    shared = seen;
    if (!open && walker.at !== undefined) shared = refuseEdge(shared, walker.pos, action.direction);
    walker.at = walker.pos;
  }

  return result(false, Math.max(...walkers.map((w) => w.elapsedMs)), undefined, `exceeded ${attemptCap} attempts`);
}

/** Omniscient lower bound. This is not a playable route: it can see the whole
 * maze. It tells a benchmark how much time is route overhead rather than maze
 * distance. */
export function shortestLabPath(maze: readonly string[], start: Cell, exit: Cell): number {
  const queue: Array<{ at: Cell; distance: number }> = [{ at: start, distance: 0 }];
  const seen = new Set<string>([`${start[0]},${start[1]}`]);
  for (let read = 0; read < queue.length; read++) {
    const current = queue[read]!;
    if (current.at[0] === exit[0] && current.at[1] === exit[1]) return current.distance;
    for (const direction of ["north", "east", "south", "west"] as const) {
      const to = ahead(current.at, direction);
      const wallY = (current.at[1] + to[1]) / 2;
      const wallX = (current.at[0] + to[0]) / 2;
      if (maze[wallY]?.[wallX] !== MAZE_PATH) continue;
      const key = `${to[0]},${to[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ at: to, distance: current.distance + 1 });
    }
  }
  throw new Error(`lab exit ${exit[0]},${exit[1]} is unreachable from ${start[0]},${start[1]}`);
}

export interface LabTiming {
  /** Defaults to the lab's gate: the slowest charisma at which a walk can run. */
  charisma?: number;
  intelligence?: number;
  threads?: number;
  hasBoots?: boolean;
  sf15Level?: number;
  authenticationDurationMultiplier?: number;
  /** Starting XP defaults to the exact threshold for `charisma`. */
  charismaExp?: number;
  /** Player charisma level multiplier times the BitNode level multiplier. */
  charismaSkillMultiplier?: number;
  charismaExpMultiplier?: number;
  bonusTime?: boolean;
}

/** The player both arenas charge against: ONE charisma pool, however many
 * walkers pay into it.
 *
 * Every failed authenticate — a wall or an ordinary step, since only the exit
 * succeeds — earns the same experience whichever PID sent it, and charisma is
 * the denominator of the authentication time. That is what makes a second
 * walker's moves speed up the FIRST walker's calls, and it is why the pool
 * lives here rather than inside either arena: a per-walker copy would have two
 * walkers levelling separately and quietly overstate the party.
 *
 * Elapsed time is deliberately not tracked here. `runLabCase` has one clock and
 * `runLabParty` has one per walker running in parallel, so the accumulator
 * belongs to the caller and the shared part is only what is genuinely shared. */
interface LabPlayer {
  /** The authentication delay at the pool's CURRENT charisma. */
  authMs(): number;
  failedMove(): void;
}

function labPlayer(stage: LabStage, timing: number | LabTiming): LabPlayer {
  if (typeof timing === "number") {
    if (!Number.isFinite(timing) || timing < 0) {
      throw new Error(`authenticationMs must be finite and non-negative, got ${timing}`);
    }
    return { authMs: () => timing, failedMove() {} };
  }

  const skillMultiplier = timing.charismaSkillMultiplier ?? 1;
  let charismaExp = timing.charismaExp
    ?? expForSkill(timing.charisma ?? stage.cha, skillMultiplier);
  let charisma = skillFromExp(charismaExp, skillMultiplier);
  if (charisma < stage.cha) {
    throw new Error(`${stage.hostname} requires charisma ${stage.cha}, got ${charisma}`);
  }
  const threads = timing.threads ?? 1;
  const failedXp = (3 + 1.1 ** 10)
    * threads
    * (timing.charismaExpMultiplier ?? 1)
    * (timing.bonusTime === true ? 1.5 : 1);
  return {
    authMs: () => labAuthenticationMs(stage, { ...timing, charisma }),
    failedMove() {
      charismaExp += failedXp;
      charisma = skillFromExp(charismaExp, skillMultiplier);
    },
  };
}

/** `calculateAuthenticationTime` for a labyrinth server.
 *
 * Lab servers have difficulty 10 and depth -1. The latter means the generic
 * under-level penalty never applies; the labyrinth rejects below-gate players
 * separately. All lab actions use this same delay at a given player snapshot;
 * `runLabCase` recalculates it if failed moves raise charisma during the walk.
 */
export function labAuthenticationMs(stage: LabStage, timing: LabTiming = {}): number {
  const charisma = timing.charisma ?? stage.cha;
  if (charisma < stage.cha) {
    throw new Error(`${stage.hostname} requires charisma ${stage.cha}, got ${charisma}`);
  }
  const intelligence = timing.intelligence ?? 0;
  const threads = timing.threads ?? 1;
  if (!Number.isFinite(threads) || threads <= 0) throw new Error(`threads must be positive, got ${threads}`);
  const threadFactor = 1 / (1 + 0.2 * (threads - 1));
  const skillFactor = (5 * stage.cha + 1_100) / (charisma + 150);
  const bootsFactor = timing.hasBoots === true ? 0.8 : 1;
  const sf15Factor = (timing.sf15Level ?? 0) > 2 ? 0.8 : 1;
  const backdoorFactor = timing.authenticationDurationMultiplier ?? 1;
  const intelligenceFactor = 1 + (Math.pow(intelligence, 0.8) * 0.25) / 600;
  return 850 * skillFactor * threadFactor * bootsFactor * sf15Factor * backdoorFactor / intelligenceFactor;
}

export interface LabRouteSummary {
  route: string;
  cases: number;
  solved: number;
  totalAttempts: number;
  meanAttempts: number;
  p95Attempts: number;
  maxAttempts: number;
  totalElapsedMs: number;
  meanElapsedMs: number;
  totalShortestMoves: number;
}

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
};

export function summarizeLabRuns(runs: readonly LabRun[]): LabRouteSummary {
  if (runs.length === 0) throw new Error("cannot summarize an empty lab run set");
  const totalAttempts = runs.reduce((sum, run) => sum + run.attempts, 0);
  const totalElapsedMs = runs.reduce((sum, run) => sum + run.elapsedMs, 0);
  return {
    route: runs[0]!.route,
    cases: runs.length,
    solved: runs.filter((run) => run.solved).length,
    totalAttempts,
    meanAttempts: totalAttempts / runs.length,
    p95Attempts: percentile(runs.map((run) => run.attempts), 0.95),
    maxAttempts: Math.max(...runs.map((run) => run.attempts)),
    totalElapsedMs,
    meanElapsedMs: totalElapsedMs / runs.length,
    totalShortestMoves: runs.reduce((sum, run) => sum + run.shortestMoves, 0),
  };
}

export interface LabRouteComparison {
  baseline: string;
  candidate: string;
  cases: number;
  candidateFaster: number;
  tied: number;
  candidateSlower: number;
  attemptDelta: number;
  elapsedDeltaMs: number;
  elapsedRatio: number;
  meanElapsedDeltaMs: number;
  ci95LowMs: number;
  ci95HighMs: number;
}

/** Paired comparison: case N in both arrays must be the same generated maze.
 * A negative delta means the candidate is faster. */
export function compareLabRuns(
  baseline: readonly LabRun[],
  candidate: readonly LabRun[],
): LabRouteComparison {
  if (baseline.length !== candidate.length || baseline.length === 0) {
    throw new Error("paired lab comparisons require equally sized, non-empty run sets");
  }
  const failed = [...baseline, ...candidate].find((run) => !run.solved);
  if (failed) {
    throw new Error(`cannot compare an unsolved lab run: ${failed.route} on ${failed.caseId}: ${failed.reason ?? "stopped"}`);
  }
  let candidateFaster = 0;
  let tied = 0;
  let candidateSlower = 0;
  const deltas: number[] = [];
  for (let i = 0; i < baseline.length; i++) {
    if (baseline[i]!.caseId !== candidate[i]!.caseId) {
      throw new Error(`lab case mismatch at ${i}: ${baseline[i]!.caseId} != ${candidate[i]!.caseId}`);
    }
    const delta = candidate[i]!.elapsedMs - baseline[i]!.elapsedMs;
    deltas.push(delta);
    if (delta < 0) candidateFaster++;
    else if (delta > 0) candidateSlower++;
    else tied++;
  }
  const baselineMs = baseline.reduce((sum, run) => sum + run.elapsedMs, 0);
  const candidateMs = candidate.reduce((sum, run) => sum + run.elapsedMs, 0);
  const meanElapsedDeltaMs = (candidateMs - baselineMs) / baseline.length;
  const variance = deltas.length < 2
    ? 0
    : deltas.reduce((sum, delta) => sum + (delta - meanElapsedDeltaMs) ** 2, 0) / (deltas.length - 1);
  const margin95 = 1.96 * Math.sqrt(variance / deltas.length);
  return {
    baseline: baseline[0]!.route,
    candidate: candidate[0]!.route,
    cases: baseline.length,
    candidateFaster,
    tied,
    candidateSlower,
    attemptDelta: candidate.reduce((sum, run) => sum + run.attempts, 0)
      - baseline.reduce((sum, run) => sum + run.attempts, 0),
    elapsedDeltaMs: candidateMs - baselineMs,
    elapsedRatio: candidateMs / baselineMs,
    meanElapsedDeltaMs,
    ci95LowMs: meanElapsedDeltaMs - margin95,
    ci95HighMs: meanElapsedDeltaMs + margin95,
  };
}
