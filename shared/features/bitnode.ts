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

/** Per-BitNode overrides, transcribed from `getBitNodeMultipliers` (v3.0.1).
 *
 * This exists because the ns getter is unusable as a general source: it costs
 * 4 GB AND requires BN5/SF5, so in most nodes the controller simply cannot ask
 * what world it is in. Without this table every consumer silently defaults to
 * 1.0 — which is a 3.3x timing error on `HackingSpeedMultiplier` in BN14, and
 * a wrong `w0r1d_d43m0n` target everywhere `WorldDaemonDifficulty` is not 1.
 *
 * BN12 is absent on purpose: its multipliers are a FUNCTION of the source-file
 * level rather than a table, so it is computed in `bitNodeMultipliers` below.
 *
 * Pinned field-by-field against the vendored original by
 * `sim/tests/bitnode-parity.test.ts`. Do not hand-edit without rerunning it. */
const BITNODE_OVERRIDES: Readonly<Record<number, Readonly<Record<string, number>>>> = {
  1: {},
  2: {
    HackingLevelMultiplier: 0.8,
    ServerGrowthRate: 0.8, ServerMaxMoney: 0.08, ServerStartingMoney: 0.4,
    CloudServerSoftcap: 1.3,
    CrimeMoney: 3,
    FactionPassiveRepGain: 0, FactionWorkRepGain: 0.5,
    CorporationSoftcap: 0.9, CorporationDivisions: 0.9,
    InfiltrationMoney: 3,
    StaneksGiftPowerMultiplier: 2, StaneksGiftExtraSize: -6,
    WorldDaemonDifficulty: 5,
  },
  3: {
    HackingLevelMultiplier: 0.8,
    ServerGrowthRate: 0.2, ServerMaxMoney: 0.04, ServerStartingMoney: 0.2,
    HomeComputerRamCost: 1.5,
    CloudServerCost: 2, CloudServerSoftcap: 1.3,
    CompanyWorkMoney: 0.25, CrimeMoney: 0.25, HacknetNodeMoney: 0.25, ScriptHackMoney: 0.2,
    FavorToDonateToFaction: 0.5,
    AugmentationMoneyCost: 3, AugmentationRepCost: 3,
    GangSoftcap: 0.9, GangUniqueAugs: 0.5,
    StaneksGiftPowerMultiplier: 0.75, StaneksGiftExtraSize: -2,
    DarknetMoneyMultiplier: 0.4,
    WorldDaemonDifficulty: 2,
  },
  4: {
    ServerMaxMoney: 0.1125, ServerStartingMoney: 0.75,
    CloudServerSoftcap: 1.2,
    CompanyWorkMoney: 0.1, CrimeMoney: 0.2, HacknetNodeMoney: 0.05, ScriptHackMoney: 0.2,
    ClassGymExpGain: 0.5, CompanyWorkExpGain: 0.5, CrimeExpGain: 0.5, FactionWorkExpGain: 0.5,
    HackExpGain: 0.4,
    FactionWorkRepGain: 0.75,
    GangUniqueAugs: 0.5,
    StaneksGiftPowerMultiplier: 1.5, StaneksGiftExtraSize: 0,
    DarknetMoneyMultiplier: 0.4,
    WorldDaemonDifficulty: 3,
  },
  5: {
    ServerStartingSecurity: 2, ServerStartingMoney: 0.5,
    CloudServerSoftcap: 1.2,
    CrimeMoney: 0.5, HacknetNodeMoney: 0.2, ScriptHackMoney: 0.15,
    HackExpGain: 0.5,
    AugmentationMoneyCost: 2,
    InfiltrationMoney: 1.5, InfiltrationRep: 1.5,
    CorporationValuation: 0.75, CorporationDivisions: 0.75,
    GangUniqueAugs: 0.5,
    StaneksGiftPowerMultiplier: 1.3, StaneksGiftExtraSize: 0,
    DarknetMoneyMultiplier: 0.7,
    WorldDaemonDifficulty: 1.5,
  },
  6: {
    HackingLevelMultiplier: 0.35,
    ServerMaxMoney: 0.2, ServerStartingMoney: 0.5, ServerStartingSecurity: 1.5,
    CloudServerSoftcap: 2,
    CompanyWorkMoney: 0.5, CrimeMoney: 0.75, HacknetNodeMoney: 0.2, ScriptHackMoney: 0.75,
    HackExpGain: 0.25,
    InfiltrationMoney: 0.75,
    CorporationValuation: 0.2, CorporationSoftcap: 0.9, CorporationDivisions: 0.8,
    GangSoftcap: 0.7, GangUniqueAugs: 0.2,
    DaedalusAugsRequirement: 35,
    StaneksGiftPowerMultiplier: 0.5, StaneksGiftExtraSize: 2,
    WorldDaemonDifficulty: 2,
  },
  7: {
    HackingLevelMultiplier: 0.35,
    ServerMaxMoney: 0.2, ServerStartingMoney: 0.5, ServerStartingSecurity: 1.5,
    CloudServerSoftcap: 2,
    CompanyWorkMoney: 0.5, CrimeMoney: 0.75, HacknetNodeMoney: 0.2, ScriptHackMoney: 0.5,
    HackExpGain: 0.25,
    AugmentationMoneyCost: 3,
    InfiltrationMoney: 0.75,
    FourSigmaMarketDataCost: 2, FourSigmaMarketDataApiCost: 2,
    CorporationValuation: 0.2, CorporationSoftcap: 0.9, CorporationDivisions: 0.8,
    BladeburnerRank: 0.6, BladeburnerSkillCost: 2,
    GangSoftcap: 0.7, GangUniqueAugs: 0.2,
    DaedalusAugsRequirement: 35,
    StaneksGiftPowerMultiplier: 0.9, StaneksGiftExtraSize: -1,
    WorldDaemonDifficulty: 2,
  },
  8: {
    CloudServerSoftcap: 4,
    CompanyWorkMoney: 0, CrimeMoney: 0, HacknetNodeMoney: 0, ManualHackMoney: 0,
    ScriptHackMoney: 0.3, ScriptHackMoneyGain: 0, CodingContractMoney: 0,
    FavorToDonateToFaction: 0,
    InfiltrationMoney: 0,
    CorporationValuation: 0, CorporationSoftcap: 0, CorporationDivisions: 0,
    BladeburnerRank: 0,
    DarknetLabyrinthRewardsTheRedPill: 0, DarknetMoneyMultiplier: 0,
    GangSoftcap: 0, GangUniqueAugs: 0,
    StaneksGiftExtraSize: -99,
  },
  9: {
    HackingLevelMultiplier: 0.5,
    StrengthLevelMultiplier: 0.45, DefenseLevelMultiplier: 0.45, DexterityLevelMultiplier: 0.45,
    AgilityLevelMultiplier: 0.45, CharismaLevelMultiplier: 0.45,
    ServerMaxMoney: 0.01, ServerStartingMoney: 0.1, ServerStartingSecurity: 2.5,
    HomeComputerRamCost: 5,
    CloudServerLimit: 0,
    CrimeMoney: 0.5, ScriptHackMoney: 0.1,
    HackExpGain: 0.05,
    FourSigmaMarketDataCost: 5, FourSigmaMarketDataApiCost: 4,
    CorporationValuation: 0.5, CorporationSoftcap: 0.75, CorporationDivisions: 0.8,
    BladeburnerRank: 0.9, BladeburnerSkillCost: 1.2,
    GangSoftcap: 0.8, GangUniqueAugs: 0.25,
    StaneksGiftPowerMultiplier: 0.5, StaneksGiftExtraSize: 2,
    DarknetMoneyMultiplier: 0.05,
    WorldDaemonDifficulty: 2,
  },
  10: {
    HackingLevelMultiplier: 0.35,
    StrengthLevelMultiplier: 0.4, DefenseLevelMultiplier: 0.4, DexterityLevelMultiplier: 0.4,
    AgilityLevelMultiplier: 0.4, CharismaLevelMultiplier: 0.4,
    HomeComputerRamCost: 1.5,
    CloudServerCost: 5, CloudServerSoftcap: 1.1, CloudServerLimit: 0.6, CloudServerMaxRam: 0.5,
    CompanyWorkMoney: 0.5, CrimeMoney: 0.5, HacknetNodeMoney: 0.5, ManualHackMoney: 0.5,
    ScriptHackMoney: 0.5, CodingContractMoney: 0.5,
    AugmentationMoneyCost: 5, AugmentationRepCost: 2,
    InfiltrationMoney: 0.5,
    CorporationValuation: 0.5, CorporationSoftcap: 0.9, CorporationDivisions: 0.9,
    BladeburnerRank: 0.8,
    GangSoftcap: 0.9, GangUniqueAugs: 0.25,
    StaneksGiftPowerMultiplier: 0.75, StaneksGiftExtraSize: -3,
    DarknetMoneyMultiplier: 0.4,
    WorldDaemonDifficulty: 2,
  },
  11: {
    HackingLevelMultiplier: 0.6,
    ServerGrowthRate: 0.2, ServerMaxMoney: 0.01, ServerStartingMoney: 0.1, ServerWeakenRate: 2,
    CloudServerSoftcap: 2,
    CompanyWorkMoney: 0.5, CrimeMoney: 3, HacknetNodeMoney: 0.1, CodingContractMoney: 0.25,
    HackExpGain: 0.5,
    AugmentationMoneyCost: 2,
    InfiltrationMoney: 2.5, InfiltrationRep: 2.5,
    FourSigmaMarketDataCost: 4, FourSigmaMarketDataApiCost: 4,
    CorporationValuation: 0.1, CorporationSoftcap: 0.9, CorporationDivisions: 0.9,
    GangUniqueAugs: 0.75,
    WorldDaemonDifficulty: 1.5,
  },
  13: {
    HackingLevelMultiplier: 0.25,
    StrengthLevelMultiplier: 0.7, DefenseLevelMultiplier: 0.7, DexterityLevelMultiplier: 0.7,
    AgilityLevelMultiplier: 0.7,
    CloudServerSoftcap: 1.6,
    ServerMaxMoney: 0.3375, ServerStartingMoney: 0.75, ServerStartingSecurity: 3,
    CompanyWorkMoney: 0.4, CrimeMoney: 0.4, HacknetNodeMoney: 0.4, ScriptHackMoney: 0.2,
    CodingContractMoney: 0.4,
    ClassGymExpGain: 0.5, CompanyWorkExpGain: 0.5, CrimeExpGain: 0.5, FactionWorkExpGain: 0.5,
    HackExpGain: 0.1,
    FactionWorkRepGain: 0.6,
    FourSigmaMarketDataCost: 10, FourSigmaMarketDataApiCost: 10,
    CorporationValuation: 0.001, CorporationSoftcap: 0.4, CorporationDivisions: 0.4,
    BladeburnerRank: 0.45, BladeburnerSkillCost: 2,
    GangSoftcap: 0.3, GangUniqueAugs: 0.1,
    StaneksGiftPowerMultiplier: 2, StaneksGiftExtraSize: 1,
    DarknetMoneyMultiplier: 0.1,
    WorldDaemonDifficulty: 3,
  },
  14: {
    GoPower: 4,
    HackingLevelMultiplier: 0.4, HackingSpeedMultiplier: 0.3,
    ServerMaxMoney: 0.7, ServerStartingMoney: 0.5, ServerStartingSecurity: 1.5,
    CrimeMoney: 0.75, CrimeSuccessRate: 0.4, HacknetNodeMoney: 0.25, ScriptHackMoney: 0.3,
    StrengthLevelMultiplier: 0.5, DexterityLevelMultiplier: 0.5, AgilityLevelMultiplier: 0.5,
    DefenseLevelMultiplier: 0.5,
    AugmentationMoneyCost: 1.5,
    InfiltrationMoney: 0.75,
    FactionWorkRepGain: 0.2, CompanyWorkRepGain: 0.2,
    CorporationValuation: 0.4, CorporationSoftcap: 0.9, CorporationDivisions: 0.8,
    BladeburnerRank: 0.6, BladeburnerSkillCost: 2,
    GangSoftcap: 0.7, GangUniqueAugs: 0.4,
    StaneksGiftPowerMultiplier: 0.5, StaneksGiftExtraSize: -1,
    WorldDaemonDifficulty: 5,
  },
  15: {
    HackingLevelMultiplier: 0.6, HackingSpeedMultiplier: 0.6,
    StrengthLevelMultiplier: 0.7, DefenseLevelMultiplier: 0.7, DexterityLevelMultiplier: 0.7,
    AgilityLevelMultiplier: 0.7, CharismaLevelMultiplier: 1.1,
    ServerMaxMoney: 0.8, ServerStartingMoney: 0.5, ServerStartingSecurity: 1.5,
    AugmentationMoneyCost: 3,
    CorporationValuation: 0.2, CorporationSoftcap: 0.4, CorporationDivisions: 0.4,
    DaedalusAugsRequirement: 20,
    BladeburnerRank: 0.2, BladeburnerSkillCost: 3,
    GangUniqueAugs: 0.3,
    StaneksGiftPowerMultiplier: 0.7, StaneksGiftExtraSize: -2,
    WorldDaemonDifficulty: 2,
  },
};

