import type { NS } from "@ns";
import { FEATURE_IDS, type FeatureId } from "../../../shared/features/ids.ts";
import type { Capabilities } from "../../../shared/features/unlock.ts";
import type { ArbiterResult, Claim } from "../../../shared/strategy/arbiter.ts";
import { emptyArbitration, grantedAmount, holdsSlot } from "../../../shared/strategy/arbiter.ts";
import type { HostRam } from "../../../shared/ram/placement.ts";
import type { Need, NeedBoard } from "../../../shared/strategy/needs.ts";
import { emptyBoard } from "../../../shared/strategy/needs.ts";
import type { RouteId } from "../../../shared/strategy/progression/endgame.ts";
import type { PlanningHorizons } from "../../../shared/strategy/progression/forecast.ts";
import type { GameState } from "../state.ts";
import type { DodgeLease } from "../ram.ts";
import { careerModule } from "./career.ts";
import { factionsModule } from "./factions.ts";
import { hacknetModule } from "./hacknet.ts";
import {
  bladeburnerModule,
  corpModule,
  dnetModule,
  gangModule,
  goModule,
  progressionModule,
  sleevesModule,
  stanekModule,
} from "./remaining.ts";
import { sideModule } from "./side.ts";
import { stockModule } from "./stock.ts";
import { hackingModule } from "./hacking.ts";

/** Feature modules: the write half of the feature axis.
 *
 * A probe reads one feature's state; a MODULE owns everything the controller
 * needs to know about acting on it — the driver, what it wants from other
 * features, what contended resources it is bidding for, and how to throw away
 * everything it derived from a world that no longer exists.
 *
 * The point of bundling the four is that the controller never names a feature.
 * Before this existed, `onBitNodeReset` called `resetHackingState()` directly,
 * so every new feature meant editing the loop; now the loop walks the registry.
 * Filling in a feature is a local change to one file.
 *
 * All fourteen are implemented. `tests/features.test.ts` enforces a module per
 * feature exactly as it enforces a probe, a topic and a tab, so a new feature
 * cannot be half-registered. */

export interface DriverContext {
  ns: NS;
  state: GameState;
  caps: Capabilities;
  /** Largest dodge budget any host could serve right now. This is the
   *  whole-fleet figure; what this feature may actually spend is
   *  `grants.ram`, which the arbiter has already cut down. */
  budgetGb: number;
  /** Where a dodge may be placed, with each host's free RAM. Feature actions
   * use featureDodge(), which validates their claim and leases this heap. */
  dodgeHosts: readonly HostRam[];
  /** Home RAM the dispatcher must leave free this pass, already accounting for
   *  every unlocked feature's declared dodge step (shared/ram/reserve.ts). */
  homeReserveGb: number;
  /** The part of the wanted reserve the home cap truncated, kept free on the
   *  largest fleet host instead (dispatch syncTopology). Zero when home holds
   *  the full reserve. */
  fleetReserveGb: number;
  /** Controller tick counter, for drivers that want a phase offset. */
  tick: number;
  /** What everyone wants, this tick. A driver satisfying another feature's
   *  need reads it here (see shared/strategy/needs.ts). */
  board: NeedBoard;
  /** What this feature was actually granted. */
  grants: FeatureGrants;
  /** Explicit node-end and next-install clocks. Consumers choose the lifetime
   * matching what they buy; unknown/stale is preserved rather than fabricated
   * into a numeric default. */
  horizons: PlanningHorizons;
  /** The chosen way to finish this BitNode, when decided. A driver may use it
   *  to bias priorities (bladeburner when it IS the route, combat stats for
   *  the Daedalus combat branch) — never to gate its whole tick. */
  route?: RouteId;
  /** Atomically choose a host and reserve its RAM in the dispatcher's heap. */
  acquireDodge(budgetGb: number): DodgeLease | undefined;
}

/** The arbiter's answer, pre-narrowed to one feature so a driver cannot
 * accidentally read another's grant. */
export interface FeatureGrants {
  money: number;
  ram: number;
  /** True when this feature holds Player.currentWork this tick. A driver that
   *  does not hold it must not start player work — the game would silently
   *  cancel whatever is running. */
  slot: boolean;
  /** The full result, for a driver that needs to know WHY it was denied. */
  result: ArbiterResult;
}

/** Context for the pure pre-tick passes. Deliberately narrower than
 * DriverContext: neither pass may call ns, because both run for every due
 * module before any of them acts. */
export interface NeedContext {
  state: GameState;
  caps: Capabilities;
  now: number;
}

export interface ClaimContext extends NeedContext {
  budgetGb: number;
  /** Same typed payoff windows later handed to the drivers. */
  horizons: PlanningHorizons;
  /** Runtime dynamic-RAM price supplied by the controller. The claim remains
   * decision-only: it receives the priced observation, never an ns handle. */
  ramPrice(methods: readonly string[]): number;
  /** The board is complete before any claim is collected, so a feature can bid
   *  harder BECAUSE something else is blocked on it — that is how `career`
   *  outbids `factions` for the work slot when a karma need is blocking. */
  board: NeedBoard;
}

export interface FeatureDriver {
  id: FeatureId;
  /** Minimum interval between ticks. A plain literal, matching the probe
   *  table's convention. */
  everyMs: number;
  /** Event-driven early wake. Used when the game exposes an authoritative
   * completion signal and waiting for the ordinary cadence would waste work
   * ticks. It must be observation-only. */
  wake?(): boolean;
  /** Ticks only while capabilities report this feature as "yes". Omit for
   *  features that are always playable. */
  requires?: FeatureId;
  tick(ctx: DriverContext): void | Promise<void>;
}

