import { skillProgress } from "../../../shared/formulas.ts";
import type { CareerPlan } from "../../../shared/telemetry/topics/career.ts";
import { card, collapsible, dataTable, definitions, dot, meter, note, table, tiles, type Column } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Career tab: stats, karma and work. Karma is here because it is the gate
 * other features wait on — BN2's gang needs -54,000 of it.
 *
 * The panel is organised around what the feature is DOING, not around the
 * shape of its data structures. The old layout put "selected: idle" in one
 * card, the work it was actually running in another, and the twenty-five
 * requests behind the decision in a third — so answering "why is it idle"
 * meant reading three tables and joining them by eye. Now: what we are doing
 * and why, then what is asking for it, then what else was considered. */

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
  weight: number;
  askers: string[];
  whys: string[];
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
        askers: request.by ? [request.by] : [],
        whys: request.why ? [request.why] : [],
      });
      continue;
    }
    existing.weight = Math.max(existing.weight, request.weight);
    if (request.by && !existing.askers.includes(request.by)) existing.askers.push(request.by);
    if (request.why && !existing.whys.includes(request.why)) existing.whys.push(request.why);
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
      return `<span class="muted" title="${esc(r.whys.join("\n"))}">${r.askers.length} requesters</span>`;
    },
  },
  { id: "weight", label: "weight", sort: (r) => r.weight, cell: (r) => fmtNum(r.weight, 2) },
];

export const careerTab: Tab = {
  id: "career",
  render(state: ProjectedState) {
    const c = state.topics.career;
    if (!c) return note("waiting for the career probe");

    // --- what we are doing, and why ---
    const work = c.currentWork;
    const plan = c.plan;
    const nowParts: string[] = [];
    if (work) {
      nowParts.push(
        `<div class="row"><span class="muted">doing</span> <strong>${esc(work.type)}</strong>` +
          `${work.detail ? `: ${esc(work.detail)}` : ""}` +
          `${work.focused ? "" : ` <span class="muted">(unfocused)</span>`}</div>`,
      );
      if (work.cyclesWorked !== undefined) {
        // Cycles are 200 ms of game time each; the raw count means nothing.
        nowParts.push(
          `<div class="muted">${fmtTime(work.cyclesWorked * 200)} spent so far (${fmtNum(work.cyclesWorked, 0)} cycles)</div>`,
        );
      }
    } else {
      nowParts.push(`<div class="row"><span class="muted">doing</span> <span class="muted">nothing</span></div>`);
    }

    if (plan) {
      nowParts.push(
        `<div class="row"><span class="muted">chose</span> ` +
          `<strong>${esc(plan.action.type)}${plan.action.subject ? `: ${esc(plan.action.subject)}` : ""}</strong>` +
          `${plan.priority ? ` <span class="muted">(${esc(plan.priority.band)} ${fmtNum(plan.priority.value, 2)})</span>` : ""}</div>` +
          `<div class="muted">${esc(plan.action.why)}</div>`,
      );
      // The decision rationale and the action rationale are different things
      // and the old layout showed them as two anonymous rows of a definition
      // list; when they disagree, that is the interesting case.
      if (plan.why && plan.why !== plan.action.why) {
        nowParts.push(`<div class="muted">${esc(plan.why)}</div>`);
      }
      if (plan.incomeFallback) {
        nowParts.push(note("no posted need could be served — this is the income fallback"));
      }
      if (plan.lastResult) {
        nowParts.push(
          `<div class="row"><span class="muted">last</span> ` +
            `<span class="${plan.lastResult.ok ? "good" : "bad"}">${esc(plan.lastResult.action)}: ${esc(
              plan.lastResult.detail,
            )}</span></div>`,
        );
      }
      const schedule = plan.schedule;
      if (schedule) {
        const last = schedule.lastCompletion;
        nowParts.push(
          `<div class="muted">reviewed on ${esc(schedule.reason)} / ${esc(schedule.mode)}` +
            (last
              ? `; last completion ${esc(last.type)}${last.detail ? `: ${esc(last.detail)}` : ""} ` +
                `${fmtTime(Date.now() - last.at)} ago`
              : "") +
            `</div>`,
        );
      }
    } else {
      nowParts.push(note("waiting for the first career decision"));
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
    const requestTable = requests.length
      ? dataTable("career.requests", requests, REQUEST_COLUMNS, {
          defaultSort: { key: "what", dir: 1 },
          empty: "no open career requests",
        })
      : note("no open career requests; income fallback is active");

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
            { id: "score", label: "score", sort: (o) => o.score, cell: (o) => fmtNum(o.score, 4) },
            {
              id: "money",
              label: "$/sec",
              sort: (o) => o.moneyPerSec,
              cell: (o) => `${fmtMoney(o.moneyPerSec)}/s`,
            },
            {
              id: "why",
              label: "why",
              left: true,
              wrap: true,
              sort: (o) => o.why,
              cell: (o) => `<span class="muted">${esc(o.why)}</span>`,
            },
          ],
          { defaultSort: { key: "score", dir: -1 }, limit: 12, empty: "no viable career options" },
        )
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
            { id: "karma", label: "karma", sort: (x) => x.karma, cell: (x) => fmtNum(x.karma, 1) },
          ],
          { defaultSort: { key: "rate", dir: -1 }, limit: 15, empty: "no crimes ranked" },
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
      card("Ranked options", collapsible("career.ranked", `${plan?.ranked.length ?? 0} option(s) scored`, options)) +
      `</div>`
    );
  },
};

/** Exported for the tests: the grouping is the load-bearing part of this
 * panel, and it is pure. */
export { groupRequests };