/** BN12's multipliers, which are derived from the source-file level rather
 * than tabulated. `lvl` is the SF12 level (0 on a first visit). */
function bitNode12(lvl: number): Record<string, number> {
  const inc = Math.pow(1.02, lvl);
  const dec = 1 / inc;
  return {
    DaedalusAugsRequirement: Math.floor(
      Math.min(DEFAULT_BITNODE_MULTIPLIERS.DaedalusAugsRequirement! + inc, 40),
    ),
    HackingLevelMultiplier: dec, StrengthLevelMultiplier: dec, DefenseLevelMultiplier: dec,
    DexterityLevelMultiplier: dec, AgilityLevelMultiplier: dec, CharismaLevelMultiplier: dec,
    ServerGrowthRate: dec, ServerMaxMoney: dec * dec, ServerStartingMoney: dec,
    ServerWeakenRate: dec,
    // Deliberately not scaled upstream — otherwise security starts at 300+.
    ServerStartingSecurity: 1.5,
    HomeComputerRamCost: inc,
    CloudServerCost: inc, CloudServerSoftcap: inc, CloudServerLimit: dec, CloudServerMaxRam: dec,
    CompanyWorkMoney: dec, CrimeMoney: dec, HacknetNodeMoney: dec, ManualHackMoney: dec,
    ScriptHackMoney: dec, CodingContractMoney: dec, DarknetMoneyMultiplier: dec,
    ClassGymExpGain: dec, CompanyWorkExpGain: dec, CrimeExpGain: dec, FactionWorkExpGain: dec,
    HackExpGain: dec,
    FactionPassiveRepGain: dec, FactionWorkRepGain: dec, FavorToDonateToFaction: inc,
    AugmentationMoneyCost: inc, AugmentationRepCost: inc,
    InfiltrationMoney: dec, InfiltrationRep: dec,
    FourSigmaMarketDataCost: inc, FourSigmaMarketDataApiCost: inc,
    CorporationValuation: dec, CorporationSoftcap: 0.8, CorporationDivisions: 0.5,
    BladeburnerRank: dec, BladeburnerSkillCost: inc,
    GangSoftcap: 0.8, GangUniqueAugs: dec,
    StaneksGiftPowerMultiplier: inc, StaneksGiftExtraSize: inc,
    WorldDaemonDifficulty: inc,
  };
}

