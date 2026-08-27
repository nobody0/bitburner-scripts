/** ONE table describing every kind of darknet job.
 *
 * A kind used to be described in about twenty places — a union here, a
 * priority map there, six `ReadonlySet`s of kind names, two copies of the farm
 * list, an inline six-term `!==` chain for rerouting, and a handful of
 * `kind === "walk"` tests scattered through the controller. Adding a kind meant
 * finding all of them, and getting one wrong was silent: the kind simply did
 * not participate in whatever that list controlled, and nothing failed.
 *
 * So every per-kind FACT lives here, and callers read it by indexing:
 * `JOBS[task.kind].threadScaled`. There are deliberately no `isThreadScaled`
 * style wrappers — a one-line predicate per flag is a name to learn and a hop
 * to follow, and it hides the one thing worth seeing, which is that the answer
 * came out of this table.
 *
 * What is NOT here, on purpose:
 *
 * - The ns call surface, the GB price and the body. Those need `NS` and the
 *   game's own cost table, so they live in `game/dnet/shared.ts`. This file
 *   stays pure, which is what lets the simulator and the plan tests read it.
 * - The controller's report handling (`onReport`). Those branches reach
 *   controller-private state — the edge graph, the vault, the storm clock — so
 *   a row big enough to carry them would be larger than the switch it replaced.
 *   That switch stays a switch: this table is not total over the feature, only
 *   over the facts a SCHEDULER needs. */

/** Everything the scheduler knows about one kind. Every flag defaults to
 * false, so a row states only what is true of it. */
export interface JobPolicy {
  /** Lower runs first within the blocking lane. */
  readonly priority: number;
  /** Settles synchronously or through launch microtasks only, so it never
   *  occupies the lane. Queues ahead of blocking work WITHOUT gaining the
   *  right to cancel any of it. */
  readonly sameTurn?: true;
  /** May displace work already running on a worker. */
  readonly preempts?: true;
  /** May not be displaced, whatever wants the slot. */
  readonly protectedActive?: true;
  /** May be re-routed across `eligibleFrom`, and may take a slot by
   *  preemption. Everything else runs where it was derived or not at all. */
  readonly reroutable?: true;
  /** Never released from an engine call already in flight: `pin` is one atomic
   *  call whose result we need, `walk` is PID-bound and would lose the maze.
   *  Both still take the cancel flag and stop at their own next boundary. */
  readonly releaseExempt?: true;
  /** Sized to FILL its host with threads. Everything else runs at what the
   *  planner asked for. */
  readonly threadScaled?: true;
  /** Does not finish on its own. */
  readonly longLived?: true;
  /** Needs every byte and ends by leaving the host empty for the spread
   *  planner to re-plant, so the prober beside it is DISPLACED rather than
   *  reserved around. */
  readonly consumesHost?: true;
  /** Earning work — LEFTOVERS. Filed only onto a host that is already spare,
   *  which is why no farm kind may preempt: it would cancel an order it cannot
   *  then replace, the next derive would re-file the victim, and the two would
   *  loop against each other at engine speed. Observed exactly that way. */
  readonly farm?: true;
  /** What a host does as a matter of course, so its price must fit beside the
   *  fixed infrastructure on a 16 GB host. */
  readonly routine?: true;
  /** Its in-flight presence holds the storm seed: work whose results a reroll
   *  would throw away mid-collection. */
  readonly harvest?: true;
  /** Deduped per (kind, target, VANTAGE) rather than per (kind, target),
   *  because several vantages legitimately work the same target at once. */
  readonly perVantage?: true;
}

/** The rows. Separate from `JOBS` for one reason: this literal is what
 * `TaskKind` is derived from, so a kind cannot exist without a row — while
 * `JOBS` below is widened to `Record<TaskKind, JobPolicy>` so that
 * `JOBS[kind].farm` type-checks for a kind that is not known statically. Read
 * from `JOBS`; this binding exists to be `keyof`-ed. */
