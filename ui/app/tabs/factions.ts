import { AUGMENTATIONS, describeMults } from "../../../shared/features/augmentations.ts";
import type {
  FactionGate,
  FactionPlan,
  FactionStanding,
  GateBlocker,
} from "../../../shared/telemetry/topics/factions.ts";
import {
  augInspector,
  augRows,
  givesCell,
  sellerCell,
  stateCell,
  stateStatus,
  stateTitle,
  type AugRow,
} from "./factions-aug.ts";
import { formatScientific } from "../../../shared/format.ts";
import { card, collapsible, dataTable, dot, filters, hint, meter, note, rankedTable, search, table, tiles, waiting, type Column, type Status } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Factions tab: four questions, four cards.
 *
 *  1. **Plan** — the action being executed and the inputs it was chosen from.
 *     A blocked feature must name the feature it is waiting on.
 *  2. **Portfolio** — the committed SET of faction pushes, in the order they
 *     will be worked, and the cycle length it was solved for. The plan stopped
 *     being one faction: reputation work is sequential, augmentations are
 *     shared between sellers, and purchases pay one escalating price ladder, so
 *     the unit of the decision is the whole install cycle. The budget sweep is
 *     shown beside it because "why this long a cycle" is a decision, not a
 *     constant.
 *  3. **Factions** — every faction the game has, whether we are in, how close
 *     an invitation is, and exactly what is still missing. This replaces what
 *     used to be three separate cards (standings, invitations, blockers) that
 *     each showed a different subset of the same 34 rows.
 *  4. **Augmentations** — the whole catalogue: what state each one is in, what
 *     it gives, what it is worth to THIS run, and who sells it. Not just the
 *     ones our current factions offer — which faction to join is the decision
 *     this panel exists to support, and it cannot be made from a list that only
 *     contains factions already joined. Static facts come from the bundled
 *     transcription; live price, rep gap, score and ownership are overlaid from
 *     telemetry. It spans the full width because it is seven columns wide and
 *     one of them is prose. Row model and inspector live in `factions-aug.ts`. */

// --- plan ------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  idle: "idle",
  joinFactions: "join",
  workForFaction: "work",
  stopWork: "stop work",
  donate: "donate",
  purchaseAugmentation: "buy",
  graft: "graft",
  travelTo: "travel",
  installAugmentations: "install",
};

interface FactionPlanAction {
  type: string;
  faction?: string;
  factions?: string[];
  augmentation?: string;
  city?: string;
  workType?: string;
  amount?: number;
  purchaseCost?: number;
}

function actionLine(action: FactionPlanAction): string {
  const label = ACTION_LABELS[action.type] ?? action.type;
  const subject = action.type === "donate" && action.amount !== undefined
    ? `${fmtMoney(action.amount)}${action.faction ? ` to ${action.faction}` : ""}`
    : action.augmentation
      ? `${action.augmentation}${action.faction ? ` from ${action.faction}` : ""}`
      : (action.factions?.join(", ") ?? action.faction ?? action.city ?? "");
  const work = action.workType ? ` (${action.workType})` : "";
  return `${esc(label)}${subject ? ` <strong>${esc(subject)}</strong>` : ""}${esc(work)}`;
}

function fmtRate(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "–";
  return Math.abs(value) >= 0.001 ? fmtNum(value, 3) : formatScientific(value);
}

