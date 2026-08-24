import { BLACK_OP_COUNT } from "../../../shared/strategy/progression/endgame.ts";
import { bar, card, dataTable, dot, NONE, note, outcome, rankedTable, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtNum, fmtPct, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

export const bladeburnerTab: Tab = {
  id: "bladeburner",
  render(state: ProjectedState) {
    const b = state.topics.bladeburner;
    if (!b) return waitingPanel("Bladeburner", "the bladeburner probe");

    const [stamina, staminaMax] = b.stamina;
    const summary = tiles([
      { label: "rank", value: fmtNum(b.rank, 0) },
      { label: "skill points", value: fmtNum(b.skillPoints, 0) },
      { label: "stamina", value: `${fmtNum(stamina, 0)} / ${fmtNum(staminaMax, 0)}`, sub: fmtPct(staminaMax ? stamina / staminaMax : 0) },
      { label: "city", value: b.city },
      { label: "action", value: b.current ? `${b.current.type}: ${b.current.name}` : "idle" },
      // The one black-op figure that survives completion: `next black op` below
      // disappears exactly when the last op lands, which is when the count
      // matters most. The denominator is the shared constant the endgame route
      // prices against, never a count of blackop rows in `b.actions` — that
      // census only exists after the ~28 GB detail probe sweeps, so counting
      // rows would let this tab and the BitNode route table print different
      // denominators for the same fact. An absent count reads as waiting and
      // never as 0; a fabricated 0 in that window already mispriced the
      // bladeburner route once (see the topic comment on `blackOpsComplete`).
      {
        label: "black ops",
        value: b.blackOpsComplete === undefined ? NONE : `${fmtNum(b.blackOpsComplete, 0)} / ${BLACK_OP_COUNT}`,
        sub: b.blackOpsComplete === undefined ? "waiting for the core probe" : undefined,
      },
      ...(b.nextBlackOp
        ? [{ label: "next black op", value: b.nextBlackOp.name, sub: `rank ${fmtNum(b.nextBlackOp.rank, 0)}` }]
        : []),
      ...(b.bonusTime ? [{ label: "bonus time", value: fmtTime(b.bonusTime) }] : []),
    ]);

    const staminaBar = bar([
      { label: "stamina", value: stamina, className: "s1" },
      { label: "spent", value: Math.max(0, staminaMax - stamina), className: "s4" },
    ]);

    // rank/sec is the DECIDER's number, joined on (type, name) rather than
    // recomputed here. `(chanceLow*rankGain - (1-chanceLow)*rankLoss)/seconds`
    // lives in shared/strategy/bladeburner/decide.ts, and a second copy in the
    // viewer would confidently print a score the controller never used the day
    // that policy changes. game/lib/features/remaining.ts publishes only
    // `decision.ranked.slice(0, 8)`, so rows past the top eight read NONE —
    // widening that slice is the game-side fix, not a UI recompute.
    const scored = new Map((b.plan?.ranked ?? []).map((entry) => [`${entry.actionType} ${entry.name}`, entry]));

    const actions = dataTable("bladeburner.actions", b.actions ?? [], [
      { id: "type", label: "type", left: true, cell: (a) => esc(a.type), sort: (a) => a.type },
      { id: "action", label: "action", left: true, cell: (a) => esc(a.name), sort: (a) => a.name },
      {
        id: "success",
        label: "success",
        cell: (a) =>
          a.chance[0] === a.chance[1] ? fmtPct(a.chance[0]) : `${fmtPct(a.chance[0])} – ${fmtPct(a.chance[1])}`,
        sort: (a) => a.chance[0],
      },
      { id: "time", label: "time", cell: (a) => fmtTime(a.timeMs), sort: (a) => a.timeMs },
      {
        // `getActionCountRemaining` returns Infinity for the five general
        // actions, and game/lib/telemetry.ts serialises records with a bare
        // JSON.stringify, so what reaches the viewer is null. The old
        // `>= 1e9` test never matched that — contract and operation counts are
        // small and a black op is 0 or 1 — so the infinity branch was dead and
        // Training / Diplomacy / Field Analysis / Recruitment / Hyperbolic
        // Regeneration read as "not measured" in the one column that should say
        // they never run out. Tested through Number.isFinite because the topic
        // still types this `number`; widening it to `number | null` the way
        // hacknet's `maxNumNodes` already is belongs to that file's own change.
        // The probe's finish() gate only publishes `actions` once every row was
        // measured, so a non-finite value here means unlimited, not absent.
        // The sort key is the half that was worse than cosmetic: dom.ts
        // compares numerically only when BOTH keys are numbers and `typeof
        // null` is "object", so null rows compared as strings and the
        // comparator was not transitive.
        id: "remaining",
        label: "remaining",
        cell: (a) => (Number.isFinite(a.countRemaining) ? fmtNum(a.countRemaining, 0) : "∞"),
        sort: (a) => (Number.isFinite(a.countRemaining) ? a.countRemaining : Infinity),
      },
      { id: "level", label: "level", cell: (a) => (a.maxLevel ? `${a.level ?? 0}/${a.maxLevel}` : NONE) },
      // The two measured inputs to the ranking, raw. Both are optional on the
      // digest (an older or partial record arrives without them), so an absent
      // one is NONE and never `?? 0` — a 0 would present a rank-losing action
      // as free.
      {
        id: "rankgain",
        label: "rank gain",
        cell: (a) => (a.rankGain === undefined ? NONE : fmtNum(a.rankGain, 1)),
        sort: (a) => a.rankGain ?? -Infinity,
      },
      {
        id: "rankloss",
        label: "rank loss",
        cell: (a) => (a.rankLoss === undefined ? NONE : fmtNum(a.rankLoss, 1)),
        sort: (a) => a.rankLoss ?? -Infinity,
      },
      {
        id: "rankpersec",
        label: "rank/sec",
        cell: (a) => {
          const entry = scored.get(`${a.type} ${a.name}`);
          return entry ? fmtNum(entry.rankPerSec, 3) : NONE;
        },
        sort: (a) => scored.get(`${a.type} ${a.name}`)?.rankPerSec ?? -Infinity,
      },
      {
        // `rankNeeded <= rank` is decide.ts's own predicate, mirrored exactly so
        // the tab and the plan can never disagree about which black op is
        // attemptable — and a rank-locked op is filtered out of `ranked`
        // altogether, so this census is the only surface that can say why it is
        // not being run. Undefined for contract/operation/general rows by
        // construction: NONE there, not "0" and not a 0-fraction meter.
        id: "rankreq",
        label: "rank req",
        cell: (a) =>
          a.rankNeeded === undefined
            ? NONE
            : html`${dot(
                a.rankNeeded <= b.rank ? "good" : "wait",
                `needs rank ${fmtNum(a.rankNeeded, 0)}, have ${fmtNum(b.rank, 0)}`,
              )} ${fmtNum(b.rank, 0)} / ${fmtNum(a.rankNeeded, 0)}`,
        sort: (a) => a.rankNeeded ?? 0,
      },
    ], { defaultSort: { key: "success", dir: -1 }, empty: "waiting for the bladeburner.actions probe" });

    const skills = Object.keys(b.skills ?? {}).length
      ? table(
          ["skill", "level", "next cost"],
          Object.entries(b.skills ?? {})
            .sort((a, c) => c[1].level - a[1].level)
            .map(([name, s]) => {
              // `getSkillUpgradeCost` returns Infinity once a skill sits at
              // maxLvl (Overclock caps at 90, and it is the cheapest skill this
              // policy buys, so a long run reaches it), and JSON.stringify
              // sends that as null. Without the finite guard `null <=
              // skillPoints` is true, so a skill that can never be bought again
              // was painted `good` — the one colour in this table that means
              // "spend points here". Rendered NONE rather than the word
              // "maxed": at the viewer a non-finite cost is only INFERRED to be
              // a cap, and a record that simply stopped carrying the field must
              // not be upgraded into that claim.
              const cost = Number.isFinite(s.upgradeCost) ? s.upgradeCost : undefined;
              const affordable = cost !== undefined && cost <= b.skillPoints;
              return [
                esc(name),
                String(s.level),
                `<span class="${affordable ? "good" : "muted"}">${cost === undefined ? NONE : fmtNum(cost, 0)}</span>`,
              ];
            }),
          { left: [0] },
        )
      : note("skill list needs the actions probe");

    const cities = b.cities?.length
      ? table(
          ["city", "population", "communities", "chaos"],
          b.cities.map((c) => [
            esc(c.name),
            fmtNum(c.population, 0),
            String(c.communities),
            `<span class="${c.chaos > 50 ? "bad" : ""}">${fmtNum(c.chaos, 1)}</span>`,
          ]),
          { left: [0] },
        )
      : note("city intel needs the cities probe");

    const plan = b.plan;
    const decision = plan
      ? tiles([
          {
            label: "selected",
            value: plan.action.type,
            sub: plan.action.name
              ? `${plan.action.actionType ?? "action"}: ${plan.action.name}`
              : plan.action.skill ?? undefined,
          },
          // `ranked` is `decision.ranked.slice(0, 8)`
          // (game/lib/features/remaining.ts) while the decider scores every
          // action with charges left, around forty of them — so printing the
          // length under "candidates" read a permanent "8" however large the
          // real candidate set was. No uncapped total is on the wire, so the
          // tile says which rows these ARE instead of claiming a total;
          // publishing `rankedTotal` beside the slice is what would let
          // rankedTable's shown/total note say how many were dropped.
          { label: "candidates", value: `top ${plan.ranked.length}`, sub: "the digest carries only the top slice" },
        ]) +
        // `stop` has two causes — stamina under the floor, and no non-black-op
        // candidate at all — and the plan publishes neither, so the panel says
        // so rather than guessing: the stamina beside it comes off the 30s core
        // probe while the decision is up to 5s old, and the chaos branch reads a
        // `cities` array the slow detail probe may not have filled yet, so a
        // viewer-side derivation would state a gate that did not fire. A
        // `reason` string on BladeburnerPlan is the real fix.
        (plan.action.type === "stop"
          ? note(
              "stopped, and the plan carries no reason: either stamina fell under the floor or nothing outside " +
                "black ops had charges left, and this panel cannot tell the two apart",
            )
          : "") +
        rankedTable(
          ["type", "action", "rank/sec", "min success"],
          plan.ranked.map((entry) => [
            esc(entry.actionType),
            esc(entry.name),
            fmtNum(entry.rankPerSec, 3),
            fmtPct(entry.chanceLow),
          ]),
          {
            selected: (i) => {
              const entry = plan.ranked[i]!;
              // `continue` means the running action IS the selection, but the
              // producer writes name/actionType onto `plan.action` only for
              // `act` — so every continue tick rendered a full ranking with
              // nothing marked. Matched on name alone, which is what decide.ts
              // itself compares (`view.current?.name === best.name`):
              // `b.current.type` is the game's capitalised string ("Black
              // Operation") against the probe's lowercase vocabulary
              // ("blackop"), so an actionType comparison would silently never
              // match and the marker would still never appear. Gated on the
              // decision type because the plan is republished every 5s while
              // `current` comes off the 30s core probe — an unconditional
              // fallback would mark a stale row on an act/upgrade/stop tick.
              if (plan.action.type === "continue") return entry.name === b.current?.name;
              return entry.name === plan.action.name && entry.actionType === plan.action.actionType;
            },
            empty: "no viable rank actions",
            left: [0, 1],
          },
        ) +
        (plan.lastResult ? outcome(plan.lastResult) : "")
      : waiting("the first Bladeburner decision");

    return (
      `<div class="col wide">` +
      card("Bladeburner", summary + staminaBar) +
      card("Decision", decision) +
      card("Actions", actions) +
      `</div>` +
      `<div class="col">` +
      card("Skills", skills) +
      card("Cities", cities) +
      `</div>`
    );
  },
};
