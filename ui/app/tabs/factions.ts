import { AUGMENTATIONS, describeMults } from "../../../shared/features/augmentations.ts";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { NEUROFLUX } from "../../../shared/strategy/factions/augs.ts";
import type { FactionIntent, HorizonSample } from "../../../shared/strategy/factions/plan.ts";
import { estimateBlockerSec, type Blocker } from "../../../shared/strategy/factions/requirements.ts";
import { REPUTATION_CHANNEL } from "../../../shared/strategy/income.ts";
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
import { ageMs, ago, isStale, stamp } from "../lib/clock.ts";
import { card, collapsible, dataTable, dot, filters, hint, meter, note, rankedTable, search, shownOf, table, tiles, waitingPanel, type Column, type Status } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
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

/** The TOPIC's action shape, not a local copy of it. The copy this replaces
 *  omitted `awaitingWorkSlot`, and `plan.action as FactionPlanAction` laundered
 *  the wire value through it, so the drop was invisible to the compiler. Aliasing
 *  the published type makes the next added action field a compile error instead of
 *  another silent omission. */
type FactionPlanAction = FactionPlan["action"];

function actionLine(action: FactionPlanAction): string {
  const label = ACTION_LABELS[action.type] ?? action.type;
  const subject = action.type === "donate" && action.amount !== undefined
    ? `${fmtMoney(action.amount)}${action.faction ? ` to ${action.faction}` : ""}`
    : action.augmentation
      ? `${action.augmentation}${action.faction ? ` from ${action.faction}` : ""}`
      : (action.factions?.join(", ") ?? action.faction ?? action.city ?? "");
  const work = action.workType ? ` (${action.workType})` : "";
  // Only the slot wait is named. The planner has four idle reasons
  // (blocked | waiting | continue | slot) and publishes `awaitingWorkSlot` for
  // exactly one of them — `reason` itself is not on the wire — so a word for the
  // other three would be a claim the telemetry cannot support.
  const why = action.type === "idle" && action.awaitingWorkSlot ? ` <em>waiting for the work slot</em>` : "";
  return `${esc(label)}${subject ? ` <strong>${esc(subject)}</strong>` : ""}${esc(work)}${why}`;
}

/** Past this, the plan is old enough that presenting it as current is a lie.
 *
 *  Deliberately not `clock.ts`'s blunt 60s: the factions driver decides every
 *  30s (`everyMs: 30_000`), so one missed tick is normal jitter and a permanent
 *  "24s ago" tile would be noise. Three missed ticks is not jitter. */
const PLAN_STALE_AFTER_MS = 90_000;

/** `avg/sec` for one package.
 *
 *  Kept as its own column rather than collapsed into `marginal/sec`: the two
 *  genuinely differ for a frontier-latched intent, which is the steady-state
 *  case. They are identical for a package taken out of the portfolio (`intentAt`
 *  sets both to marginalValue / marginalSec), and printing the same figure twice
 *  reads as two measurements agreeing, so that case says so instead. */