/** The full multiplier set for a BitNode — defaults with that node's overrides
 * applied. `sf12Level` only matters for BN12.
 *
 * Prefer this over `ns.getBitNodeMultipliers()`: it is free, needs no SF5, and
 * is identical to the getter's result. Returns undefined for an unknown node
 * rather than guessing, so a caller cannot mistake "we do not know" for BN1. */
export function bitNodeMultipliers(
  n: number | undefined,
  sf12Level = 0,
): Record<string, number> | undefined {
  if (n === undefined) return undefined;
  if (n === 12) return { ...DEFAULT_BITNODE_MULTIPLIERS, ...bitNode12(sf12Level) };
  const overrides = BITNODE_OVERRIDES[n];
  if (overrides === undefined) return undefined;
  return { ...DEFAULT_BITNODE_MULTIPLIERS, ...overrides };
}

/** Multipliers available to game strategy in every BitNode.
 *
 * `ns.getBitNodeMultipliers()` is gated behind BN5/SF5, but its absence does
 * not mean all multipliers are 1. The pinned static table supplies the complete
 * baseline; an observed getter result wins field-by-field when available. */
export function effectiveBitNodeMultipliers(
  n: number | undefined,
  sf12Level = 0,
  observed?: Record<string, number>,
): Record<string, number> | undefined {
  const known = bitNodeMultipliers(n, sf12Level);
  if (!known) return observed ? { ...observed } : undefined;
  return { ...known, ...(observed ?? {}) };
}

