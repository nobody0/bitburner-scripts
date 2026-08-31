import type { PlayerRequirement } from "@ns";
import type { Clock } from "../clock.ts";
import type { SimPlayer } from "../core/player.ts";
import type { CrimeSystem } from "../features/crime.ts";
import type { FactionSystem } from "../features/factions.ts";
import type { GraftingSystem } from "../features/grafting.ts";
import type { EducationSystem } from "../features/education.ts";
import type { ProgramSystem } from "../features/programs.ts";
import type { CompanySystem } from "../features/companies.ts";
import { satisfiesAll, type SatisfyContext } from "../features/requirements.ts";
import { unmodeled } from "../realm/unmodeled.ts";
import type { SimWorld } from "../world.ts";
import { AUGMENTATION_TABLE } from "../vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { FACTION_TABLE } from "../vendor/bitburner/src/Faction/FactionTable.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { FactionName } from "../vendor/bitburner/src/Faction/Enums.ts";
import { CityName, LocationName } from "../vendor/bitburner/src/Locations/Enums.ts";
import { CompanyName } from "../vendor/bitburner/src/Company/Enums.ts";
import { JobField, JobName } from "../vendor/bitburner/src/Work/Enums.ts";
import { AugmentationName } from "../vendor/bitburner/src/Augmentation/Enums.ts";
import { calculateHackingTime } from "../vendor/bitburner/src/Hacking.ts";
import { getUpgradeHomeRamCost } from "../core/effects.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";
import { nsString, resolveServer } from "./contracts.ts";

/** The `ns.singularity` namespace, plus `ns.getFavorToDonate` and `ns.enums`.
 *
 * Every failure condition is modelled with its REAL return. That distinction
 * is load-bearing for this project: the strategy treats a `false` from
 * `purchaseAugmentation` as a decision outcome and reports it, so a simulator
 * that threw instead would exercise a code path the game never takes — and one
 * that returned `true` unconditionally would let a broken planner look
 * perfect.
 *
 * What is NOT modelled reports through `unmodeled()` and throws, never a
 * plausible-looking zero. */

export interface SingularityDeps {
  /** Called after DarkscapeNavigator.exe lands, so the darknet is generated
   *  exactly as upstream's purchase hook does it. */
  onDarknetUnlocked?: () => void;
  world: SimWorld;
  player: SimPlayer;
  factions: FactionSystem;
  clock: Clock;
  bitNode: number;
  /** Current hostname of the terminal's connection, for backdoors. */
  terminal: { host: string };
  /** The actual server graph. Singularity.connect is a terminal hop, not a teleport. */
  network: Map<string, string[]>;
  crimes: CrimeSystem;
  grafting?: GraftingSystem;
  education?: EducationSystem;
  programs?: ProgramSystem;
  companies?: CompanySystem;
  satisfyContext(): SatisfyContext;
  /** Poke the engine's invitation counter, as the real call does. */
  pokeInvitationCounter(): void;
  /** Files on home, so a bought program becomes visible to `ns.ls`. */
  homeFiles(): Set<string>;
  hasTor(): boolean;
  setTor(value: boolean): void;
  /** Explicit world-generation rolls for augmentations whose multipliers are
   * randomized at load time. Absent values remain unmodeled. */
  augmentationStats?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  assertPrestigeSupported?(): void;
  onPrestige?: (cbScript: string | undefined, newlyInstalled: ReadonlyMap<string, number>) => void;
  /** Terminal BitNode transition. The simulator stops at this boundary; the
   * next BitNode is a separate scenario, just as augmentation prestige is a
   * separate controller epoch. */
  onBitNodeComplete?: (
    nextBitNode: number,
    cbScript: string | undefined,
    options: SimBitNodeOptions,
  ) => void;
}

export interface SimBitNodeOptions {
  sourceFileOverrides: Map<number, number>;
  intelligenceOverride: number | undefined;
  restrictHomePCUpgrade: boolean;
  disableGang: boolean;
  disableCorporation: boolean;
  disableBladeburner: boolean;
  disable4SData: boolean;
  disableHacknetServer: boolean;
  disableSleeveExpAndAugmentation: boolean;
}

/** Darkweb inventory @ v3.0.1 (src/DarkWeb/DarkWebItems.ts). It is kept in
 * declaration order because getDarkwebPrograms
 * exposes that order. */