function avgRateCell(intent: FactionIntent): string {
  return intent.rate === intent.marginalRate
    ? `<span class="muted" title="identical to the marginal rate for a set member">–</span>`
    : fmtRate(intent.rate);
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
        // A tile value is a TEXT slot — `tiles` runs it through `inline` — so
        // the esc() this replaced escaped the kind twice.
        { label: "blocker", value: plan.blocked.kind },
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

  parts.push(`<div class="row"><span class="muted">next</span> ${actionLine(plan.action)}</div>`);

  // What the work slot is worth, and where. `workRate` is published even when the
  // action is idle precisely so the price of the slot can be argued while another
  // feature holds it (shared/strategy/factions/plan.ts:174-181) — and on the
  // idle-because-slot path no `until` is attached, so this is the ONLY fact on the
  // wire about what the slot would earn. The label is keyed on the ACTION, never
  // on `context.holdsWorkSlot`: the planner idles WITH the slot in hand when
  // working would earn less than the passive tick, so holding it is not evidence
  // the rate is being earned. It names `workRate.faction` rather than the action's
  // faction because on the slot-wait path the action carries no faction at all.
  {
    const rate = plan.workRate;
    if (!rate) {
      parts.push(
        `<div class="row"><span class="muted">work slot</span> ` +
          `<span class="muted" title="this decision chose no work target — joining, travelling, or nothing reachable — so there is no rate on the wire">–</span></div>`,
      );
    } else {
      const label = plan.action.type === "workForFaction"
        ? "earning"
        : plan.action.awaitingWorkSlot
          ? "would earn — slot held elsewhere"
          : "work slot would earn";
      // Reputation is the headline, not a chip: `produces` seeds its reputation
      // channel FROM `repPerSec`, so chipping every channel prints it twice.
      // `augmentations` is augs/sec (package augs over package ETA), everything
      // else is experience per second.
      const chips = Object.entries(rate.produces)
        .filter(([channel]) => channel !== REPUTATION_CHANNEL)
        .map(
          ([channel, value]) =>
            `<span class="chip idle">${esc(channel)} ${esc(fmtRate(value))} ${channel === "augmentations" ? "augs/s" : "exp/s"}</span>`,
        )
        .join("");
      parts.push(
        `<div class="row"><span class="muted">${esc(label)}</span> ` +
          `${esc(fmtRate(rate.repPerSec))} rep/s @ <strong>${esc(rate.faction)}</strong></div>` +
          (chips ? `<div class="chips">${chips}</div>` : ""),
      );
    }
  }

  {
    const context = plan.context;
    const augGoal = context.targetAugCount === undefined
      ? `${context.ownedAugCount} owned`
      : `${context.ownedAugCount} / ${context.targetAugCount}`;
    // How old the DECISION is. `context.evaluatedAt` is the only stamp on the wire
    // that can date the plan (the projection keeps no per-topic receipt time), and
    // state records are last-write-wins, so a driver that stopped keeps presenting
    // its last decision with full confidence. Shown only past the threshold: a
    // frozen topic means an unreadable world view (the `if (!view) return` guard),
    // the `factions` capability gate unscheduling the driver, or a stopped
    // controller. `plan.blocked` is NOT one of them — a blocked plan is
    // republished every tick and is correctly dated.
    const planAge = ageMs(state, context.evaluatedAt);
    const planStale = isStale(state, context.evaluatedAt, PLAN_STALE_AFTER_MS);
    parts.push(tiles([
      { label: "planning window", value: fmtTime(context.horizonSec * 1000), sub: context.route ?? "no end route" },
      { label: "income", value: `${fmtMoney(context.incomePerSec)}/s` },
      { label: "cash", value: fmtMoney(context.moneyAvailable), sub: `${fmtMoney(context.moneyGranted)} granted` },
      { label: "augmentation goal", value: augGoal, sub: `${context.queuedAugCount} queued (included)` },
      ...(planStale
        ? [{ label: "evaluated", value: html`<span class="bad">${ago(state, context.evaluatedAt)}</span>` }]
        : []),
      // The final drain spends a budget FROZEN when it began — cash plus the
      // liquidatable book at that moment, not cash on hand — so fresh income above
      // it is not evidence the plan is under-spending. Emitted only while a drain
      // is running: absent means "no drain", not "no budget", and it is published
      // on the buying branch with no `recommendInstall`, which is exactly the case
      // that was invisible.
      ...(plan.drainCeiling !== undefined
        ? [{ label: "sweep budget", value: fmtMoney(plan.drainCeiling), sub: "frozen when the drain began" }]
        : []),
    ]));
    if (planStale) {
      parts.push(note(`plan not re-evaluated for ${fmtTime(planAge)} — the factions driver may have stopped`));
    }
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
    // error, so a rejection is shown as a result rather than swallowed. Dated
    // from its own `at`: undated, an hour-old failure reads as what just
    // happened, which is the most common way this row misled.
    const cls = plan.lastResult.ok ? "good" : "bad";
    parts.push(
      `<div class="row"><span class="muted">last</span> ` +
        `<span class="${cls}">${esc(plan.lastResult.action)}: ${esc(plan.lastResult.detail)}</span> ` +
        `${stamp(state, plan.lastResult.at)}</div>`,
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
      const runner = objective.runnerUp;
      const second = objective.portfolio?.packages[1];
      // `runnerUp` changed meaning when selection became a portfolio: it is now
      // simply work-order position 2, which the Portfolio card lists as a
      // COMMITTED row. Labelling it "the option that lost" made the two cards say
      // opposite things about the same push. Only an objective with no portfolio
      // (the promoted-runner path, and pre-portfolio JSONL on the replay path)
      // still carries a genuinely rejected alternative here, so the label is
      // derived rather than fixed — and the row is not simply dropped, because for
      // those records it is the only rendering of the second package.
      const runnerIsNext =
        runner !== undefined
        && second !== undefined
        && second.faction === runner.faction
        && second.repTarget === runner.repTarget;
      const runnerLabel = runnerIsNext
        ? `<span title="work-order position 2 — what the Portfolio card's &quot;starts after&quot; counts from">next in the set</span>`
        : `<span title="the best package the solver rejected at this decision point">runner-up</span>`;
      parts.push(
        `<div class="row"><span class="muted">breakpoint</span> ` +
          `<strong>${esc(intent.faction)}</strong> to ${fmtNum(intent.repTarget, 0)} rep ` +
          `(${intent.augmentations.length} aug, ${esc(fmtTime(intent.etaSec * 1000))})</div>` +
          // `purpose` gates whether factions keeps working after progression has
          // armed an install, so "still working with the install armed" is
          // unexplainable without it.
          `<div class="muted">favor after install ${fmtNum(intent.favorAfterInstall, 1)}` +
          `${intent.purpose
            ? ` · <span title="an augmentations push buys this cycle; a favor push banks reputation for the next one">${esc(intent.purpose)} push</span>`
            : ""}</div>` +
          table(
            ["package", "package value", "avg/sec", "marginal/sec", "ETA", "cash"],
            [
              [
                // "chosen" read as the winner of a comparison. It is the head of
                // the committed set, which is a different claim.
                `<span title="the push being worked now">head</span>`,
                fmtNum(intent.value, 3),
                avgRateCell(intent),
                fmtRate(intent.marginalRate),
                esc(fmtTime(intent.etaSec * 1000)),
                fmtMoney(intent.totalCost),
              ],
              ...(runner
                ? [[
                    `${runnerLabel} ${esc(runner.faction)} @ ${fmtNum(runner.repTarget, 0)} rep`,
                    fmtNum(runner.value, 3),
                    avgRateCell(runner),
                    fmtRate(runner.marginalRate),
                    esc(fmtTime(runner.etaSec * 1000)),
                    fmtMoney(runner.totalCost),
                  ]]
                : []),
            ],
            { left: [0] },
          ) +
          `<div class="muted">ETA: unlock ${esc(fmtTime(intent.unlockSec * 1000))}, rep ${esc(fmtTime(intent.repSec * 1000))}, ` +
          `money ${esc(fmtTime(intent.moneySec * 1000))}; cash: ${fmtMoney(intent.purchaseCost)} purchase` +
          `${intent.donationCost > 0 ? ` + ${fmtMoney(intent.donationCost)} donation` : ""}</div>`,
      );
    } else if (objective.horizonStarved) {
      // The producer sets this when `intent` is absent ONLY because every raw
      // candidate repaid beyond twice the planning window and was dropped as
      // noise. Rendering nothing left the card saying "objective: none" for what
      // is a transient forecast state, which is the exact reading the field's own
      // doc comment forbids.
      parts.push(
        note(
          hint(
            "no package fits the planning window",
            `every candidate repaid beyond twice the ${fmtTime(plan.context.horizonSec * 1000)} window and was dropped as noise — a transient forecast state, not an exhausted frontier`,
          ),
        ),
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

  // Immediately after the purchase row, because the two have to be read
  // together: that row names a price the cash tile cannot cover, and the idle
  // action's `reason` is not on the wire, so without this the wait reads as a
  // stalled plan instead of stock proceeds settling.
  if (plan.liquidationNeeded) {
    const l = plan.liquidationNeeded;
    // `meter()` clamps a non-finite fraction to 0, which would paint a confident
    // empty bar for an unknown price.
    const progress = Number.isFinite(l.price) && l.price > 0
      ? meter(
          (l.cash + l.pendingProceeds) / l.price,
          `${fmtMoney(l.cash)} cash + ${fmtMoney(l.pendingProceeds)} settling of ${fmtMoney(l.price)}`,
          false,
          "cash plus pending stock proceeds against the price",
        )
      : `<span class="muted">–</span>`;
    parts.push(
      `<div class="row"><span class="muted">waiting on</span> stock proceeds for ` +
        `<strong>${esc(l.augmentation)}</strong> ${progress}</div>`,
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
      const target = plan.objective?.intent;
      return [
        // `ago` rather than a local subtraction, so a replayed or simulated run
        // measures against its own clock instead of wall time.
        esc(ago(state, record.t)),
        actionLine(plan.action),
        target ? `${esc(target.faction)} @ ${fmtNum(target.repTarget, 0)} rep` : `<span class="muted">none</span>`,
        // The arbiter column the shared history table renders cannot be shown
        // here: `faction.decision` carries no `arbitration` payload. The grant the
        // decision was TAKEN AGAINST is on the wire, and it is the arbiter fact
        // this tab can state — a push planned against nothing granted was not
        // funded, whatever the plan wanted.
        fmtMoney(plan.context?.moneyGranted),
      ];
    })
    .filter((row): row is string[] => row !== undefined);
  return decisions.length > 0
    ? table(["when", "decision", "target", "granted"], decisions, { left: [0, 1, 2] })
    : note("decision transitions will appear here as the plan changes");
}

// --- factions --------------------------------------------------------------

interface FactionRow {
  name: string;
  joined: boolean;
  invited: boolean;
  reachable: boolean;
  /** True once the driver has EVALUATED this faction's requirements. No gate is
   *  a different state from "nothing missing", and it used to render as a `wait`
   *  dot claiming "0 requirement(s) still missing". */
  evaluated: boolean;
  /** [0, 1] toward an invitation; 1 once joined or invited, absent while the
   *  requirements have not been evaluated. */
  progress?: number;
  /** Absent without the singularity API, and for up to a minute after joining:
   *  `standings` is rebuilt from `player.factions` on its own 60s probe, while
   *  `joined` comes from the free 5s one. */
  rep?: number;
  favor?: number;
  /** Fraction of the donation favor gate; absent when either side is unknown —
   *  `favorToDonate` comes from the same probe step as favor but can arrive
   *  apart from it. */
  favorFrac?: number;
  canDonate: boolean;
  missing: GateBlocker[];
  /** Worst estimated seconds among `missing`, -1 when nothing is missing. The
   *  cost the column sorts by; see `blockerSec`. */
  missingSec: number;
  workTypes: string[];
  enemies: string[];
  /** Enemies of this faction we have ALREADY joined: the invitation is off the
   *  table for this install cycle, and no requirement says so. */
  bannedBy: string[];
  /** Enemies joining it would ban, minus the ones we are already in — an enemy
   *  already joined is not a cost of joining. */
  wouldBan: string[];
  /** Augmentations this faction sells that we do not own. */
  augsLeft: number;
  inObjective: boolean;
  /** 1-based position in the committed work order, when it is in the plan. */
  planPosition?: number;
}

/** Unreachable blockers sort at one end, but as a large FINITE number: the
 *  estimator returns Infinity for them and `dataTable`'s comparator subtracts,
 *  so two Infinities would produce NaN and an arbitrary order. */
const UNREACHABLE_SORT_SEC = 1e12;

/** Seconds to satisfy one blocker, for RANKING only.
 *
 *  The shared estimator rather than a second copy of the rule: it prefers the
 *  blocker's own observation-aware `etaSec` where the interpreter priced one
 *  (backdoor installs, company promotion walks, title ladders) and falls back to
 *  the coarse nominal per-unit table otherwise. Ordering by `etaSec` alone
 *  mis-ranks, because a karma grind or a big `augCount` gate carries none and
 *  would sort below a 60-second employment step.
 *
 *  The wire widens `kind` to a string, so an unknown kind can fall out of the
 *  nominal table as NaN. That ranks last rather than being given a fabricated
 *  cost. */
function blockerSec(blocker: GateBlocker, incomePerSec: number): number {
  const sec = estimateBlockerSec(blocker as Blocker, incomePerSec);
  if (Number.isFinite(sec)) return sec;
  return blocker.reachable ? 0 : UNREACHABLE_SORT_SEC;
}

function describeBlocker(blocker: GateBlocker): string {
  const subject = blocker.subject ? ` ${blocker.subject}` : "";
  const amounts =
    blocker.target > 0 && blocker.have >= 0 && blocker.kind !== "bitNode" && blocker.kind !== "sourceFile"
      ? ` ${fmtNum(blocker.have)}/${fmtNum(blocker.target)}`
      : "";
  return `${blocker.negated ? "not " : ""}${blocker.kind}${subject}${amounts}`;
}

/** Everything known about one blocker, for the chip's tooltip: the `0/1` gates
 *  print no amounts, so without this the chip is a bare word. */
function blockerTitle(blocker: GateBlocker): string {
  const eta = blocker.etaSec !== undefined
    ? `about ${fmtTime(blocker.etaSec * 1000)} to satisfy`
    : "no estimate on the wire";
  return (
    `${describeBlocker(blocker)} — owed by ${blocker.owner}; ${eta}; ` +
    `${(blocker.progress * 100).toFixed(0)}% there${blocker.reachable ? "" : "; not reachable in this run"}`
  );
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
  // The one rate the planner genuinely measures, and what the money kind of
  // blocker is estimated against. Zero is safe: the estimator floors it at 1.
  const incomePerSec = f.plan?.context.incomePerSec ?? 0;

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
    const favor = standing?.favor;
    const isJoined = joined.has(name);
    const augsLeft = Object.entries(AUGMENTATIONS).filter(
      ([aug, info]) => info.factions.includes(name) && !owned.has(aug),
    ).length;
    const enemies = f.enemies?.[name] ?? [];
    // A join bans every enemy for the install cycle and prunes their pending
    // invitations, and the gate deliberately does not model that: `gatesFrom` and
    // `blockersFor` evaluate the invite REQUIREMENT tree only, so a ban appears
    // neither in `missing` nor in `reachable`. Carried as its own fact rather than
    // folded into those two, which would put a second interpretation of the
    // requirement tree in the repository. A joined faction cannot be banned.
    const bannedBy = isJoined ? [] : enemies.filter((enemy) => joined.has(enemy));
    // A sorted COPY. `g.missing` is the array inside ProjectedState, which the
    // live fold keeps across renders, so sorting in place would permanently
    // reorder wire data under every other consumer and under a replay re-fold.
    // Ranked by cost, worst first: the cell shows four of them, and the one
    // requirement that decides the row is the one that used to hide behind "+2".
    const missing = [...(g?.missing ?? [])].sort(
      (a, b) => blockerSec(b, incomePerSec) - blockerSec(a, incomePerSec),
    );
    return {
      name,
      joined: isJoined,
      invited: invited.has(name),
      reachable: g?.reachable ?? true,
      evaluated: g !== undefined,
      progress: isJoined || invited.has(name) ? 1 : g?.progress,
      rep: standing?.rep,
      favor,
      ...(favor !== undefined && gate !== undefined ? { favorFrac: Math.min(1, favor / gate) } : {}),
      canDonate: gate !== undefined && favor !== undefined && favor >= gate,
      missing,
      missingSec: missing.length > 0 ? blockerSec(missing[0]!, incomePerSec) : -1,
      workTypes: f.workTypes?.[name] ?? [],
      enemies,
      bannedBy,
      wouldBan: isJoined ? [] : enemies.filter((enemy) => !joined.has(enemy)),
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
  // Ban-locked reads differently from BitNode-locked and from merely far away.
  if (row.bannedBy.length > 0) {
    return { status: "bad", tooltip: `banned this install cycle by ${row.bannedBy.join(", ")}` };
  }
  // Without a gate this used to claim "0 requirement(s) still missing", which is
  // the fabricated-zero reading of an unevaluated row.
  if (!row.evaluated) return { status: "wait", tooltip: "invite requirements not evaluated yet" };
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
    // `-1` for an unknown, the sentinel the `worth` column already uses:
    // unknowns last under the descending default, first when the operator clicks
    // to ascend. `Column.sort` cannot return undefined.
    sort: (r) => r.progress ?? -1,
    cell: (r) => {
      if (r.joined) return `<span class="good">joined</span>`;
      if (r.invited) return `<span class="good">invited</span>`;
      if (!r.reachable) return `<span class="bad">unreachable</span>`;
      // A meter toward an invitation that cannot arrive is the false claim; the
      // ban lasts the whole install cycle.
      if (r.bannedBy.length > 0) {
        return `<span class="bad" title="${esc(`banned this install cycle by ${r.bannedBy.join(", ")}`)}">banned</span>`;
      }
      if (r.progress === undefined) {
        return `<span class="muted" title="requirement evaluation needs the factions driver — nothing on the wire says how close this is">–</span>`;
      }
      return meter(r.progress, `${(r.progress * 100).toFixed(0)}%`, false, "progress on the bottleneck requirement");
    },
  },
  {
    id: "missing",
    label: "still needs",
    wrap: true,
    // The worst estimated cost, not the requirement COUNT: a count ranks a
    // faction with four cheap requirements above one with a single forty-minute
    // promotion walk, which is the failure this replaces. It ranks `missing`
    // only — the ban chip below is a different fact.
    sort: (r) => r.missingSec,
    cell: (r) => {
      // Prospective, for a row that could still be joined: a join gives these up
      // for the install cycle, and `objective.foreclosed` only says so after the
      // solver has already committed the set.
      const bans = !r.joined && r.bannedBy.length === 0 && r.wouldBan.length > 0
        ? ` <span class="need bad" title="${esc(`joining bans these for this install cycle: ${r.wouldBan.join(", ")}`)}">bans ${r.wouldBan.length}</span>`
        : "";
      if (r.missing.length === 0) return `<span class="muted">—</span>${bans}`;
      const hidden = r.missing.slice(4);
      return r.missing
        .slice(0, 4)
        .map(
          (blocker) =>
            `<span class="need ${blocker.reachable ? "" : "bad"}" title="${esc(blockerTitle(blocker))}">` +
            `${esc(describeBlocker(blocker))}` +
            // Only a blocker that CARRIES an estimate prints one. The coarse
            // per-unit fallback that ordered the chips is a ranking device, not a
            // measurement, and printing it as the requirement's ETA is the
            // absence-as-zero trap in a new place.
            `${blocker.etaSec !== undefined ? ` ${esc(fmtTime(blocker.etaSec * 1000))}` : ""}` +
            `<span class="owner">${esc(blocker.owner)}</span></span>`,
        )
        .join(" ")
        .concat(
          hidden.length > 0
            ? ` <span class="muted" title="${esc(hidden.map(describeBlocker).join(", "))}">+${hidden.length}</span>`
            : "",
          bans,
        );
    },
  },
  {
    id: "rep",
    label: "rep",
    sort: (r) => r.rep ?? -1,
    cell: (r) => {
      if (!r.joined) return `<span class="muted">–</span>`;
      // Unknown, not zero. `standings` needs the singularity API and is rebuilt
      // from `player.factions` on a 60s probe while membership comes from the free
      // 5s one, so "joined with no standing" is routine — permanent pre-SF4 and
      // for the first minute after any join. A confident `0` there reads as
      // "nothing banked here, safe to install".
      if (r.rep === undefined) {
        return `<span class="muted" title="reputation needs the singularity API (BN4/SF4); a fresh join reads unknown until the 60s standings probe runs">–</span>`;
      }
      return fmtNum(r.rep, 0);
    },
  },
  {
    id: "favor",
    label: "favor",
    sort: (r) => r.favor ?? -1,
    cell: (r) => {
      if (!r.joined) return `<span class="muted">–</span>`;
      if (r.favor === undefined) {
        return `<span class="muted" title="favor needs the singularity API (BN4/SF4); a fresh join reads unknown until the 60s standings probe runs">–</span>`;
      }
      // Favor only matters as a donation gate, so it is shown as progress
      // toward that gate rather than as a bare number — but a meter with no
      // denominator is the same false claim as a fabricated favor, and
      // `favorToDonate` can be absent while favor is known.
      if (r.favorFrac === undefined) {
        return `<span title="the donation favor gate is not on the wire, so there is nothing to measure this against">${fmtNum(r.favor, 1)}</span>`;
      }
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

/** The columns take `state` because ONE of them has to: the price cell names the
 *  factors between the catalogue base and the price, and those live in
 *  `plan.context.priceQueue` and the BitNode's multiplier table rather than on
 *  the row. */
function augColumns(state: ProjectedState): Column<AugRow>[] {
  const priceQueue = state.topics.factions?.plan?.context.priceQueue;
  const p = state.topics.progression;
  // The pinned STATIC table, with an observed one winning field by field:
  // `progression.multipliers` is SF5/BN5-gated, so in most nodes it is
  // permanently ABSENT rather than late, and `?? 1` would be a wrong answer
  // asserted as fact. Undefined here is an unknown BitNode and is said as such.
  const augMoneyCost = effectiveBitNodeMultipliers(p?.bitNode, sfLevel(p?.sourceFiles, 12), p?.multipliers)?.[
    "AugmentationMoneyCost"
  ];
  return [
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
        if (base === undefined || base === r.cost) return fmtMoney(r.cost);
        // "base X before the queue escalation" was false. `basePrice` is the raw
        // CATALOGUE number, while the price also carries the BitNode's
        // AugmentationMoneyCost (3 in BN15, 5 in BN10) and, for NeuroFlux,
        // 1.14^level — so in BN15 an untouched queue printed "$3m (base $1m)" and
        // attributed 3x to an escalation that had not happened. The label now says
        // what the number IS, and the factors are named separately so buying in a
        // different order can actually be reasoned about. (SF11 is not a separate
        // factor: it discounts the 1.9 itself.)
        const factors = [
          ...(priceQueue !== undefined ? [`the queue escalation 1.9^${priceQueue.nonSoA}`] : []),
          ...(r.name === NEUROFLUX && priceQueue !== undefined
            ? [`the NeuroFlux level 1.14^${priceQueue.neurofluxLevel}`]
            : []),
          augMoneyCost === undefined
            ? "this BitNode's augmentation cost multiplier, which is unknown"
            : `this BitNode's augmentation cost multiplier of ${fmtNum(augMoneyCost, 2)}`,
        ];
        return (
          `${fmtMoney(r.cost)} <span class="muted" title="${esc(
            `the price above also carries ${factors.join(", ")}`,
          )}">(catalogue base ${fmtMoney(base)})</span>`
        );
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
}

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
    // A favor push buys nothing this cycle: it banks reputation so the NEXT
    // cycle's donations are unlocked. Unlabelled, its row reads "augs 0 / cash
    // $0" and looks like a bug, and `purpose` is also what gates whether factions
    // keeps working once progression has armed an install.
    esc(pkg.faction) +
      (pkg.purpose === "favor"
        ? ` <span class="chip idle" title="reputation banked for next-cycle favor, not for augmentations this cycle">favor</span>`
        : ""),
    fmtNum(pkg.repTarget, 0),
    esc(fmtTime((pkg.workSecFromNow ?? 0) * 1000)),
    esc(fmtTime(pkg.etaSec * 1000)),
    // The other source of a zero here: the union is deduplicated, so a package
    // counts only what the pushes before it did not already buy.
    `<span title="augmentations this push adds that earlier pushes did not already buy">${String(pkg.augmentations.length)}</span>`,
    fmtMoney(pkg.totalCost),
    fmtRate(pkg.marginalRate),
    // Required in the type, but old JSONL predates it — a fabricated 0 favor
    // would be read as "this push banks nothing".
    pkg.favorAfterInstall === undefined ? `<span class="muted">–</span>` : fmtNum(pkg.favorAfterInstall, 1),
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
  // The committed budget is on the wire; do not re-derive it. The published curve
  // is often NOT this pass's sweep — the sweep runs on the forecast's
  // recalibration tick and a repriced pass republishes the last one, and a latched
  // objective carries an older curve still while `budgetSec` moves on. An argmax
  // then marks the OLD sweep's winner and the panel contradicts its own "cycle
  // budget" tile, with nothing to notice it by. Tolerance rather than ===, the way
  // a committed package is re-found by `repTarget`: these grid values are `pow()`
  // doubles carried through JSON.
  const isCommitted = (sample: HorizonSample): boolean => Math.abs(sample.sec - portfolio.budgetSec) <= 1e-9;
  const committedOnGrid = curve.some(isCommitted);
  const sweep = curve.length > 0
    ? rankedTable(
        ["budget", "value", "rate", "factions"],
        curve.map((sample) => [
          esc(fmtTime(sample.sec * 1000)),
          fmtNum(sample.value, 2),
          fmtRate(sample.rate),
          String(sample.factions),
        ]),
        { selected: (index) => committedOnGrid && isCommitted(curve[index]!), left: [0] },
      ) +
      (committedOnGrid
        ? ""
        : note(
            `the committed ${fmtTime(portfolio.budgetSec * 1000)} budget is not on this grid — this sweep predates it`,
          ))
    : note("the budget sweep re-runs on the forecast's recalibration tick");

  return card(
    "Portfolio",
    summary +
      table(
        ["faction", "rep target", "starts after", "adds", "augs", "cash", "marginal/sec", "favor after"],
        rows,
        {
          left: [0],
          // Starvation is a transient forecast state, not an exhausted frontier,
          // and with `intent` absent this table would otherwise assert the latter.
          empty: objective.horizonStarved ? "no set fits the planning window" : "no set committed yet",
        },
      ) +
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
    if (!f) return waitingPanel("Factions", "the factions probe");

    const rows = factionRows(state);
    // One predicate per filter, used for BOTH the badge and the filtering. A
    // badge computed separately drifts from the rows it promises: "reachable"
    // counted only un-invited factions while the filter included invited ones,
    // so every pending invitation made the badge undercount its own view.
    const FACTION_VIEWS: { value: string; label: string; match(row: (typeof rows)[number]): boolean }[] = [
      { value: "all", label: "all", match: () => true },
      { value: "joined", label: "joined", match: (r) => r.joined },
      // Banned rows are excluded here and given their own view rather than folded
      // into "unreachable": the "reachable" badge counted invitations that cannot
      // arrive this cycle, and a ban is temporary where an unreachable requirement
      // is for the whole run.
      { value: "open", label: "reachable", match: (r) => !r.joined && r.reachable && r.bannedBy.length === 0 },
      { value: "objective", label: "objective", match: (r) => r.inObjective },
      { value: "banned", label: "banned", match: (r) => r.bannedBy.length > 0 },
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
        }) +
        note(
          "requirement evaluation needs the factions driver — joined membership only until it runs; reputation and favor need the singularity API",
        );

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

    // NOT ranked, deliberately. The producer pushes two incommensurable units
    // into one `value`: reputation/sec for a work target (order 1e2) and
    // BN-seconds of package value per second for the runner-up package (order
    // 1e-3). Sorting them together always put every work row above the one real
    // package alternative and invited the reading that it was better by five
    // orders of magnitude. The topic carries only `{label, value}`, so the viewer
    // cannot group by unit either — ranking WITHIN a unit needs a `unit` field on
    // `ScoredAlternative` and on the wire. Until then the rows stay in the order
    // the planner scored them, said out loud. `fmtRate`, not `fmtNum(v, 3)`,
    // because a package rate below 5e-4 printed as a flat "0.000".
    const alternatives =
      f.plan && f.plan.alternatives.length > 0
        ? table(
            ["alternative", "value"],
            f.plan.alternatives.slice(0, 8).map((entry) => [esc(entry.label), fmtRate(entry.value)]),
            { left: [0] },
          ) +
          note(
            hint(
              "in scoring order, not ranked",
              "some rows are reputation per second at a faction and some are BN-seconds of package value per second; the topic publishes no unit, so ordering them against each other would assert a comparison the data does not support",
            ),
          ) +
          (f.plan.alternatives.length > 8 ? shownOf(8, f.plan.alternatives.length, "scored alternatives") : "")
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
        dataTable("augs.list", shownAugs, augColumns(state), {
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
