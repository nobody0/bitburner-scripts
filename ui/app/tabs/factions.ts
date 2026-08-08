import type { PlayerRequirement } from "@ns";
import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Factions tab: the plan, reputation standing, pending invites, and the
 * augmentation shopping list (grafting included — it is another way to buy the
 * same augs).
 *
 * The Plan card is the point of this panel. A faction run spends most of its
 * time doing ONE long thing, so "what is it doing and why" matters far more
 * than a live number, and a blocked feature must name the feature it is
 * waiting on rather than silently sitting there. */

const ACTION_LABELS: Record<string, string> = {
  idle: "idle",
  joinFaction: "join",
  workForFaction: "work",
  stopWork: "stop work",
  donate: "donate",
  purchaseAugmentation: "buy",
  graft: "graft",
  travelTo: "travel",
  installAugmentations: "install",
};

function actionLine(action: FactionPlanAction): string {
  const label = ACTION_LABELS[action.type] ?? action.type;
  const subject = action.faction ?? action.augmentation ?? action.city ?? "";
  const work = action.workType ? ` (${action.workType})` : "";
  return `${esc(label)}${subject ? ` <strong>${esc(subject)}</strong>` : ""}${esc(work)}`;
}

interface FactionPlanAction {
  type: string;
  why: string;
  faction?: string;
  augmentation?: string;
  city?: string;
  workType?: string;
}

/** Render a requirement tree as something a human can act on.
 *
 * The bare `type` field is useless in a panel: four skill requirements render
 * as "skills, skills, skills, skills", which tells the reader neither which
 * skills nor how much. The values are already in the structured tree, so this
 * just shows them. */
function describeRequirement(requirement: PlayerRequirement): string {
  switch (requirement.type) {
    case "money":
      return `$${fmtMoney(requirement.money)}`;
    case "skills":
      return Object.entries(requirement.skills)
        .map(([skill, level]) => `${skill} ${level}`)
        .join(" + ");
    // Karma is an UPPER bound on a negative number — showing "karma 9" would
    // read as a target to climb toward rather than fall below.
    case "karma":
      return `karma ≤ ${requirement.karma}`;
    case "numPeopleKilled":
      return `${requirement.numPeopleKilled} kills`;
    case "numAugmentations":
      return `${requirement.numAugmentations} augs`;
    case "employedBy":
      return `job at ${requirement.company}`;
    case "companyReputation":
      return `${fmtNum(requirement.reputation, 0)} rep at ${requirement.company}`;
    case "jobTitle":
      return `title: ${requirement.jobTitle}`;
    case "city":
      return `in ${requirement.city}`;
    case "location":
      return `at ${requirement.location}`;
    case "backdoorInstalled":
      return `backdoor ${requirement.server}`;
    case "file":
      return `file ${requirement.file}`;
    case "hacknetRAM":
      return `${requirement.hacknetRAM}GB hacknet RAM`;
    case "hacknetCores":
      return `${requirement.hacknetCores} hacknet cores`;
    case "hacknetLevels":
      return `${requirement.hacknetLevels} hacknet levels`;
    case "bladeburnerRank":
      return `Bladeburner rank ${requirement.bladeburnerRank}`;
    case "numInfiltrations":
      return `${requirement.numInfiltrations} infiltrations`;
    case "bitNodeN":
      return `BN${requirement.bitNodeN}`;
    case "sourceFile":
      return `SF${requirement.sourceFile}`;
    case "not":
      return `NOT (${describeRequirement(requirement.condition)})`;
    case "someCondition":
      return `(${requirement.conditions.map(describeRequirement).join(" OR ")})`;
    case "everyCondition":
      return requirement.conditions.map(describeRequirement).join(" + ");
  }
}

function describeRequirements(requirements: readonly PlayerRequirement[]): string {
  return requirements.map(describeRequirement).join(" + ");
}

function planCard(state: ProjectedState): string {
  const plan = state.topics.factions?.plan;
  if (!plan) return card("Plan", note("no decision yet — the factions driver has not run"));

  const parts: string[] = [];

  if (plan.blocked) {
    // An explicit blocker, not a spinner. The SF4 RAM wall is real and
    // unfixable inside the run, so the panel says so instead of showing an
    // idle feature that looks merely slow.
    parts.push(`<div class="bad"><strong>blocked:</strong> ${esc(plan.blocked)}</div>`);
  }

  parts.push(
    `<div class="row"><span class="muted">next</span> ${actionLine(plan.action as FactionPlanAction)}</div>` +
      `<div class="muted">${esc(plan.action.why)}</div>`,
  );

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
    parts.push(
      `<div class="row"><span class="muted">objective</span> ${esc(objective.factions.join(", ") || "none")}</div>` +
        `<div class="muted">${esc(objective.why)}</div>`,
    );
    if (objective.foreclosed.length > 0) {
      // A ban is permanent, so what the objective gives up is part of the plan.
      parts.push(
        `<div class="muted">forecloses ${objective.foreclosed
          .map((entry) => `${esc(entry.name)} (via ${esc(entry.bannedBy)})`)
          .join(", ")}</div>`,
      );
    }
    if (objective.augmentations.length > 0) {
      parts.push(
        table(
          ["#", "augmentation"],
          objective.augmentations.slice(0, 20).map((name, i) => [String(i + 1), esc(name)]),
        ),
      );
    }
  }

  if (plan.recommendInstall) {
    parts.push(
      `<div class="good"><strong>recommends install:</strong> ${esc(plan.recommendInstall.why)}</div>` +
        note("advisory — the reset cadence belongs to the BitNode feature"),
    );
  }

  const alternatives =
    plan.alternatives.length > 0
      ? table(
          ["alternative", "value", "why"],
          plan.alternatives
            .slice()
            .sort((a, b) => b.value - a.value)
            .slice(0, 6)
            .map((entry) => [esc(entry.label), fmtNum(entry.value, 3), esc(entry.why)]),
          { wrap: [2] },
        )
      : note("no scored alternatives");

  const blockers =
    plan.blockers.length > 0
      ? table(
          ["faction", "needs", "progress", "owner"],
          plan.blockers
            .slice()
            .sort((a, b) => b.progress - a.progress)
            .slice(0, 20)
            .map((blocker) => [
              esc(blocker.faction),
              `${esc(blocker.why)}${blocker.reachable ? "" : ' <span class="bad">(unreachable)</span>'}`,
              `${fmtNum(blocker.progress * 100, 0)}%`,
              // The cross-feature contract, rendered: a stalled faction names
              // the feature it is waiting on.
              `<span class="muted">${esc(blocker.owner)}</span>`,
            ]),
          { wrap: [1] },
        )
      : note("nothing blocking");

  return (
    card("Plan", parts.join("")) + card("Alternatives considered", alternatives) + card("Blockers", blockers)
  );
}

