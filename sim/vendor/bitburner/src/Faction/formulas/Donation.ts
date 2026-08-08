// Vendored from bitburner-src v3.0.1:src/Faction/formulas/donation.ts (3 symbols, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import type { Person as IPerson } from "@nsdefs";
import { CONSTANTS } from "../../Constants";
import { currentNodeMults } from "../../BitNode/BitNodeMultipliers";

export function repFromDonation(amt: number, person: IPerson): number {
  return (amt / CONSTANTS.DonateMoneyToRepDivisor) * person.mults.faction_rep * currentNodeMults.FactionWorkRepGain;
}

export function donationForRep(rep: number, person: IPerson): number {
  return (rep * CONSTANTS.DonateMoneyToRepDivisor) / person.mults.faction_rep / currentNodeMults.FactionWorkRepGain;
}

export function favorNeededToDonate(): number {
  return Math.floor(CONSTANTS.BaseFavorToDonate * currentNodeMults.FavorToDonateToFaction);
}
