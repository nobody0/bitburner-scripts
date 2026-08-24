import type { NS } from "@ns";
import { SOLVER_CODES } from "../../shared/strategy/dnet/solvers/types.ts";
import { labStage } from "../../shared/strategy/dnet/rates.ts";
import { targetStateFor } from "./report-shared.ts";
import {
  decideLab,
  emptyField,
  LAB_FIRST_PROBE,
  labPrior,
  mergeLabFields,
  observeLab,
  readCoords,
  refuseEdge,
  type Cell,
  type Direction,
  type LabField,
} from "../../shared/strategy/dnet/maze.ts";
import type { AgentIo, Order, Report } from "./shared.ts";
import { awaitDnetOperation } from "./timing.ts";

/** The `walk` order body: the maze walker — extracted mechanically from
 * `orders.ts`.
 *
 * The body returns the report FIELDS; the agent wrapper stamps `id`, `kind`,
 * `host` and `from` on top.
 *
 * ## The rule this file exists under, with no exceptions
 *
 * It bundles into the same artifact as the controller, and Bitburner's static
 * analyser charges by MEMBER NAME across the whole bundle. So every `ns` reach
 * here is bracket notation on the `jobNs` the body was HANDED
 * (`jobNs["dnet"]["authenticate"]`), and one dot-access would bill the entire
 * order surface to the small controller allocation. `tests/ram-budget.test.ts`
 * greps every file in this directory for that shape and pins the built
 * artifact against esbuild rewriting it. */

type OrderResult = Omit<Report, "id" | "kind" | "host" | "from">;

/** The maze walker: `authenticate(lab, <direction>)`, over and over, with the
 * occasional paid `labradar` when one render decides more than one move can.
 *
 * THE ONE JOB THAT MUST NEVER END EARLY. Position is
 * `DarknetState.labLocations[pid]`, so a dead PID abandons the walk and the
 * next process is re-seeded at the start — there is no resuming, and a deep
 * lab is thousands of moves. That is why it is the only `longLived` kind, why
 * it beats every move, and why its host is the first thing a stasis link is
 * spent on.
 *
 * The lab is the one model that answers through `authenticate`'s own return
 * value: `message` carries the new coordinates and `data` a radius-1 render.
 * That free render reveals all four adjacent walls BEFORE the next choice, so
 * the planner in `shared/strategy/dnet/maze.ts` never pays an authentication
 * to bump a wall — except the deliberate first probe, made blind because the
 * position is unknown until the first response. `labradar` costs the same
 * full authentication as a move and earns no charisma, so `decideLab` pays
 * for one only when its radius-3 window would decide the exit outright or
 * scout several of a seam's door candidates at once.
 *
 * **A wall refusal leaves the position UNCHANGED.** The engine tests the cell
 * BETWEEN us and the target and returns "You are still at X,Y" without
 * moving, so every position comes from parsing the response rather than from
 * assuming the move worked. */