export const factionsTab: Tab = {
  id: "factions",
  render(state: ProjectedState) {
    const f = state.topics.factions;
    if (!f) return note("waiting for the factions probe");

    const summary = tiles([
      { label: "joined", value: String(f.joined.length) },
      { label: "invites", value: f.invites ? String(f.invites.length) : "–" },
      { label: "augs owned", value: f.ownedAugs ? String(f.ownedAugs.length) : "–" },
      { label: "augs available", value: f.augTotal !== undefined ? String(f.augTotal) : "–" },
    ]);

    const standings = f.standings
      ? table(
          ["faction", "rep", "favor", "donate at", "work", "bans"],
          f.standings
            .slice()
            .sort((a, b) => b.rep - a.rep)
            .map((s) => {
              const gate = f.favorToDonate;
              const unlocked = gate !== undefined && s.favor >= gate;
              const progress = gate ? Math.min(100, (s.favor / gate) * 100) : 0;
              return [
                esc(s.name),
                fmtNum(s.rep, 0),
                `<span class="${unlocked ? "good" : ""}">${fmtNum(s.favor, 1)}</span>`,
                gate !== undefined
                  ? `${fmtNum(gate, 0)} <span class="muted">(${fmtNum(progress, 0)}%)</span>`
                  : "–",
                f.workTypes?.[s.name]?.length
                  ? `<span class="muted">${esc(f.workTypes[s.name]!.join(", "))}</span>`
                  : "–",
                f.enemies?.[s.name]?.length
                  ? `<span class="muted">${esc(f.enemies[s.name]!.join(", ").slice(0, 60))}</span>`
                  : "–",
              ];
            }),
          { wrap: [4, 5] },
        )
      : table(
          ["faction"],
          f.joined.map((name) => [esc(name)]),
          "no factions joined",
        ) + note("rep and favor need BN4 or SF4 (Singularity)");

    const invites =
      f.invites && f.invites.length > 0
        ? table(
            ["faction", "requirements"],
            f.invites.map((name) => [
              esc(name),
              esc(describeRequirements(f.requirements?.[name] ?? []) || "satisfied"),
            ]),
            // A requirement tree is prose and can be long; without wrapping it
            // pushes the card into horizontal scroll and hides everything else.
            { wrap: [1] },
          )
        : note("no pending invitations");

    const offers = f.offers
      ? table(
          ["augmentation", "faction", "price", "rep req", "rep gap"],
          f.offers
            .slice(0, 60)
            .map((a) => [
              esc(a.name),
              esc(a.faction),
              // Both prices when they differ: the 1.9^queued escalation should
              // be visible as an escalation, not look like a price change.
              a.basePrice !== undefined && a.basePrice !== a.price
                ? `${fmtMoney(a.price)} <span class="muted">(base ${fmtMoney(a.basePrice)})</span>`
                : fmtMoney(a.price),
              fmtNum(a.repReq, 0),
              a.affordableRep
                ? `<span class="good">met</span>`
                : `<span class="muted">${fmtNum(a.repGap ?? a.repReq, 0)}</span>`,
            ]),
          "nothing purchasable",
        ) +
        (f.augTotal !== undefined && f.augTotal > (f.offers?.length ?? 0)
          ? note(`showing ${f.offers.length} of ${f.augTotal} — the probe caps its list`)
          : "")
      : note("augmentation list needs BN4 or SF4");

    const graft =
      f.graftable && f.graftable.length > 0
        ? table(
            ["augmentation", "price", "time"],
            f.graftable.slice(0, 40).map((g) => [esc(g.name), fmtMoney(g.price), fmtTime(g.timeMs)]),
          )
        : note("nothing graftable (needs New Tokyo's VitaLife clinic)");

    return (
      `<div class="col wide">` +
      planCard(state) +
      card("Standing", summary + standings) +
      card("Augmentations", offers) +
      `</div>` +
      `<div class="col">` +
      card("Invitations", invites) +
      card("Grafting", graft) +
      `</div>`
    );
  },
};
