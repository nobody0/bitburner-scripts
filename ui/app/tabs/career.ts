import { skillProgress } from "../../../shared/formulas.ts";
import type { CareerPlan } from "../../../shared/telemetry/topics/career.ts";
import { ago, nowFor, stamp } from "../lib/clock.ts";
import { card, collapsible, dataTable, dot, meter, NONE, note, table, tiles, waiting, waitingPanel, type Column } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Career tab: stats, karma and work. Karma is here because it is the gate
 * other features wait on — BN2's gang needs -54,000 of it.
 *
 * The panel is organised around what the feature is doing: the action and its
 * scores, the requests it serves, and the alternatives considered. */

const GANG_KARMA = -54_000;

const SKILLS = ["hacking", "strength", "defense", "dexterity", "agility", "charisma", "intelligence"] as const;

/** The BitNode multiplier that scales each stat's level, by stat. */
const LEVEL_NODE_MULT: Partial<Record<(typeof SKILLS)[number], string>> = {
  hacking: "HackingLevelMultiplier",
  strength: "StrengthLevelMultiplier",
  defense: "DefenseLevelMultiplier",
  dexterity: "DexterityLevelMultiplier",
  agility: "AgilityLevelMultiplier",
  charisma: "CharismaLevelMultiplier",
};

/** The effective multiplier the game applies when turning experience into a
 * level: the player's own stat multiplier times the BitNode's.
 *
 * Both halves matter and both are easy to forget. Passing 1 — as this panel
 * first did — reports a level the player does not have and a bar to the wrong
 * next level: at 1.2m hacking experience under a 1.2x multiplier the true
 * level is 297 with 53% of the way to 298, but a 1x reading claims 94%.
 *
 * Intelligence is deliberately absent: the game applies no multiplier to it. */
function skillMultiplier(state: ProjectedState, skill: (typeof SKILLS)[number]): number {
  if (skill === "intelligence") return 1;
  const mults = state.player?.mults as unknown as Record<string, number> | undefined;
  const player = mults?.[skill];
  if (player === undefined) return 1;
  const field = LEVEL_NODE_MULT[skill];
  const node = field ? (state.topics.progression?.multipliers?.[field] ?? 1) : 1;
  return player * node;
}

/** Requests are grouped so ten factions wanting the same thing are one row.
 *
 * A late-game save posts one request per (faction, requirement) pair, which
 * meant eleven consecutive rows reading "companyRep 0.0 to 400.00k" that
 * differed only in which faction was asking. The work is identical; the list
 * of askers is the detail. */
interface RequestGroup {
  key: string;
  kind: string;
  subject?: string;
  urgency: string;
  /** The NEXT milestone: progress, have and target all taken from the single
   *  closest request in the group.
   *
   *  These three have to move together. Taking the maximum of each
   *  independently draws the bar for the nearest ask and labels it with the
   *  furthest one — an 89.8% bar reading "1.35k / 2.50k", which is 54% — and
   *  turns the meter green the moment the easiest requirement is met while
   *  harder ones are still open. */
  progress: number;
  have?: number;
  target?: number;
  /** The hardest target in the group, when it is not the one shown. */
  finalTarget?: number;
  /** The summed weight of every request in the group, because that is what the
   *  planner prices — see the aggregation below. */
  weight: number;
  /** How many requests were merged. Not `askers.length`: two requests from the
   *  same feature are two weights but one asker. */
  asks: number;
  askers: string[];
}

const URGENCY_ORDER: Record<string, number> = { blocking: 0, wanted: 1, nice: 2, income: 3 };

