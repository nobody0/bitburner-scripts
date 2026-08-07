import type { Person, Server } from "@ns";
import { defaultMultipliers } from "../vendor/bitburner/src/PersonObjects/Multipliers.ts";

/** Plain-object Server/Person literals shaped like @nsdefs, seeded from the
 * game's own ns.formulas.mockServer()/mockPerson() templates
 * (bitburner-src v3.0.1 src/NetscriptFunctions/Formulas.ts). The vendored
 * formulas read only these shapes — no game classes needed. */

export function mockServer(overrides: Partial<Server> = {}): Server {
  return {
    cpuCores: 1,
    ftpPortOpen: false,
    hasAdminRights: false,
    hostname: "",
    httpPortOpen: false,
    ip: "",
    isConnectedTo: false,
    maxRam: 0,
    organizationName: "",
    ramUsed: 0,
    smtpPortOpen: false,
    sqlPortOpen: false,
    sshPortOpen: false,
    purchasedByPlayer: false,
    backdoorInstalled: false,
    baseDifficulty: 0,
    hackDifficulty: 0,
    minDifficulty: 0,
    moneyAvailable: 0,
    moneyMax: 0,
    numOpenPortsRequired: 0,
    openPortCount: 0,
    requiredHackingSkill: 0,
    serverGrowth: 0,
    ...overrides,
  };
}

export function mockPerson(overrides: Partial<Person> = {}): Person {
  return {
    hp: { current: 10, max: 10 },
    skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    exp: { hacking: 0, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 },
    mults: defaultMultipliers(),
    city: "Sector-12" as Person["city"],
    ...overrides,
  };
}
