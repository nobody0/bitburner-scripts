import type { HacknetNodeDigest, HacknetPlan } from "../../../shared/telemetry/topics/hacknet.ts";
import { ago, isStale, stamp } from "../lib/clock.ts";
import { NONE, card, dataTable, hint, note, outcome, rankedTable, shownOf, table, tiles, waitingPanel, type Tile } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Past this the plan has stopped being republished rather than jittered.
 *
 *  Deliberately not `clock.ts`'s blunt 60s: the hacknet driver decides every
 *  10s (`everyMs: 10_000`), so a missed tick is normal and three is not. */
const PLAN_STALE_AFTER_MS = 30_000;

/** The free share of a hash server's RAM — the term the idle valuation is worth.
 *
 * `1 - ramUsed/ram` is literally `oldFreeRatio` in
 * `shared/strategy/hacknet/formulas.ts`, and it is why a fully occupied node's
 * idle-basis delta collapses to zero. Absent usage is said out loud rather than
 * read as zero, which would quote a busy node as entirely free. */
function freeRamTip(node: HacknetNodeDigest): string {
  if (node.ramUsed === undefined || !(node.ram > 0)) return "RAM usage unmeasured — the idle basis cannot be checked here";
  return `${fmtPct(1 - node.ramUsed / node.ram, 0)} free — the hash multiplier an idle-RAM valuation is worth`;
}

/** What the pass DID, which the ranking on its own cannot say.
 *
 * `buy` is the INTENDED purchase, published before it is attempted
 * (`game/lib/features/hacknet.ts`), so "buying" is the honest tense and whether
 * it worked is the `outcome(...)` line under the tiles. A hold is a decision and
 * not a failure: a milestone leader priced above the grant is waited for, an
 * unprofitable one is refused (`shared/strategy/hacknet/decide.ts`). The reason
 * is read off the leader and the grant only — `ranked` is capped at six rows, so
 * nothing here may claim anything about the rungs the digest dropped. */
function planDecision(plan: HacknetPlan): Tile {
  if (plan.buy) {
    const node = plan.buy.node !== undefined ? ` #${plan.buy.node}` : "";
    return { label: "decision", value: `buying ${plan.buy.kind}${node}`, sub: fmtMoney(plan.buy.cost) };
  }
  const leader = plan.ranked[0];
  if (!leader) return { label: "decision", value: "holding", sub: "nothing ranked" };
  if (leader.milestone && leader.cost > plan.moneyGranted) {
    return {
      label: "decision",
      value: "holding",
      sub: `${leader.label} at ${fmtMoney(leader.cost)} needs more than the ${fmtMoney(plan.moneyGranted)} grant`,
    };
  }
  return {
    label: "decision",
    value: "holding",
    sub: leader.worthBuying === false ? "nothing repays inside the horizon" : "nothing affordable within the grant",
  };
}

