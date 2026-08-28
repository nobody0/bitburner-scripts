import {
  FALLBACK_MONEY_PER_SEC,
  FALLBACK_RANK_PER_SEC,
  FALLBACK_SEC_PER_AUG,
  FALLBACK_SEC_PER_BLACK_OP,
  FALLBACK_SEC_PER_CHARISMA_LEVEL,
  FALLBACK_SEC_PER_COMBAT_LEVEL,
  FALLBACK_SEC_PER_HACK_LEVEL,
  routeEtas,
  type ProgressResource,
  type RouteEta,
  type RouteRates,
} from "./eta.ts";
import type { EndgameDecision, EndgameView, RouteId } from "./endgame.ts";
import type { ForecastComponent, TimeForecast } from "./forecast.ts";

/** The currencies a route's ETA actually depends on, and therefore the ones a
 * rate can be priced in. Every one of these already has a rate in `RouteRates`
 * and a part in the route estimates — this list is what has been WIRED to a
 * marginal, not a separate model. */
export type MarginalResource =
  | "money"
  | "hacking"
  | "charisma"
  | "reputation"
  | "combat"
  | "bladeburnerRank"
  | "augmentations";

export const MARGINAL_RESOURCES: readonly MarginalResource[] = [
  "money",
  "hacking",
  "charisma",
  "reputation",
  "combat",
  "bladeburnerRank",
  "augmentations",
];

/** An observed zero is economic evidence; an absent observation is not. */
export type MeasuredMarginal =
  | { state: "measured"; value: number }
  | { state: "unknown"; reason: string };

export interface ResourceMarginal {
  /** A forecast can be absent; zero is a real modeled result and stays distinct. */
  state: "estimated" | "unknown";
  /** BN seconds saved by a 100% relative increase at the local derivative. */
  secondsPerRelativeRate: number;
  /** The absolute production rate the relative perturbation was applied AT —
   * the derivative's operating point, in the resource's own units per second.
   * When nothing is measured yet this is the same declared fallback the route
   * ETA itself was priced with, so a consumer converting an absolute rate to
   * a relative one divides by the exact rate the slope was taken at instead
   * of refusing to price the claim. That refusal was circular starvation: the
   * FIRST income source can never measure an income rate before it is funded. */
  atRatePerSec?: number;
  /** Which clock supplied the value. */
  horizon?: "install" | "node" | "future-binding";
  reason?: string;
}

export type ProgressionMarginals = Record<MarginalResource, ResourceMarginal>;

export interface ProgressionMarginalInput {
  view: EndgameView;
  decision: EndgameDecision;
  rates: RouteRates;
  selectedRoute?: RouteId;
  install: TimeForecast;
}

/** One percent is large enough to survive floating-point noise in fitted cycle
 * curves and small enough to represent the local value used by RAM arbitration. */
export const MARGINAL_RATE_DELTA = 0.01;

/** Local slope for a linear gap/rate ETA, sampled with the same bounded
 * perturbation as nonlinear route curves. */
export function linearSecondsPerRelativeRate(
  seconds: number,
  relativeDelta = MARGINAL_RATE_DELTA,
): number {
  const delta = Math.max(Number.EPSILON, relativeDelta);
  const before = Math.max(0, seconds);
  return (before - before / (1 + delta)) / delta;
}

/** Re-price a gap whose completion rate changes as another produced resource
 * accumulates. Five fixed-point iterations, each using Simpson's three-point
 * integral, bound this to 30 `rateAtProgress` calls for both perturbations. */
export function growingProgressSecondsPerRelativeRate(input: {
  gap: number;
  initialProgress: number;
  progressPerSec: number;
  rateAtProgress: (progress: number) => number;
  relativeDelta?: number;
}): number | undefined {
  const gap = Math.max(0, input.gap);
  if (gap <= 0) return 0;
  if (!(input.progressPerSec > 0)) return undefined;
  const initial = Math.max(0, input.initialProgress);
  const startRate = input.rateAtProgress(initial);
  if (!(startRate > 0)) return undefined;
  const eta = (progressPerSec: number): number => {
    let sec = gap / startRate;
    for (let iteration = 0; iteration < 5; iteration++) {
      const middleRate = input.rateAtProgress(initial + progressPerSec * sec / 2);
      const endRate = input.rateAtProgress(initial + progressPerSec * sec);
      const averageRate = (startRate + 4 * Math.max(0, middleRate) + Math.max(0, endRate)) / 6;
      if (!(averageRate > 0)) return Infinity;
      sec = gap / averageRate;
    }
    return sec;
  };
  const delta = Math.max(Number.EPSILON, input.relativeDelta ?? MARGINAL_RATE_DELTA);
  const before = eta(input.progressPerSec);
  const after = eta(input.progressPerSec * (1 + delta));
  return Number.isFinite(before) && Number.isFinite(after) ? Math.max(0, before - after) / delta : undefined;
}