const DARKWEB_PRICES: Record<string, number> = {
  "BruteSSH.exe": 500_000,
  "FTPCrack.exe": 1_500_000,
  "relaySMTP.exe": 5_000_000,
  "HTTPWorm.exe": 30_000_000,
  "SQLInject.exe": 250_000_000,
  "ServerProfiler.exe": 500_000,
  "DeepscanV1.exe": 500_000,
  "DeepscanV2.exe": 25_000_000,
  "AutoLink.exe": 1_000_000,
  "DarkscapeNavigator.exe": 50_000_000,
  "Formulas.exe": 5_000_000_000,
};

function darkwebItem(name: string): [string, number] | undefined {
  const lower = name.toLowerCase();
  return Object.entries(DARKWEB_PRICES).find(([program]) => program.toLowerCase() === lower);
}

/** The 1.9^queued escalation, restricted to non-SoA augmentations.
 *
 * THESE NAMES MUST MATCH THE TABLE EXACTLY. Every one of them used to be
 * written without the prefix the game actually ships ("Might of Ares" rather
 * than "SoA - Might of Ares"), so the set matched nothing: the SoA branch in
 * `priceOf` was dead, and `queuedNonSoA` counted SoA augmentations it was
 * written to exclude. Both directions were wrong — SoA augs were priced with
 * the generic 1.9^queued x AugmentationMoneyCost formula the game does not
 * apply to them, and a queued SoA aug inflated the NEXT NeuroFlux purchase by
 * 1.9x. A miss is silent by construction, which is why the parity suite now
 * asserts every name resolves.
 * Source: src/Augmentation/Enums.ts:139-147 */
export const SOA_SET = new Set([
  "SoA - Beauty of Aphrodite",
  "SoA - Chaos of Dionysus",
  "SoA - Flood of Poseidon",
  "SoA - Hunt of Artemis",
  "SoA - Knowledge of Apollo",
  "SoA - Might of Ares",
  "SoA - Trickery of Hermes",
  "SoA - Wisdom of Athena",
  "SoA - phyzical WKS harmonizer",
]);

export interface SingularityNamespace {
  singularity: Record<string, unknown>;
  grafting: Record<string, unknown>;
  getFavorToDonate: () => number;
  enums: Record<string, unknown>;
  /** Process-aware adapter used by makeSimNs so a script kill cancels the
   * same delay that gates the world mutation. */
  installBackdoorWithDelay: (delay: (ms: number) => Promise<void>) => Promise<void>;
}

