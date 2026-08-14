import type { NS } from "@ns";
import type { PrestigeKind } from "../../../shared/reset.ts";
import { FEATURE_IDS, type FeatureId } from "../../../shared/features/ids.ts";
import type { Capabilities } from "../../../shared/features/unlock.ts";
import type { ArbiterResult, Claim, ClaimValueCurve, StepClaim } from "../../../shared/strategy/arbiter.ts";
import { emptyArbitration, grantedAmount, holdsSlot } from "../../../shared/strategy/arbiter.ts";
import type { Need, NeedBoard } from "../../../shared/strategy/needs.ts";
import { emptyBoard } from "../../../shared/strategy/needs.ts";
import type { RouteId } from "../../../shared/strategy/progression/endgame.ts";
import type { PlanningHorizons } from "../../../shared/strategy/progression/forecast.ts";
import type { GameState } from "../state.ts";
import type { DodgeAcquire } from "../ram.ts";
import type { ArenaPlan, BrokerRequest } from '../../../shared/ram/broker.ts';
import type { FeatureClaim, RamClaim } from "./claims.ts";
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
  /** Features whose drivers can actually run in this pass. This includes a
   * driver's dependency (`requires`), unlike checking only its own capability.
   * Providers use it before delegating work onto the needs board, so an
   * isolation profile cannot leave a request that no enabled consumer can
   * satisfy. */
  activeFeatures: ReadonlySet<FeatureId>;
  /** Current broker arena and its guaranteed dynamic boundary. */
  arena: ArenaPlan;
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
  acquireDodge(
    budgetGb: number,
    request: Omit<BrokerRequest, 'gb' | 'class'>,
  ): DodgeAcquire;
}

/** The arbiter's answer, pre-narrowed to one feature so a driver cannot
 * accidentally read another's grant. */
export interface FeatureGrants {
  money: number;
  /** Broker priorities declared by this feature for the current pass. */
  ramClaims: ReadonlyMap<string, RamClaim>;
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
  /** All enabled drivers, not merely the subset due on this cadence. */
  activeFeatures: ReadonlySet<FeatureId>;
}

export interface ClaimContext extends NeedContext {
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
  /** Invalidate everything derived from the pre-prestige world. Modules may
   * distinguish install from BitNode prestige when a cache's lifetime really
   * differs; re-observing persistent game state is always safe. The state is
   * passed so each module clears its own topics instead of relying on a
   * controller-owned field blacklist. */
  reset?(state: GameState, kind: PrestigeKind): void;
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
  claims?(ctx: ClaimContext): FeatureClaim[];
  /** PURE. Fresh BN-seconds economics for one of this module's standing
   * claims. It is evaluated after the contribution cache is assembled, so a
   * cached claim never carries a stale closure across feature cadences. */
  valueCurve?(claim: Claim, ctx: ClaimContext): ClaimValueCurve | undefined;
  /** PURE. Return the next indivisible rung after this exact one is granted. */
  nextStep?(claim: StepClaim, ctx: ClaimContext): StepClaim | undefined;
  /** PURE. Outcomes this feature wants from others, this tick. */
  needs?(ctx: NeedContext): Need[];
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
 * augmentation and BitNode prestige instead of naming features one by one. */
export function resetAllFeatures(state: GameState, kind: PrestigeKind): void {
  for (const id of FEATURE_IDS) FEATURE_MODULES[id].reset?.(state, kind);
}

/** Narrow a whole arbitration to one feature's share. */
export function grantsFor(
  result: ArbiterResult,
  id: FeatureId,
  ramClaims: readonly RamClaim[] = [],
): FeatureGrants {
  return {
    money: grantedAmount(result, id, "money"),
    ramClaims: new Map(
      ramClaims.filter((claim) => claim.by === id).map((claim) => [claim.id, claim]),
    ),
    slot: holdsSlot(result, id),
    result,
  };
}

/** The grants a driver sees before any claim has been resolved. */
export function noGrants(): FeatureGrants {
  return { money: 0, ramClaims: new Map(), slot: false, result: emptyArbitration() };
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
