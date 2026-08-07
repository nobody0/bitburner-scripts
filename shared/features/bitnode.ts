/** BitNode reference data, transcribed from the pinned upstream checkout
 * (bitburner-src @ v3.0.1: src/BitNode/BitNode.tsx and
 * src/BitNode/BitNodeMultipliers.ts — see spec/game-source.md).
 *
 * Two things live here because both are static game data the UI needs but no
 * ns getter provides cheaply:
 *  - BITNODES: names + taglines, so the BitNode grid can label nodes we have
 *    not visited (ns tells us the current node, never the others').
 *  - DEFAULT_BITNODE_MULTIPLIERS: every field's BN1 value, so the multiplier
 *    table can show only what the active node actually changes. */

export interface BitNodeInfo {
  n: number;
  name: string;
  tagline: string;
}

export const BITNODES: readonly BitNodeInfo[] = [
  { n: 1, name: "Source Genesis", tagline: "The original BitNode" },
  { n: 2, name: "Rise of the Underworld", tagline: "From the shadows, they rose" },
  { n: 3, name: "Corporatocracy", tagline: "The Price of Civilization" },
  { n: 4, name: "The Singularity", tagline: "The Man and the Machine" },
  { n: 5, name: "Artificial Intelligence", tagline: "Posthuman" },
  { n: 6, name: "Bladeburners", tagline: "Like Tears in Rain" },
  { n: 7, name: "Bladeburners 2079", tagline: "More human than humans" },
  { n: 8, name: "Ghost of Wall Street", tagline: "Money never sleeps" },
  { n: 9, name: "Hacktocracy", tagline: "Hacknet Unleashed" },
  { n: 10, name: "Digital Carbon", tagline: "Your body is not who you are" },
  { n: 11, name: "The Big Crash", tagline: "Okay. Sell it all." },
  { n: 12, name: "The Recursion", tagline: "Repeat." },
  { n: 13, name: "They're lunatics", tagline: "1 step back, 2 steps forward" },
  { n: 14, name: "IPvGO Subnet Takeover", tagline: "Territory exists only in the 'net" },
  { n: 15, name: "The Secrets of the Dark Net", tagline: "The rules have changed" },
];

export const BITNODE_COUNT = BITNODES.length;

export function bitNodeInfo(n: number): BitNodeInfo | undefined {
  return BITNODES.find((b) => b.n === n);
}

/** Every BitNodeMultipliers field at its BN1 value. Two fields are NOT 1 —
 * transcribing them as 1 would make BN1 look like it modifies them. */
export const DEFAULT_BITNODE_MULTIPLIERS: Readonly<Record<string, number>> = {
  AgilityLevelMultiplier: 1,
  AugmentationMoneyCost: 1,
  AugmentationRepCost: 1,
  BladeburnerRank: 1,
  BladeburnerSkillCost: 1,
  CharismaLevelMultiplier: 1,
  ClassGymExpGain: 1,
  CodingContractMoney: 1,
  CompanyWorkExpGain: 1,
  CompanyWorkMoney: 1,
  CompanyWorkRepGain: 1,
  CorporationDivisions: 1,
  CorporationSoftcap: 1,
  CorporationValuation: 1,
  CrimeExpGain: 1,
  CrimeMoney: 1,
  CrimeSuccessRate: 1,
  DaedalusAugsRequirement: 30,
  DarknetLabyrinthRewardsTheRedPill: 1,
  DarknetMoneyMultiplier: 1,
  DefenseLevelMultiplier: 1,
  DexterityLevelMultiplier: 1,
  FactionPassiveRepGain: 1,
  FactionWorkExpGain: 1,
  FactionWorkRepGain: 1,
  FourSigmaMarketDataApiCost: 1,
  FourSigmaMarketDataCost: 1,
  GangSoftcap: 1,
  GangUniqueAugs: 1,
  GoPower: 1,
  HackExpGain: 1,
  HackingLevelMultiplier: 1,
  HackingSpeedMultiplier: 1,
  HacknetNodeMoney: 1,
  HomeComputerRamCost: 1,
  InfiltrationMoney: 1,
  InfiltrationRep: 1,
  ManualHackMoney: 1,
  CloudServerCost: 1,
  CloudServerSoftcap: 1,
  CloudServerLimit: 1,
  CloudServerMaxRam: 1,
  FavorToDonateToFaction: 1,
  ScriptHackMoney: 1,
  ScriptHackMoneyGain: 1,
  ServerGrowthRate: 1,
  ServerMaxMoney: 1,
  ServerStartingMoney: 1,
  ServerStartingSecurity: 1,
  ServerWeakenRate: 1,
  StrengthLevelMultiplier: 1,
  StaneksGiftPowerMultiplier: 1,
  StaneksGiftExtraSize: 0,
  WorldDaemonDifficulty: 1,
};

/** Fields whose active value differs from the BN1 default. */
export function changedMultipliers(
  active: Readonly<Record<string, number>> | undefined,
): { field: string; value: number; base: number }[] {
  if (!active) return [];
  const changed: { field: string; value: number; base: number }[] = [];
  for (const [field, value] of Object.entries(active)) {
    const base = DEFAULT_BITNODE_MULTIPLIERS[field];
    if (base === undefined || value !== base) changed.push({ field, value, base: base ?? 1 });
  }
  return changed.sort((a, b) => (a.field < b.field ? -1 : 1));
}
