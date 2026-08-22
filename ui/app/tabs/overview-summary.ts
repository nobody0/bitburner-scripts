import { FEATURES } from "../../../shared/features/registry.ts";
import type { FeatureId } from "../../../shared/features/ids.ts";
import { meter, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum, fmtRam } from "../lib/format.ts";
import type { Markup } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";

function featureLabel(id: FeatureId): string {
  return FEATURES.find((feature) => feature.id === id)?.label ?? id;
}

function words(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();
}

function featureLink(id: FeatureId): string {
  return `<a href="#/${esc(id)}">${esc(featureLabel(id))}</a>`;
}

function nowTiles(state: ProjectedState): string {
  const progression = state.topics.progression;
  const plan = progression?.plan;
  const arbitration = state.topics.arbitration;
  const farm = state.topics.farm;
  const pipelines = farm?.pipelines ?? [];
  const slot = arbitration?.slot;
  const currentWork = state.topics.career?.currentWork;

  const route = plan?.route ?? (progression?.bitNode ? `BN${progression.bitNode}` : "not chosen");
  const work = slot
    ? `${featureLabel(slot.by)} · ${words(slot.id)}`
    : currentWork
      ? `${words(currentWork.type)}${currentWork.detail ? ` · ${currentWork.detail}` : ""}`
      : "idle";
  const pipelineText = pipelines.length
    ? pipelines.map((pipeline) => `${pipeline.role} ${pipeline.host}`).join(" · ")
    : farm?.target
      ? `farm ${farm.target}`
      : "idle";
  const install = plan?.install
    ? "executing"
    : plan?.installReady
      ? "ready"
      : plan?.installWanted
        ? "wanted"
        : plan?.installDecision?.effective === "push"
          ? "pushing"
          : "not planned";

  return tiles([
    { label: "endgame route", value: route, sub: plan?.phase ? `${words(plan.phase)} phase` : undefined },
    { label: "work slot", value: work },
    { label: "farm pipelines", value: pipelineText, sub: farm?.mode ? `${farm.mode} scheduling` : undefined },
    { label: "next install", value: install, sub: plan?.queuedAugmentations?.length ? `${plan.queuedAugmentations.length} queued` : undefined },
  ]);
}

function nextRows(state: ProjectedState): Markup[][] {
  const urgency = { blocking: 0, wanted: 1, nice: 2 } as const;
  return (state.topics.progression?.needs ?? [])
    .filter((need) => !need.satisfied)
    .sort((left, right) => urgency[left.urgency] - urgency[right.urgency] || left.progress - right.progress)
    .slice(0, 6)
    .map((need) => [
      featureLink(need.by),
      esc(`${words(need.kind)}${need.subject ? ` · ${need.subject}` : ""}`),
      meter(need.progress, `${fmtNum(need.have)} / ${fmtNum(need.target)}`, need.satisfied),
      esc(need.urgency),
    ]);
}

function blockerRows(state: ProjectedState): Markup[][] {
  const rows: Markup[][] = [];
  for (const blocker of state.topics.progression?.plan?.installBlockers ?? []) {
    rows.push(["install", esc(words(blocker))]);
  }
  const factions = state.topics.factions?.plan?.blocked;
  if (factions) {
    rows.push([
      featureLink("factions"),
      esc(`Singularity call needs ${fmtRam(factions.callRamGb)} in BN${factions.bitNode} at SF4.${factions.sf4Level}`),
    ]);
  }
  for (const wait of (state.topics.ramArena?.starvation ?? []).slice(0, 4)) {
    rows.push([
      esc(wait.by),
      esc(`${words(wait.id)} needs ${fmtRam(wait.gb)}; waiting ${(wait.waitMs / 1_000).toFixed(1)}s`),
    ]);
  }
  for (const warning of (state.topics.arbitration?.warnings ?? []).slice(0, 3)) {
    rows.push(["arbiter", esc(warning)]);
  }
  return rows;
}

/** Cross-feature digest for the Overview. It reports controller decisions
 * already present in typed topics; it never infers a new game decision. */
export function automationSummary(state: ProjectedState): string {
  const next = nextRows(state);
  const blockers = blockerRows(state);
  return (
    `<div class="summary-section"><h3>Now</h3>${nowTiles(state)}</div>` +
    `<div class="summary-section"><h3>Next</h3>${
      next.length
        ? table(["wanted by", "need", "progress", "urgency"], next, { left: [0, 1, 3] })
        : note("no unmet cross-feature needs are posted")
    }</div>` +
    `<div class="summary-section"><h3>Blocked</h3>${
      blockers.length
        ? table(["owner", "barrier"], blockers, { left: [0, 1], wrap: [1] })
        : note("nothing is explicitly blocked")
    }</div>`
  );
}