function planCard(state: ProjectedState): string {
  const plan = state.topics.factions?.plan;
  if (!plan) return card("Plan", note("no decision yet — the factions driver has not run"));

  const parts: string[] = [];

  if (plan.blocked) {
    if (typeof plan.blocked === "object") {
      parts.push(tiles([
        { label: "blocker", value: esc(plan.blocked.kind) },
        { label: "BitNode", value: String(plan.blocked.bitNode) },
        { label: "SF4", value: String(plan.blocked.sf4Level) },
        { label: "RAM / call", value: `${fmtNum(plan.blocked.callRamGb)} GB` },
      ]));
    } else {
      // Old JSONL can contain the former prose-only shape. Do not repeat it;
      // there are no structured facts to recover from that record.
      parts.push(note("legacy blocked record (no structured RAM facts)"));
    }
  }

  parts.push(`<div class="row"><span class="muted">next</span> ${actionLine(plan.action as FactionPlanAction)}</div>`);

  {
    const context = plan.context;
    const augGoal = context.targetAugCount === undefined
      ? `${context.ownedAugCount} owned`
      : `${context.ownedAugCount} / ${context.targetAugCount}`;
    parts.push(tiles([
      { label: "planning window", value: fmtTime(context.horizonSec * 1000), sub: context.route ?? "no end route" },
      { label: "income", value: `${fmtMoney(context.incomePerSec)}/s` },
      { label: "cash", value: fmtMoney(context.moneyAvailable), sub: `${fmtMoney(context.moneyGranted)} granted` },
      { label: "augmentation goal", value: augGoal, sub: `${context.queuedAugCount} queued (included)` },
    ]));
    const inputRows = [
      ["work slot", context.holdsWorkSlot ? "granted" : "held elsewhere"],
      ["donation favor", fmtNum(context.favorToDonate, 0)],
      ["normal queue", String(context.priceQueue.nonSoA)],
      ["SoA owned", String(context.priceQueue.ownedSoA)],
      ["NeuroFlux level", String(context.priceQueue.neurofluxLevel)],
      ...(plan.invalidation ?? []).map((entry) => [`replan: ${entry.label}`, esc(entry.value)]),
    ];
    parts.push(collapsible("factions.inputs", "decision inputs", table(["input", "value"], inputRows, { left: [0, 1] })));
  }

  if (plan.until) {
    const eta = Number.isFinite(plan.until.etaSec) ? fmtTime(plan.until.etaSec * 1000) : "never at this rate";
    parts.push(
      `<div class="row"><span class="muted">until</span> ` +
        `${fmtNum(plan.until.have, 0)} / ${fmtNum(plan.until.target, 0)} ${esc(plan.until.kind)}` +
        `${plan.until.faction ? ` @ ${esc(plan.until.faction)}` : ""} — ${esc(eta)}</div>`,
    );
  }

  if (plan.lastResult) {
    // Every singularity call's `false` return is a MODELLED OUTCOME, not an
    // error, so a rejection is shown as a result rather than swallowed.
    const cls = plan.lastResult.ok ? "good" : "bad";
    parts.push(
      `<div class="row"><span class="muted">last</span> ` +
        `<span class="${cls}">${esc(plan.lastResult.action)}: ${esc(plan.lastResult.detail)}</span></div>`,
    );
  }

  if (plan.objective) {
    const objective = plan.objective;
    // Chips, not a comma-separated paragraph: twenty faction names wrapped
    // across three lines of prose is unreadable and unscannable.
    parts.push(
      `<div class="row"><span class="muted">objective</span></div>` +
        `<div class="chips">${
          objective.factions.map((name) => `<span class="chip idle">${esc(name)}</span>`).join("") ||
          `<span class="muted">none</span>`
        }</div>`,
    );
    if (objective.intent) {
      const intent = objective.intent;
      parts.push(
        `<div class="row"><span class="muted">breakpoint</span> ` +
          `<strong>${esc(intent.faction)}</strong> to ${fmtNum(intent.repTarget, 0)} rep ` +
          `(${intent.augmentations.length} aug, ${esc(fmtTime(intent.etaSec * 1000))})</div>` +
          `<div class="muted">favor after install ${fmtNum(intent.favorAfterInstall, 1)}</div>` +
          table(
            ["package", "value", "avg/sec", "marginal/sec", "ETA", "cash"],
            [
              [
                "chosen",
                fmtNum(intent.value, 3),
                fmtRate(intent.rate),
                fmtRate(intent.marginalRate),
                esc(fmtTime(intent.etaSec * 1000)),
                fmtMoney(intent.totalCost),
              ],
              ...(objective.runnerUp
                ? [[
                    `${esc(objective.runnerUp.faction)} @ ${fmtNum(objective.runnerUp.repTarget, 0)} rep`,
                    fmtNum(objective.runnerUp.value, 3),
                    fmtRate(objective.runnerUp.rate),
                    fmtRate(objective.runnerUp.marginalRate),
                    esc(fmtTime(objective.runnerUp.etaSec * 1000)),
                    fmtMoney(objective.runnerUp.totalCost),
                  ]]
                : []),
            ],
            { left: [0] },
          ) +
          `<div class="muted">ETA: unlock ${esc(fmtTime(intent.unlockSec * 1000))}, rep ${esc(fmtTime(intent.repSec * 1000))}, ` +
          `money ${esc(fmtTime(intent.moneySec * 1000))}; cash: ${fmtMoney(intent.purchaseCost)} purchase` +
          `${intent.donationCost > 0 ? ` + ${fmtMoney(intent.donationCost)} donation` : ""}</div>`,
      );
    }
    if (objective.foreclosed.length > 0) {
      // Enemy exclusions last for this install cycle, so show the trade-off.
      parts.push(
        `<div class="muted">forecloses this install cycle: ${objective.foreclosed
          .map((entry) => `${esc(entry.name)} (via ${esc(entry.bannedBy)})`)
          .join(", ")}</div>`,
      );
    }
    if (objective.augmentations.length > 0) {
      parts.push(
        collapsible(
          "factions.shopping",
          `shopping list — ${objective.augmentations.length} augmentation(s)`,
          table(
            ["#", "augmentation", "gives"],
            objective.augmentations.slice(0, 30).map((name, i) => [
              String(i + 1),
              esc(name),
              `<span class="muted">${esc(
                describeMults(AUGMENTATIONS[name]?.mults, 2)
                  .map((m) => m.text)
                  .join(", ") || "—",
              )}</span>`,
            ]),
            { left: [1, 2] },
          ),
        ),
      );
    }
  }

  if (plan.nextBuy) {
    parts.push(
      `<div><strong>next purchase:</strong> ${esc(plan.nextBuy.name)} at ${fmtMoney(plan.nextBuy.price)}</div>` +
        note(hint("priced at purchase-order slot, dearest first", "this is what the money claim reserves")),
    );
  }

  if (plan.recommendInstall) {
    parts.push(
      `<div class="good"><strong>install candidate:</strong> ${plan.recommendInstall.augmentations.length} augmentation(s) acquired</div>` +
        note("advisory — the reset cadence belongs to the BitNode feature"),
    );
  }

  return card("Plan", parts.join(""));
}

