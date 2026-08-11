import type { Person, Server } from "@ns";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { staticsFromRolls } from "../../shared/strategy/bounds.ts";
import {
  calculateHackingChance,
  calculateHackingExpGain,
  calculatePercentMoneyHacked,
} from "../vendor/bitburner/src/Hacking.ts";
import { calculateSkill } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { numCycleForGrowthCorrected } from "../vendor/bitburner/src/Server/GrowthCycles.ts";
import { ServerConstants } from "../vendor/bitburner/src/Server/data/Constants.ts";
import { calculateGrowMoney } from "../vendor/bitburner/src/Server/formulas/grow.ts";
import { isPowerOfTwo } from "../vendor/bitburner/src/utils/helpers/isPowerOfTwo.ts";

/** Engine effect application, transcribed from bitburner-src v3.0.1 (the
 * originals reach into Player/AllServers singletons and can't be imported).
 * Every function cites its source; re-read the tag when bumping versions —
 * tools/vendor.ts's drift detection does NOT cover these. Formula math is
 * never transcribed: it comes from sim/vendor. */

/** A Server literal whose gameplay fields are guaranteed present. */
export type SimServer = Server &
  Required<
    Pick<
      Server,
      | "hackDifficulty"
      | "minDifficulty"
      | "baseDifficulty"
      | "moneyAvailable"
      | "moneyMax"
      | "requiredHackingSkill"
      | "serverGrowth"
      | "numOpenPortsRequired"
    >
  > & { simKind?: "Server" | "HacknetServer" | "DarknetServer" };

// v3.0.1 src/Server/Server.ts capDifficulty()/fortify()/weaken()
export function capDifficulty(server: SimServer): void {
  if (server.hackDifficulty < server.minDifficulty) server.hackDifficulty = server.minDifficulty;
  if (server.hackDifficulty < 1) server.hackDifficulty = 1;
  if (server.hackDifficulty > 100) server.hackDifficulty = 100;
}

export function fortify(server: SimServer, amt: number): void {
  server.hackDifficulty += amt;
  capDifficulty(server);
}

export function weakenServer(server: SimServer, amt: number): void {
  server.hackDifficulty -= amt;
  capDifficulty(server);
}

// v3.0.1 src/Server/ServerHelpers.ts getCoreBonus()/getWeakenEffect()
export function getCoreBonus(cores = 1): number {
  return 1 + (cores - 1) / 16;
}

export function getWeakenEffect(threads: number, cores: number): number {
  return ServerConstants.ServerWeakenAmount * threads * getCoreBonus(cores) * currentNodeMults.ServerWeakenRate;
}

// v3.0.1 src/PersonObjects/Person.ts gainHackingExp()
export function gainHackingExp(person: Person, exp: number): void {
  if (isNaN(exp)) return;
  person.exp.hacking += exp;
  if (person.exp.hacking < 0) person.exp.hacking = 0;
  person.skills.hacking = calculateSkill(
    person.exp.hacking,
    person.mults.hacking * currentNodeMults.HackingLevelMultiplier,
  );
}

export interface HackOutcome {
  success: boolean;
  moneyGained: number;
  /** Money removed from the SERVER, before `ScriptHackMoneyGain` takes the
   *  player's cut. Reported separately because stock manipulation rolls against
   *  THIS as a fraction of moneyMax (NetscriptHelpers.tsx:615) — in BN8 the cut
   *  is 0 and only this one is non-zero, which is why hacking still moves
   *  prices there while earning nothing. */
  moneyDrained: number;
  expGained: number;
}