/** Required hacking level to reach `w0r1d_d43m0n` in this node: the server's
 * base 3000 scaled by `WorldDaemonDifficulty` (Server/ServerHelpers.ts). */
export const WORLD_DAEMON_BASE_SKILL = 3000;

export function worldDaemonSkill(n: number | undefined, sf12Level = 0): number | undefined {
  const mults = bitNodeMultipliers(n, sf12Level);
  if (!mults) return undefined;
  return WORLD_DAEMON_BASE_SKILL * (mults.WorldDaemonDifficulty ?? 1);
}

/** What a multiplier belongs to, and which direction hurts.
 *
 * `harderWhen` is the load-bearing half. A BitNode panel that colours by sign
 * is actively misleading: `CrimeMoney 0.70` and `AugmentationMoneyCost 1.43`
 * are both bad news, and half the fields in this table are costs where "up" is
 * the punishment. Classification is editorial — it is not transcribed from the
 * game — but `tests/bitnode-facets.test.ts` pins that every known field has
 * one, so a vendor bump that adds a multiplier cannot silently land as an
 * uncategorised, uncoloured row. */
export type MultiplierGroup =
  | "hacking"
  | "skills"
  | "career"
  | "factions"
  | "infra"
  | "side"
  | "hacknet"
  | "stock"
  | "gang"
  | "corp"
  | "bladeburner"
  | "stanek"
  | "go"
  | "darknet"
  | "endgame";

