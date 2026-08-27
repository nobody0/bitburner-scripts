import type { FeatureId } from "../features/ids.ts";

/** The needs board: outcome-level communication between features.
 *
 * This is deliberately NOT the arbiter (./arbiter.ts). The arbiter allocates a
 * contended resource — money, the player's single work slot — and answers
 * "who gets it". The board answers a different question: *"factions
 * needs karma <= -45; who can deliver that, and is it worth their time?"*
 *
 * A Need therefore states a desired OUTCOME and its worth, never a method.
 * `factions` posts `{kind:"karma", target:-45}`; it does not know or care
 * whether `career` gets there through Mug or Homicide, or whether `sleeves`
 * gets there in parallel. That separation is what keeps each feature's strategy
 * a self-contained optimization problem: the consumer folds the board into
 * objective weights (needWeights) and maximises its own rate against them.
 *
 * Pure, and deliberately clock-free — `postNeeds` takes the needs and nothing
 * else, so it is directly unit-testable and identical in the sim and the game. */

export type NeedKind =
  | "money"
  | "karma"
  | "kills"
  | "skill"
  | "combatSkills"
  | "charisma"
  | "companyRep"
  | "factionRep"
  | "jobTitle"
  | "employment"
  | "quitCompany"
  | "city"
  | "root"
  | "backdoor"
  | "hacknetRam"
  | "hacknetCores"
  | "hacknetLevels"
  | "bladeburnerRank"
  | "file"
  | "augCount";

export const NEED_KINDS: readonly NeedKind[] = [
  "money",
  "karma",
  "kills",
  "skill",
  "combatSkills",
  "charisma",
  "companyRep",
  "factionRep",
  "jobTitle",
  "employment",
  "quitCompany",
  "city",
  "root",
  "backdoor",
  "hacknetRam",
  "hacknetCores",
  "hacknetLevels",
  "bladeburnerRank",
  "file",
  "augCount",
] as const;

/** Which direction satisfies a need.
 *
 * Load-bearing, and the one thing that is easy to get backwards: karma targets
 * are NEGATIVE and satisfied by going lower (`karma <= -54000` founds a gang),
 * while every accumulating stat is satisfied by going higher. `quitCompany` is
 * "employed-by count at this company must reach 0". Getting this wrong makes a
 * satisfied need look blocking forever, which is exactly the failure mode that
 * makes a feature spin. */
export type NeedDirection = "atLeast" | "atMost";

const DIRECTION: Record<NeedKind, NeedDirection> = {
  money: "atLeast",
  karma: "atMost",
  kills: "atLeast",
  skill: "atLeast",
  combatSkills: "atLeast",
  charisma: "atLeast",
  companyRep: "atLeast",
  factionRep: "atLeast",
  jobTitle: "atLeast",
  employment: "atLeast",
  quitCompany: "atMost",
  city: "atLeast",
  root: "atLeast",
  backdoor: "atLeast",
  hacknetRam: "atLeast",
  hacknetCores: "atLeast",
  hacknetLevels: "atLeast",
  bladeburnerRank: "atLeast",
  file: "atLeast",
  augCount: "atLeast",
};

export function needDirection(kind: NeedKind): NeedDirection {
  return DIRECTION[kind];
}

export type NeedUrgency = "blocking" | "wanted" | "nice";

/** Ordering only. Worth lives in `weight`; this is how two needs of equal
 * weight are ranked, and how the UI sorts. */
export const URGENCY_ORDER: Record<NeedUrgency, number> = { blocking: 2, wanted: 1, nice: 0 };

export interface Need {
  /** Who wants it. */
  by: FeatureId;
  kind: NeedKind;
  /** Company / hostname / skill name / city, when the kind is per-subject. */
  subject?: string;
  /** The threshold, in the game's own units. */
  target: number;
  have: number;
  /** The posting route's TERMINAL blocker — worth the whole remaining
   * horizon; see RouteNeed.terminal. */
  terminal?: true;
  /** Worth of satisfying it, in the requester's own value units per second of
   *  the run it would unblock. Comparable across features only via this field —
   *  which is the whole point of normalising to "per second of unblocked run". */
  weight: number;
  /** Optional MEASURED economics: BN-seconds of completion time satisfying
   *  this need is estimated to save. Deliberately separate from `weight` —
   *  weight stays on the small cross-kind scale every existing consumer
   *  calibrates against (Go demand clamps `weight / 10` into [0.1, 1]), while
   *  valueSec carries the raw estimate for consumers that rank actions
   *  economically (hacking's server-access selection, RAM escalation).
   *  Absent = unmeasured, never zero. Same-key values ADD, like weights. */
  valueSec?: number;
  urgency: NeedUrgency;
}

/** Stable identity for a need's subject-space. Two features asking for the same
 * outcome collapse onto one key, which is what lets a consumer see the TOTAL
 * worth of delivering it. */
