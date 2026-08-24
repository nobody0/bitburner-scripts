import { coreEffect } from "../../ram/heap.ts";
import { WORKER_RAM } from "../../world.ts";
import { relativeGainSaving } from "../share.ts";

export const CHARGE_DURATION_SEC = 1;
export const CHARGE_RAM_GB = WORKER_RAM.charge;

export interface ChargeFragment {
  id: number;
  type: string;
  x: number;
  y: number;
  power: number;
  numCharge: number;
  highestCharge: number;
  chargedEffect: number;
  chargeable?: boolean;
}

export interface ChargePricingInput {
  fragments: readonly ChargeFragment[];
  moneySecondsPerRelativeRate: number;
  hackingSecondsPerRelativeRate: number;
  totalMoneyPerSec?: number;
  totalHackingExpPerSec?: number;
  /** Portion of each measured total rate produced by this fleet. Filled by the
   * evaluator from the chosen farm solve; absent is unknown, never 100%. */
  moneySourceShare?: number;
  hackingSourceShare?: number;
}

export interface ChargeHostBlock {
  hostname: string;
  gb: number;
  cores: number;
}

export interface ChargeCutover {
  fragment?: ChargeFragment;
  allotmentGb: number;
  threads: number;
  effectiveThreads: number;
  valueSeconds: number;
  opportunitySeconds: number;
}

function chargeState(fragment: ChargeFragment, addedEffectiveThreads: number): { highest: number; count: number } {
  const threads = Math.max(0, addedEffectiveThreads);
  const highest = Math.max(0, fragment.highestCharge);
  const count = Math.max(0, fragment.numCharge);
  if (threads <= 0) return { highest, count };
  if (threads > highest) {
    return { highest: threads, count: highest > 0 ? highest * count / threads + 1 : 1 };
  }
  return { highest, count: count + threads / Math.max(highest, Number.EPSILON) };
}

function effectShape(highest: number, count: number): number {
  return Math.log(highest + 1) * Math.pow((count + 1) / 5, 0.07);
}

/** Project the exact Stanek charge accumulator. The observed chargedEffect
 * recovers booster/BitNode power without making the game driver probe either.
 * An uncharged fragment has no recoverable coefficient, so its documented
 * base power is used conservatively. */
export function projectedChargeEffect(fragment: ChargeFragment, addedEffectiveThreads: number): number {
  const beforeShape = effectShape(Math.max(0, fragment.highestCharge), Math.max(0, fragment.numCharge));
  const coefficient = beforeShape > 0 && fragment.chargedEffect > 1
    ? (fragment.chargedEffect - 1) / beforeShape
    : Math.max(0, fragment.power) / 60;
  const next = chargeState(fragment, addedEffectiveThreads);
  return 1 + coefficient * effectShape(next.highest, next.count);
}

function affectedShares(fragment: ChargeFragment, input: ChargePricingInput): { money: number; hacking: number } {
  const money = Math.min(1, Math.max(0, input.moneySourceShare ?? 0));
  const hacking = Math.min(1, Math.max(0, input.hackingSourceShare ?? 0));
  switch (Number(fragment.type)) {
    case 3: return { money, hacking }; // HGW speed
    case 4: // hack money
    case 5: return { money, hacking: 0 }; // grow power
    case 6: return { money: 0, hacking }; // hacking level/experience
    default: return { money: 0, hacking: 0 };
  }
}

export function chargeValueSeconds(
  fragment: ChargeFragment,
  effectiveThreads: number,
  input: ChargePricingInput,
): number {
  const current = Math.max(1, fragment.chargedEffect);
  const next = projectedChargeEffect(fragment, effectiveThreads);
  const gain = Math.max(0, next / current - 1);
  const shares = affectedShares(fragment, input);
  return Math.max(0, input.moneySecondsPerRelativeRate) * relativeGainSaving(gain * shares.money)
    + Math.max(0, input.hackingSecondsPerRelativeRate) * relativeGainSaving(gain * shares.hacking);
}

/** Price one large, host-local charge call against the farm work displaced for
 * its one-second lifetime. Larger calls are tested first because highestCharge
 * is logarithmic and a charge cannot be split across hosts without weakening
 * that term. */
export function chargeCutover(
  input: ChargePricingInput,
  blocks: readonly ChargeHostBlock[],
  maxGb = Infinity,
): ChargeCutover {
  const empty: ChargeCutover = {
    allotmentGb: 0,
    threads: 0,
    effectiveThreads: 0,
    valueSeconds: 0,
    opportunitySeconds: 0,
  };
  const fleetGb = blocks.reduce((sum, block) => sum + Math.max(0, block.gb), 0);
  if (fleetGb <= 0) return empty;
  let best = empty;
  const ordered = [...blocks].sort((a, b) => b.gb - a.gb || b.cores - a.cores || a.hostname.localeCompare(b.hostname));
  for (const block of ordered) {
    const threads = Math.floor(Math.min(block.gb, maxGb) / CHARGE_RAM_GB);
    if (threads < 1) continue;
    const effectiveThreads = threads * coreEffect(block.cores);
    for (const fragment of input.fragments) {
      if (fragment.chargeable === false) continue;
      const shares = affectedShares(fragment, input);
      const criticalSourceShare =
        (input.moneySecondsPerRelativeRate > 0 ? shares.money : 0) +
        (input.hackingSecondsPerRelativeRate > 0 ? shares.hacking : 0);
      const opportunitySeconds = CHARGE_DURATION_SEC * criticalSourceShare
        * (threads * CHARGE_RAM_GB / fleetGb);
      const valueSeconds = chargeValueSeconds(fragment, effectiveThreads, input);
      if (valueSeconds <= opportunitySeconds) continue;
      if (
        threads > best.threads ||
        (threads === best.threads && valueSeconds - opportunitySeconds > best.valueSeconds - best.opportunitySeconds)
      ) {
        best = {
          fragment,
          allotmentGb: threads * CHARGE_RAM_GB,
          threads,
          effectiveThreads,
          valueSeconds,
          opportunitySeconds,
        };
      }
    }
  }
  return best;
}
