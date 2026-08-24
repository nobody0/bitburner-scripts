import { FEATURES } from "../../../shared/features/registry.ts";
import type { FeatureId } from "../../../shared/features/ids.ts";
import { hint, meter, NONE, note, shownOf, table, tiles } from "../lib/dom.ts";
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

/** The digest bound on the starvation list. The unabridged view is the BitNode
 * tab's RAM arena card, which renders every waiter with its starved marker, so
 * this one only has to say that it stopped. */
const STARVING_SHOWN = 4;
/** Same for the needs list: the BitNode tab's coordination card carries all of
 * them, with the arbiter's weights beside each. */
const NEEDS_SHOWN = 6;

function nowTiles(state: ProjectedState): string {
  const progression = state.topics.progression;
  const plan = progression?.plan;
  const arbitration = state.topics.arbitration;
  const farm = state.topics.farm;
  const pipelines = farm?.pipelines ?? [];
  const slot = arbitration?.slot;
  const currentWork = state.topics.career?.currentWork;

  // Every tile answers from its OWN topic, and an absent topic reads as absent.
  // These four are the first thing on the default tab and they used to make
  // "nothing has been measured" indistinguishable from "the automation chose to
  // do nothing" — the arbiter legitimately writes nothing for a whole
  // hacking-only run (game/lib/controller.ts), the career probe needs SF4, and
  // every topic is dropped on prestige, so a confident "idle" here read as a
  // broken controller.
  const route: Markup = progression === undefined
    ? hint(NONE, "no progression topic yet")
    // A BitNode id is not a RouteId (shared/strategy/progression/endgame.ts), so
    // it goes in the sub-line rather than standing in for a route that has not
    // been chosen.
    : plan?.route ?? "not chosen";
  const routeSub = plan?.phase
    ? `${words(plan.phase)} phase`
    : progression?.bitNode !== undefined
      ? `BN${progression.bitNode}`
      : undefined;
  // `currentWork` is `undefined` when the SF4-gated probe never ran and `null`
  // when it ran and found nothing running, so the test is against `undefined`
  // and not against truthiness.
  const work: Markup = slot
    ? `${featureLabel(slot.by)} · ${words(slot.id)}`
    : currentWork
      ? `${words(currentWork.type)}${currentWork.detail ? ` · ${currentWork.detail}` : ""}`
      : arbitration === undefined && currentWork === undefined
        ? hint(NONE, "no arbiter verdict and no career probe yet")
        : "idle";
  const pipelineText: Markup = farm === undefined
    ? hint(NONE, "the dispatcher publishes the farm rollup once a second")
    : pipelines.length
      ? pipelines.map((pipeline) => `${pipeline.role} ${pipeline.host}`).join(" · ")
      : farm.target
        ? `farm ${farm.target}`
        : "idle";
  const install: Markup = plan === undefined
    ? hint(NONE, "no progression plan published yet")
    : plan.install
      ? "executing"
      : plan.installReady
        ? "ready"
        : plan.installWanted
          ? "wanted"
          : plan.installDecision?.effective === "push"
            ? "pushing"
            : "not planned";

  return tiles([
    { label: "endgame route", value: route, sub: routeSub },
    { label: "work slot", value: work },
    { label: "farm pipelines", value: pipelineText, sub: farm?.mode ? `${farm.mode} scheduling` : undefined },
    { label: "next install", value: install, sub: plan?.queuedAugmentations?.length ? `${plan.queuedAugmentations.length} queued` : undefined },
  ]);
}

function nextRows(state: ProjectedState): { rows: Markup[][]; total: number } {
  const urgency = { blocking: 0, wanted: 1, nice: 2 } as const;
  const unmet = (state.topics.progression?.needs ?? [])
    .filter((need) => !need.satisfied)
    .sort((left, right) => urgency[left.urgency] - urgency[right.urgency] || left.progress - right.progress);
  return {
    rows: unmet.slice(0, NEEDS_SHOWN).map((need) => [
      featureLink(need.by),
      esc(`${words(need.kind)}${need.subject ? ` · ${need.subject}` : ""}`),
      meter(need.progress, `${fmtNum(need.have)} / ${fmtNum(need.target)}`, need.satisfied),
      esc(need.urgency),
    ]),
    total: unmet.length,
  };
}

function blockerRows(state: ProjectedState): { rows: Markup[][]; starving: number } {
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
  const starvation = state.topics.ramArena?.starvation ?? [];
  for (const wait of starvation.slice(0, STARVING_SHOWN)) {
    rows.push([
      esc(wait.by),
      esc(`${words(wait.id)} needs ${fmtRam(wait.gb)}; waiting ${(wait.waitMs / 1_000).toFixed(1)}s`),
    ]);
  }
  // Warnings are NOT capped. They are programming-error class (an invalid next
  // step, the step-loop cap) and arrive in single digits by construction, this
  // is the only place in the viewer that renders them at all, and a truncation
  // note pointing nowhere is worse than the rows it replaces.
  for (const warning of state.topics.arbitration?.warnings ?? []) {
    rows.push(["arbiter", esc(warning)]);
  }
  return { rows, starving: starvation.length };
}

/** Cross-feature digest for the Overview. It reports controller decisions
 * already present in typed topics; it never infers a new game decision. */
export function automationSummary(state: ProjectedState): string {
  const next = nextRows(state);
  const blockers = blockerRows(state);
  // Both tables claim to enumerate what is holding the run up, so a cut list
  // that says nothing reads as the whole set — `shownOf` is the one wording for
  // that, and it appears only when something really was cut.
  const nextNote =
    next.total > next.rows.length
      ? shownOf(next.rows.length, next.total, "unmet needs — the BitNode tab's coordination card lists every one")
      : "";
  const starvingNote =
    blockers.starving > STARVING_SHOWN
      ? shownOf(
          STARVING_SHOWN,
          blockers.starving,
          "starving RAM requests — the BitNode tab's RAM arena card lists every waiter",
        )
      : "";
  return (
    `<div class="summary-section"><h3>Now</h3>${nowTiles(state)}</div>` +
    `<div class="summary-section"><h3>Next</h3>${
      next.rows.length
        ? table(["wanted by", "need", "progress", "urgency"], next.rows, { left: [0, 1, 3] }) + nextNote
        : note("no unmet cross-feature needs are posted")
    }</div>` +
    `<div class="summary-section"><h3>Blocked</h3>${
      blockers.rows.length
        ? table(["owner", "barrier"], blockers.rows, { left: [0, 1], wrap: [1] }) + starvingNote
        : note("nothing is explicitly blocked")
    }</div>`
  );
}