function decisionHistory(state: ProjectedState): string {
  const decisions = state.events
    .filter((record) => record.kind === "event" && record.name === "faction.decision")
    .slice(-8)
    .reverse()
    .map((record) => {
      const data = record.data as { plan?: FactionPlan } | undefined;
      const plan = data?.plan;
      if (!plan) return undefined;
      const ageMs = Math.max(0, state.lastT - record.t);
      const when = ageMs < 1_000 ? "now" : `${fmtTime(ageMs)} ago`;
      const target = plan.objective?.intent;
      return [
        esc(when),
        actionLine(plan.action),
        target ? `${esc(target.faction)} @ ${fmtNum(target.repTarget, 0)} rep` : `<span class="muted">none</span>`,
      ];
    })
    .filter((row): row is string[] => row !== undefined);
  return decisions.length > 0
    ? table(["when", "decision", "target"], decisions, { left: [0, 1, 2] })
    : note("decision transitions will appear here as the plan changes");
}

// --- factions --------------------------------------------------------------

interface FactionRow {
  name: string;
  joined: boolean;
  invited: boolean;
  reachable: boolean;
  /** [0, 1] toward an invitation; 1 once joined or invited. */
  progress: number;
  rep: number;
  favor: number;
  /** Fraction of the donation favor gate. */
  favorFrac: number;
  canDonate: boolean;
  missing: GateBlocker[];
  workTypes: string[];
  enemies: string[];
  /** Augmentations this faction sells that we do not own. */
  augsLeft: number;
  inObjective: boolean;
  /** 1-based position in the committed work order, when it is in the plan. */
  planPosition?: number;
}

function describeBlocker(blocker: GateBlocker): string {
  const subject = blocker.subject ? ` ${blocker.subject}` : "";
  const amounts =
    blocker.target > 0 && blocker.have >= 0 && blocker.kind !== "bitNode" && blocker.kind !== "sourceFile"
      ? ` ${fmtNum(blocker.have)}/${fmtNum(blocker.target)}`
      : "";
  return `${blocker.negated ? "not " : ""}${blocker.kind}${subject}${amounts}`;
}

