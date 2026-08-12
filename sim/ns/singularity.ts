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
}

/** Darkweb prices @ v3.0.1 (src/DarkWeb/DarkWebItems.ts). Port openers only —
 * the rest are not on any path the strategy takes yet. */
const DARKWEB_PRICES: Record<string, number> = {
  "BruteSSH.exe": 500_000,
  "FTPCrack.exe": 1_500_000,
  "relaySMTP.exe": 5_000_000,
  "HTTPWorm.exe": 30_000_000,
  "SQLInject.exe": 250_000_000,
};

/** The 1.9^queued escalation, restricted to non-SoA augmentations. */
const SOA_SET = new Set([
  "Beauty of Aphrodite",
  "Chaos of Dionysus",
  "Flood of Poseidon",
  "Hunt of Artemis",
  "Knowledge of Apollo",
  "Might of Ares",
  "Trickery of Hermes",
  "WKS Harmonizer",
  "Wisdom of Athena",
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
      const ownedSoA = [...player.augmentations.keys()].filter((entry) => SOA_SET.has(entry)).length;
      return {
        moneyCost: aug.baseCost * Math.pow(7, ownedSoA),
        repCost: aug.baseRepRequirement * Math.pow(1.3, ownedSoA),
      };
    }
    return {
      moneyCost: aug.baseCost * generic * currentNodeMults.AugmentationMoneyCost,
      repCost: aug.baseRepRequirement * currentNodeMults.AugmentationRepCost,
    };
  };

  const favorToDonate = (): number => Math.floor(150 * currentNodeMults.FavorToDonateToFaction);

  const installBackdoorWithDelay = async (delay: (ms: number) => Promise<void>): Promise<void> => {
    const server = world.servers.get(deps.terminal.host);
    if (!server) throw new Error(`installBackdoor: server '${deps.terminal.host}' does not exist`);
    if (server.simKind === "DarknetServer") {
      return unmodeled("subsystem", "Darknet backdoor", "Darknet authentication/backdoor effects are not modeled");
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
    getFactionRep: (name: string): number => factions.get(name)?.rep ?? 0,
    getFactionFavor: (name: string): number => factions.get(name)?.favor ?? 0,
    getFactionEnemies: (name: string): string[] => factions.enemies(name),

    getFactionWorkTypes: (name: string): string[] => {
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
    getFactionInviteRequirements: (name: string): PlayerRequirement[] => factions.requirements(name),

    checkFactionInvitations: (): string[] => {
      // The real call re-checks immediately rather than waiting out the 2 s
      // cycle, by resetting the engine counter. Reproduced so a driver that
      // calls it right after satisfying a requirement sees the invitation.
      deps.pokeInvitationCounter();
      factions.checkInvitations((requirements) => satisfiesAll(requirements, deps.satisfyContext()));
      return [...player.factionInvitations];
    },

    joinFaction: (name: string): boolean => factions.join(name),

    workForFaction: (name: string, type: string, focus = true): boolean => {
      const faction = factions.get(name);
      if (!faction || !faction.joined) return false;
      const offers = factions.offersWork(name);
      const key = type === "hacking" ? "hacking" : type === "field" ? "field" : "security";
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

    donateToFaction: (name: string, amount: number): boolean =>
      factions.donate(name, amount, favorToDonate()) > 0,

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
      world.emit({ kind: "event", name: "travel", data: { city } });
      return true;
    },

    // --- augmentations ------------------------------------------------
    getOwnedAugmentations: (includeQueued = false): string[] => player.ownedAugmentations(includeQueued),

    // Does NOT require membership upstream (Singularity.ts:128-133) — and it
    // must not, or the planner could never value a faction it has not joined
    // and would have no basis for choosing which to join.
    getAugmentationsFromFaction: (name: string): string[] =>
      Object.values(AUGMENTATION_TABLE)
        .filter((aug) => aug.factions.includes(name))
        // Upstream removes The Red Pill from Daedalus in BN15.
        // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L204-L208
        .filter((aug) => !(deps.bitNode === 15 && name === "Daedalus" && aug.name === "The Red Pill"))
        .map((aug) => aug.name),

    getAugmentationPrice: (name: string): number => priceOf(name).moneyCost,
    getAugmentationRepReq: (name: string): number => priceOf(name).repCost,
    getAugmentationPrereq: (name: string): string[] => AUGMENTATION_TABLE[name]?.prereqs ?? [],
    getAugmentationStats: (name: string): Record<string, number> => {
      const aug = AUGMENTATION_TABLE[name];
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

    purchaseAugmentation: (factionName: string, augName: string): boolean => {
      const faction = factions.get(factionName);
      const aug = AUGMENTATION_TABLE[augName];
      if (!faction?.joined || !aug) return false;
      if (!aug.factions.includes(factionName)) return false;
      if (player.hasAugmentation(augName) && augName !== "NeuroFlux Governor") return false;
      // Prerequisites must be owned or queued.
      if (aug.prereqs.some((prereq) => !player.hasAugmentation(prereq))) return false;
      const { moneyCost, repCost } = priceOf(augName);
      if (faction.rep < repCost) return false;
      if (player.money < moneyCost) return false;
      player.money -= moneyCost;
      world.recordMoney("augmentations", -moneyCost);
      player.queuedAugmentations.set(augName, (player.queuedAugmentations.get(augName) ?? 0) + 1);
      world.emit({ kind: "event", name: "aug.purchased", data: { faction: factionName, augmentation: augName, cost: moneyCost } });
      return true;
    },

    installAugmentations: (cbScript?: string): boolean => {
      if (player.queuedAugmentations.size === 0) return false;
      deps.assertPrestigeSupported?.();
      const newlyInstalled = new Map(player.queuedAugmentations);
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
      if (deps.hasTor()) return true;
      if (player.money < 200_000) return false;
      player.money -= 200_000;
      world.recordMoney("other", -200_000);
      deps.setTor(true);
      return true;
    },

    purchaseProgram: (name: string): boolean => {
      if (!deps.hasTor()) return false;
      const cost = DARKWEB_PRICES[name];
      if (cost === undefined) return false;
      if (deps.homeFiles().has(name)) return true;
      if (player.money < cost) return false;
      player.money -= cost;
      world.recordMoney("other", -cost);
      deps.homeFiles().add(name);
      world.emit({ kind: "event", name: "program.bought", data: { program: name, cost } });
      return true;
    },

    getDarkwebProgramCost: (name: string): number => DARKWEB_PRICES[name] ?? -1,
    getDarkwebPrograms: (): string[] => Object.keys(DARKWEB_PRICES),

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

    connect: (hostname: string): boolean => {
      const server = world.servers.get(hostname);
      if (!server) return false;
      const adjacent = deps.network.get(deps.terminal.host)?.includes(hostname) ?? false;
      if (!adjacent && !server.backdoorInstalled && !server.purchasedByPlayer) return false;
      deps.terminal.host = hostname;
      return true;
    },

    installBackdoor: (): Promise<void> =>
      installBackdoorWithDelay((ms) => new Promise<void>((resolve) => void clock.in(ms, resolve))),

    b1tflum3: (): never => unmodeled("ns", "singularity.b1tflum3", "one BitNode per process (see spec/simulator.md)"),
    destroyW0r1dD43m0n: (): never =>
      unmodeled("ns", "singularity.destroyW0r1dD43m0n", "one BitNode per process (see spec/simulator.md)"),
  };

  return {
    singularity,
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
