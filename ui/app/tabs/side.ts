import type {
  ContractFailure,
  ContractOrigin,
  ContractOriginTotals,
  ContractSolveReport,
  SideState,
} from "../../../shared/telemetry/topics/side.ts";
import { ago } from "../lib/clock.ts";
import { card, collapsible, definitions, NONE, note, shownOf, table, tiles, waitingPanel } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Coding-contract telemetry is a digest: totals and the front work batch are
 * state, while a full rejected input/answer is logged once as
 * `contract.quarantined`. */

/** Persisted payloads are untrusted, and render has no error boundary. */
function latestReplay(state: ProjectedState): ContractFailure | undefined {
  const value: Partial<ContractFailure> | null = state.contractReplay;
  if (
    typeof value?.host === "string"
    && typeof value.file === "string"
    && typeof value.type === "string"
    && typeof value.data === "string"
    && typeof value.answer === "string"
    && typeof value.reason === "string"
    && typeof value.at === "number"
    && (value.triesBefore === undefined || typeof value.triesBefore === "number")
  ) return value as ContractFailure;
  return undefined;
}

const ORIGINS: ContractOrigin[] = ["network", "darknet"];

/** Persisted telemetry is untrusted at the render boundary. Validate the
 * minimum shape once, then dereference freely below. */
function originTotals(state: ProjectedState): [ContractOrigin, ContractOriginTotals][] {
  const rewards = state.topics.side?.rewards;
  if (!rewards || typeof rewards !== "object") return [];
  const out: [ContractOrigin, ContractOriginTotals][] = [];
  for (const origin of ORIGINS) {
    const totals: Partial<ContractOriginTotals> | null | undefined = rewards[origin];
    if (totals && typeof totals === "object" && typeof totals.attempted === "number") {
      out.push([origin, totals as ContractOriginTotals]);
    }
  }
  return out;
}

function solveReports(state: ProjectedState): ContractSolveReport[] {
  const recent = state.topics.side?.recentSolves;
  if (!Array.isArray(recent)) return [];
  return recent.filter((entry): entry is ContractSolveReport =>
    !!entry && typeof entry === "object"
    && typeof entry.at === "number" && typeof entry.host === "string" && typeof entry.file === "string");
}

function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? fmtNum(value) : NONE;
}

/** Keep display-precision money visibly distinct from the exact ledger. */
function approxMoney(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `≈${fmtMoney(value)}` : NONE;
}

