import type { Server } from "@ns";
import { coreBonus } from "../../../shared/formulas.ts";
import type { RootState } from "../../../shared/features/servers.ts";
import { definitions, meter, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtRam, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";

export interface ServerExplorerRow {
  server: Server;
  root: RootState;
  hackTimeMs?: number;
  hackTimeMinMs?: number;
  portOpeners: number;
  moneyFrac: number;
  atMaxMoney: boolean;
  secFrac: number;
  atMinSec: boolean;
}

export function contractHosts(state: ProjectedState): Set<string> {
  return new Set([
    ...(state.topics.side?.contracts ?? []).map((contract) => contract.host),
    ...(state.topics.side?.failures ?? []).map((failure) => failure.host),
  ]);
}

function assignment(row: ServerExplorerRow, state: ProjectedState): { label: string; explanation: string } {
  const farm = state.topics.farm;
  const pipeline = farm?.pipelines?.find((candidate) => candidate.host === row.server.hostname);
  if (pipeline?.role === "farm") {
    const score = pipeline.moneyPerSecPerGb === undefined
      ? ""
      : ` at ${fmtMoney(pipeline.moneyPerSecPerGb)}/s/GB`;
    const solve = farm?.targetSolveExact === false ? "; the bounded target solve was not exhaustive" : "";
    return {
      label: `${pipeline.mode} farm · ${fmtRam(pipeline.gb)}`,
      explanation: `Selected as the committed farm winner${score}${solve}.`,
    };
  }
  if (pipeline?.role === "prep") {
    const eta = pipeline.eta
      ? ` Estimated ${fmtTime(pipeline.eta.seconds * 1_000)} to prep (${pipeline.eta.bound}-bound).`
      : "";
    return {
      label: `prep · ${fmtRam(pipeline.gb)}`,
      explanation: `Selected for preparation because its post-prep value repays the remaining preparation cost.${eta}`,
    };
  }
  if (farm?.target === row.server.hostname) {
    return { label: "farm target", explanation: "Selected as the farm target; no pipeline detail has been published yet." };
  }
  if (farm?.prepTarget === row.server.hostname) {
    return { label: "prep target", explanation: "Selected as the preparation target; no pipeline detail has been published yet." };
  }

  const server = row.server;
  if ((server.moneyMax ?? 0) <= 0) {
    return { label: "unassigned", explanation: "Not a money target: this server has no money pool." };
  }
  if (row.root === "blocked") {
    const blockers = [];
    const skill = state.player?.skills?.hacking ?? 0;
    if ((server.requiredHackingSkill ?? 0) > skill) blockers.push(`needs hacking ${fmtNum(server.requiredHackingSkill ?? 0)} (have ${fmtNum(skill)})`);
    if ((server.numOpenPortsRequired ?? 0) > row.portOpeners) blockers.push(`needs ${server.numOpenPortsRequired} port openers (have ${row.portOpeners})`);
    return { label: "blocked", explanation: `Not eligible: ${blockers.join("; ") || "root access is unavailable"}.` };
  }
  if (row.root === "ready") {
    return { label: "rootable", explanation: "Eligible for root now, but not a target until root access is taken and the evaluator scores it." };
  }
  return {
    label: "eligible · unassigned",
    explanation: "Eligible, but not selected. The current rollup publishes the committed winner, not rejected candidate scores, so the dashboard does not invent a rejection reason.",
  };
}

export function serverInspector(row: ServerExplorerRow, state: ProjectedState): string {
  const server = row.server;
  const role = assignment(row, state);
  const contracts = (state.topics.side?.contracts ?? []).filter((contract) => contract.host === server.hostname).length;
  const quarantined = (state.topics.side?.failures ?? []).filter((failure) => failure.host === server.hostname).length;
  const maxMoney = server.moneyMax ?? 0;
  const currentMoney = server.moneyAvailable ?? 0;
  const minSecurity = server.minDifficulty;
  const currentSecurity = server.hackDifficulty;
  const cores = server.cpuCores ?? 1;
  const supportBonus = coreBonus(Math.max(1, cores));
  const flags = [
    server.purchasedByPlayer ? "purchased" : "network",
    server.backdoorInstalled ? "backdoored" : "no backdoor",
    `${contracts} queued contract${contracts === 1 ? "" : "s"}`,
    quarantined ? `${quarantined} quarantined` : "",
  ].filter(Boolean).join(" · ");

  const currentVsIdeal = table(
    ["measure", "current", "ideal", "state"],
    [
      [
        "money",
        esc(fmtMoney(currentMoney)),
        maxMoney > 0 ? esc(fmtMoney(maxMoney)) : "none",
        maxMoney > 0 ? meter(row.moneyFrac, fmtPct(row.moneyFrac), row.atMaxMoney) : "–",
      ],
      [
        "security",
        currentSecurity === undefined ? "–" : currentSecurity.toFixed(2),
        minSecurity === undefined ? "–" : minSecurity.toFixed(2),
        minSecurity === undefined ? "–" : meter(1 - row.secFrac, row.atMinSec ? "minimum" : "needs weaken", row.atMinSec),
      ],
      [
        "hack time",
        row.hackTimeMs === undefined ? "–" : esc(fmtTime(row.hackTimeMs)),
        row.hackTimeMinMs === undefined ? "–" : esc(fmtTime(row.hackTimeMinMs)),
        // With no time computed there is nothing for security to be slowing:
        // the row's caller withholds both figures when the player record or the
        // BitNode is unknown, and "current security slows it" beside two dashes
        // reads as a measurement of something.
        row.hackTimeMs === undefined
          ? "–"
          : row.atMinSec ? "prepped" : "current security slows it",
      ],
    ],
    { left: [0, 3] },
  );

  return (
    `<div class="server-inspector">` +
    `<h3>${esc(server.hostname)}</h3>` +
    tiles([
      { label: "assignment", value: role.label },
      { label: "root", value: row.root },
      { label: "RAM", value: `${fmtRam(server.ramUsed ?? 0)} / ${fmtRam(server.maxRam ?? 0)}`, sub: `${cores} core(s) · ${supportBonus.toFixed(4)}x support effect` },
      { label: "contracts", value: String(contracts + quarantined), sub: flags },
    ]) +
    `<div class="server-detail-grid">` +
    `<div><h4>Selection</h4><p>${esc(role.explanation)}</p>${definitions([
      ["organization", esc(server.organizationName ?? "unknown")],
      ["skill", `${fmtNum(state.player?.skills?.hacking ?? 0)} / ${fmtNum(server.requiredHackingSkill ?? 0)} required`],
      ["ports", `${fmtNum(row.portOpeners)} openers / ${fmtNum(server.numOpenPortsRequired ?? 0)} required`],
      ["status", esc(flags)],
    ])}</div>` +
    `<div><h4>Current vs ideal</h4>${currentVsIdeal}</div>` +
    `</div>` +
    (row.root === "blocked" ? note("Blocked servers remain visible so the missing access requirement is explicit.") : "") +
    `</div>`
  );
}