function factionRows(state: ProjectedState): FactionRow[] {
  const f = state.topics.factions;
  if (!f) return [];
  const gates = f.gates ?? {};
  const standings = new Map<string, FactionStanding>((f.standings ?? []).map((s) => [s.name, s]));
  const joined = new Set(f.joined);
  const invited = new Set(f.invites ?? []);
  const owned = new Set(f.ownedAugs ?? []);
  // Position in the committed order, not merely membership: the plan is a
  // SEQUENCE now (one work slot), so "third" is a different fact from "in it".
  const order = new Map((f.plan?.objective?.factions ?? []).map((name, index) => [name, index + 1]));
  const gate = f.favorToDonate;

  // Every faction we know of from any source: the gate map is complete once
  // the driver has run, but before that the joined list is all we have.
  const names = new Set<string>([
    ...Object.keys(gates),
    ...Object.keys(f.requirements ?? {}),
    ...joined,
    ...invited,
  ]);

  return [...names].map((name) => {
    const g: FactionGate | undefined = gates[name];
    const standing = standings.get(name);
    const favor = standing?.favor ?? 0;
    const augsLeft = Object.entries(AUGMENTATIONS).filter(
      ([aug, info]) => info.factions.includes(name) && !owned.has(aug),
    ).length;
    return {
      name,
      joined: joined.has(name),
      invited: invited.has(name),
      reachable: g?.reachable ?? true,
      progress: joined.has(name) || invited.has(name) ? 1 : (g?.progress ?? 0),
      rep: standing?.rep ?? 0,
      favor,
      favorFrac: gate ? Math.min(1, favor / gate) : 0,
      canDonate: gate !== undefined && favor >= gate,
      missing: g?.missing ?? [],
      workTypes: f.workTypes?.[name] ?? [],
      enemies: f.enemies?.[name] ?? [],
      augsLeft,
      ...(order.has(name) ? { planPosition: order.get(name)! } : {}),
      inObjective: order.has(name),
    };
  });
}

function factionStatus(row: FactionRow): { status: Status; tooltip: string } {
  if (row.joined) return { status: "good", tooltip: "joined" };
  if (row.invited) return { status: "ready", tooltip: "invitation pending — join it" };
  if (!row.reachable) return { status: "bad", tooltip: "not reachable in this run" };
  return { status: "wait", tooltip: `${row.missing.length} requirement(s) still missing` };
}

const FACTION_COLUMNS: Column<FactionRow>[] = [
  {
    id: "name",
    label: "faction",
    left: true,
    sort: (r) => r.name,
    cell: (r) => {
      const { status, tooltip } = factionStatus(r);
      const star = r.planPosition !== undefined
        ? ` <span class="warn" title="${esc(
            r.planPosition === 1
              ? "the push being worked now"
              : `queued in the plan — ${r.planPosition - 1} push(es) ahead of it`,
          )}">${r.planPosition}</span>`
        : "";
      return `${dot(status, tooltip)}${esc(r.name)}${star}`;
    },
  },
  {
    id: "progress",
    label: "invite",
    sort: (r) => r.progress,
    cell: (r) => {
      if (r.joined) return `<span class="good">joined</span>`;
      if (r.invited) return `<span class="good">invited</span>`;
      if (!r.reachable) return `<span class="bad">unreachable</span>`;
      return meter(r.progress, `${(r.progress * 100).toFixed(0)}%`, false, "progress on the bottleneck requirement");
    },
  },
  {
    id: "missing",
    label: "still needs",
    wrap: true,
    sort: (r) => r.missing.length,
    cell: (r) => {
      if (r.missing.length === 0) return `<span class="muted">—</span>`;
      return r.missing
        .slice(0, 4)
        .map(
          (blocker) =>
            `<span class="need ${blocker.reachable ? "" : "bad"}">` +
            `${esc(describeBlocker(blocker))}` +
            `<span class="owner">${esc(blocker.owner)}</span></span>`,
        )
        .join(" ")
        .concat(r.missing.length > 4 ? ` <span class="muted">+${r.missing.length - 4}</span>` : "");
    },
  },
  { id: "rep", label: "rep", sort: (r) => r.rep, cell: (r) => (r.joined ? fmtNum(r.rep, 0) : `<span class="muted">–</span>`) },
  {
    id: "favor",
    label: "favor",
    sort: (r) => r.favor,
    cell: (r) => {
      if (!r.joined) return `<span class="muted">–</span>`;
      // Favor only matters as a donation gate, so it is shown as progress
      // toward that gate rather than as a bare number.
      return meter(r.favorFrac, fmtNum(r.favor, 1), r.canDonate, r.canDonate ? "donations unlocked" : "favor needed to donate");
    },
  },
  {
    id: "augs",
    label: "augs left",
    sort: (r) => r.augsLeft,
    cell: (r) => (r.augsLeft > 0 ? String(r.augsLeft) : `<span class="muted">—</span>`),
  },
  {
    id: "work",
    label: "work",
    left: true,
    sort: (r) => r.workTypes.join(","),
    cell: (r) => (r.workTypes.length ? `<span class="muted">${esc(r.workTypes.join(", "))}</span>` : `<span class="muted">–</span>`),
  },
];

