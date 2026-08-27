import {
  ahead,
  decideLab,
  emptyField,
  LAB_FIRST_PROBE,
  labPrior,
  observeLab,
  refuseEdge,
  type Cell,
  type Direction,
  type LabField,
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

export type LabObservation = LabMoveObservation | LabRadarObservation;

export type LabDecision =
  | { kind: "move"; direction: Direction }
  | { kind: "radar" }
  | { kind: "stop"; reason: string };

/** A route is stateful because the real walk is stateful and PID-bound. It gets
 * the real maze dimensions and the public stage facts — exactly what `walkJob`
 * reads out of `labStage` — but never the maze, start, or endpoint. */
export interface LabRoute {
  name: string;
  start(context: { stage: LabStage }): {
    next(last?: LabObservation): LabDecision;
  };
}

/** Adapter for the planning walker in `shared/strategy/dnet/maze.ts`, wired
 * exactly the way `walkJob` drives it: observe every response's render, mark a
 * refused edge, then ask `decideLab` for the next paid action. The first move
 * is a blind probe — the position is unknown until the first response — and it
 * probes TOWARD the exit's corner, because a probe that happens to land is a
 * free step in the right direction. */
export function plannerRoute(): LabRoute {
  return {
    name: `planner:${LAB_FIRST_PROBE}`,
    start: ({ stage }) => {
      const prior = labPrior(stage);
      let field: LabField = emptyField();
      let at: Cell | undefined;
      let pending: Direction | undefined;
      return {
        next: (last) => {
          if (last !== undefined) {
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
            pending = LAB_FIRST_PROBE;
            return { kind: "move", direction: LAB_FIRST_PROBE };
          }
          const plan = decideLab(field, at, prior);
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
  elapsedMs: number;
  shortestMoves: number;
  reason?: string;
}

/** Execute only the labyrinth protocol. There is no network, server mutation,
 * cache reward, session, telemetry, or virtual clock here. Every move and
 * radar pays the authentication delay. Failed moves also award the same
 * charisma experience as the game, which can shorten later calls. */
export function runLabCase(
  lab: LabCase,
  route: LabRoute,
  timing: number | LabTiming = {},
  attemptCap = 20_000,
): LabRun {
  const player = labPlayer(lab.stage, timing);
  const session = route.start({ stage: lab.stage });
  const shortestMoves = shortestLabPath(lab.maze, lab.start, lab.exit);
  let at = lab.start;
  let last: LabObservation | undefined;
  let elapsedMs = 0;
  let attempts = 0;
  let moves = 0;
  let blocked = 0;
  let radars = 0;

  const result = (solved: boolean, reason?: string): LabRun => ({
    caseId: lab.id,
    route: route.name,
    solved,
    attempts,
    moves,
    blocked,
    radars,
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

/** Player state charged by the arena. Every failed authenticate — a wall or
 * an ordinary step, since only the exit succeeds — earns charisma experience,
 * and the updated skill shortens the following authentication. */
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