export function needKey(need: Pick<Need, "kind" | "subject">): string {
  return need.subject === undefined ? need.kind : `${need.kind}:${need.subject}`;
}

export function isSatisfied(need: Pick<Need, "kind" | "target" | "have">): boolean {
  return DIRECTION[need.kind] === "atLeast" ? need.have >= need.target : need.have <= need.target;
}

/** How close we are, in [0, 1]. Sortable, so "nearly there" outranks "barely
 * started" when weights tie — the same idea as the predecessor scripts'
 * `progress` ratio on each requirement (src/_lib/factions.ts:55). */
export function needProgress(need: Pick<Need, "kind" | "target" | "have">): number {
  if (isSatisfied(need)) return 1;
  const { target, have } = need;
  // Both target and have on the same side of zero: a plain ratio is meaningful
  // (karma -10 of -45 is 22% of the way there, and so is skill 10 of 45).
  if (target !== 0 && Math.sign(target) === Math.sign(have)) {
    const ratio = have / target;
    return ratio > 0 && ratio < 1 ? ratio : 0;
  }
  // Crossing zero (karma 0 heading to -45) or a zero target: no meaningful
  // fraction, so report "not started" rather than inventing one.
  return 0;
}

export interface NeedBoard {
  /** Every posted need, satisfied ones included — a satisfied need is evidence
   *  the requester is unblocked, and dropping it would make the UI look like
   *  the requester stopped caring. */
  needs: Need[];
  byKind: Record<NeedKind, Need[]>;
  /** Unsatisfied needs only, highest (urgency, weight) first. The work queue. */
  open: Need[];
}

/** Fold posted needs into the board. Deterministic: ordering never depends on
 * the order features happened to be collected in. */
export function postNeeds(all: readonly Need[]): NeedBoard {
  const needs = [...all].sort(compareNeeds);
  const byKind = {} as Record<NeedKind, Need[]>;
  for (const kind of NEED_KINDS) byKind[kind] = [];
  for (const need of needs) byKind[need.kind]!.push(need);
  return { needs, byKind, open: needs.filter((need) => !isSatisfied(need)) };
}

function compareNeeds(a: Need, b: Need): number {
  const urgency = URGENCY_ORDER[b.urgency] - URGENCY_ORDER[a.urgency];
  if (urgency !== 0) return urgency;
  if (b.weight !== a.weight) return b.weight - a.weight;
  const progress = needProgress(b) - needProgress(a);
  if (progress !== 0) return progress;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const aKey = needKey(a);
  const bKey = needKey(b);
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return a.by < b.by ? -1 : a.by > b.by ? 1 : 0;
}

/** Consumer side: what is each outcome worth to the rest of the system right
 * now, keyed by `needKey`.
 *
 * Only UNSATISFIED needs contribute. That is the rule that stops `career`
 * grinding crime for karma it has already delivered — the weight simply
 * vanishes from its objective the moment the threshold is crossed.
 *
 * Weights of different requesters for the same outcome ADD, because delivering
 * it once unblocks all of them. */
export function needWeights(board: NeedBoard, kinds: readonly NeedKind[]): Record<string, number> {
  const wanted = new Set(kinds);
  const weights: Record<string, number> = {};
  for (const need of board.open) {
    if (!wanted.has(need.kind)) continue;
    const key = needKey(need);
    weights[key] = (weights[key] ?? 0) + need.weight;
  }
  return weights;
}

/** Total measured BN-seconds each outcome would save, keyed by `needKey`.
 * Same rules as `needWeights`: unsatisfied needs only, same-key values add.
 * Keys with no measured `valueSec` on any poster are ABSENT, not zero — a
 * consumer chooses its own fallback (see access/value.ts `rankingValueSec`). */
export function needValueSeconds(board: NeedBoard, kinds: readonly NeedKind[]): Record<string, number> {
  const wanted = new Set(kinds);
  const values: Record<string, number> = {};
  for (const need of board.open) {
    if (!wanted.has(need.kind) || need.valueSec === undefined) continue;
    const key = needKey(need);
    values[key] = (values[key] ?? 0) + need.valueSec;
  }
  return values;
}

/** Look one outcome's total worth up, honouring the subject convention. */
export function weightFor(weights: Record<string, number>, kind: NeedKind, subject?: string): number {
  return weights[needKey({ kind, subject })] ?? 0;
}

/** The open needs a given feature could act on, richest first. Consumers rank
 * their own actions against this. */
export function openFor(board: NeedBoard, kinds: readonly NeedKind[]): Need[] {
  const wanted = new Set(kinds);
  return board.open.filter((need) => wanted.has(need.kind));
}

/** An empty board — the controller's state before any feature has posted. */
export function emptyBoard(): NeedBoard {
  return postNeeds([]);
}
