import type { Person, Player } from "@ns";

/** The non-`Person` half of the player.
 *
 * `Person` (sim/core/mocks.ts) carries what the vendored formulas read —
 * skills, exp, mults, hp, city. Everything else the game tracks about the
 * PLAYER specifically lives here: the things faction requirements are written
 * against (karma, kills, augmentations owned, jobs, city), the single work
 * slot, and the source files.
 *
 * Splitting them this way is not cosmetic. The vendored formulas take an
 * `IPerson` and must keep taking exactly that — a sleeve is a `Person` too —
 * so bolting player-only fields onto the same object would make it impossible
 * to hand a sleeve to the same formula without lying about its type. */

export type WorkKind = "faction" | "company" | "crime" | "class" | "graft" | "createProgram";

/** What `Player.currentWork` is doing right now. One slot, exclusively.
 *
 * That exclusivity is the reason the arbiter has a `time` resource at all:
 * `ns.singularity.workForFaction` does not queue behind an existing activity,
 * it silently CANCELS it. */
export interface SimWork {
  kind: WorkKind;
  /** Faction name, company name, crime type, course name — whatever the kind
   *  is about. */
  subject: string;
  /** Faction/company work type ("hacking" | "field" | "security"), if any. */
  workType?: string;
  /** When this activity started, in virtual ms. */
  startedAt: number;
  /** Accumulated toward whatever this work produces (rep, exp, crime time). */
  cyclesWorked: number;
  /** Repeating-unit progress when it differs from upstream's cumulative
   * `cyclesWorked` counter (currently crimes). */
  unitCycles?: number;
  /** Unfocused work is ×0.8 unless NeuroreceptorManager is owned. */
  focused: boolean;
  /** Modeled Task.nextCompletion. Kept live across the NS API copy. */
  nextCompletion: Promise<void>;
  resolveNextCompletion: () => void;
}

export interface SimPlayerOptions {
  money?: number;
  city?: string;
  location?: string;
  karma?: number;
  numPeopleKilled?: number;
  factions?: string[];
  factionInvitations?: string[];
  augmentations?: { name: string; level: number }[];
  queuedAugmentations?: { name: string; level: number }[];
  sourceFiles?: Record<string, number>;
  jobs?: Record<string, string>;
  /** Player.gang.facName. Needed because that faction receives no passive
   * reputation while it is the player's gang. */
  gangFaction?: string;
  focus?: boolean;
}

export class SimPlayer {
  money: number;
  /** Negative and DECREASING. Every faction/gang karma requirement is an upper
   *  bound, which is why shared/strategy/needs.ts gives `karma` an `atMost`
   *  direction. */
  karma: number;
  numPeopleKilled: number;
  entropy = 0;
  city: string;
  location: string;
  /** Company name -> job title. */
  jobs: Record<string, string>;
  /** Joined factions, in join order. */
  factions: string[];
  /** Pending invitations. Distinct from `factions`: an invitation can be
   *  revoked by joining an enemy, and the two must not be conflated. */
  factionInvitations: string[] = [];
  /** Factions whose rumour requirements are met — the game surfaces these
   *  before the invitation itself. */
  factionRumors: string[] = [];
  /** Installed augmentation name -> level (level matters for NeuroFlux). */
  augmentations: Map<string, number>;
  /** Bought but not yet installed. These count for `numAugmentations`
   *  requirements but their multipliers are NOT active. */
  queuedAugmentations: Map<string, number> = new Map();
  /** SF number (as string) -> level. */
  sourceFiles: Record<string, number>;
  gangFaction: string | undefined;
  currentWork: SimWork | undefined;
  focus = true;

  constructor(options: SimPlayerOptions = {}) {
    this.money = options.money ?? 1_000;
    this.karma = options.karma ?? 0;
    this.numPeopleKilled = options.numPeopleKilled ?? 0;
    this.city = options.city ?? "Sector-12";
    this.location = options.location ?? "home";
    this.jobs = { ...(options.jobs ?? {}) };
    this.factions = [...(options.factions ?? [])];
    this.factionInvitations = [...(options.factionInvitations ?? [])];
    this.sourceFiles = { ...(options.sourceFiles ?? {}) };
    this.gangFaction = options.gangFaction;
    this.focus = options.focus ?? true;
    this.augmentations = new Map((options.augmentations ?? []).map((a) => [a.name, a.level]));
    this.queuedAugmentations = new Map();
    for (const augmentation of options.queuedAugmentations ?? []) {
      this.queuedAugmentations.set(
        augmentation.name,
        (this.queuedAugmentations.get(augmentation.name) ?? 0) + 1,
      );
    }
  }

  startWork(work: Omit<SimWork, "nextCompletion" | "resolveNextCompletion">): void {
    this.stopWork();
    let resolveNextCompletion!: () => void;
    const nextCompletion = new Promise<void>((resolve) => { resolveNextCompletion = resolve; });
    this.currentWork = { ...work, nextCompletion, resolveNextCompletion };
  }

  /** Resolve one repeatable unit and immediately arm the following one. */
  completeWorkUnit(): void {
    const work = this.currentWork;
    if (!work) return;
    work.resolveNextCompletion();
    let resolveNextCompletion!: () => void;
    work.nextCompletion = new Promise<void>((resolve) => { resolveNextCompletion = resolve; });
    work.resolveNextCompletion = resolveNextCompletion;
  }

  stopWork(): boolean {
    const work = this.currentWork;
    if (!work) return false;
    this.currentWork = undefined;
    work.resolveNextCompletion();
    return true;
  }

  /** Exact getOwnedAugmentations shape: installed entries once, followed by
   * every queued purchase. Repeated NeuroFlux levels therefore remain
   * repeated, including when an installed level already exists. */
  ownedAugmentations(includeQueued = true): string[] {
    const names = [...this.augmentations.keys()];
    if (includeQueued) {
      for (const [name, levels] of this.queuedAugmentations) {
        for (let level = 0; level < levels; level++) names.push(name);
      }
    }
    return names;
  }

  augmentationCount(includeQueued = true): number {
    return this.ownedAugmentations(includeQueued).length;
  }

  hasAugmentation(name: string, includeQueued = true): boolean {
    return this.augmentations.has(name) || (includeQueued && this.queuedAugmentations.has(name));
  }
}

/** What `ns.getPlayer()` reports.
 *
 * Every nested object is COPIED, not shared. The controller stores this in its
 * game-state store and decides from it, so handing back live references would
 * make the "snapshot" silently track the world — a stored player from ten
 * minutes ago would report the current skill vector, and any test comparing
 * them would pass for the wrong reason. That was a real latent bug here: the
 * previous implementation spread `this.person`, so `skills`, `exp` and `mults`
 * all aliased the live objects. */
export function playerRecord(person: Person, player: SimPlayer, totalPlaytime: number): Player {
  return {
    hp: { ...person.hp },
    skills: { ...person.skills },
    exp: { ...person.exp },
    mults: { ...person.mults },
    city: player.city as Person["city"],
    location: player.location,
    money: player.money,
    karma: player.karma,
    numPeopleKilled: player.numPeopleKilled,
    entropy: player.entropy,
    jobs: { ...player.jobs },
    factions: [...player.factions],
    totalPlaytime,
    // NOTE: no BitNode field. `Player` genuinely does not carry one — the
    // active node comes from ns.getResetInfo().currentNode, and inventing a
    // `bitNodeN` here would be a value the real game never reports.
  } as unknown as Player;
}