function groupRequests(plan: CareerPlan | undefined): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const request of plan?.serving ?? []) {
    const urgency = request.urgency ?? "income";
    const key = `${urgency}|${request.kind}|${request.subject ?? ""}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        kind: request.kind,
        ...(request.subject !== undefined ? { subject: request.subject } : {}),
        urgency,
        progress: request.progress,
        ...(request.have !== undefined ? { have: request.have } : {}),
        ...(request.target !== undefined ? { target: request.target } : {}),
        ...(request.target !== undefined ? { finalTarget: request.target } : {}),
        weight: request.weight,
        asks: 1,
        askers: request.by ? [request.by] : [],
      });
      continue;
    }
    // Weights ADD, they do not compete. Two factions wanting the same
    // `companyRep` at weight 1 are a weight-2 outcome everywhere in the
    // decision path — `needWeights` and `needValueSeconds` sum same-key
    // requests (shared/strategy/needs.ts), and `channelWorth` folds
    // `rankingValueSec` per key into one per-channel total
    // (shared/strategy/income.ts). Taking the maximum priced ONE asker for work
    // the planner priced N askers for, so the column an operator sorts by to
    // see what dominates the board ranked a single weight-3 ask above eleven
    // weight-1 asks worth 3.7x as much. A one-member group is unchanged.
    existing.weight += request.weight;
    existing.asks += 1;
    if (request.by && !existing.askers.includes(request.by)) existing.askers.push(request.by);
    // The furthest target is worth keeping — it is where this work ends — but
    // only as a note beside the milestone actually being shown.
    if (request.target !== undefined) {
      existing.finalTarget = Math.max(existing.finalTarget ?? request.target, request.target);
    }
    // A strictly closer request replaces the displayed milestone WHOLE.
    if (request.progress > existing.progress) {
      existing.progress = request.progress;
      if (request.have !== undefined) existing.have = request.have;
      if (request.target !== undefined) existing.target = request.target;
    }
  }
  return [...groups.values()].sort(
    (a, b) => (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9) || b.progress - a.progress,
  );
}

const REQUEST_COLUMNS: Column<RequestGroup>[] = [
  {
    id: "what",
    label: "wanted",
    left: true,
    sort: (r) => `${URGENCY_ORDER[r.urgency] ?? 9}${r.kind}`,
    cell: (r) => {
      const status = r.urgency === "blocking" ? "bad" : r.urgency === "wanted" ? "wait" : "off";
      return `${dot(status, r.urgency)}${esc(r.kind)}${r.subject ? `: <strong>${esc(r.subject)}</strong>` : ""}`;
    },
  },
  {
    id: "progress",
    label: "next",
    sort: (r) => r.progress,
    cell: (r) => {
      // The label is the milestone the bar measures; a harder one further out
      // is named in the tooltip rather than swapped into the label.
      const beyond =
        r.finalTarget !== undefined && r.target !== undefined && r.finalTarget > r.target
          ? `\nthen ${fmtNum(r.finalTarget, 0)}`
          : "";
      return meter(
        r.progress,
        r.have !== undefined && r.target !== undefined
          ? `${fmtNum(r.have, 0)} / ${fmtNum(r.target, 0)}`
          : fmtPct(r.progress),
        r.progress >= 1,
        `${fmtPct(r.progress)} of the way to the nearest milestone${beyond}`,
      );
    },
  },
  {
    id: "askers",
    label: "asked by",
    left: true,
    wrap: true,
    sort: (r) => r.askers.length,
    cell: (r) => {
      if (r.askers.length === 0) return `<span class="muted">—</span>`;
      // One asker names itself; many collapse to a count with the list behind
      // a hover, because the interesting fact is "eleven of them want this".
      if (r.askers.length <= 2) return `<span class="muted">${esc(r.askers.join(", "))}</span>`;
      return `<span class="muted" title="${esc(r.askers.join("\n"))}">${r.askers.length} requesters</span>`;
    },
  },
  {
    id: "weight",
    label: "weight",
    sort: (r) => r.weight,
    // A merged row's weight is a COMBINED ask, so the cell says so rather than
    // letting a number that changed meaning look like the one a single request
    // posted. Urgency is still part of the group key, so the sum is one band of
    // the channel, not the channel's whole worth.
    cell: (r) =>
      r.asks > 1
        ? `<span title="${esc(`${r.asks} asks, weights combined — this urgency band only`)}">${fmtNum(r.weight, 2)}</span>`
        : fmtNum(r.weight, 2),
  },
];

/** Expected karma REDUCTION per second — the planner's own `karmaPerSec`
 * (shared/strategy/career/crimes.ts), recomputed from fields already on the
 * row: a failed attempt still pays a quarter of the karma, so the factor is
 * `0.25 + 0.75 * chance`.
 *
 * `Math.abs` because the sign convention is not settled across the repo: the
 * probe copies the game's positive magnitude, one in-game consumer defends
 * against a negative one, and a negative rate here would claim karma is
 * RISING. `undefined` rather than a number whenever the inputs cannot support
 * one — an absent karma field on a replayed pre-field log, or a zero duration
 * — because Infinity and 0 both read as measurements. */
function karmaRate(crime: { karma?: number; chance?: number; timeMs?: number }): number | undefined {
  const karma = crime.karma;
  const timeMs = crime.timeMs;
  if (karma === undefined || !Number.isFinite(karma)) return undefined;
  if (timeMs === undefined || !(timeMs > 0)) return undefined;
  return ((0.25 + 0.75 * (crime.chance ?? 0)) * Math.abs(karma)) / (timeMs / 1000);
}

/** Skill keys shortened so the per-attempt experience table fits one wrapped
 * cell. Keys arrive off the wire as a bare record, so an unknown one is passed
 * through (and escaped) rather than dropped. */
const EXP_SHORT: Record<string, string> = {
  hacking: "hack",
  strength: "str",
  defense: "def",
  dexterity: "dex",
  agility: "agi",
  charisma: "cha",
  intelligence: "int",
};

export const careerTab: Tab = {
  id: "career",
  render(state: ProjectedState) {
    const c = state.topics.career;
    if (!c) return waitingPanel("Career", "the career probe");

    // --- observed work and the structured decision beside it ---
    const work = c.currentWork;
    const plan = c.plan;
    const nowParts: string[] = [];
    if (work) {
      nowParts.push(
        // The faction work SUBTYPE belongs on this line: `doing FACTION:
        // Sector-12` cannot say whether that is hacking, field or security
        // work, and the continuation guard decides on exactly that field
        // (`work.workType !== last.workType` in shared/strategy/factions/
        // decide.ts). The factions tab cannot cover it either — while the work
        // runs, that plan emits `idle / continue` and carries no subtype.
        `<div class="row"><span class="muted">doing</span> <strong>${esc(work.type)}</strong>` +
          `${work.detail ? `: ${esc(work.detail)}` : ""}` +
          `${work.workType ? ` <span class="muted">${esc(work.workType)}</span>` : ""}` +
          `${work.focused ? "" : ` <span class="muted">(unfocused)</span>`}</div>`,
      );
      if (work.cyclesWorked !== undefined) {
        // Cycles are 200 ms of game time each; the raw count means nothing.
        // The observation is up to a probe interval (30 s) old, so the driver
        // reconstructs elapsed time as `cyclesWorked*200 + (now - observedAt)`
        // (game/lib/features/career.ts) and this line does the same — but only
        // when the observation is STAMPED. `observedAt` is optional on the wire
        // and real records omit it; folding an absent stamp in made the whole
        // sum NaN, which fmtTime renders as "–", erasing the figure the drift
        // was meant to sharpen. The age is shown rather than silently baked in,
        // so both the reconstruction and what it rests on are visible.
        //
        // CrimeWork keeps `cyclesWorked` cumulative across repeated units, so
        // this is time in the ACTIVITY, not the age of the current unit.
        const drift = work.observedAt !== undefined ? Math.max(0, nowFor(state) - work.observedAt) : 0;
        nowParts.push(
          `<div class="muted">${fmtTime(work.cyclesWorked * 200 + drift)} spent so far ` +
            `(${fmtNum(work.cyclesWorked, 0)} cycles, ${stamp(state, work.observedAt, "observed ")})</div>`,
        );
      }
    } else {
      nowParts.push(`<div class="row"><span class="muted">doing</span> <span class="muted">nothing</span></div>`);
    }

    if (plan) {
      // `plan.priority` describes `ranked[0]`, NOT the emitted action — the
      // producer states it at its own claim site ("`ranked[0]` is the option the
      // slot would actually run — the emitted action can be idle or continue",
      // game/lib/features/career.ts). `stepCareer` returns idle with the ranking
      // intact whenever the best option needs a slot career does not hold,
      // whenever the crime menu is still filling, and whenever progress work is
      // in flight, so hanging the band and BN-seconds off the chosen action
      // printed `chose idle (blocking, worth 14.20s)`: doing nothing, priced as
      // the thing we would rather be doing. In the steady state where another
      // feature owns the slot that was every frame's reading.
      //
      // `stop` is NOT a hold — it is an action career took to cancel abandoned
      // work — so it keeps the `chose` row and only loses the parenthetical.
      const top = plan.ranked[0];
      const holding = plan.action.type === "idle" && top !== undefined;
      // With an empty ranking the producer's `?? 0` publishes a confident
      // `worth 0.00s` for a number nobody measured, so there is no bid to state.
      const bid = top && plan.priority
        ? ` <span class="muted">(${esc(plan.priority.band)}, worth ${fmtNum(plan.priority.value, 2)}s)</span>`
        : "";
      if (holding) {
        // Why the leader is not running is on the wire in another topic: the
        // arbiter's slot holder. The bids themselves already have a table on the
        // BitNode tab, so this links there rather than copying it.
        const slot = state.topics.arbitration?.slot;
        nowParts.push(
          `<div class="row"><span class="muted">holding</span> ` +
            (slot && slot.by !== "career"
              ? `<a href="#/${esc(slot.by)}">${esc(slot.by)}</a> ` +
                `<span class="muted">has the work slot, ${fmtTime(slot.heldMs)} so far</span>`
              : `<span class="muted">nothing started this pass</span>`) +
            `</div>`,
        );
      } else {
        nowParts.push(
          `<div class="row"><span class="muted">chose</span> ` +
            `<strong>${esc(plan.action.type)}${plan.action.subject ? `: ${esc(plan.action.subject)}` : ""}</strong>` +
            `${plan.action.field ? ` <span class="muted">${esc(plan.action.field)}</span>` : ""}` +
            `${plan.action.type === "stop" ? "" : bid}</div>`,
        );
      }
      // Stated as the leader's own price whenever the leader is not what ran.
      if (top && (holding || plan.action.type === "stop")) {
        nowParts.push(
          `<div class="row"><span class="muted">best option</span> <strong>${esc(top.label)}</strong>${bid}</div>`,
        );
      }
      if (plan.incomeFallback) {
        // The flag is computed from `best`, so on a hold it describes the option
        // that leads the ranking, not one that was chosen.
        nowParts.push(
          note(
            holding
              ? "the best option serves no posted need — it leads on the rates it produces"
              : "the chosen option serves no posted need — it won on the rates it produces",
          ),
        );
      }
      if (plan.lastResult) {
        // `lastResult` persists across idle and backed-off decisions, so show
        // its timestamp to distinguish retained history from current state.
        nowParts.push(
          `<div class="row"><span class="muted">last</span> ` +
            `<span class="${plan.lastResult.ok ? "good" : "bad"}">${esc(plan.lastResult.action)}: ${esc(
              plan.lastResult.detail,
            )}</span> ${stamp(state, plan.lastResult.at)}</div>`,
        );
      }
      const schedule = plan.schedule;
      if (schedule) {
        const last = schedule.lastCompletion;
        // The plan is only re-merged when the review is DUE, and progress mode
        // is never due (shared/strategy/career/schedule.ts) — so while a Heist
        // or a program write runs, this decision can be ten minutes old while
        // `mode`/`reason` still describe the frame it was made in. Hence
        // "decided", dated: the age is the load-bearing half.
        //
        // An absent `nextReviewAt` is not one state: progress mode publishes
        // none because the completion is the next review, and idle mode
        // publishes none because the driver re-decides at frame rate.
        const next =
          schedule.nextReviewAt !== undefined
            ? `next review in ${fmtTime(Math.max(0, schedule.nextReviewAt - nowFor(state)))}`
            : schedule.mode === "progress"
              ? "next review at completion"
              : schedule.mode === "idle"
                ? "re-decided every frame"
                : "no next review published";
        nowParts.push(
          `<div class="muted">decided ${esc(ago(state, schedule.reviewedAt))} on ${esc(schedule.reason)} / ${esc(schedule.mode)}` +
            `; ${esc(next)}` +
            (last
              ? `; last completion ${esc(last.type)}${last.detail ? `: ${esc(last.detail)}` : ""} ` +
                // Wall time made a replayed completion read hours old, and grew
                // while scrubbing backwards; the run's own clock is the only
                // reference that means anything here.
                `${esc(ago(state, last.at))}`
              : "") +
            `</div>`,
        );
      }
    } else {
      nowParts.push(waiting("the first career decision"));
    }

    // --- karma, the gate other features wait on ---
    const karmaFrac = Math.max(0, Math.min(1, c.karma / GANG_KARMA));
    const summary = tiles([
      { label: "city", value: c.city },
      { label: "people killed", value: String(c.numPeopleKilled) },
      { label: "entropy", value: String(c.entropy) },
      { label: "playtime", value: fmtTime(c.totalPlaytime) },
    ]);
    const karma =
      `<div class="row"><span class="muted">karma</span> ${fmtNum(c.karma, 0)} ` +
      `<span class="muted">of ${fmtNum(GANG_KARMA, 0)} for a gang</span></div>` +
      meter(karmaFrac, fmtPct(karmaFrac), karmaFrac >= 1, "progress toward the BN2 gang gate");

    // --- skills, as progress rather than totals ---
    const skillRows = SKILLS.map((key) => {
      const exp = c.exp[key] ?? 0;
      const level = c.skills[key] ?? 0;
      const progress = skillProgress(exp, skillMultiplier(state, key));
      // Trust the multiplier only when it reproduces the level the game
      // reports. If it does not, the progress bar would be confidently wrong —
      // and silently so, since both numbers look plausible — so the row falls
      // back to the raw experience with no bar at all.
      if (progress.level !== level) {
        return [esc(key), String(level), `<span class="muted">${fmtNum(exp, 0)} exp</span>`];
      }
      return [
        esc(key),
        String(level),
        // The experience number alone cannot say whether a level is imminent.
        meter(progress.fraction, `${fmtNum(progress.remaining, 0)} to ${level + 1}`, false, `${fmtNum(exp, 0)} total exp`),
      ];
    });

    const requests = groupRequests(plan);
    // A card cannot infer a decision mode from an empty list. With no plan on
    // the wire there has been no decision at all — the driver requires
    // Singularity, so `plan` is absent for a whole pre-SF4 BitNode while the
    // local probe keeps filling this topic — and even with a plan the `stop` and
    // empty-ranking branches report `incomeFallback: false` with nothing being served.
    const noRequests = !plan
      ? waiting("the first career decision")
      : note(plan.incomeFallback ? "no open career requests — earning instead (see Now)" : "no open career requests");
    // No `empty` option on the table: it is only built when there are rows, and
    // carrying a second wording for the empty case is what let the two drift.
    const requestTable = requests.length
      ? dataTable("career.requests", requests, REQUEST_COLUMNS, { defaultSort: { key: "what", dir: 1 } })
      : noRequests;

    // The decision trail marks the option that is RUNNING, keyed off `ranked[0]`
    // by identity rather than by label: "continue"/"stop"/"idle" are decision
    // verbs that never appear as an option label, and the published label drops
    // `action.field`, so "apply: ECorp" can legitimately appear twice. Every
    // non-idle/non-stop return in `stepCareer` is built from `ranked[0]`, and
    // `dataTable` sorts a copy and hands `rowClass` the row object, so the mark
    // survives re-sorting. On an idle or stop pass nothing is marked — giving
    // the leader `.picked` there would claim work the feature is not doing.
    const chosen = plan && plan.action.type !== "idle" && plan.action.type !== "stop" ? plan.ranked[0] : undefined;
    const options = plan?.ranked.length
      ? dataTable(
          "career.options",
          plan.ranked,
          [
            { id: "label", label: "option", left: true, sort: (o) => o.label, cell: (o) => esc(o.label) },
            {
              id: "priority",
              label: "band",
              sort: (o) => URGENCY_ORDER[o.priority ?? "income"] ?? 9,
              cell: (o) => `<span class="muted">${esc(o.priority ?? "income")}</span>`,
            },
            { id: "score", label: "BN-sec", sort: (o) => o.score, cell: (o) => `${fmtNum(o.score, 4)}s` },
            {
              // Why a score is below what its channels are worth: an option that
              // must OCCUPY the slot before it delivers only gets the part of the
              // run that is left once it has finished. Blank for ordinary work,
              // which produces for as long as it holds the slot.
              id: "delivers",
              label: "delivers",
              sort: (o) => o.deliveryFraction ?? 1,
              cell: (o) => o.deliveryFraction !== undefined && o.deliveryFraction < 1
                ? `<span class="muted">${fmtNum(o.deliveryFraction * 100, 3)}% of horizon</span>`
                : "",
            },
            {
              id: "money",
              label: "$/sec",
              sort: (o) => o.moneyPerSec,
              cell: (o) => `${fmtMoney(o.moneyPerSec)}/s`,
            },
            {
              id: "contributions",
              label: "priced inputs",
              left: true,
              wrap: true,
              sort: (o) => o.contributions?.length ?? 0,
              cell: (o) => o.contributions?.length
                ? o.contributions.map((part) =>
                    `${esc(part.kind)}${part.subject ? `:${esc(part.subject)}` : ""} ` +
                    `${fmtNum(part.perSec, 4)}/s of a channel worth ${fmtNum(part.worthSec, 3)}s → ${fmtNum(part.valueSec, 4)}s`,
                  ).join("<br>")
                : `<span class="muted">nothing priced</span>`,
            },
          ],
          {
            defaultSort: { key: "score", dir: -1 },
            limit: 12,
            empty: "no viable career options",
            rowClass: (o) => (o === chosen ? "picked" : ""),
          },
        ) + (chosen === undefined ? note("nothing started this pass — the top row is the bid, not the work") : "")
      : note("no viable career options");

    const jobs = Object.keys(c.jobs).length
      ? table(
          ["company", "position", "rep", "favor"],
          Object.entries(c.jobs).map(([company, position]) => [
            esc(company),
            esc(position),
            c.companies?.[company] ? fmtNum(c.companies[company]!.rep, 0) : "–",
            c.companies?.[company] ? fmtNum(c.companies[company]!.favor, 1) : "–",
          ]),
          { left: [0, 1] },
        )
      : note("no jobs held");

    const crimes = c.crimes
      ? dataTable(
          "career.crimes",
          c.crimes,
          [
            { id: "name", label: "crime", left: true, sort: (x) => x.name, cell: (x) => esc(x.name) },
            {
              id: "rate",
              label: "$/sec",
              sort: (x) => x.moneyPerSec,
              cell: (x) => `${fmtMoney(x.moneyPerSec)}/s`,
            },
            {
              id: "chance",
              label: "chance",
              sort: (x) => x.chance,
              cell: (x) => meter(x.chance, fmtPct(x.chance), x.chance >= 1),
            },
            { id: "money", label: "payout", sort: (x) => x.money, cell: (x) => fmtMoney(x.money) },
            { id: "time", label: "time", sort: (x) => x.timeMs, cell: (x) => fmtTime(x.timeMs) },
            {
              // The per-attempt karma is not the question this card exists to
              // answer. Printed raw under a meter counting toward -54,000 it
              // ranked Heist (15 karma per ten minutes) above Homicide (3 per
              // three seconds), so sorting the column put the best karma farm in
              // the game near the bottom. The rate is the planner's own
              // `karmaPerSec`; the per-attempt figure stays in the tooltip so a
              // reader can still cross-check the game's crime menu.
              id: "karma",
              label: "karma/s down",
              sort: (x) => karmaRate(x) ?? -1,
              cell: (x) => {
                const rate = karmaRate(x);
                if (rate === undefined) {
                  return `<span class="muted" title="no karma or duration on this record — not measured">${NONE}</span>`;
                }
                return `<span title="${esc(
                  `each attempt costs ${fmtNum(Math.abs(x.karma), 2)} karma; karma counts DOWN toward the gang gate`,
                )}">${fmtNum(rate, 3)}</span>`;
              },
            },
            {
              // The experience table is a decision input, not decoration: the
              // combat-stat gates other features wait on are trained here, and
              // the planner prices a combat need as the MINIMUM of the four
              // combat exp rates. Per successful attempt, as published — turning
              // it into a rate would mean re-deriving the multipliers the
              // planner applies, and the viewer does not re-derive the
              // objective. Zero-valued skills are skipped, matching the
              // planner's own `expPerSec`.
              id: "exp",
              label: "exp / attempt",
              left: true,
              wrap: true,
              sort: (x) => Object.values(x.exp ?? {}).reduce((sum, amount) => sum + amount, 0),
              cell: (x) => {
                const parts = Object.entries(x.exp ?? {})
                  .filter(([, amount]) => amount > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([skill, amount]) => `${esc(EXP_SHORT[skill] ?? skill)} ${fmtNum(amount, 1)}`);
                return parts.length ? `<span class="muted">${parts.join(" · ")}</span>` : `<span class="muted">${NONE}</span>`;
              },
            },
            {
              // Blank at zero, dash when the field never arrived: absence is not
              // "this crime kills nobody".
              id: "kills",
              label: "kills",
              sort: (x) => x.kills ?? -1,
              cell: (x) => (x.kills === undefined ? `<span class="muted">${NONE}</span>` : x.kills > 0 ? fmtNum(x.kills, 0) : ""),
            },
          ],
          {
            defaultSort: { key: "rate", dir: -1 },
            limit: 15,
            empty: "no crimes ranked",
            // Marks what is RUNNING, off the observed work rather than off
            // `plan.action.subject`: the chosen crime and the running one differ
            // while a completion is pending, and `subject` is a bare string
            // shared with company, course and travel actions. The join is the
            // one the game side already uses (`crime.name === work.detail`).
            rowClass: (x) =>
              work?.type?.toUpperCase() === "CRIME" && work.detail === x.name ? "picked" : "",
          },
        )
      : note("crime ranking needs BN4 or SF4 (Singularity)");

    return (
      `<div class="col wide">` +
      card("Now", nowParts.join("")) +
      card("Wanted from career", requestTable) +
      card("Crime ranking", crimes) +
      `</div>` +
      `<div class="col">` +
      card("Career", summary + karma) +
      card("Skills", table(["skill", "level", "next"], skillRows, { left: [0] })) +
      card("Employment", jobs) +
      card(
        "Ranked options",
        collapsible(
          "career.ranked",
          // "N option(s) scored" was a claim about the size of the RANKING, and
          // the digest carries `ranked.slice(0, 8)` with no total beside it —
          // while the menu is routinely 20-30 priced options (12 crimes, the
          // training courses, the requested port openers, per-company
          // apply/promote/quit/travel). So the count is worded as what was
          // published. The true count needs `rankedTotal` on the career topic,
          // which is a producer change this panel cannot make.
          plan?.ranked.length
            ? html`<span title="the digest publishes the leading options only; the size of the full ranking is not on the wire">top ${String(plan.ranked.length)} scored option(s)</span>`
            : "no scored options",
          options,
        ),
      ) +
      `</div>`
    );
  },
};

/** Exported for the tests: the grouping is the load-bearing part of this
 * panel, and it is pure. */
export { groupRequests };