// v3.0.1 src/Netscript/NetscriptHelpers.tsx hack() completion body. Chance and
// percent are computed HERE, at completion time, with post-delay server state —
// matching the game (not at action start).
export function applyHack(server: SimServer, person: Person, threads: number, rand: number): HackOutcome {
  const hackChance = calculateHackingChance(server, person);
  let expGainedOnSuccess = calculateHackingExpGain(server, person) * threads;
  const expGainedOnFailure = expGainedOnSuccess / 4;

  if (rand >= hackChance) {
    gainHackingExp(person, expGainedOnFailure);
    return { success: false, moneyGained: 0, moneyDrained: 0, expGained: expGainedOnFailure };
  }

  const percentHacked = calculatePercentMoneyHacked(server, person);
  let maxThreadNeeded = Math.ceil(1 / percentHacked);
  if (isNaN(maxThreadNeeded)) maxThreadNeeded = 1e6;

  let moneyDrained = server.moneyAvailable * percentHacked * threads;
  if (moneyDrained < 0) moneyDrained = 0;
  if (moneyDrained > server.moneyAvailable) moneyDrained = server.moneyAvailable;
  if (moneyDrained === 0) expGainedOnSuccess = expGainedOnFailure;

  server.moneyAvailable -= moneyDrained;
  if (server.moneyAvailable < 0) server.moneyAvailable = 0;

  const moneyGained = moneyDrained * currentNodeMults.ScriptHackMoneyGain;
  gainHackingExp(person, expGainedOnSuccess);
  fortify(server, ServerConstants.ServerFortifyAmount * Math.min(threads, maxThreadNeeded));
  // moneyDrained is reported alongside moneyGained because stock manipulation
  // rolls against the DRAINED fraction, before ScriptHackMoneyGain is applied
  // (NetscriptHelpers.tsx:615). In BN8 the two differ absolutely: gained is 0
  // and drained is not, which is why hacking still moves prices there.
  return { success: true, moneyGained, moneyDrained, expGained: expGainedOnSuccess };
}

export interface GrowOutcome {
  growth: number;
  /** `moneyAfter - moneyBefore` (NetscriptFunctions.ts:306). The grow-side stock
   *  influence rolls against this as a fraction of moneyMax. */
  moneyGrown: number;
  expGained: number;
}

// v3.0.1 src/Server/ServerHelpers.ts processSingleServerGrowth() (person passed
// explicitly instead of the Player singleton) + the exp gain from
// src/NetscriptFunctions.ts grow() completion.
export function applyGrow(server: SimServer, person: Person, threads: number, cores = 1): GrowOutcome {
  const oldMoneyAvailable = server.moneyAvailable;
  server.moneyAvailable = calculateGrowMoney(server, threads, person, cores);

  if (oldMoneyAvailable !== server.moneyAvailable) {
    let usedCycles = numCycleForGrowthCorrected(server, server.moneyAvailable, oldMoneyAvailable, cores, person);
    usedCycles = Math.min(Math.max(0, Math.ceil(usedCycles)), threads);
    fortify(server, 2 * ServerConstants.ServerFortifyAmount * usedCycles);
  }

  const expGained = calculateHackingExpGain(server, person) * threads;
  gainHackingExp(person, expGained);

  let growth: number;
  if (server.moneyAvailable === 0 && oldMoneyAvailable === 0) growth = 1;
  else if (oldMoneyAvailable === 0) growth = server.moneyAvailable;
  else growth = server.moneyAvailable / oldMoneyAvailable;
  return { growth, moneyGrown: server.moneyAvailable - oldMoneyAvailable, expGained };
}

export interface WeakenOutcome {
  securityReduced: number;
  expGained: number;
}

// v3.0.1 src/NetscriptFunctions.ts weaken() completion body.
export function applyWeaken(server: SimServer, person: Person, threads: number, cores = 1): WeakenOutcome {
  const before = server.hackDifficulty;
  weakenServer(server, getWeakenEffect(threads, cores));
  const expGained = calculateHackingExpGain(server, person) * threads;
  gainHackingExp(person, expGained);
  return { securityReduced: before - server.hackDifficulty, expGained };
}

// v3.0.1 src/Server/ServerPurchases.ts getCloudServerCost()/-Limit()/-MaxRam()
export function getCloudServerMaxRam(): number {
  const ram = Math.round(ServerConstants.CloudServerMaxRam * currentNodeMults.CloudServerMaxRam);
  return 1 << (31 - Math.clz32(ram));
}

export function getCloudServerLimit(): number {
  return Math.round(ServerConstants.CloudServerLimit * currentNodeMults.CloudServerLimit);
}