/** Ignore malformed persisted addends instead of poisoning the total with NaN. */
function across(rows: [ContractOrigin, ContractOriginTotals][], field: keyof ContractOriginTotals): number {
  let total = 0;
  for (const [, totals] of rows) {
    const value = totals[field];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

/** Two figures for the same window, and the card says plainly which is which.
 *
 * Ours is per-origin and read off the game's own display text, so it is a
 * magnitude — `formatMoney` carries about four significant figures. The game's
 * ledger is exact but has no origin split. Neither replaces the other, and a
 * gap between them is expected rather than a fault. */
function rewardsBody(state: ProjectedState): string {
  const rows = originTotals(state);
  if (rows.length === 0) {
    return note("no coding contract has been attempted since the last install");
  }
  const perOrigin = table(
    ["origin", "attempted", "solved", "money (approx)", "faction rep", "company rep", "quarantined"],
    rows.map(([origin, t]) => [
      esc(origin),
      num(t.attempted),
      num(t.solved),
      approxMoney(t.moneyApprox),
      num(t.factionRep),
      num(t.companyRep),
      num(t.quarantined),
    ]),
    { left: [0] },
  );

  const ours = across(rows, "moneyApprox");
  const paidMoney = across(rows, "moneySolves");
  const ledger = state.topics.progression?.moneySources?.sinceInstall?.codingcontract;
  const since = state.topics.side?.rewardsSince;
  const crossCheck = definitions([
    // The solve count behind the figure, because it is what separates a node
    // that pays zero for contracts from contracts that never paid money at all.
    ["parsed from reward text, by origin", `${approxMoney(ours)} over ${fmtNum(paidMoney)} paying solve(s)`],
    [
      "game ledger, exact (no origin split)",
      typeof ledger === "number" && Number.isFinite(ledger) ? fmtMoney(ledger) : NONE,
    ],
    ["measuring since", typeof since === "number" ? esc(ago(state, since)) : NONE],
  ]);

  // Absorbing an unreadable reward into the money total as a zero is the one
  // failure this whole card exists to avoid, so say it out loud.
  const unparsed = across(rows, "unparsed");
  const warning = unparsed > 0
    ? `<p class="bad">${unparsed} reward string${unparsed === 1 ? "" : "s"} did not match this build's parser — `
      + `the money figure is short by an unknown amount. The game's number format, currency symbol or locale `
      + `may have moved.</p>`
    : "";

  const unrewarded = across(rows, "unrewarded");
  return perOrigin + crossCheck + warning + note(
    "money is read off the game's formatted reward text, which carries about four significant figures — a"
    + " magnitude, not a ledger. Reputation is exact. The game's own total is authoritative for the combined"
    + " figure; only ours is attributable to an origin."
    + (unrewarded > 0 ? ` ${unrewarded} solved contract(s) paid nothing at all.` : "")
    + (paidMoney > 0 && ours === 0
      ? " Money rewards landed but totalled zero, which is what a BitNode that zeroes contract money looks like."
      : ""),
  );
}

function recentSolvesBody(state: ProjectedState): string {
  const reports = solveReports(state);
  if (reports.length === 0) return note("no contract has been solved since the last install");
  const solved = across(originTotals(state), "solved");
  const rows = reports
    .slice()
    .reverse()
    .map((entry) => [
      esc(ago(state, entry.at)),
      esc(entry.origin ?? NONE),
      esc(entry.file),
      esc(entry.type ?? NONE),
      esc(entry.reward),
      entry.to?.length
        ? esc(entry.to.join(", ") + (entry.toTotal ? ` +${entry.toTotal - entry.to.length}` : ""))
        : NONE,
    ]);
  return table(["when", "origin", "file", "type", "the game said", "toward"], rows, {
    wrap: [3, 4, 5],
    left: [2, 3, 4, 5],
  })
    + shownOf(rows.length, solved, "a bounded sample; the totals above are the census");
}

export const sideTab: Tab = {
  id: "side",
  render(state: ProjectedState) {
    const s = state.topics.side;
    if (!s) return waitingPanel("Coding contracts", "the side probe");

    const candidates = s.solvableTotal ?? s.contracts.length;
    // Persisted telemetry, and `render()` has no try/catch (ui/app/main.ts): a
    // stored run from a build that predates the per-origin census carries no
    // `contractsByOrigin`, and dereferencing `.network` on it would take down
    // the whole viewer frame rather than one tile.
    const census = typeof s.contractsByOrigin === "object" && s.contractsByOrigin !== null
      ? s.contractsByOrigin as Partial<SideState["contractsByOrigin"]>
      : undefined;
    const quarantined = s.quarantinedTotal ?? s.failures?.length ?? 0;
    const typeTotal = s.contractTypeTotal;
    const supportedTypes = s.supportedTypeTotal;
    const coverage = typeTotal !== undefined && supportedTypes !== undefined
      ? `${supportedTypes}/${typeTotal}`
      : s.registryComplete ? "complete" : "–";
    const summary = tiles([
      { label: "contracts observed", value: fmtNum(s.contractTotal ?? s.contracts.length) },
      {
        label: "candidate queue",
        value: fmtNum(candidates),
        sub: census === undefined
          ? `${s.contracts.length} visible; per-origin census not published yet`
          : `${s.contracts.length} visible; network ${fmtNum(census.network?.solvable)}/${fmtNum(census.network?.observed)}`
            + ` · darknet ${fmtNum(census.darknet?.solvable)}/${fmtNum(census.darknet?.observed)} solvable/observed`,
      },
      {
        label: "quarantined",
        value: fmtNum(quarantined),
        sub: quarantined ? "automatic retry disabled" : "no solver failures",
      },
      {
        label: "solver coverage",
        value: coverage,
        // Absence means the coverage probe has not run.
        sub: s.registryComplete === false
          ? "registry has gaps"
          : s.registryComplete
            ? "every observed type has a solver"
            : "coverage not observed yet",
      },
    ]);

    // A driver can drain the visible batch before the next authoritative sweep.
    const drained = s.contracts.length === 0 && candidates > 0;
    const scanned = s.contractScannedAt === undefined
      ? "no network sweep recorded yet"
      : `last network scan ${ago(state, s.contractScannedAt)}`;
    const queue =
      table(
        ["host", "file", "origin"],
        s.contracts.map((contract) => [esc(contract.host), esc(contract.file), esc(contract.origin ?? NONE)]),
        {
          empty: drained
            ? `the published batch is drained — ${fmtNum(candidates)} candidates remain in the queue behind it, and the next network sweep refills it (${scanned})`
            : "no contract candidates waiting",
          left: [1],
        },
      )
      // Derive the batch size; the final published batch may be short.
      + (s.contracts.length === 0
        ? ""
        : candidates > s.contracts.length
          ? shownOf(s.contracts.length, candidates, `one ${s.contracts.length}-contract batch is published`)
          : note("the visible batch is the complete candidate queue"));

    const last = s.lastResult;
    const automation = last
      ? definitions([
          ["status", `<span class="${last.ok ? "good" : "bad"}">${last.ok ? "completed" : "blocked"}</span>`],
          ["last batch", esc(last.detail)],
          ["when", esc(ago(state, last.at))],
          ["last network scan", esc(ago(state, s.contractScannedAt))],
        ])
      : definitions([
          ["status", `<span class="muted">waiting for the first contract batch</span>`],
          ["last network scan", esc(ago(state, s.contractScannedAt))],
        ]);

    const missing = Object.entries(s.unsolvableByType ?? {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const gaps = missing.length
      ? table(
          ["unsupported contract type", "observed files"],
          missing.map(([type, count]) => [esc(type), String(count)]),
          { wrap: [0] },
        ) + note("zero means the game exposes the type but no matching file has reached inspection")
      : note("every contract type reported by the running game has a solver");

    const failures = s.failures?.length
      ? table(
          ["host", "file", "origin", "type", "reason", "tries"],
          s.failures.map((failure) => [
            esc(failure.host),
            esc(failure.file),
            esc(failure.origin ?? NONE),
            esc(failure.type),
            esc(failure.reason),
            failure.triesBefore === undefined ? "–" : String(failure.triesBefore),
          ]),
          { wrap: [3, 4], left: [1, 2, 3, 4] },
        ) + shownOf(s.failures.length, quarantined, "quarantined files are never retried")
      : note("no contract has been quarantined");

    const replay = latestReplay(state);
    const replayCard = replay
      ? definitions([
          ["contract", `${esc(replay.host)} / ${esc(replay.file)}`],
          ["type", esc(replay.type)],
          ["reason", `<span class="bad">${esc(replay.reason)}</span>`],
          ["tries before", replay.triesBefore === undefined ? "–" : String(replay.triesBefore)],
          ["when", esc(ago(state, replay.at))],
        ])
        + collapsible(
          "side.replay.input",
          `input · ${replay.data.length} chars`,
          `<div class="replay-value">${esc(replay.data)}</div>`,
          true,
        )
        + collapsible(
          "side.replay.answer",
          `submitted answer · ${replay.answer.length} chars`,
          `<div class="replay-value">${esc(replay.answer)}</div>`,
        )
      // Three empty cases, and they are not the same state. A payload that is
      // present but unreadable must not read as "nothing has failed yet": the
      // quarantine summaries above are still the evidence, and the replay is
      // the thing that is missing.
      : note(state.contractReplay
          ? "the retained replay does not match the fields this build reads; the compact summary remains above"
          : s.failures?.length
            ? "no replay was retained for these quarantines — they happened before this viewer's record window, or the run was served compacted; the compact summary remains above"
            : "a rejected answer will log its input and submitted answer here once");

    return (
      `<div class="col wide">`
      + card("Coding contracts", summary)
      + card("Contract rewards", rewardsBody(state))
      + card("Contract candidates", queue)
      + `</div>`
      + `<div class="col">`
      + card("Automation", automation)
      + card("Recent solves", recentSolvesBody(state))
      + card("Solver gaps", gaps)
      + card("Quarantine", failures)
      + card("Latest failure replay", replayCard)
      + `</div>`
    );
  },
};