// --- augmentations ---------------------------------------------------------

// --- augmentations ---------------------------------------------------------

const AUG_COLUMNS: Column<AugRow>[] = [
    {
      id: "name",
      label: "augmentation",
      left: true,
      sort: (r) => r.name,
      cell: (r) => {
        const pre = r.prereqs.length
          ? ` <span class="muted" title="${esc(`needs ${r.prereqs.join(", ")}`)}">(needs ${r.prereqs.length})</span>`
          : "";
        // A button, so the row opens the inspector — the same master-detail
        // affordance the hacking tab uses for servers.
        return (
          `${dot(stateStatus(r), stateTitle(r))}` +
          `<button class="rowlink" data-view-key="augs.selected" data-view-value="${esc(r.name)}">${esc(r.name)}</button>` +
          pre
        );
      },
    },
    {
      id: "state",
      label: "state",
      left: true,
      sort: (r) => r.state,
      cell: (r) => stateCell(r),
    },
    {
      id: "gives",
      label: "gives",
      left: true,
      wrap: true,
      sort: (r) => r.gives,
      cell: (r) => givesCell(r),
    },
    {
      id: "score",
      label: "worth",
      sort: (r) => r.score ?? -1,
      cell: (r) =>
        r.score === undefined
          ? `<span class="muted" title="scored only for augmentations with a live offer">–</span>`
          : `<span title="BN-seconds under the run's objective weights">${fmtNum(r.score, 2)}</span>`,
    },
    {
      id: "from",
      label: "from",
      left: true,
      sort: (r) => r.seller ?? "",
      cell: (r) => sellerCell(r),
    },
    {
      id: "cost",
      label: "price",
      sort: (r) => r.cost,
      cell: (r) => {
        if (!Number.isFinite(r.cost)) return `<span class="muted">unbuyable</span>`;
        const base = r.offer?.basePrice;
        // Both prices when they differ: the 1.9^queued escalation should be
        // visible as an escalation, not look like a price change.
        return base !== undefined && base !== r.cost
          ? `${fmtMoney(r.cost)} <span class="muted">(base ${fmtMoney(base)})</span>`
          : fmtMoney(r.cost);
      },
    },
    {
      id: "rep",
      label: "rep",
      sort: (r) => r.rep,
      cell: (r) => {
        if (!Number.isFinite(r.rep)) return `<span class="muted">–</span>`;
        if (r.owned) return `<span class="muted">owned</span>`;
        if (r.offer?.affordableRep) return `<span class="good">met</span>`;
        return r.repGap !== undefined
          ? `<span class="muted" title="reputation still needed at the cheapest offering faction">${fmtNum(r.repGap, 0)} short</span>`
          : fmtNum(r.rep, 0);
      },
    },
];

// --- portfolio -------------------------------------------------------------

/** The committed SET and the cycle length it was solved for.
 *
 * The plan used to be one faction, so the panel could describe it in a line.
 * It is now an ordered set costed together, and two things about it have to be
 * arguable rather than trusted: which pushes are in it and in what order, and
 * why THIS cycle length. Both are published, so both are shown. */