export interface MultiplierFacet {
  group: MultiplierGroup;
  harderWhen: "higher" | "lower";
}

/** Display order for the groups — roughly the order a run engages with them. */
export const MULTIPLIER_GROUPS: readonly MultiplierGroup[] = [
  "hacking",
  "infra",
  "skills",
  "career",
  "factions",
  "side",
  "hacknet",
  "stock",
  "gang",
  "corp",
  "bladeburner",
  "stanek",
  "go",
  "darknet",
  "endgame",
];

const HIGHER: "higher" = "higher";
const LOWER: "lower" = "lower";

export const MULTIPLIER_FACETS: Readonly<Record<string, MultiplierFacet>> = {
  HackingLevelMultiplier: { group: "hacking", harderWhen: LOWER },
  HackingSpeedMultiplier: { group: "hacking", harderWhen: LOWER },
  HackExpGain: { group: "hacking", harderWhen: LOWER },
  ManualHackMoney: { group: "hacking", harderWhen: LOWER },
  ScriptHackMoney: { group: "hacking", harderWhen: LOWER },
  ScriptHackMoneyGain: { group: "hacking", harderWhen: LOWER },
  ServerGrowthRate: { group: "hacking", harderWhen: LOWER },
  ServerMaxMoney: { group: "hacking", harderWhen: LOWER },
  ServerStartingMoney: { group: "hacking", harderWhen: LOWER },
  ServerWeakenRate: { group: "hacking", harderWhen: LOWER },
  // More starting security is more weakening before the first batch lands.
  ServerStartingSecurity: { group: "hacking", harderWhen: HIGHER },

  HomeComputerRamCost: { group: "infra", harderWhen: HIGHER },
  CloudServerCost: { group: "infra", harderWhen: HIGHER },
  CloudServerSoftcap: { group: "infra", harderWhen: HIGHER },
  CloudServerLimit: { group: "infra", harderWhen: LOWER },
  CloudServerMaxRam: { group: "infra", harderWhen: LOWER },

  AgilityLevelMultiplier: { group: "skills", harderWhen: LOWER },
  CharismaLevelMultiplier: { group: "skills", harderWhen: LOWER },
  DefenseLevelMultiplier: { group: "skills", harderWhen: LOWER },
  DexterityLevelMultiplier: { group: "skills", harderWhen: LOWER },
  StrengthLevelMultiplier: { group: "skills", harderWhen: LOWER },
  ClassGymExpGain: { group: "skills", harderWhen: LOWER },

  CompanyWorkExpGain: { group: "career", harderWhen: LOWER },
  CompanyWorkMoney: { group: "career", harderWhen: LOWER },
  CompanyWorkRepGain: { group: "career", harderWhen: LOWER },
  CrimeExpGain: { group: "career", harderWhen: LOWER },
  CrimeMoney: { group: "career", harderWhen: LOWER },
  CrimeSuccessRate: { group: "career", harderWhen: LOWER },

  AugmentationMoneyCost: { group: "factions", harderWhen: HIGHER },
  AugmentationRepCost: { group: "factions", harderWhen: HIGHER },
  DaedalusAugsRequirement: { group: "factions", harderWhen: HIGHER },
  FavorToDonateToFaction: { group: "factions", harderWhen: HIGHER },
  FactionPassiveRepGain: { group: "factions", harderWhen: LOWER },
  FactionWorkExpGain: { group: "factions", harderWhen: LOWER },
  FactionWorkRepGain: { group: "factions", harderWhen: LOWER },

  CodingContractMoney: { group: "side", harderWhen: LOWER },
  InfiltrationMoney: { group: "side", harderWhen: LOWER },
  InfiltrationRep: { group: "side", harderWhen: LOWER },

  HacknetNodeMoney: { group: "hacknet", harderWhen: LOWER },

  FourSigmaMarketDataApiCost: { group: "stock", harderWhen: HIGHER },
  FourSigmaMarketDataCost: { group: "stock", harderWhen: HIGHER },

  GangSoftcap: { group: "gang", harderWhen: LOWER },
  GangUniqueAugs: { group: "gang", harderWhen: LOWER },

  CorporationDivisions: { group: "corp", harderWhen: LOWER },
  CorporationSoftcap: { group: "corp", harderWhen: LOWER },
  CorporationValuation: { group: "corp", harderWhen: LOWER },

  BladeburnerRank: { group: "bladeburner", harderWhen: LOWER },
  BladeburnerSkillCost: { group: "bladeburner", harderWhen: HIGHER },

  StaneksGiftPowerMultiplier: { group: "stanek", harderWhen: LOWER },
  StaneksGiftExtraSize: { group: "stanek", harderWhen: LOWER },

  GoPower: { group: "go", harderWhen: LOWER },

  DarknetMoneyMultiplier: { group: "darknet", harderWhen: LOWER },
  DarknetLabyrinthRewardsTheRedPill: { group: "darknet", harderWhen: LOWER },

  WorldDaemonDifficulty: { group: "endgame", harderWhen: HIGHER },
};

/** Facet for a field, with a safe fallback for one the table has not met. */
export function multiplierFacet(field: string): MultiplierFacet {
  return MULTIPLIER_FACETS[field] ?? { group: "endgame", harderWhen: LOWER };
}

export interface ChangedMultiplier {
  field: string;
  value: number;
  base: number;
  group: MultiplierGroup;
  harderWhen: "higher" | "lower";
  /** True when this node's value is worse for the run than BN1's. */
  harder: boolean;
}

/** Fields whose active value differs from the BN1 default. */
export function changedMultipliers(active: Readonly<Record<string, number>> | undefined): ChangedMultiplier[] {
  if (!active) return [];
  const changed: ChangedMultiplier[] = [];
  for (const [field, value] of Object.entries(active)) {
    const base = DEFAULT_BITNODE_MULTIPLIERS[field];
    if (base !== undefined && value === base) continue;
    const facet = multiplierFacet(field);
    const resolved = base ?? 1;
    changed.push({
      field,
      value,
      base: resolved,
      group: facet.group,
      harderWhen: facet.harderWhen,
      harder: facet.harderWhen === HIGHER ? value > resolved : value < resolved,
    });
  }
  return changed.sort((a, b) => (a.field < b.field ? -1 : 1));
}