function forecastTotal(components: readonly Pick<ForecastComponent, "mode" | "sec">[]): number {
  let parallel = 0;
  let sequential = 0;
  for (const component of components) {
    const sec = Math.max(0, component.sec);
    if (component.mode === "parallel") parallel = Math.max(parallel, sec);
    else sequential += sec;
  }
  return parallel + sequential;
}

/** Which ETA part label a marginal resource may claim seconds from — for the
 * LAST-RESORT slope only. The real answer comes from re-running the estimate
 * with the rate perturbed, which reads no labels at all.
 *
 * Bladeburner rank has none. Its parts share the `combat` label with the
 * black-op sequence they overlap, and claiming those seconds would price a
 * Bladeburner rate on any route that merely has a combat branch — Daedalus
 * accepts combat 1500, so that is most of them. The perturbation already
 * separates the two correctly, and where it reports no movement, a measured
 * zero is the honest answer rather than a borrowed one. */
function partResourcesFor(resource: MarginalResource): readonly ProgressResource[] {
  return resource === "bladeburnerRank" ? [] : [resource as ProgressResource];
}

/** Linear forecast parts are gap/rate, so their finite perturbation is closed
 * form. Recompose the forecast afterward: shortening a nonbinding parallel
 * part correctly saves zero on the immediate horizon. */
function forecastSaved(forecast: TimeForecast, resource: MarginalResource, relativeDelta: number): number | undefined {
  if (forecast.state === "unknown") return undefined;
  const delta = Math.max(0, relativeDelta);
  const before = forecastTotal(forecast.components);
  const labels = partResourcesFor(resource);
  const after = forecastTotal(forecast.components.map((component) => labels.includes(component.resource)
    ? { ...component, sec: component.sec / (1 + delta) }
    : component));
  return Math.max(0, before - after);
}

function scalePointResource(
  point: NonNullable<RouteRates["cycle"]>["points"][number],
  resource: "money" | "hacking",
  scale: number,
) {
  return resource === "money"
    ? { ...point, money: point.money * scale }
    : { ...point, hacking: 1 + Math.max(0, point.hacking - 1) * scale };
}

/** The absolute rate a resource's relative perturbation operates on — the same
 * measured-or-declared-fallback substitution `perturbedRates` applies, exposed
 * so the published marginal can carry its own operating point. */
function operatingRate(rates: RouteRates, resource: MarginalResource): number | undefined {
  switch (resource) {
    case "money":
      return rates.moneyPerSec > 0 ? rates.moneyPerSec : FALLBACK_MONEY_PER_SEC;
    case "hacking":
      return rates.hackingSkillPerSec > 0 ? rates.hackingSkillPerSec : 1 / FALLBACK_SEC_PER_HACK_LEVEL;
    case "combat":
      return rates.combatSkillPerSec > 0 ? rates.combatSkillPerSec : 1 / FALLBACK_SEC_PER_COMBAT_LEVEL;
    case "charisma":
      return rates.charismaSkillPerSec > 0 ? rates.charismaSkillPerSec : 1 / FALLBACK_SEC_PER_CHARISMA_LEVEL;
    case "augmentations":
      return rates.augsPerSec > 0 ? rates.augsPerSec : 1 / FALLBACK_SEC_PER_AUG;
    case "bladeburnerRank":
      return rates.bladeburnerRankPerSec > 0 ? rates.bladeburnerRankPerSec : FALLBACK_RANK_PER_SEC;
    default:
      return undefined;
  }
}

/** Perturb both the linear rate and the cumulative fresh-cycle curve. The
 * latter is what makes nonlinear regrowth/cycle ETAs genuinely re-price rather
 * than pretending their current sec value is linear. */