function portfolioCard(state: ProjectedState): string {
  const objective = state.topics.factions?.plan?.objective;
  const portfolio = objective?.portfolio;
  if (!portfolio) return "";

  const rows = portfolio.packages.map((pkg) => [
    esc(pkg.faction),
    fmtNum(pkg.repTarget, 0),
    esc(fmtTime((pkg.workSecFromNow ?? 0) * 1000)),
    esc(fmtTime(pkg.etaSec * 1000)),
    String(pkg.augmentations.length),
    fmtMoney(pkg.totalCost),
    fmtRate(pkg.marginalRate),
  ]);

  const summary = tiles([
    { label: "cycle budget", value: fmtTime(portfolio.budgetSec * 1000),
      sub: portfolio.previousBudgetSec !== undefined && portfolio.previousBudgetSec !== portfolio.budgetSec
        ? `was ${fmtTime(portfolio.previousBudgetSec * 1000)}`
        : "steady" },
    { label: "set ETA", value: fmtTime(portfolio.etaSec * 1000),
      sub: `${fmtTime(portfolio.workSec * 1000)} work · ${fmtTime(portfolio.moneySec * 1000)} money` },
    { label: "augmentations", value: String(portfolio.augmentations.length),
      sub: `${portfolio.packages.length} faction(s)` },
    { label: "value", value: fmtNum(portfolio.value, 2),
      sub: `within ${(portfolio.boundGap * 100).toFixed(0)}% of the bound` },
  ]);

  const curve = objective.horizonCurve ?? [];
  const chosen = curve.reduce(
    (best, sample, index) => (sample.rate > (curve[best]?.rate ?? -Infinity) ? index : best),
    0,
  );
  const sweep = curve.length > 0
    ? rankedTable(
        ["budget", "value", "rate", "factions"],
        curve.map((sample) => [
          esc(fmtTime(sample.sec * 1000)),
          fmtNum(sample.value, 2),
          fmtRate(sample.rate),
          String(sample.factions),
        ]),
        { selected: (index) => index === chosen, left: [0] },
      )
    : note("the budget sweep re-runs on the forecast's recalibration tick");

  return card(
    "Portfolio",
    summary +
      table(["faction", "rep target", "starts after", "adds", "augs", "cash", "marginal/sec"], rows, {
        left: [0],
        empty: "no set committed yet",
      }) +
      collapsible(
        "factions.horizon",
        `cycle length — ${curve.length} budget(s) evaluated`,
        note(
          hint(
            "chosen to maximise value per second of cycle, reset overhead included",
            "the whole grid is evaluated rather than walked: rates rise within a cycle, so a faction unreachable at a short budget can be cheap at a long one",
          ),
        ) + sweep,
      ),
  );
}

// --- tab -------------------------------------------------------------------

