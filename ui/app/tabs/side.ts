import type { ContractFailure } from "../../../shared/telemetry/topics/side.ts";
import { card, collapsible, definitions, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Coding-contract telemetry is a digest: totals and the front work batch are
 * state, while a full rejected input/answer is logged once as
 * `contract.quarantined`. */

function latestReplay(state: ProjectedState): ContractFailure | undefined {
  if (state.contractReplay) return state.contractReplay;
  for (let index = state.events.length - 1; index >= 0; index--) {
    const record = state.events[index]!;
    if (record.kind !== "event" || record.name !== "contract.quarantined") continue;
    const value = record.data as Partial<ContractFailure> | undefined;
    if (
      typeof value?.host === "string"
      && typeof value.file === "string"
      && typeof value.type === "string"
      && typeof value.data === "string"
      && typeof value.answer === "string"
      && typeof value.reason === "string"
      && typeof value.at === "number"
    ) return value as ContractFailure;
  }
  return undefined;
}

function age(reference: number, at: number): string {
  return `${fmtTime(Math.max(0, reference - at))} ago`;
}

export const sideTab: Tab = {
  id: "side",
  render(state: ProjectedState) {
    const s = state.topics.side;
    if (!s) return note("waiting for the side probe");

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

    const queue =
      table(
        ["host", "file"],
        s.contracts.map((contract) => [esc(contract.host), esc(contract.file)]),
        { empty: "no contract candidates waiting", left: [1] },
      )
      + (candidates > s.contracts.length
        ? note(`showing the front ${s.contracts.length} of ${fmtNum(candidates)} candidates; one 20-contract batch is published`)
        : note("the visible batch is the complete candidate queue"));

    const last = s.lastResult;
    const automation = last
      ? definitions([
          ["status", `<span class="${last.ok ? "good" : "bad"}">${last.ok ? "completed" : "blocked"}</span>`],
          ["last batch", esc(last.detail)],
          ["when", esc(age(state.lastT || last.at, last.at))],
          ["last network scan", s.contractScannedAt === undefined ? "–" : esc(age(state.lastT || s.contractScannedAt, s.contractScannedAt))],
        ])
      : definitions([
          ["status", `<span class="muted">waiting for the first contract batch</span>`],
          ["last network scan", s.contractScannedAt === undefined ? "–" : esc(age(state.lastT || s.contractScannedAt, s.contractScannedAt))],
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
        ) + note(`showing ${s.failures.length} of ${quarantined}; quarantined files are never retried automatically`)
      : note("no contract has been quarantined");

    const replay = latestReplay(state);
    const replayCard = replay
      ? definitions([
          ["contract", `${esc(replay.host)} / ${esc(replay.file)}`],
          ["type", esc(replay.type)],
          ["reason", `<span class="bad">${esc(replay.reason)}</span>`],
          ["tries before", replay.triesBefore === undefined ? "–" : String(replay.triesBefore)],
          ["when", esc(age(state.lastT || replay.at, replay.at))],
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
      : note(s.failures?.length
          ? "failure replay is outside the retained event tail; the compact summary remains above"
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