function perturbedRates(rates: RouteRates, resource: MarginalResource, relativeDelta: number): RouteRates {
  const scale = 1 + Math.max(0, relativeDelta);
  const next: RouteRates = { ...rates };
  if (resource === "money") {
    next.moneyPerSec = (rates.moneyPerSec > 0 ? rates.moneyPerSec : FALLBACK_MONEY_PER_SEC) * scale;
  } else if (resource === "hacking") {
    next.hackingSkillPerSec = (
      rates.hackingSkillPerSec > 0 ? rates.hackingSkillPerSec : 1 / FALLBACK_SEC_PER_HACK_LEVEL
    ) * scale;
    // The closed-form climb legs price off the EXPERIENCE rate, not the level
    // tracker; leaving it unscaled made every stacked-climb leg blind to the
    // perturbation, so the route's largest hacking dependencies reported zero
    // movement and fell to the coarse linear floor.
    if (rates.hackingExpPerSec !== undefined && rates.hackingExpPerSec > 0) {
      next.hackingExpPerSec = rates.hackingExpPerSec * scale;
    }
    // Faction-work reputation is EARNED BY hacking skill (near-linearly, per
    // the transcribed work-rep formulas), so a hacking perturbation moves the
    // reputation legs too, at the driver-measured elasticity. Without this
    // the route's dominant channel was invisible to the multipliers that
    // accelerate it.
    const elasticity = rates.repRateHackingElasticity;
    if (elasticity !== undefined && elasticity > 0) {
      const repScale = 1 + (scale - 1) * elasticity;
      if (rates.daedalusRepPerSec > 0) next.daedalusRepPerSec = rates.daedalusRepPerSec * repScale;
      if (rates.daedalusRepPerSecProjected !== undefined && rates.daedalusRepPerSecProjected > 0) {
        next.daedalusRepPerSecProjected = rates.daedalusRepPerSecProjected * repScale;
      }
    }
  } else if (resource === "charisma") {
    next.charismaSkillPerSec = (
      rates.charismaSkillPerSec > 0 ? rates.charismaSkillPerSec : 1 / FALLBACK_SEC_PER_CHARISMA_LEVEL
    ) * scale;
    if (rates.charismaExpPerSec !== undefined && rates.charismaExpPerSec > 0) {
      next.charismaExpPerSec = rates.charismaExpPerSec * scale;
    }
  } else if (resource === "combat") {
    next.combatSkillPerSec = (
      rates.combatSkillPerSec > 0 ? rates.combatSkillPerSec : 1 / FALLBACK_SEC_PER_COMBAT_LEVEL
    ) * scale;
  } else if (resource === "augmentations") {
    next.augsPerSec = (rates.augsPerSec > 0 ? rates.augsPerSec : 1 / FALLBACK_SEC_PER_AUG) * scale;
  } else if (resource === "bladeburnerRank") {
    // Rank and the black-op sequence overlap in the route estimate (the slower
    // of the two binds), so a rank rate that moved without the ops moving would
    // report a saving the route cannot actually realise. Scale both.
    next.bladeburnerRankPerSec = (
      rates.bladeburnerRankPerSec > 0 ? rates.bladeburnerRankPerSec : FALLBACK_RANK_PER_SEC
    ) * scale;
    next.blackOpsPerSec = (
      rates.blackOpsPerSec > 0 ? rates.blackOpsPerSec : 1 / FALLBACK_SEC_PER_BLACK_OP
    ) * scale;
  } else {
    // The selected route can use either reputation stream. Scaling both is the
    // resource-level question; only the route's actual part contributes.
    next.daedalusRepPerSec = Math.max(0, rates.daedalusRepPerSec) * scale;
    next.gangRepPerSec = Math.max(0, rates.gangRepPerSec) * scale;
  }
  if (rates.cycle && (resource === "money" || resource === "hacking")) {
    next.cycle = {
      ...rates.cycle,
      points: rates.cycle.points.map((point) => scalePointResource(point, resource, scale)),
      ...(rates.cycle.priorPoints
        ? { priorPoints: rates.cycle.priorPoints.map((point) => scalePointResource(point, resource, scale)) }
        : {}),
    };
  }
  return next;
}

function selected(etas: readonly RouteEta[], route: RouteId | undefined): RouteEta | undefined {
  return route ? etas.find((eta) => eta.id === route) : undefined;
}

function resourceSeconds(parts: readonly { resource: ProgressResource; sec: number }[], resource: MarginalResource): number {
  const labels = partResourcesFor(resource);
  return parts
    .filter((part) => labels.includes(part.resource))
    .reduce((sum, part) => sum + Math.max(0, part.sec), 0);
}

/** Answer "if this production rate were higher by delta, how many seconds
 * sooner would the install or BitNode finish?" for all three share currencies.
 *
 * The install clock is preferred because prestige erases current-cycle
 * progress. When that resource is a nonbinding parallel track, the selected
 * node route is the legitimate fallback. Finally, a known parallel dependency
 * gets its own local slope even while another track masks it: today's
 * bottleneck eventually clears, and treating the next one as valueless would
 * starve it until the instant it became critical. */
