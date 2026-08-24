import { stamp } from "../lib/clock.ts";
import { NONE, bar, card, dataTable, dot, hint, meter, note, outcome, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import { html, type Markup } from "../lib/html.ts";
import { ASCEND_THRESHOLD, CLASH_CONFIDENCE } from "../../../shared/strategy/gang/decide.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

const STATS = ["hack", "str", "def", "dex", "agi", "cha"] as const;

export const gangTab: Tab = {
  id: "gang",
  render(state: ProjectedState) {
    const g = state.topics.gang;
    if (!g) return waitingPanel("Gang", "the gang probe");

    // Three states, and the wire distinguishes them: `respectForNextRecruit` is
    // `Infinity` upstream once the roster is at GangConstants.MaximumGangMembers
    // and JSON.stringify flattens that to `null`, so a FULL roster arrives as
    // null — the terminal, best state of the roster, which used to print as
    // "next at – respect", the app's own symbol for "not measured".
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Gang/Gang.ts#L316-L323
    // `Number.isFinite` cannot be the test: it is false for `null` (roster full)
    // AND for `undefined` (a replay from before the field existed), which are
    // different facts. Read the wire value instead, and do not count
    // `members.length` against 12 — that constant belongs to the game and an
    // untracked copy of it here would go stale silently.
    const nextRecruit = g.respectForNextRecruit as number | null | undefined;
    const recruitable = g.recruitsAvailable as number | undefined;
    const memberSub = g.canRecruit
      ? recruitable === undefined
        ? "can recruit"
        : `${fmtNum(recruitable, 0)} recruitable now`
      : nextRecruit === null
        ? "roster full"
        : `next at ${fmtNum(nextRecruit, 0)} respect`;

    const summary = tiles([
      { label: "faction", value: g.faction, sub: g.isHacking ? "hacking gang" : "combat gang" },
      { label: "respect", value: fmtNum(g.respect, 0), sub: `${fmtNum(g.respectGainRate, 2)}/s` },
      {
        label: "wanted",
        value: fmtNum(g.wantedLevel, 2),
        sub: `penalty ${fmtPct(1 - g.wantedPenalty)}`,
      },
      { label: "income", value: `${fmtMoney(g.moneyGainRate)}/s` },
      { label: "territory", value: fmtPct(g.territory, 2) },
      { label: "power", value: fmtNum(g.power, 0) },
      { label: "members", value: String(g.members.length), sub: memberSub },
      ...(g.bonusTime ? [{ label: "bonus time", value: fmtTime(g.bonusTime) }] : []),
    ]);

    type Member = (typeof g.members)[number];
    const skillColumn = (id: keyof Member["skills"]) => ({
      id: String(id),
      label: String(id),
      cell: (m: Member) => String(m.skills[id]),
      sort: (m: Member) => m.skills[id],
    });

    // What ascending costs, spelled out in the cell title. `ascensionResult.respect`
    // is NOT part of the gain: upstream sets it to the member's earnedRespect and
    // `ascend()` returns it as respectToDeduct, so it is the respect ascending
    // DESTROYS — a tooltip that listed it beside the multipliers without saying so
    // would assert the opposite of the truth.
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Gang/GangMember.ts#L330-L334
    const ascTitle = (m: Member, result: NonNullable<Member["ascensionResult"]>): string =>
      `${g.isHacking ? "hack multiplier" : "min(str, def, dex, agi)"} of the reported result; ` +
      `gain ${STATS.map((k) => `${k} ${fmtNum(result[k], 2)}`).join(" ")}; ` +
      `current ${STATS.map((k) => `${k} ${fmtNum(m.ascMults[k], 2)}`).join(" ")}; ` +
      `respect lost ${fmtNum(result.respect, 0)} of ${fmtNum(m.earnedRespect, 0)} earned; ` +
      `ascends at ${ASCEND_THRESHOLD}x`;

    // The scalar the ascension decision is taken on, and the reason the column
    // label names the reduction: the probe reduces the per-stat result to ONE
    // number differently per gang — `result.hack` for a hacking gang,
    // `min(str, def, dex, agi)` for a combat one (game/lib/probes/dodged.ts).
    //
    // Three distinct states collapse onto 0 on the way here — the record has no
    // `ascensionGain` at all, the probe wrote 0 because the game returned no
    // ascension result (it does that until the member has earned enough exp), and
    // a genuinely measured 0 — so none of them may render as a confident "0.00x".
    const ascCell = (m: Member): Markup => {
      const gain = g.ascensionGain?.[m.name];
      if (gain === undefined) return html`<span class="muted" title="this record carries no ascension gain for this member">${NONE}</span>`;
      const result = m.ascensionResult;
      if (!result) {
        return html`<span class="muted" title="the game reports an ascension result only once the member has earned enough experience to gain anything">not yet</span>`;
      }
      const label = `${gain.toFixed(2)}x`;
      return gain >= ASCEND_THRESHOLD
        ? html`<span class="good" title="${ascTitle(m, result)}">${label}</span>`
        : html`<span title="${ascTitle(m, result)}">${label}</span>`;
    };

    const members = dataTable("gang.members", g.members, [
      { id: "name", label: "member", left: true, cell: (m) => esc(m.name), sort: (m) => m.name },
      { id: "task", label: "task", left: true, cell: (m) => esc(m.task), sort: (m) => m.task },
      { id: "respect", label: "respect/s", cell: (m) => fmtNum(m.respectGain, 3), sort: (m) => m.respectGain },
      {
        id: "wanted",
        label: "wanted/s",
        cell: (m) => `<span class="${m.wantedLevelGain > 0 ? "bad" : "good"}">${fmtNum(m.wantedLevelGain, 3)}</span>`,
        sort: (m) => m.wantedLevelGain,
      },
      { id: "money", label: "$/s", cell: (m) => fmtMoney(m.moneyGain), sort: (m) => m.moneyGain },
      {
        id: "asc",
        label: g.isHacking ? "hack asc" : "combat asc",
        cell: ascCell,
        // An absent gain sorts BELOW a measured zero: it is not a small number,
        // it is no number.
        sort: (m) => g.ascensionGain?.[m.name] ?? -1,
      },
      skillColumn("hack"),
      skillColumn("str"),
      skillColumn("def"),
      skillColumn("dex"),
      skillColumn("agi"),
      skillColumn("cha"),
      { id: "aug", label: "aug", cell: (m) => String(m.augmentations), sort: (m) => m.augmentations },
    ], { defaultSort: { key: "respect", dir: -1 }, empty: "no members recruited" });

    // `ns.gang.getAllGangInformation()` returns every entry of AllGangs INCLUDING
    // our own, and `getChanceToWinClash` against ourselves is
    // power / (power + power) = exactly 0.5 by construction. That row is an
    // artefact of the API, not a rival, and it was listed here under the header
    // "rival gang" on every run.
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Gang.ts#L105-L113
    const rivals = Object.entries(g.clashChances ?? {}).filter(([name]) => name !== g.faction);
    // Warfare is decided on the WORST clash chance, not on the best or the
    // average — and `decide.ts` takes that minimum over `clashChances`
    // UNFILTERED, so the artefact row named above is one of its inputs, at
    // exactly 0.5. Its input is not this panel's to improve: marking the worst
    // RIVAL and captioning it "the decision is taken on this row" would report a
    // met gate on every pass where the controller is refusing to fight because of
    // a row that is not a rival at all. So both numbers are computed, the mark is
    // claimed only where the two populations agree, and the note prints the
    // decider's own figure beside the rival one.
    const worst = rivals.length > 0 ? Math.min(...rivals.map(([, chance]) => chance)) : undefined;
    const decided = g.clashChances && Object.keys(g.clashChances).length > 0
      ? Math.min(...Object.values(g.clashChances), 1)
      : undefined;
    const decides = worst !== undefined && worst === decided;
    const gate = `warfare engages only when the worst clash chance the API reports — our own gang included, always 50% —`
      + ` clears ${fmtPct(CLASH_CONFIDENCE, 0)}`;
    const clash = g.clashChances
      ? table(
          ["rival gang", "win chance"],
          rivals
            .sort((a, b) => b[1] - a[1])
            .map(([name, chance]) => [
              chance === worst
                ? html`${dot(
                    decided !== undefined && decided >= CLASH_CONFIDENCE ? "good" : "wait",
                    decides
                      ? `the warfare decision is taken on this row: ${gate}`
                      : `the lowest rival odds, but not what decides:`
                        + ` the decider's worst is ${fmtPct(decided)} — ${gate}`,
                  )} ${name}`
                : esc(name),
              // `atTarget` is the strategy's gate, not a half-way mark: at the old
              // literal 0.5 a 55% rival was painted as won while the strategy was
              // refusing to fight it. `>=` matches decide.ts, boundary included.
              meter(chance, fmtPct(chance), chance >= CLASH_CONFIDENCE, gate),
            ]),
          { left: [0], empty: "no rival gangs reported" },
        )
      : note("clash odds need the detail probe");

    const territoryBar = bar([
      { label: "ours", value: g.territory, className: "s1" },
      { label: "rivals", value: Math.max(0, 1 - g.territory), className: "s4" },
    ]);

    // `territoryClashChance` is the chance a clash OCCURS on a tick — forced to 1
    // while warfare is engaged and decayed by 0.01 per cycle once it is not — so
    // it belongs beside the engaged/disengaged note as a frequency. It is emphatically
    // not a win chance and must never be shown as one.
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Gang/Gang.ts#L211-L215
    // The gate is quoted against the DECIDER's minimum, with the rival one beside
    // it: they differ whenever every rival sits above our own artefact row, which
    // is exactly the situation where the panel would otherwise announce a gate
    // the controller is not clearing.
    const territoryNote = note(
      `${g.territoryWarfareEngaged ? "warfare engaged" : "warfare disengaged"} — clashes roll at ` +
        `${fmtPct(g.territoryClashChance)} per tick · worst rival ` +
        `${worst === undefined ? NONE : fmtPct(worst)} · decided on ` +
        `${decided === undefined ? NONE : fmtPct(decided)} against a ${fmtPct(CLASH_CONFIDENCE, 0)} gate`,
    );

    const plan = g.plan;
    // The driver applies exactly ONE action per 10 s pass — it takes
    // `actions.find((a) => a.type !== "idle")` and executes that alone
    // (game/lib/features/remaining.ts) — so the ORDER stepGang pushes them in
    // (recruit, then ascensions, then assignments, then warfare) is load-bearing:
    // the head of the array is what this pass will attempt, and everything behind
    // it waits. Never sort or filter `plan.actions` before rendering, and never
    // label a row "queued" as if the whole array were applied together.
    const queued = plan ? plan.actions.filter((action) => action.type !== "idle") : [];
    const next = queued[0];

    type PlanAction = (typeof queued)[number];
    const target = (action: PlanAction): Markup => {
      // `engage: false` is a real decision — disengage — so it is tested against
      // `false` rather than falsiness, which would merge it with a missing field.
      if (action.type === "warfare") {
        return action.engage === true ? "engage" : action.engage === false ? "disengage" : NONE;
      }
      if (action.member === undefined) return NONE;
      return action.task === undefined ? esc(action.member) : `${esc(action.member)} → ${esc(action.task)}`;
    };
    const describe = (action: PlanAction): string =>
      action.type === "warfare"
        ? `warfare ${action.engage === true ? "engage" : action.engage === false ? "disengage" : NONE}`
        : action.member === undefined
          ? action.type
          : `${action.type} ${action.member}`;

    // Recruits, ascensions and warfare toggles were counted into the tile and then
    // never named anywhere — a queued ascension raised "changes" with nothing in
    // the DOM to account for it. Assignments keep their own table below, so this
    // one carries the rest of the queue, in execution order.
    const others = queued.filter((action) => action.type !== "assign");
    const otherActions = others.length > 0
      ? table(
          ["action", "target", "when"],
          others.map((action) => [
            esc(action.type),
            target(action),
            action === next ? "next" : hint("planned", "one action is applied per 10 s pass"),
          ]),
          { left: [0, 1, 2] },
        )
      : "";

    const decision = plan?.assignment
      ? tiles([
          { label: "search", value: plan.assignment.approximated ? "greedy" : "exact" },
          { label: "objective", value: fmtNum(plan.assignment.total, 4) },
          {
            label: "queued",
            value: String(queued.length),
            sub: next ? `next: ${describe(next)}` : "nothing to do",
          },
        ]) +
        otherActions +
        table(
          ["member", "selected task", "raw score", "change"],
          plan.assignment.choices.map((choice) => {
            const change = plan.actions.find((action) => action.type === "assign" && action.member === choice.member);
            return [
              esc(choice.member),
              esc(choice.task),
              fmtNum(choice.score, 4),
              !change
                ? "unchanged"
                : change === next
                  ? "next"
                  : hint("planned", "one action is applied per 10 s pass"),
            ];
          }),
          { empty: "no priced assignment", left: [0, 1, 3] },
        ) +
        // `lastResult` is a sticky module-level value on the game side, republished
        // with its ORIGINAL `at` every pass and rewritten only when an action is
        // actually attempted — and the driver returns early when everything is
        // idle. Undated, an hour-old "assign refused" reads as what just happened,
        // under tiles describing a current plan. The stamp goes INSIDE the outcome
        // line: appended after it, it would land as an orphan sibling of the <p>.
        (plan.lastResult
          ? outcome({
              ok: plan.lastResult.ok,
              detail: html`${plan.lastResult.detail} · ${stamp(state, plan.lastResult.at)}`,
            })
          : "")
      : plan
        ? note("this replay predates structured gang assignment scores")
        : waiting("the first gang decision");

    return (
      `<div class="col wide">` +
      card("Gang", summary + members) +
      card("Decision", decision) +
      `</div>` +
      `<div class="col">` +
      card("Territory", territoryBar + territoryNote) +
      card("Clash odds", clash) +
      `</div>`
    );
  },
};
