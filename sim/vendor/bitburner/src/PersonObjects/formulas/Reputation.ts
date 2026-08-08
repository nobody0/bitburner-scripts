// Vendored from bitburner-src v3.0.1:src/PersonObjects/formulas/reputation.ts (5 symbols, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import type { Person as IPerson } from "@nsdefs";
import { CONSTANTS } from "../../Constants";
import { currentNodeMults } from "../../BitNode/BitNodeMultipliers";
import { calculateIntelligenceBonus } from "./intelligence";

/** Injected: upstream reads these from live singletons (NetworkShare and
 *  @player). They are real inputs to the rate, so they are parameters here
 *  rather than constants — a hardcoded 1x share bonus would quietly
 *  understate every rep rate on a sharing fleet. */
let shareBonus = 1;
let sf15Level = 0;
export function setReputationContext(ctx: { shareBonus?: number; sf15Level?: number }): void {
  if (ctx.shareBonus !== undefined) shareBonus = ctx.shareBonus;
  if (ctx.sf15Level !== undefined) sf15Level = ctx.sf15Level;
}
const calculateCurrentShareBonus = (): number => shareBonus;

function mult(favor: number): number {
  let favorMult = 1 + favor / 100;
  if (isNaN(favorMult)) {
    favorMult = 1;
  }
  return favorMult * currentNodeMults.FactionWorkRepGain;
}

export function getHackingWorkRepGain(p: IPerson, favor: number): number {
  return (
    ((p.skills.hacking + p.skills.intelligence / 3 + getDarknetCharismaBonus(p, 0.1)) / CONSTANTS.MaxSkillLevel) *
    p.mults.faction_rep *
    calculateIntelligenceBonus(p.skills.intelligence, 1) *
    mult(favor) *
    calculateCurrentShareBonus()
  );
}

export function getFactionSecurityWorkRepGain(p: IPerson, favor: number): number {
  const t =
    (0.9 *
      (p.skills.strength +
        p.skills.defense +
        p.skills.dexterity +
        p.skills.agility +
        getDarknetCharismaBonus(p, 0.3) +
        (p.skills.hacking + p.skills.intelligence) * calculateCurrentShareBonus())) /
    CONSTANTS.MaxSkillLevel /
    4.5;
  return t * p.mults.faction_rep * mult(favor) * calculateIntelligenceBonus(p.skills.intelligence, 1);
}

export function getFactionFieldWorkRepGain(p: IPerson, favor: number): number {
  const t =
    (0.9 *
      (p.skills.strength +
        p.skills.defense +
        p.skills.dexterity +
        p.skills.agility +
        p.skills.charisma +
        (p.skills.hacking + p.skills.intelligence + getDarknetCharismaBonus(p, 0.3)) * calculateCurrentShareBonus())) /
    CONSTANTS.MaxSkillLevel /
    5.5;
  return t * p.mults.faction_rep * mult(favor) * calculateIntelligenceBonus(p.skills.intelligence, 1);
}

function getDarknetCharismaBonus(p: IPerson, scalar: number = 1): number {
  if (sf15Level >= 3) {
    return p.skills.charisma * scalar;
  }
  return 0;
}