const ROWS = {
  // Completing the labyrinth is the whole point of the darknet, so the walk
  // outranks everything. It holds its host alone for the whole maze because
  // `DarknetState.labLocations` is keyed by PID.
  walk: {
    priority: -2_000,
    preempts: true, protectedActive: true, reroutable: true,
    releaseExempt: true, threadScaled: true, longLived: true,
    consumesHost: true,
  },
  // The prober carries no self-revival, so a dead one is repaired at maximum
  // urgency — but it is one `exec`, so it takes the instant lane and cancels
  // nothing.
  relaunchProbe: { priority: -1_900, sameTurn: true },
  // Placing a process is the scarcest blocking work we do: it is the only
  // action that GROWS the set of places we can act from.
  plant: { priority: -1_800, preempts: true, reroutable: true, routine: true },
  inventory: { priority: -1_700, sameTurn: true, routine: true },
  // Sorts near the front — a cache dies with its host — but may NOT preempt:
  // it is farm work, and farm work is filed only onto spare hosts.
  cache: {
    priority: -1_650,
    reroutable: true, farm: true, routine: true, harvest: true,
  },
  // A stasis link is 12 GB and the job is 13.9: it does not clear a 16 GB host
  // beside a lender, so the prober is displaced rather than reserved around.
  pin: {
    priority: -1_600,
    preempts: true, protectedActive: true, reroutable: true,
    releaseExempt: true, consumesHost: true,
  },
  // Below the pin STRUCTURALLY: a pending link is a reason not to fire yet.
  storm: { priority: -1_500, protectedActive: true },
  attempt: {
    priority: 0,
    preempts: true, reroutable: true, threadScaled: true,
    routine: true, harvest: true,
  },
  bleed: { priority: 100, reroutable: true, threadScaled: true, routine: true },
  reclaim: {
    priority: 300,
    threadScaled: true, farm: true, routine: true, harvest: true,
  },
  // A project of hundreds of calls whose value arrives only at the end, so it
  // waits behind everything that opens the net. Several vantages charge one
  // target at once — the engine accumulates the charge ON the target — hence
  // the per-vantage dedup.
  induce: { priority: 400, perVantage: true },
  phish: { priority: 500, threadScaled: true, farm: true, routine: true },
  promote: { priority: 600, threadScaled: true, farm: true },
} as const satisfies Record<string, JobPolicy>;

/** The kinds the planner derives, from the table's own keys. */
export type TaskKind = keyof typeof ROWS;

export const JOBS: Readonly<Record<TaskKind, JobPolicy>> = ROWS;

export const TASK_KINDS = Object.keys(ROWS) as readonly TaskKind[];

/** The four earning kinds, derived from the `farm` flag so the union cannot
 * drift from the table. `farm.ts` keys its price and busy maps on this. */
export type FarmKind = { [K in TaskKind]: (typeof ROWS)[K] extends { farm: true } ? K : never }[TaskKind];

/** Kinds that are not derived work at all — a price and a call surface, and
 * nothing else. Never planned, never queued, never handed to a body. They have
 * no row here, which is why `priorityOf` answers `+Infinity` for them. */
export type ProcessMode = "idle" | "bootstrapReclaim";

export const isTaskKind = (kind: string): kind is TaskKind => kind in ROWS;

/** Queue rank. The two callers that ask about a process mode — or about work
 * read back from a snapshot, where the kind is only a string — get
 * `+Infinity`, which sorts them behind everything and keeps them out of every
 * comparison without each caller remembering to exclude them. */
export function priorityOf(kind: string): number {
  return isTaskKind(kind) ? JOBS[kind].priority : Number.POSITIVE_INFINITY;
}

/** The instant lane. Takes a plain string because the queue comparator sorts
 * records whose kind came off a snapshot. */
export function isSameTurn(kind: string): boolean {
  return isTaskKind(kind) && JOBS[kind].sameTurn === true;
}

/** Whether newly-ready work may displace active work on the same worker.
 *
 * Queue order and displacement are deliberately separate questions: `cache`
 * and `inventory` both sort near the front and neither may cancel anything. */
export function canPreempt(incoming: string, active: string): boolean {
  if (!isTaskKind(incoming) || !JOBS[incoming].preempts) return false;
  if (incoming === active) return false;
  if (isTaskKind(active) && JOBS[active].protectedActive === true) return false;
  return priorityOf(incoming) < priorityOf(active);
}