export function getCloudServerCost(ram: number): number {
  const sanitizedRam = Math.round(ram);
  if (isNaN(sanitizedRam) || !isPowerOfTwo(sanitizedRam) || !(Math.sign(sanitizedRam) === 1)) return Infinity;
  if (sanitizedRam > getCloudServerMaxRam()) return Infinity;
  const upg = Math.max(0, Math.log(sanitizedRam) / Math.log(2) - 6);
  return (
    sanitizedRam *
    ServerConstants.BaseCostFor1GBOfRamServer *
    currentNodeMults.CloudServerCost *
    Math.pow(currentNodeMults.CloudServerSoftcap, upg)
  );
}

export function getCloudServerUpgradeCost(currentRam: number, targetRam: number): number {
  if (targetRam <= currentRam) return -1;
  const target = getCloudServerCost(targetRam);
  if (!Number.isFinite(target)) return -1;
  return target - getCloudServerCost(currentRam);
}

// v3.0.1 src/PersonObjects/Player/PlayerObjectServerMethods.ts
// getUpgradeHomeRamCost() (currentRam passed instead of getHomeComputer()).
export function getUpgradeHomeRamCost(currentRam: number): number {
  const numUpgrades = Math.log2(currentRam);
  const mult = Math.pow(1.58, numUpgrades);
  return currentRam * ServerConstants.BaseCostFor1GBOfRamHome * mult * currentNodeMults.HomeComputerRamCost;
}

export function getUpgradeHomeCoresCost(currentCores: number): number {
  return 1e9 * Math.pow(7.5, currentCores);
}

// v3.0.1 src/Server/Server.ts constructor — how metadata base values derive
// the live fields at world creation.
export interface ServerSpec {
  hostname: string;
  organizationName?: string;
  hackDifficulty: number;
  moneyAvailable: number;
  requiredHackingSkill: number;
  serverGrowth: number;
  numOpenPortsRequired: number;
  maxRam: number;
  cpuCores?: number;
  /** Explicit live save-state overrides. The roll fields above still derive
   * base/min/max exactly as the upstream constructor does. */
  currentDifficulty?: number;
  currentMoney?: number;
  simKind?: SimServer["simKind"];
}

export function serverFromSpec(spec: ServerSpec, base: SimServer): SimServer {
  // The constructor derivations (25x money, the difficulty cap, the /3 min
  // clamp) live in ONE transcription — shared/strategy/bounds.ts — so a
  // vendor bump cannot desynchronize the sim's world from the prune bounds
  // and the band table. Only the live starting money stays local.
  const statics = staticsFromRolls(
    spec.hostname,
    {
      money: spec.moneyAvailable,
      sec: spec.hackDifficulty,
      skill: spec.hostname === "w0r1d_d43m0n"
        ? spec.requiredHackingSkill * currentNodeMults.WorldDaemonDifficulty
        : spec.requiredHackingSkill,
      growth: spec.serverGrowth,
    },
    { ServerMaxMoney: currentNodeMults.ServerMaxMoney, ServerStartingSecurity: currentNodeMults.ServerStartingSecurity },
  );
  base.hostname = spec.hostname;
  base.simKind = spec.simKind ?? "Server";
  base.organizationName = spec.organizationName ?? "";
  base.maxRam = spec.maxRam;
  base.cpuCores = spec.cpuCores ?? 1;
  base.requiredHackingSkill = statics.requiredHackingSkill;
  base.moneyAvailable = spec.currentMoney
    ?? spec.moneyAvailable * currentNodeMults.ServerStartingMoney;
  base.moneyMax = statics.moneyMax;
  base.hackDifficulty = spec.currentDifficulty ?? statics.baseDifficulty;
  base.baseDifficulty = statics.baseDifficulty;
  base.minDifficulty = statics.minDifficulty;
  base.serverGrowth = statics.serverGrowth;
  base.numOpenPortsRequired = spec.numOpenPortsRequired;
  capDifficulty(base);
  base.moneyAvailable = Math.max(0, Math.min(base.moneyMax, base.moneyAvailable));
  return base;
}