export async function runWalk(ns: NS, order: Order, io: AgentIo): Promise<OrderResult> {
  const jobNs = ns;
  const state = order;
  const beat = io.beat;
  const cancelled = io.cancelled;

  const jobCodes: Record<string, number> = {};
  const count = (code: number | string): void => {
    jobCodes[String(code)] = (jobCodes[String(code)] ?? 0) + 1;
  };
  const stage = labStage(state.host);
  // Below the lab's charisma every single move answers 451 and nothing is
  // learned. Refusing to start is the difference between a job that reports
  // a career need and one that spends an hour collecting 451s.
  // The planner's whole edge is knowing the generator's arithmetic for THIS
  // stage — the seams, the door candidates, the exit candidates. A lab host
  // outside the ladder has no stage to know, and walking it blind would be
  // the old DFS without its aim; stop and say so instead.
  if (!stage) {
    return {
      ok: false,
      codes: { [String(SOLVER_CODES.OracleUnparsed)]: 1 },
      detail: `${state.host} is not a labyrinth rung the walker knows`,
    };
  }
  const basePrior = labPrior(stage);
  let prior = basePrior;
  // Seed from the controller's shared field: the one piece of walk progress
  // that outlives a PID. A re-seeded walker starts with its predecessor's
  // map, so a replacement starts with everything its predecessor learned.
  let field: LabField = io.deps.labField(state.host) ?? emptyField();
  let at: Cell | undefined;
  /** The direction of the move in flight, so a refusal can be written down. */
  let pending: Direction | undefined;
  let moves = 0;
  let walls = 0;
  let radars = 0;
  /** The planner's own A* estimate of what is left, refreshed every decision.
   *  The walk's only forward-looking number, and the one the panel turns into
   *  an ETA against the walk's own observed pace. */
  let believedLeft: number | undefined;
  const progress = (): Record<string, unknown> => ({
    ...(at !== undefined ? { at: `${at[0]},${at[1]}` } : {}),
    moves,
    walls,
    radars,
    learned: Object.keys(field.slots).length,
    ...(believedLeft !== undefined ? { believedLeft } : {}),
  });
  for (;;) {
    const cancellation = cancelled();
    if (cancellation !== undefined) {
      return { ok: false, targetState: "cancelled", codes: jobCodes, detail: `${state.host}: ${cancellation}` };
    }
    // The FIRST call has no known position, so it is a deliberate blind
    // probe: any direction answers with our coordinates whether it moves us
    // or not, and probing TOWARD the exit's corner turns the lucky half of
    // those probes into a free first step.
    let direction: Direction;
    if (at === undefined) {
      direction = LAB_FIRST_PROBE;
    } else {
      // Fold in whatever the OTHER walker has published since our last look,
      // then decide. Merging every step is cheap — a field tops out around
      // two thousand slots — and it is what turns two walkers into one
      // mapper rather than two strangers.
      field = mergeLabFields(field, io.deps.labField(state.host));
      let plan = decideLab(field, at, prior);
      if (plan.kind === "lost" && prior !== basePrior) {
        // The route bias closed every remaining path. Drop it for good and
        // help wherever the map still has questions.
        prior = basePrior;
        plan = decideLab(field, at, prior);
      }
      if (plan.kind === "lost") {
        return {
          ok: false,
          codes: jobCodes,
          detail: `${state.host}: ${plan.reason}`.slice(0, 200),
        };
      }
      field = plan.field;
      if (plan.kind === "radar") {
        // One authentication for a radius-3 render with the exit overlay ON.
        // `decideLab` has already written this vantage down, so a refused or
        // unreadable radar is skipped rather than retried forever.
        const seen = await awaitDnetOperation(io, {
          operation: "labradar", host: state.host, from: state.from, threads: state.jobThreads ?? state.threads,
        }, () => jobNs["dnet"]["labradar"]());
        radars++;
        count(seen.success ? "radar" : "radar-refused");
        if (seen.success) {
          field = observeLab(field, at, String(seen.message ?? ""), basePrior) ?? field;
        }
        io.deps.publishLabField(state.host, field);
        beat(progress());
        continue;
      }
      direction = plan.direction;
      believedLeft = plan.believedCost;
    }
    // The direction word IS the password. `getDirectionFromInput` splits on
    // spaces and takes the first token that parses, so "north" and "go north"
    // are the same move and the shorter one is one less thing to get wrong.
    pending = direction;
    const answer = await awaitDnetOperation(io, {
      operation: "authenticate", host: state.host, from: state.from, threads: state.jobThreads ?? state.threads,
    }, () => jobNs["dnet"]["authenticate"](state.host, direction));
    count(answer.code);
    if (answer.success) {
      return {
        ok: true,
        codes: jobCodes,
        // Neither listing NOR identity: the walker's only job is to reach the
        // exit. The `.cache` the exit drops, and the lab's ip, are read by the
        // ORDINARY worker `planSpread` re-plants here the moment the walk ends —
        // paying `ls` (0.2) and `getServer` (2.0) on ONE resident instead of on
        // every one of the walker's authenticate threads.
        detail: `${state.host}: reached the exit after ${moves} moves and ${radars} radars`,
      };
    }
    // A move that never reached the model — the host moved, or we lost the
    // charisma gate mid-walk. Neither is recoverable from here, and the walk
    // is lost with the PID either way, so stop rather than spin.
    if (answer.code !== 401) {
      return {
        ok: false,
        codes: jobCodes,
        ...targetStateFor(answer.code),
        detail: `${state.host}: ${answer.message}`.slice(0, 200),
      };
    }
    const where = readCoords(answer.message);
    if (where === undefined) {
      // The grammar moved. Stopping is right: a walker that cannot read its
      // own position would walk into the same wall for hours.
      count(SOLVER_CODES.OracleUnparsed);
      return {
        ok: false,
        codes: jobCodes,
        detail: `${state.host}: could not read a position out of the response`,
      };
    }
    const seen = observeLab(field, where, String(answer.data ?? ""), basePrior);
    if (seen === undefined) {
      // Same verdict for a render that is no longer a centred odd square: a
      // walker that believed it would learn confident lies.
      count(SOLVER_CODES.OracleUnparsed);
      return {
        ok: false,
        codes: jobCodes,
        detail: `${state.host}: could not read the surroundings out of the response`,
      };
    }
    field = seen;
    const moved = at === undefined || where[0] !== at[0] || where[1] !== at[1];
    if (at !== undefined && moved) moves++;
    if (at !== undefined && !moved) {
      walls++;
      // THE ENGINE REFUSED A STEP WE BELIEVED OPEN. With the prior in place
      // this should never happen — the border is pre-walled and the first
      // edge of every plan is already known — but an engine that disagrees
      // with our model must be written down, or the identical decision
      // repeats until the host dies, which no watchdog would catch because
      // the beat below keeps stamping.
      field = refuseEdge(field, at, pending);
    }
    at = where;
    // Publish AFTER folding this response in, so the other walker — and any
    // successor of ours — plans over everything this step just paid for.
    io.deps.publishLabField(state.host, field);
    beat(progress());
  }
}