export function makeSingularity(deps: SingularityDeps): SingularityNamespace {
  const { world, player, factions, clock } = deps;
  const connectTorRoot = (): void => {
    const darkweb = world.servers.get("darkweb");
    if (!darkweb || darkweb.simKind !== "DarknetServer") {
      return unmodeled(
        "subsystem",
        "darkweb root",
        "purchaseTor requires the always-present v3.0.1 DarknetServer and its network edge",
      );
    }
    const homeLinks = deps.network.get("home") ?? [];
    const darkwebLinks = deps.network.get("darkweb") ?? [];
    if (!homeLinks.includes("darkweb")) homeLinks.push("darkweb");
    if (!darkwebLinks.includes("home")) darkwebLinks.push("home");
    deps.network.set("home", homeLinks);
    deps.network.set("darkweb", darkwebLinks);
  };
  const requireSingularityAccess = (): void => {
    if (deps.bitNode === 4 || (player.sourceFiles["4"] ?? 0) > 0) return;
    throw new Error(
      "You do not currently have access to the Singularity API. This is either because you are not in BitNode 4 or because you do not have Source-File 4",
    );
  };
  const validateBitNodeOptions = (raw: unknown): SimBitNodeOptions => {
    const defaults: SimBitNodeOptions = {
      sourceFileOverrides: new Map(),
      intelligenceOverride: undefined,
      restrictHomePCUpgrade: false,
      disableGang: false,
      disableCorporation: false,
      disableBladeburner: false,
      disable4SData: false,
      disableHacknetServer: false,
      disableSleeveExpAndAugmentation: false,
    };
    if (raw == null) return defaults;
    if (typeof raw !== "object") {
      throw new Error(`bitNodeOptions must be an object if it's specified. It was ${String(raw)}.`);
    }
    const options = raw as Record<string, unknown>;
    if (!(options["sourceFileOverrides"] instanceof Map)) {
      throw new Error("sourceFileOverrides must be a Map.");
    }
    const overrides = options["sourceFileOverrides"] as Map<unknown, unknown>;
    for (const [rawNumber, rawLevel] of overrides) {
      if (typeof rawNumber !== "number" || !Number.isInteger(rawNumber) || rawNumber < 1 || rawNumber > 15) {
        throw new Error(`sourceFileOverrides is invalid. Reason: Invalid BitNode: ${String(rawNumber)}.`);
      }
      if (typeof rawLevel !== "number" || !Number.isFinite(rawLevel)) {
        throw new Error(`sourceFileOverrides is invalid. Reason: Invalid SF level: ${String(rawLevel)}.`);
      }
      const maxLevel = player.ownedSourceFiles[String(rawNumber)] ?? 0;
      if (rawLevel > maxLevel) {
        throw new Error(
          `sourceFileOverrides is invalid. Reason: Invalid SF level: ${rawLevel}. Max level: ${maxLevel}.`,
        );
      }
      defaults.sourceFileOverrides.set(rawNumber, rawLevel);
    }
    if (options["intelligenceOverride"] !== undefined) {
      const value = typeof options["intelligenceOverride"] === "string"
        ? Number.parseFloat(options["intelligenceOverride"])
        : options["intelligenceOverride"];
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`intelligenceOverride must be a positive integer, was ${String(value)}`);
      }
      defaults.intelligenceOverride = value;
    }
    defaults.restrictHomePCUpgrade = !!options["restrictHomePCUpgrade"];
    defaults.disableGang = !!options["disableGang"];
    defaults.disableCorporation = !!options["disableCorporation"];
    defaults.disableBladeburner = !!options["disableBladeburner"];
    defaults.disable4SData = !!options["disable4SData"];
    defaults.disableHacknetServer = !!options["disableHacknetServer"];
    defaults.disableSleeveExpAndAugmentation = !!options["disableSleeveExpAndAugmentation"];
    return defaults;
  };
  const requireGraftingAccess = (): void => {
    if (deps.bitNode === 10 || (player.sourceFiles["10"] ?? 0) > 0) return;
    throw new Error(
      "You do not currently have access to the Grafting API. This is either because you are not in BitNode 10 or because you do not have Source-File 10",
    );
  };

  const queuedNonSoA = (): number =>
    [...player.queuedAugmentations].reduce(
      (total, [name, purchases]) => total + (SOA_SET.has(name) ? 0 : purchases),
      0,
    );

  /** `getFactionAugmentationsFiltered` (FactionHelpers.tsx:172-206): which
   * augmentations a faction actually offers right now.
   *
   * Shared by the listing AND the purchase, because upstream gates both and the
   * sim used to filter only the listing — so a BN15 run could still buy The Red
   * Pill from Daedalus and finish the node by a route the game forbids. BN15's
   * whole design is that it comes out of the darknet labyrinth instead. */
  const offersAugmentation = (faction: string, augName: string): boolean => {
    const aug = AUGMENTATION_TABLE[augName];
    if (!aug?.factions.includes(faction)) return false;
    return !(deps.bitNode === 15 && faction === "Daedalus" && augName === "The Red Pill");
  };

  const priceOf = (name: string): { moneyCost: number; repCost: number } => {
    const aug = AUGMENTATION_TABLE[name];
    if (!aug) return { moneyCost: Infinity, repCost: Infinity };
    const sf11 = Math.min(3, Math.max(0, player.sourceFiles["11"] ?? 0));
    const genericBase = CONSTANTS.MultipleAugMultiplier * [1, 0.96, 0.94, 0.93][sf11]!;
    const generic = Math.pow(genericBase, queuedNonSoA());
    if (name === "NeuroFlux Governor") {
      const level = (player.augmentations.get(name) ?? 0) + (player.queuedAugmentations.get(name) ?? 0);
      const multiplier = Math.pow(CONSTANTS.NeuroFluxGovernorLevelMult, level);
      return {
        repCost: aug.baseRepRequirement * multiplier * currentNodeMults.AugmentationRepCost,
        moneyCost: aug.baseCost * multiplier * currentNodeMults.AugmentationMoneyCost * generic,
      };
    }
    if (SOA_SET.has(name)) {
      // hasAugmentation defaults ignoreQueued = false (Person.ts:233-241), so
      // an SoA aug bought earlier this install cycle already raises the price
      // of the next one: two in one cycle cost base + 7*base, not 2*base.
      const ownedSoA = [...SOA_SET].filter(
        (entry) => player.augmentations.has(entry) || player.queuedAugmentations.has(entry),
      ).length;
      return {
        moneyCost: aug.baseCost * Math.pow(CONSTANTS.SoACostMult, ownedSoA),
        repCost: aug.baseRepRequirement * Math.pow(CONSTANTS.SoARepMult, ownedSoA),
      };
    }
    return {
      moneyCost: aug.baseCost * generic * currentNodeMults.AugmentationMoneyCost,
      repCost: aug.baseRepRequirement * currentNodeMults.AugmentationRepCost,
    };
  };

  const favorToDonate = (): number => Math.floor(150 * currentNodeMults.FavorToDonateToFaction);

  const installBackdoorWithDelay = async (delay: (ms: number) => Promise<void>): Promise<void> => {
    requireSingularityAccess();
    const server = world.servers.get(deps.terminal.host);
    if (!server) throw new Error(`installBackdoor: server '${deps.terminal.host}' does not exist`);
    // A DARKNET backdoor skips both gates and takes a flat four seconds:
    // `calculateHackingTime` returns 16 for a DarknetServer outright
    // (`Hacking.ts:60-61`) and the install is a quarter of it, so there is no
    // hacking-skill requirement and no root requirement to check. That is what
    // makes it cheap enough to be worth spending the free allowance on, and why
    // the only thing that limits it is the `1.07 ^ surplus` tax the darknet
    // system charges every authentication once the allowance is gone.
    if (server.simKind === "DarknetServer") {
      await delay((16 * 1000) / 4);
      server.backdoorInstalled = true;
      world.emit({ kind: "event", name: "backdoor", data: { host: server.hostname } });
      return;
    }
    if (server.purchasedByPlayer) throw new Error("installBackdoor: cannot backdoor a purchased server");
    if (!server.hasAdminRights) throw new Error(`installBackdoor: no root access on '${server.hostname}'`);
    if (world.person.skills.hacking < (server.requiredHackingSkill ?? 0)) {
      throw new Error(`installBackdoor: hacking level is too low for '${server.hostname}'`);
    }
    const ms = (calculateHackingTime(server, world.person) * 1000) / 4;
    await delay(ms);
    server.backdoorInstalled = true;
    deps.pokeInvitationCounter();
    world.emit({ kind: "event", name: "backdoor", data: { host: server.hostname } });
  };

  const singularity: Record<string, unknown> = {
    // --- factions -----------------------------------------------------
    getFactionRep: (rawName: unknown): number => factions.get(factionName(rawName))?.rep ?? 0,
    getFactionFavor: (rawName: unknown): number => factions.get(factionName(rawName))?.favor ?? 0,
    getFactionEnemies: (rawName: unknown): string[] => factions.enemies(factionName(rawName)),

    getFactionWorkTypes: (rawName: unknown): string[] => {
      const name = factionName(rawName);
      // Load-bearing, not decoration: the planner refuses to work a type a
      // faction does not offer, so an empty or fabricated answer here would
      // make every faction unworkable (or make the sim disagree with the game
      // about which types are valid).
      const offers = factions.offersWork(name);
      const out: string[] = [];
      if (offers.hacking) out.push("hacking");
      if (offers.field) out.push("field");
      if (offers.security) out.push("security");
      return out;
    },
    getFactionInviteRequirements: (rawName: unknown): PlayerRequirement[] => factions.requirements(factionName(rawName)),

    checkFactionInvitations: (): string[] => {
      // The real call re-checks immediately rather than waiting out the 2 s
      // cycle, by resetting the engine counter. Reproduced so a driver that
      // calls it right after satisfying a requirement sees the invitation.
      deps.pokeInvitationCounter();
      factions.checkInvitations((requirements) => satisfiesAll(requirements, deps.satisfyContext()));
      return [...player.factionInvitations];
    },

    joinFaction: (rawName: unknown): boolean => {
      const name = factionName(rawName);
      const joined = factions.join(name);
      if (joined) world.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain * 5);
      return joined;
    },

    workForFaction: (rawName: unknown, rawType: unknown, focus = true): boolean => {
      const name = factionName(rawName);
      const type = nsString("workType", rawType);
      if (type !== "hacking" && type !== "field" && type !== "security") {
        throw new Error(`Invalid faction work type: '${type}'`);
      }
      const faction = factions.get(name);
      if (!faction || !faction.joined) return false;
      const offers = factions.offersWork(name);
      const key = type;
      if (!offers[key as keyof typeof offers]) return false;
      // Silently CANCELS whatever was running — the single most important
      // behaviour for the strategy's continuation guard to be tested against.
      player.startWork({
        kind: "faction",
        subject: name,
        workType: key,
        startedAt: clock.now(),
        cyclesWorked: 0,
        focused: focus,
      });
      player.focus = focus;
      world.emit({ kind: "event", name: "faction.work", data: { faction: name, type: key, focus } });
      return true;
    },

    // --- crime --------------------------------------------------------
    commitCrime: (type: string, focus = true): number => deps.crimes.start(type, focus),

    getCrimeChance: (type: string): number => {
      const crime = deps.crimes.get(type);
      if (!crime) throw new Error(`Invalid crime: '${type}'`);
      return deps.crimes.successChance(crime);
    },

    getCrimeStats: (type: string): Record<string, unknown> => {
      const crime = deps.crimes.get(type);
      if (!crime) throw new Error(`Invalid crime: '${type}'`);
      const mults = world.person.mults as unknown as Record<string, number>;
      return {
        // Object.assign({}, crime, calculateCrimeWorkStats(...)) leaves karma
        // positive and returns multiplier-adjusted money and experience.
        // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L1068-L1090
        difficulty: crime.difficulty,
        karma: crime.karma,
        kills: crime.kills,
        money: crime.money * (mults["crime_money"] ?? 1) * currentNodeMults.CrimeMoney,
        time: crime.timeMs,
        type: crime.type,
        hacking_exp: (crime.exp["hacking"] ?? 0) * (mults["hacking_exp"] ?? 1) * currentNodeMults.CrimeExpGain,
        strength_exp: (crime.exp["strength"] ?? 0) * (mults["strength_exp"] ?? 1) * currentNodeMults.CrimeExpGain,
        defense_exp: (crime.exp["defense"] ?? 0) * (mults["defense_exp"] ?? 1) * currentNodeMults.CrimeExpGain,
        dexterity_exp: (crime.exp["dexterity"] ?? 0) * (mults["dexterity_exp"] ?? 1) * currentNodeMults.CrimeExpGain,
        agility_exp: (crime.exp["agility"] ?? 0) * (mults["agility_exp"] ?? 1) * currentNodeMults.CrimeExpGain,
        charisma_exp: (crime.exp["charisma"] ?? 0) * (mults["charisma_exp"] ?? 1) * currentNodeMults.CrimeExpGain,
        intelligence_exp: (crime.exp["intelligence"] ?? 0) * currentNodeMults.CrimeExpGain,
      };
    },

    isFocused: (): boolean => player.focus,

    setFocus: (value: boolean): boolean => {
      // THROWS when not working, rather than returning false — the one
      // singularity call in this feature's path that does.
      if (!player.currentWork) throw new Error("setFocus: not currently working");
      player.focus = value;
      if (player.currentWork) player.currentWork.focused = value;
      return true;
    },

    stopAction: (): boolean => {
      return player.stopWork();
    },

    universityCourse: (universityName: string, courseName: string, focus = true): boolean =>
      deps.education?.universityCourse(universityName, courseName, focus)
        ?? unmodeled("subsystem", "education", "class work was invoked without an education system"),

    gymWorkout: (gymName: string, stat: string, focus = true): boolean =>
      deps.education?.gymWorkout(gymName, stat, focus)
        ?? unmodeled("subsystem", "education", "gym work was invoked without an education system"),

    // --- companies ----------------------------------------------------
    getCompanyPositions: (companyName: string): string[] => {
      const companies = deps.companies
        ?? unmodeled("subsystem", "companies", "company positions were requested without a company system");
      return companies.positions(companyName);
    },

    getCompanyPositionInfo: (companyName: string, positionName: string): Record<string, unknown> => {
      const companies = deps.companies
        ?? unmodeled("subsystem", "companies", "company position info was requested without a company system");
      return companies.positionInfo(companyName, positionName);
    },

    workForCompany: (companyName: string, focus = true): boolean => {
      const companies = deps.companies
        ?? unmodeled("subsystem", "companies", "company work was started without a company system");
      return companies.startWork(companyName, focus);
    },

    applyToCompany: (companyName: string, field: string): string | null => {
      const companies = deps.companies
        ?? unmodeled("subsystem", "companies", "a company application was made without a company system");
      return companies.apply(companyName, field);
    },

    quitJob: (companyName: string): void => {
      const companies = deps.companies
        ?? unmodeled("subsystem", "companies", "a company job was quit without a company system");
      companies.quit(companyName);
    },

    getCompanyRep: (companyName: string): number => {
      const companies = deps.companies
        ?? unmodeled("subsystem", "companies", "company reputation was requested without a company system");
      return companies.rep(companyName);
    },

    getCompanyFavor: (companyName: string): number => {
      const companies = deps.companies
        ?? unmodeled("subsystem", "companies", "company favor was requested without a company system");
      return companies.favor(companyName);
    },

    createProgram: (name: string, focus = true): boolean =>
      deps.programs?.start(name, focus)
        ?? unmodeled("subsystem", "programs", "program creation was invoked without a program system"),

    getCurrentWork: (): unknown => {
      const work = player.currentWork;
      if (!work) return null;
      return {
        type: work.kind === "faction"
          ? "FACTION"
          : work.kind === "graft"
            ? "GRAFTING"
            : work.kind === "createProgram"
              ? "CREATE_PROGRAM"
              : work.kind.toUpperCase(),
        factionName: work.kind === "faction" ? work.subject : undefined,
        companyName: work.kind === "company" ? work.subject : undefined,
        crimeType: work.kind === "crime" ? work.subject : undefined,
        factionWorkType: work.workType,
        classType: work.kind === "class" ? work.subject : undefined,
        programName: work.kind === "createProgram" ? work.subject : undefined,
        cyclesWorked: work.cyclesWorked,
        nextCompletion: work.nextCompletion,
      };
    },

    donateToFaction: (rawName: unknown, amount: number): boolean =>
      factions.donate(factionName(rawName), amount, favorToDonate()) > 0,

    travelToCity: (city: string): boolean => {
      // Invalid enum input throws; valid travel costs $200k and insufficient
      // funds returns false.
      // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L378-L405
      const cost = 200_000;
      if (!Object.values(CityName).includes(city as never)) throw new Error(`Invalid city name: '${city}'`);
      if (player.money < cost) return false;
      player.money -= cost;
      world.recordMoney("other", -cost);
      player.city = city;
      world.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain / 50_000);
      world.emit({ kind: "event", name: "travel", data: { city } });
      return true;
    },

    // --- augmentations ------------------------------------------------
    getOwnedAugmentations: (includeQueued = false): string[] => player.ownedAugmentations(includeQueued),

    // Does NOT require membership upstream (Singularity.ts:128-133) — and it
    // must not, or the planner could never value a faction it has not joined
    // and would have no basis for choosing which to join.
    getAugmentationsFromFaction: (rawName: unknown): string[] => {
      const name = factionName(rawName);
      return Object.values(AUGMENTATION_TABLE)
        .filter((aug) => offersAugmentation(name, aug.name))
        .map((aug) => aug.name);
    },

    getAugmentationPrice: (rawName: unknown): number => priceOf(augmentationName(rawName)).moneyCost,
    getAugmentationRepReq: (rawName: unknown): number => priceOf(augmentationName(rawName)).repCost,
    getAugmentationPrereq: (rawName: unknown): string[] => [...AUGMENTATION_TABLE[augmentationName(rawName)]!.prereqs],
    getAugmentationStats: (rawName: unknown): Record<string, number> => {
      const name = augmentationName(rawName);
      const aug = AUGMENTATION_TABLE[name]!;
      // A randomised augmentation has no stable stats to report. Reporting
      // the empty placeholder would be a fabricated value; this is the one
      // place the simulator must refuse rather than guess.
      if (aug?.multsUnknown) {
        const rolled = deps.augmentationStats?.[name];
        if (rolled) return { ...rolled };
        unmodeled("ns", "singularity.getAugmentationStats", `${name} randomises its multipliers at load time`);
      }
      return { ...(aug?.mults ?? {}) };
    },

    purchaseAugmentation: (rawFactionName: unknown, rawAugName: unknown): boolean => {
      const factionKey = factionName(rawFactionName);
      const augName = augmentationName(rawAugName);
      const faction = factions.get(factionKey);
      const aug = AUGMENTATION_TABLE[augName]!;
      if (!faction?.joined) return false;
      if (!offersAugmentation(factionKey, augName)) return false;
      if (player.hasAugmentation(augName) && augName !== "NeuroFlux Governor") return false;
      // Prerequisites must be owned or queued.
      if (aug.prereqs.some((prereq) => !player.hasAugmentation(prereq))) return false;
      const { moneyCost, repCost } = priceOf(augName);
      if (faction.rep < repCost) return false;
      if (player.money < moneyCost) return false;
      player.money -= moneyCost;
      world.recordMoney("augmentations", -moneyCost);
      player.queuedAugmentations.set(augName, (player.queuedAugmentations.get(augName) ?? 0) + 1);
      world.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain * 10);
      world.emit({ kind: "event", name: "aug.purchased", data: { faction: factionKey, augmentation: augName, cost: moneyCost } });
      return true;
    },

    installAugmentations: (cbScript?: string): boolean => {
      if (player.queuedAugmentations.size === 0) return false;
      deps.assertPrestigeSupported?.();
      const newlyInstalled = new Map(player.queuedAugmentations);
      world.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain * 10);
      // Reputation banks into favor HERE and nowhere else — the reason a
      // donation-gated faction is a reset decision rather than a wait.
      factions.prestigeAugmentation();
      deps.companies?.prestigeAugmentation();
      for (const [name, level] of player.queuedAugmentations) {
        player.augmentations.set(name, (player.augmentations.get(name) ?? 0) + level);
      }
      player.queuedAugmentations.clear();
      player.stopWork();
      world.emit({ kind: "event", name: "aug.installed", data: { count: player.augmentations.size } });
      deps.onPrestige?.(cbScript, newlyInstalled);
      return true;
    },

    // --- darkweb ------------------------------------------------------
    //
    // Port-opener programs are modelled because without them the faction
    // ladder is unreachable: CSEC needs one open port, so no BruteSSH means no
    // root, no backdoor, and CyberSec can never be joined. Prices are the
    // game's darkweb prices (src/DarkWeb/DarkWebItems.ts @ v3.0.1).
    purchaseTor: (): boolean => {
      if (deps.hasTor()) {
        connectTorRoot();
        return true;
      }
      if (player.money < 200_000) return false;
      // Validate the modeled world before mutating money. A missing darkweb
      // root is incomplete simulator state, not a failed in-game purchase.
      connectTorRoot();
      player.money -= 200_000;
      world.recordMoney("other", -200_000);
      deps.setTor(true);
      world.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain / 500);
      return true;
    },

    purchaseProgram: (rawName: unknown): boolean => {
      if (!deps.hasTor()) return false;
      const name = nsString("programName", rawName);
      const item = darkwebItem(name);
      if (!item) return false;
      const [program, cost] = item;
      if (deps.homeFiles().has(program)) return true;
      if (player.money < cost) return false;
      // Upstream pushes the completed file before cancelling matching work;
      // its finish hook therefore does not leave a stale partial file.
      deps.homeFiles().add(program);
      if (player.currentWork?.kind === "createProgram" && player.currentWork.subject === program) {
        player.stopWork(true);
      }
      player.money -= cost;
      world.recordMoney("other", -cost);
      // Upstream calls populateDarknet() right here, so the program is not just
      // a file: it brings a darknet into existence. Without this the purchase
      // would change nothing observable and could not be tested.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L458-L460
      if (program === "DarkscapeNavigator.exe") deps.onDarknetUnlocked?.();
      world.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain / 5_000);
      world.emit({ kind: "event", name: "program.bought", data: { program, cost } });
      return true;
    },

    getDarkwebProgramCost: (name: string): number => {
      if (!deps.hasTor()) return -1;
      const item = darkwebItem(name);
      if (!item) throw new Error(`No such exploit ('${name.toLowerCase()}') found on the darkweb!`);
      return deps.homeFiles().has(item[0]) ? 0 : item[1];
    },
    getDarkwebPrograms: (): string[] => deps.hasTor() ? Object.keys(DARKWEB_PRICES) : [],

    // --- home infrastructure -----------------------------------------
    getUpgradeHomeRamCost: (): number => {
      const home = world.servers.get("home");
      return home ? getUpgradeHomeRamCost(home.maxRam) : Infinity;
    },

    upgradeHomeRam: (): boolean => world.execute({ type: "upgradeHomeRam" }),

    getUpgradeHomeCoresCost: (): number => {
      const home = world.servers.get("home");
      return home ? 1e9 * Math.pow(7.5, home.cpuCores) : Infinity;
    },

    upgradeHomeCores: (): boolean => world.execute({ type: "upgradeHomeCore" }),

    // --- terminal / backdoors -----------------------------------------
    getCurrentServer: (): string => deps.terminal.host,

    connect: (rawHost: unknown): boolean => {
      const server = resolveServer(world.servers, deps.network, rawHost, deps.terminal.host);
      const adjacent = deps.network.get(deps.terminal.host)?.includes(server.hostname) ?? false;
      if (!adjacent && !server.backdoorInstalled && !server.purchasedByPlayer) return false;
      const previous = world.servers.get(deps.terminal.host);
      if (previous) previous.isConnectedTo = false;
      server.isConnectedTo = true;
      deps.terminal.host = server.hostname;
      return true;
    },

    installBackdoor: (): Promise<void> =>
      installBackdoorWithDelay((ms) => new Promise<void>((resolve) => void clock.in(ms, resolve))),

    b1tflum3: (): never => unmodeled("ns", "singularity.b1tflum3", "one BitNode per process (see spec/simulator.md)"),
    destroyW0r1dD43m0n: (
      rawNextBitNode: unknown,
      rawCbScript?: unknown,
      rawBitNodeOptions?: unknown,
    ): void => {
      const nextBitNode = typeof rawNextBitNode === "string"
        ? Number.parseFloat(rawNextBitNode)
        : rawNextBitNode;
      if (typeof nextBitNode !== "number" || !Number.isInteger(nextBitNode) || nextBitNode < 1 || nextBitNode > 15) {
        throw new Error(`Invalid BitNode: '${String(rawNextBitNode)}'`);
      }
      const cbScript = rawCbScript
        ? nsString("cbScript", rawCbScript).replace(/^\/+/, "")
        : undefined;
      const daemon = world.servers.get("w0r1d_d43m0n");
      if (!daemon || daemon.simKind === "DarknetServer") {
        throw new Error("WorldDaemon is not a normal server. This is a simulator bug.");
      }
      const hackingComplete = daemon.hasAdminRights && world.person.skills.hacking >= daemon.requiredHackingSkill;
      if (!hackingComplete) {
        if (world.gates.inBladeburner) {
          return unmodeled(
            "subsystem",
            "Bladeburner BitNode completion",
            "the number of completed Black Operations is not retained by this world model",
          );
        }
        return;
      }
      // Upstream validates these inside enterBitNode(), after the completion
      // requirements. An invalid options object is therefore unobservable
      // while the daemon route is incomplete.
      const bitNodeOptions = validateBitNodeOptions(rawBitNodeOptions);
      daemon.backdoorInstalled = true;
      deps.onBitNodeComplete?.(
        nextBitNode,
        cbScript,
        bitNodeOptions,
      );
    },
  };
  const factionName = (raw: unknown): string => {
    const name = nsString("faction", raw);
    if (!FACTION_TABLE[name]) throw new Error(`Invalid faction name: '${name}'`);
    return name;
  };
  const augmentationName = (raw: unknown): string => {
    const name = nsString("augmentation", raw);
    if (!AUGMENTATION_TABLE[name]) throw new Error(`Invalid augmentation name: '${name}'`);
    return name;
  };

  const guardedSingularity = Object.fromEntries(
    Object.entries(singularity).map(([name, member]) => [
      name,
      typeof member === "function"
        ? (...args: unknown[]) => {
            requireSingularityAccess();
            return (member as (...inner: unknown[]) => unknown)(...args);
          }
        : member,
    ]),
  );

  return {
    singularity: guardedSingularity,
    grafting: {
      getGraftableAugmentations: () => {
        requireGraftingAccess();
        return deps.grafting?.available()
          ?? unmodeled("subsystem", "grafting", "the harness did not install GraftingSystem");
      },
      getAugmentationGraftPrice: (name: string) => {
        requireGraftingAccess();
        return deps.grafting?.price(name)
          ?? unmodeled("subsystem", "grafting", "the harness did not install GraftingSystem");
      },
      getAugmentationGraftTime: (name: string) => {
        requireGraftingAccess();
        return deps.grafting?.timeMs(name)
          ?? unmodeled("subsystem", "grafting", "the harness did not install GraftingSystem");
      },
      graftAugmentation: (name: string, focus = true) => {
        requireGraftingAccess();
        return deps.grafting?.start(name, focus)
          ?? unmodeled("subsystem", "grafting", "the harness did not install GraftingSystem");
      },
      waitForOngoingGrafting: (): Promise<void> => {
        requireGraftingAccess();
        const work = player.currentWork;
        if (!work) return Promise.resolve();
        if (work.kind !== "graft") return Promise.reject(`The current work is not a grafting work. Type: ${work.kind}`);
        return work.nextCompletion;
      },
    },
    getFavorToDonate: favorToDonate,
    installBackdoorWithDelay,
    enums: makeEnums(),
  };
}

/** `ns.enums` — a 0 GB property, and the planner's only way to enumerate every
 * faction (including ones it has not been invited to). Frozen, like the game's. */
function makeEnums(): Record<string, unknown> {
  const enums = {
    FactionName,
    CityName,
    LocationName,
    CompanyName,
    JobName,
    JobField,
    AugmentationName,
    // Present so a probe reading it does not fall through to unmodeled().
    FactionWorkType: Object.freeze({ hacking: "hacking", field: "field", security: "security" }),
  };
  for (const value of Object.values(enums)) Object.freeze(value);
  return Object.freeze(enums) as Record<string, unknown>;
}

export { FACTION_TABLE };