export function progressionMarginals(
  input: ProgressionMarginalInput,
  relativeDelta = MARGINAL_RATE_DELTA,
): ProgressionMarginals {
  const delta = Math.max(Number.EPSILON, relativeDelta);
  const baselineEtas = routeEtas(input.view, input.decision, input.rates);
  const baselineRoute = selected(baselineEtas, input.selectedRoute);

  const one = (resource: MarginalResource): ResourceMarginal => {
    // The operating point the slope is taken at rides along with the slope, so
    // an absolute-rate consumer converts with the same denominator the ETA
    // itself was priced with — measured when measured, the declared fallback
    // when not.
    const atRate = operatingRate(input.rates, resource);
    const at = atRate !== undefined && atRate > 0 ? { atRatePerSec: atRate } : {};
    const installSaved = forecastSaved(input.install, resource, delta);

    // Both clocks are perturbed and the LARGER slope wins, for the same reason
    // the future-binding branch below exists: one clock must not hide a
    // dependency the other can see. Preferring the install slope whenever it
    // moved at all did exactly that — in a node whose only income is the
    // market, money's install slope (a few augmentations' worth) masked the
    // $100b Daedalus gate on the node clock, pricing money and hacking-exp
    // seconds at the same ~1e4 scale and letting an experience-valued RAM rung
    // out-bid the working capital of the node's entire economy. The install
    // slope still stands wherever it is genuinely the larger dependency, which
    // is the case the original preference was protecting.
    let nodeSaved: number | undefined;
    if (baselineRoute) {
      const afterRoute = selected(
        routeEtas(input.view, input.decision, perturbedRates(input.rates, resource, delta)),
        input.selectedRoute,
      );
      if (afterRoute) nodeSaved = Math.max(0, baselineRoute.etaSec - afterRoute.etaSec);
    }
    const install = installSaved !== undefined && installSaved > 0 ? installSaved : 0;
    const node = nodeSaved !== undefined && nodeSaved > 0 ? nodeSaved : 0;
    const perturbedSlope = Math.max(install, node) / delta;

    // FLOOR the perturbed slope with the local slope of every leg this
    // resource must still complete — including AND-parallel legs masked by a
    // slower sibling (EtaPart.hidden). The infinitesimal perturbation cannot
    // see through a parallel maximum, but the decisions priced off these
    // worths (augmentation multipliers, work-slot bids) buy FINITE rate
    // changes that do flip which branch binds. Measured: with the money gate
    // masking the invite hacking climb, worth(hacking) collapsed 612k -> 7.6k
    // BN-seconds exactly while the run chose its augmentations, and the
    // multiplier stack that would have cut two 7-14h climbs was never bought.
    // The floor covers exactly what the perturbation is blind to: hidden
    // AND-parallel legs (covered by a slower sibling's window, so a rate
    // change moves nothing) — plus, as before, the all-parts fallback when
    // both perturbations report no movement at all. Flooring on VISIBLE legs
    // too double-weighted long unmeasured parts the perturbation already
    // prices: measured on a 6h screen, worth(hacking) drowned every other
    // channel and total income fell 160x.
    const hiddenNodeSec = baselineRoute
      ? resourceSeconds(baselineRoute.parts.filter((part) => part.hidden === true), resource)
      : 0;
    const installResourceSec = input.install.state === "unknown"
      ? 0
      : resourceSeconds(input.install.components, resource);
    const nodeResourceSec = baselineRoute ? resourceSeconds(baselineRoute.parts, resource) : 0;
    const dependentSec = perturbedSlope > 0
      ? hiddenNodeSec
      : Math.max(installResourceSec, nodeResourceSec);
    const floorSlope = dependentSec > 0 ? linearSecondsPerRelativeRate(dependentSec, delta) : 0;

    if (perturbedSlope > 0 || floorSlope > 0) {
      return {
        state: "estimated",
        secondsPerRelativeRate: Math.max(perturbedSlope, floorSlope),
        horizon: perturbedSlope >= floorSlope
          ? (node > install ? "node" : "install")
          : "future-binding",
        ...at,
      };
    }

    if (input.install.state === "unknown" && !baselineRoute) {
      return {
        state: "unknown",
        secondsPerRelativeRate: 0,
        reason: "neither an install forecast nor a selected BitNode route is available",
      };
    }
    return { state: "estimated", secondsPerRelativeRate: 0, reason: "the selected plan has no dependency on this resource" };
  };

  const out = {} as ProgressionMarginals;
  for (const resource of MARGINAL_RESOURCES) out[resource] = one(resource);
  return out;
}