export const factionsTab: Tab = {
  id: "factions",
  render(state: ProjectedState) {
    const f = state.topics.factions;
    if (!f) return waiting("the factions probe");

    const rows = factionRows(state);
    // One predicate per filter, used for BOTH the badge and the filtering. A
    // badge computed separately drifts from the rows it promises: "reachable"
    // counted only un-invited factions while the filter included invited ones,
    // so every pending invitation made the badge undercount its own view.
    const FACTION_VIEWS: { value: string; label: string; match(row: (typeof rows)[number]): boolean }[] = [
      { value: "all", label: "all", match: () => true },
      { value: "joined", label: "joined", match: (r) => r.joined },
      { value: "open", label: "reachable", match: (r) => !r.joined && r.reachable },
      { value: "objective", label: "objective", match: (r) => r.inObjective },
      { value: "unreachable", label: "unreachable", match: (r) => !r.reachable },
    ];
    const counts = {
      joined: rows.filter((r) => r.joined).length,
      invited: rows.filter((r) => r.invited).length,
    };
    const factionMode = view("factions.mode", "all");
    const active = FACTION_VIEWS.find((v) => v.value === factionMode) ?? FACTION_VIEWS[0]!;
    const shown = rows.filter((r) => active.match(r));

    const factionControls = filters(
      "factions.mode",
      FACTION_VIEWS.map((v) => ({
        value: v.value,
        label: v.label,
        badge: String(rows.filter((r) => v.match(r)).length),
      })),
      "all",
    );

    const factionTable = f.gates
      ? dataTable("factions.list", shown, FACTION_COLUMNS, {
          defaultSort: { key: "progress", dir: -1 },
          empty: "no factions match this filter",
        })
      : dataTable("factions.list", shown, FACTION_COLUMNS, {
          defaultSort: { key: "name", dir: 1 },
          empty: "no factions known yet",
        }) + note("requirement evaluation needs the factions driver — joined/rep only until it runs");

    // --- augmentations ---
    const augs = augRows(state);
    const augMode = view("augs.mode", "available");
    const needle = view("augs.search").trim().toLowerCase();
    // One predicate per filter, used for both the badge and the rows — the same
    // rule the faction filters follow, so a badge cannot promise a count its
    // own view does not show.
    const AUG_VIEWS: { value: string; label: string; title: string; match(row: AugRow): boolean }[] = [
      { value: "plan", label: "this cycle", title: "committed to the current install cycle, bought or not",
        match: (a) => a.state === "planned" || a.state === "banked" || a.state === "queued" },
      { value: "available", label: "buyable", title: "reputation met at a joined faction",
        match: (a) => a.state === "buyable" },
      { value: "short", label: "rep short", title: "a joined faction sells it, but the gate is not met",
        match: (a) => a.state === "short" },
      { value: "installed", label: "installed", title: "installed and working for us",
        match: (a) => a.state === "installed" },
      { value: "locked", label: "locked", title: "no faction we are in sells it",
        match: (a) => a.state === "locked" },
      { value: "all", label: "all", title: "the whole catalogue", match: () => true },
    ];
    const augCounts = {
      installed: augs.filter((a) => a.state === "installed").length,
      queued: augs.filter((a) => a.state === "queued").length,
      available: augs.filter((a) => a.state === "buyable").length,
      planned: augs.filter((a) => a.state === "planned" || a.state === "banked").length,
    };
    const activeAug = AUG_VIEWS.find((v) => v.value === augMode) ?? AUG_VIEWS[1]!;
    const shownAugs = augs.filter((a) => {
      // Sellers are searchable because they are no longer scannable: the column
      // names one faction and counts the rest, so "everything NiteSec sells" has
      // to be a query rather than a read.
      if (
        needle
        && !a.name.toLowerCase().includes(needle)
        && !a.gives.toLowerCase().includes(needle)
        && !a.factions.some((faction) => faction.toLowerCase().includes(needle))
      ) {
        return false;
      }
      return activeAug.match(a);
    });

    const augControls =
      filters(
        "augs.mode",
        AUG_VIEWS.map((v) => ({
          value: v.value,
          label: v.label,
          title: v.title,
          badge: String(augs.filter((a) => v.match(a)).length),
        })),
        "available",
      ) + search("augs.search", "name, effect or faction…");

    // The inspector's subject comes from the VISIBLE rows: a selection that a
    // filter has hidden would render a panel with no row above it.
    const selectedAug = shownAugs.find((a) => a.name === view("augs.selected"));

    const summary = tiles([
      { label: "joined", value: String(counts.joined), sub: `${rows.length} exist` },
      { label: "invites", value: String(counts.invited) },
      { label: "installed", value: String(augCounts.installed),
        sub: augCounts.queued > 0 ? `${augCounts.queued} queued for next install` : `${augs.length} exist` },
      { label: "buyable now", value: String(augCounts.available),
        sub: augCounts.planned > 0 ? `${augCounts.planned} planned this cycle` : "" },
    ]);

    const graft =
      f.graftable && f.graftable.length > 0
        ? table(
            ["augmentation", "price", "time"],
            f.graftable.slice(0, 40).map((g) => [esc(g.name), fmtMoney(g.price), fmtTime(g.timeMs)]),
            { left: [0] },
          )
        : note("nothing graftable (needs New Tokyo's VitaLife clinic)");

    const alternatives =
      f.plan && f.plan.alternatives.length > 0
        ? table(
            ["alternative", "value"],
            f.plan.alternatives
              .slice()
              .sort((a, b) => b.value - a.value)
              .slice(0, 6)
              .map((entry) => [esc(entry.label), fmtNum(entry.value, 3)]),
            { left: [0] },
          )
        : note("no scored alternatives");

    // The augmentation table spans the full width rather than sharing the
    // two-column grid. Seven columns inside three fifths of the page is what
    // squeezed `gives` into an unreadable sliver; the sidebar cards do not need
    // to sit beside it.
    return (
      `<div class="col wide">` +
      planCard(state) +
      portfolioCard(state) +
      card("Factions", summary + factionTable, factionControls) +
      `</div>` +
      `<div class="col">` +
      card("Decision history", decisionHistory(state)) +
      card("Alternatives considered", alternatives) +
      card("Grafting", graft) +
      `</div>` +
      `<div class="col span">` +
      card(
        "Augmentations",
        dataTable("augs.list", shownAugs, AUG_COLUMNS, {
          defaultSort: { key: "score", dir: -1 },
          empty: "nothing matches this filter",
          limit: 200,
          rowClass: (row) =>
            row.name === selectedAug?.name
              ? "picked"
              : row.state === "installed"
                ? "installed"
                : row.state === "planned" || row.state === "banked" || row.state === "queued"
                  ? "planned"
                  : "",
        }) + (selectedAug ? augInspector(selectedAug, state) : ""),
        augControls,
      ) +
      `</div>`
    );
  },
};