export interface FeatureModule {
  driver: FeatureDriver;
  /** Drop everything derived from a world that no longer exists — module
   *  state AND the feature's published topics. Called on a BitNode reset for
   *  EVERY module, so a feature's cross-run state cannot be forgotten by the
   *  controller failing to name it. The state is passed precisely so each
   *  module can clear its own topics: a per-field delete blacklist in the
   *  controller is the coupling this registry exists to remove, and a stale
   *  topic surviving a reset is live data from a dead node (the first route
   *  decision of a new node once read the old node's Red Pill out of it). */
  reset?(state: GameState): void;
  /** The refresh half of the refresh/act split. Called for every due module
   *  BEFORE needs, claims or any tick() — evaluation only, writing its
   *  conclusions (digests, ETA contributions) to the store for everyone else
   *  to read this same pass. No ns access: anything that touches the game
   *  belongs in tick(), the act half.
   *
   *  This is what resolves the ordering problem between the endgame decision
   *  and the features: every due feature's published state is refreshed, THEN
   *  progression's refresh picks the route from it, THEN drivers act with the
   *  route and horizon in their context. */
  refresh?(ctx: NeedContext): void;
  /** PURE. Called for every due module BEFORE any tick(). */
  claims?(ctx: ClaimContext): Claim[];
  /** PURE. Outcomes this feature wants from others, this tick. */
  needs?(ctx: NeedContext): Need[];
  /** Largest single dodge step this feature needs to function, in GB. Declared
   *  next to the driver so it cannot drift from the probe, and folded into the
   *  home reserve by shared/ram/reserve.ts. */
  peakStepGb?: number;
}

export const FEATURE_MODULES: Readonly<Record<FeatureId, FeatureModule>> = {
  progression: progressionModule,
  hacking: hackingModule,
  factions: factionsModule,
  career: careerModule,
  hacknet: hacknetModule,
  stock: stockModule,
  gang: gangModule,
  corp: corpModule,
  bladeburner: bladeburnerModule,
  sleeves: sleevesModule,
  go: goModule,
  stanek: stanekModule,
  dnet: dnetModule,
  side: sideModule,
};

/** Registry order is FEATURE_IDS order, so the tab bar, the scheduler and the
 * telemetry all agree without a second list to keep in sync. */
export const FEATURE_DRIVERS: readonly FeatureDriver[] = FEATURE_IDS.map((id) => FEATURE_MODULES[id].driver);

export function featureModule(id: FeatureId): FeatureModule {
  return FEATURE_MODULES[id];
}

/** Every module's reset hook, in registry order. The controller calls this on
 * a BitNode reset instead of naming features one by one. */
export function resetAllFeatures(state: GameState): void {
  for (const id of FEATURE_IDS) FEATURE_MODULES[id].reset?.(state);
}

/** Peak dodge step per enabled feature, for shared/ram/reserve.ts. */
export function featureRamDemand(): Partial<Record<FeatureId, number>> {
  const demand: Partial<Record<FeatureId, number>> = {};
  for (const id of FEATURE_IDS) {
    const peak = FEATURE_MODULES[id].peakStepGb;
    if (peak !== undefined) demand[id] = peak;
  }
  return demand;
}

/** Narrow a whole arbitration to one feature's share. */
export function grantsFor(result: ArbiterResult, id: FeatureId): FeatureGrants {
  return {
    money: grantedAmount(result, id, "money"),
    ram: grantedAmount(result, id, "ram"),
    slot: holdsSlot(result, id),
    result,
  };
}

/** The grants a driver sees before any claim has been resolved. */
export function noGrants(): FeatureGrants {
  return { money: 0, ram: 0, slot: false, result: emptyArbitration() };
}

export { emptyBoard };

/** Which drivers should run now. Pure, so the scheduling rule is unit-tested
 * rather than inferred from live behaviour.
 *
 * "unknown" never runs a driver: not having looked is not the same as being
 * unlocked, and acting on a feature we cannot see would spend a stub launch
 * discovering an API that throws. */
export function selectDue(
  drivers: readonly FeatureDriver[],
  lastRun: Record<string, number>,
  caps: Capabilities,
  now: number,
): FeatureDriver[] {
  return drivers.filter((driver) => {
    // A driver never runs while its OWN feature reads "no". `requires` is
    // about a dependency; this is about the feature itself, and it is what
    // lets an isolation profile switch off the five always-playable drivers —
    // they declare no `requires`, so nothing else would ever stop them.
    // In the real game this is a no-op: deriveCapabilities reports those five
    // as "yes" unconditionally, and gated features are handled below.
    if (!driverEnabled(driver, caps)) return false;
    return driver.wake?.() === true || now - (lastRun[driver.id] ?? 0) >= driver.everyMs;
  });
}

/** Capability half of scheduling, shared with contribution-cache pruning. */
export function driverEnabled(driver: FeatureDriver, caps: Capabilities): boolean {
  if (caps.unlocked[driver.id] !== "yes") return false;
  return driver.requires === undefined || caps.unlocked[driver.requires] === "yes";
}

/** The modules whose drivers are due — the set the needs and claims passes run
 * over. Same rule as selectDue, so a feature can never post a claim on a tick
 * its driver would not run and then fail to spend the grant. */
export function selectDueModules(
  lastRun: Record<string, number>,
  caps: Capabilities,
  now: number,
): FeatureModule[] {
  return selectDue(FEATURE_DRIVERS, lastRun, caps, now).map((driver) => FEATURE_MODULES[driver.id]);
}

export { FEATURE_IDS };