export const hacknetTab: Tab = {
  id: "hacknet",
  render(state: ProjectedState) {
    const h = state.topics.hacknet;
    if (!h) return waitingPanel("Hacknet", "the hacknet probe");

    const summary = tiles([
      { label: "nodes", value: `${h.numNodes}`, sub: h.maxNumNodes === null ? "uncapped" : `max ${h.maxNumNodes}` },
      { label: h.servers ? "hashes/sec" : "$/sec", value: fmtNum(h.productionPerSec, 3) },
      { label: "total produced", value: h.servers ? fmtNum(h.totalProduction, 0) : fmtMoney(h.totalProduction) },
      { label: "next node", value: fmtMoney(h.purchaseNodeCost) },
      ...(h.hashes ? [{ label: "hashes", value: `${fmtNum(h.hashes.current, 0)} / ${fmtNum(h.hashes.capacity, 0)}` }] : []),
      // An unobserved quote is the state the whole driver refuses to decide in
      // (`hacknetBasis` returns undefined), so it must not read as a confident
      // "0 hashes / $1m" — the hash-plan tile below guards the same value.
      ...(h.hashes
        ? [{ label: "hash sale", value: h.hashes.sellForMoneyCost > 0 ? `${fmtNum(h.hashes.sellForMoneyCost, 0)} hashes / $1m` : "unobserved" }]
        : []),
    ]);

    type Node = (typeof h.nodes)[number];
    const nodes = dataTable("hacknet.nodes", h.nodes, [
      { id: "name", label: "node", left: true, cell: (n: Node) => esc(n.name), sort: (n: Node) => n.name },
      { id: "level", label: "level", cell: (n: Node) => String(n.level), sort: (n: Node) => n.level },
      // In hash mode the RAM is a production INPUT, not just a size: the free
      // share of it is the multiplier a RAM rung is valued through, so the
      // Decision table's idle/occupied basis can only be checked against a node
      // that says how much of its RAM is occupied. Rendered used/total rather
      // than `ram - ramUsed`, which on a node whose usage was never measured
      // would print a confident "all free". The sort stays on capacity so the
      // persisted key means the same thing in both modes.
      {
        id: "ram",
        label: h.servers ? "ram used/total" : "ram",
        cell: (n: Node) => (h.servers ? hint(`${fmtRam(n.ramUsed)} / ${fmtRam(n.ram)}`, freeRamTip(n)) : fmtRam(n.ram)),
        sort: (n: Node) => n.ram,
      },
      { id: "cores", label: "cores", cell: (n: Node) => String(n.cores), sort: (n: Node) => n.cores },
      ...(h.servers
        ? [
            { id: "cache", label: "cache", cell: (n: Node) => String(n.cache ?? NONE), sort: (n: Node) => n.cache ?? 0 },
            // The cache LEVEL does not say what capacity it bought, and the
            // capacity is what a cache rung's milestone progress is scored
            // against. A hash COUNT, never GB — the summary tile above shows
            // only the fleet total.
            { id: "capacity", label: "hash cap", cell: (n: Node) => fmtNum(n.hashCapacity, 0), sort: (n: Node) => n.hashCapacity ?? 0 },
          ]
        : []),
      {
        id: "production",
        label: "production",
        cell: (n: Node) => (h.servers ? fmtNum(n.production, 3) : `${fmtMoney(n.production)}/s`),
        sort: (n: Node) => n.production,
      },
      // Lifetime production per node is dropped in hash mode: the fleet total is
      // in the summary above, the figure feeds no decision, and the column
      // budget goes to the cache/capacity pair that does.
      ...(h.servers
        ? []
        : [{ id: "total", label: "total", cell: (n: Node) => fmtMoney(n.totalProduction), sort: (n: Node) => n.totalProduction }]),
      { id: "online", label: "online", cell: (n: Node) => fmtTime(n.timeOnline * 1000), sort: (n: Node) => n.timeOnline },
    ], { defaultSort: { key: "production", dir: -1 }, empty: "no nodes purchased" });

    const upgrades = h.plan?.ranked?.length
      ? rankedTable(
          // The last column reports whether the option REPAYS (or which
          // milestone justifies it). It is not the valuation basis: idle versus
          // occupied is the tooltip on "adds $/sec", the number it explains.
          ["upgrade", "cost", "adds $/sec", "payback", "horizon net", "status"],
          h.plan.ranked.map((u) => [
            esc(u.label),
            // An upgrade the grant cannot reach yet is a different kind of
            // "not bought" than one that never repays; say which.
            h.plan!.moneyGranted < u.cost ? hint(fmtMoney(u.cost), "over the current grant") : fmtMoney(u.cost),
            u.ramBasis
              ? hint(fmtMoney(u.deltaProduction), u.ramBasis === "occupied"
                ? "valued as fleet RAM: farm income beats the hashes the busy RAM gives up"
                : "valued as idle RAM: the free-RAM hash multiplier beats farming it")
              : fmtMoney(u.deltaProduction),
            // A rung that adds no production is scored `Infinity` by design, and
            // every `cache` rung is one. `JSON.stringify(Infinity)` is `null`, so
            // the guard has to sit BEFORE the ×1000: `null * 1000` is 0, which
            // rendered the fastest payback in the table for the option that
            // never pays back at all.
            hint(
              Number.isFinite(u.paybackSec) ? fmtTime(u.paybackSec * 1000) : "never",
              `return/$ ${fmtNum(u.returnPerDollarSec, 8)}`,
            ),
            fmtMoney(u.netOverHorizon),
            esc(u.milestone
              ? `${u.milestone.kind} ${fmtNum(u.milestone.have, 0)}/${fmtNum(u.milestone.target, 0)}`
              : u.worthBuying === true ? (h.plan!.moneyGranted < u.cost ? "repays, over grant" : "repays")
              : u.worthBuying === false ? "past horizon" : NONE),
          ]),
          {
            // The wire's `selected` means "the purchase, OR the leader when
            // nothing was bought" — the producer falls back to index 0 so a
            // grant-forced fall-through still highlights the rung it bought. Only
            // `plan.buy` separates the two, so without this guard a deliberate
            // hold paints row 0 as the chosen option. Guarded here rather than in
            // the producer because every record already recorded replays through
            // this panel.
            selected: (i) => Boolean(h.plan!.buy) && h.plan!.ranked[i]!.selected,
            left: [0, 5],
          },
        )
      // No plan is not no prices: `nextUpgrades` rides a PARTIAL emission, and
      // the driver returns before publishing a plan whenever the node list or
      // the hash sale quote is missing. Showing the observed menu says the
      // VALUATION is what has not happened yet; "no upgrade costs yet" survives
      // as the table's empty text, which is where it is true (the driver clears
      // the list after a purchase invalidates every quote).
      : table(
          ["upgrade", "cost"],
          (h.nextUpgrades ?? []).map((u) => [esc(`${u.kind} #${u.node}`), fmtMoney(u.cost)]),
          { left: [0], empty: "no upgrade costs yet" },
        ) +
        (!h.plan && h.nextUpgrades?.length
          ? note(
              h.servers && !(h.hashes && h.hashes.sellForMoneyCost > 0)
                ? "prices observed; the hash sale quote is unobserved, so nothing can be valued yet"
                : "prices observed; no valuation published yet",
            )
          : "");

    // A frozen plan is the failure this tile exists to expose: the driver returns
    // early while the hash sale quote is unobserved, so `plan` can sit unchanged
    // under last-write-wins while the probe-fed summary above keeps refreshing.
    // An unconditional age reads "3s ago" forever and trains the eye past it, so
    // the sub says which of the two states this is.
    const planStale = h.plan ? isStale(state, h.plan.evaluatedAt, PLAN_STALE_AFTER_MS) : false;

    const decision = h.plan
      ? tiles([
          planDecision(h.plan),
          { label: "horizon", value: Number.isFinite(h.plan.horizonSec) ? fmtTime(h.plan.horizonSec * 1000) : NONE },
          { label: "cash / grant", value: `${fmtMoney(h.plan.moneyAvailable)} / ${fmtMoney(h.plan.moneyGranted)}` },
          // `hashDollarValue` is 1 outside BN9/SF9 — the identity multiplier that
          // turns native production into dollars, not an observed quote. Quoting
          // it as a price would invent a currency the run does not have.
          ...(h.servers ? [{ label: "hash value", value: `${fmtMoney(h.plan.hashDollarValue)}/hash` }] : []),
          // Context, not a switch: RAM upgrades are valued as the better of
          // idle-hash and occupied-farm regardless, and each row says which won.
          { label: "fleet load", value: `${fmtNum(h.plan.fleetUtilization * 100, 1)}%`, sub: h.plan.fleetDemanded === true ? "fleet RAM is scarce" : h.plan.fleetDemanded === false ? "fleet RAM is spare" : "basis unavailable" },
          {
            label: "evaluated",
            value: planStale ? html`<span class="bad">${ago(state, h.plan.evaluatedAt)}</span>` : ago(state, h.plan.evaluatedAt),
            sub: planStale ? "the plan stopped being republished" : "current",
          },
        ]) +
        // `lastResult` is a sticky module-level value republished with its
        // ORIGINAL `at` on every pass, so an hour-old refusal reads as what just
        // happened unless the age rides along. The stamp goes INSIDE the outcome
        // line: appended after it, it would land as an orphan sibling of the <p>.
        (h.plan.lastResult
          ? outcome({
              ok: h.plan.lastResult.ok,
              detail: html`${h.plan.lastResult.detail} · ${stamp(state, h.plan.lastResult.at)}`,
            })
          : "") +
        upgrades +
        (h.plan.rankedTotal > h.plan.ranked.length ? shownOf(h.plan.ranked.length, h.plan.rankedTotal, "scored upgrades") : "")
      : upgrades;

    const hashUpgrades = h.hashUpgrades?.length
      ? table(
          ["hash upgrade", "level", "cost"],
          h.hashUpgrades.map((u) => [esc(u.name), String(u.level), fmtNum(u.cost, 0)]),
          { left: [0] },
        )
      : "";

    const hashPlan = h.plan?.hashes
      ? tiles([
          { label: "bank", value: `${fmtNum(h.plan.hashes.current, 0)} / ${fmtNum(h.plan.hashes.capacity, 0)}` },
          { label: "production", value: `${fmtNum(h.plan.hashes.productionPerSec, 3)}/s` },
          { label: "cash quote", value: h.plan.hashes.sellForMoneyCost > 0 ? `${fmtNum(h.plan.hashes.sellForMoneyCost, 0)} / $1m` : "unavailable" },
        ]) +
        (h.plan.hashes.ranked.length
          ? rankedTable(
              ["goal", "cost", "priority", "cash alternative", "net value", "status"],
              h.plan.hashes.ranked.map((action) => [
                esc(`${action.name}${action.target ? ` @ ${action.target}` : ""}`),
                fmtNum(action.cost, 0),
                fmtNum(action.priority, 0),
                fmtMoney(action.saleValueDollars),
                action.netDollars !== undefined ? fmtMoney(action.netDollars) : "goal",
                action.eligible === false ? "worse than cash" : action.fitsCapacity === false ? "needs cache" : action.affordable ? "ready" : "saving",
              ]),
              { selected: (i) => h.plan!.hashes!.ranked[i]!.selected, left: [0, 5] },
            )
          : "") +
        (h.plan.hashes.rankedTotal > h.plan.hashes.ranked.length
          ? shownOf(h.plan.hashes.ranked.length, h.plan.hashes.rankedTotal, "scored hash goals")
          : "") +
        // Dated for the same reason as the purchase result above.
        (h.plan.hashes.lastResult
          ? outcome({
              ok: h.plan.hashes.lastResult.ok,
              detail: html`${h.plan.hashes.lastResult.detail} · ${stamp(state, h.plan.hashes.lastResult.at)}`,
            })
          : "")
      : "";

    return (
      `<div class="col wide">` +
      card("Hacknet", summary + nodes) +
      `</div>` +
      `<div class="col">` +
      card("Decision", decision) +
      (hashPlan ? card("Hash plan", hashPlan) : "") +
      // Funding and hash-spend history live in the arbiter drawer
      // (ui/app/lib/arbiter.ts): the decisions are cross-feature, so their
      // log is too.
      (hashUpgrades ? card("Hash upgrades", hashUpgrades) : "") +
      `</div>`
    );
  },
};
