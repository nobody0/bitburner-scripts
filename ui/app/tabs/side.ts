import type { ContractFailure } from "../../../shared/telemetry/topics/side.ts";
import { ago } from "../lib/clock.ts";
import { card, collapsible, definitions, note, shownOf, table, tiles, waitingPanel } from "../lib/dom.ts";
import { esc, fmtNum } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Coding-contract telemetry is a digest: totals and the front work batch are
 * state, while a full rejected input/answer is logged once as
 * `contract.quarantined`. */

/** The retained replay, and the only reader of it.
 *
 * This used to fall back to scanning the event tail backwards for the newest
 * `contract.quarantined` record. That scan was dead: the projection assigns
 * `state.contractReplay` from the very record it then pushes onto `events`
 * (ui/app/project.ts), so the scan could only run when the field was already
 * empty — and in that case there was nothing in the ring to find either.
 *
 * The shape check is not dead, and is the reason this is still a function.
 * `data` and `answer` are dereferenced for `.length` below and `tab.render()`
 * (ui/app/main.ts) has no try/catch, so a stored run from an older build with a
 * differently-shaped payload would take down the whole viewer frame rather than
 * one card. The check belongs at the fold — rejecting the record there would
 * keep an earlier valid replay instead of letting a malformed newer one erase
 * it — but the fold casts every topic payload unchecked, so it sits here and
 * the card below says which of the two empty cases it is looking at. */
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

export const sideTab: Tab = {
  id: "side",
  render(state: ProjectedState) {
    const s = state.topics.side;
    if (!s) return waitingPanel("Coding contracts", "the side probe");

    const candidates = s.solvableTotal ?? s.contracts.length;
    const quarantined = s.quarantinedTotal ?? s.failures?.length ?? 0;
    const typeTotal = s.contractTypeTotal;
    const supportedTypes = s.supportedTypeTotal;
    const coverage = typeTotal !== undefined && supportedTypes !== undefined
      ? `${supportedTypes}/${typeTotal}`
      : s.registryComplete ? "complete" : "–";
    const summary = tiles([
      { label: "contracts on network", value: fmtNum(s.contractTotal ?? s.contracts.length) },
      {
        label: "candidate queue",
        value: fmtNum(candidates),
        sub: `${s.contracts.length} visible in telemetry`,
      },
      {
        label: "quarantined",
        value: fmtNum(quarantined),
        sub: quarantined ? "automatic retry disabled" : "no solver failures",
      },
      {
        label: "solver coverage",
        value: coverage,
        sub: s.registryComplete === false ? "registry has gaps" : "v3 registry complete",
      },
    ]);

    // The empty state and the truncation note used to be chosen from
    // independent conditions, so a drained batch printed "no contract
    // candidates waiting" directly above "0 of 8,437 — one 20-contract batch is
    // published", and neither sentence was true: the driver runs every 5s and
    // can empty the probe's 100-deep private queue between two network sweeps.
    // The drained case is now one statement, worded off the scan stamp rather
    // than off the probe's period — that period is not on the wire, so a
    // literal "30 s" here would drift the next time it changes.
    const drained = s.contracts.length === 0 && candidates > 0;
    const scanned = s.contractScannedAt === undefined
      ? "no network sweep recorded yet"
      : `last network scan ${ago(state, s.contractScannedAt)}`;
    const queue =
      table(
        ["host", "file"],
        s.contracts.map((contract) => [esc(contract.host), esc(contract.file)]),
        {
          empty: drained
            ? `the published batch is drained — ${fmtNum(candidates)} candidates remain in the queue behind it, and the next network sweep refills it (${scanned})`
            : "no contract candidates waiting",
          left: [1],
        },
      )
      // With no rows there is no visible batch to describe, so the drained
      // sentence above stands alone. The batch size comes off the published
      // window, not the literal 20: a short final batch is published too.
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
          ["host", "file", "type", "reason", "tries"],
          s.failures.map((failure) => [
            esc(failure.host),
            esc(failure.file),
            esc(failure.type),
            esc(failure.reason),
            failure.triesBefore === undefined ? "–" : String(failure.triesBefore),
          ]),
          { wrap: [2, 3], left: [1, 2, 3] },
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
      + card("Contract candidates", queue)
      + `</div>`
      + `<div class="col">`
      + card("Automation", automation)
      + card("Solver gaps", gaps)
      + card("Quarantine", failures)
      + card("Latest failure replay", replayCard)
      + `</div>`
    );
  },
};
