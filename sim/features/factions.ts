import type { PlayerRequirement } from "@ns";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { AUGMENTATION_TABLE } from "../vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { FACTION_TABLE } from "../vendor/bitburner/src/Faction/FactionTable.ts";
import { addRepToFavor } from "../vendor/bitburner/src/Faction/formulas/favor.ts";
import { repFromDonation } from "../vendor/bitburner/src/Faction/formulas/Donation.ts";
import {
  getFactionFieldWorkRepGain,
  getFactionSecurityWorkRepGain,
  getHackingWorkRepGain,
} from "../vendor/bitburner/src/PersonObjects/formulas/Reputation.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";

/** The faction subsystem.
 *
 * Modelled against v3.0.1's real ordering, because the strategy is being
 * measured on wall-clock and the ordering is worth real reputation:
 *
 *  - reputation is applied per CYCLE, BEFORE experience, and faction work
 *    NEVER self-terminates (src/Work/FactionWork.tsx:37-56);
 *  - passive growth runs every 5 cycles, compensates for cycles it missed on a
 *    fat tick, and SKIPS the faction currently being worked
 *    (src/Faction/FactionHelpers.tsx:132-170);
 *  - invitations are checked every 10 cycles (2 s), and joining a faction bans
 *    its enemies AND prunes their pending invitations
 *    (src/Faction/FactionHelpers.tsx:35-52).
 *
 * Everything numeric comes from the vendored originals, so a parity test can
 * assert bit-identity rather than "close enough". */

export interface SimFaction {
  name: string;
  joined: boolean;
  rep: number;
  favor: number;
  /** Invitation offered but not accepted. */
  invited: boolean;
  /** Permanently banned by having joined an enemy. */
  banned: boolean;
}

export type SimWorkType = "hacking" | "field" | "security";

export class FactionSystem {
  readonly factions = new Map<string, SimFaction>();
  #world: SimWorld;
  #player: SimPlayer;

  constructor(world: SimWorld, player: SimPlayer, initial: Record<string, { rep: number; favor: number }> = {}) {
    this.#world = world;
    this.#player = player;
    for (const name of Object.keys(FACTION_TABLE)) {
      const standing = initial[name];
      this.factions.set(name, {
        name,
        joined: false,
        rep: standing?.rep ?? 0,
        favor: standing?.favor ?? 0,
        invited: false,
        banned: false,
      });
    }
    // A save or profile may start already joined.
    for (const name of player.factions) {
      const faction = this.factions.get(name);
      if (faction) faction.joined = true;
    }
    // Joined factions win over malformed legacy input containing an enemy
    // pair. Every unjoined enemy is banned before invitations are restored.
    for (const name of player.factions) {
      if (!this.factions.has(name)) continue;
      for (const enemy of this.enemies(name)) {
        const faction = this.factions.get(enemy);
        if (faction && !faction.joined) faction.banned = true;
      }
    }
    const validInvitations: string[] = [];
    for (const name of player.factionInvitations) {
      const faction = this.factions.get(name);
      if (!faction || faction.joined || faction.banned) continue;
      faction.invited = true;
      if (!validInvitations.includes(name)) validInvitations.push(name);
    }
    player.factionInvitations = validInvitations;
  }

  get(name: string): SimFaction | undefined {
    return this.factions.get(name);
  }

  requirements(name: string): PlayerRequirement[] {
    return (FACTION_TABLE[name]?.inviteReqs ?? []) as PlayerRequirement[];
  }

  enemies(name: string): string[] {
    return FACTION_TABLE[name]?.enemies ?? [];
  }

  offersWork(name: string): { hacking: boolean; field: boolean; security: boolean } {
    const info = FACTION_TABLE[name];
    return {
      hacking: info?.offerHackingWork ?? false,
      field: info?.offerFieldWork ?? false,
      security: info?.offerSecurityWork ?? false,
    };
  }

  /** `joinFaction` @ v3.0.1: joining BANS every enemy and prunes their pending
   * invitations. Irreversible, which is why the planner solves a max-weight
   * independent set rather than joining greedily. */
  join(name: string): boolean {
    const faction = this.factions.get(name);
    if (!faction || faction.joined || faction.banned || !faction.invited) return false;
    faction.joined = true;
    faction.invited = false;
    if (!this.#player.factions.includes(name)) this.#player.factions.push(name);
    for (const enemy of this.enemies(name)) {
      const other = this.factions.get(enemy);
      if (!other || other.joined) continue;
      other.banned = true;
      other.invited = false;
    }
    this.#player.factionInvitations = this.#player.factionInvitations.filter(
      (invite) => invite !== name && !this.factions.get(invite)?.banned,
    );
    this.#world.emit({ kind: "event", name: "faction.joined", data: { faction: name } });
    return true;
  }

  /** Engine hook: `checkFactionInvitations`, every 10 cycles (2 s). */
  checkInvitations(satisfies: (requirements: PlayerRequirement[]) => boolean): void {
    for (const faction of this.factions.values()) {
      if (faction.joined || faction.banned || faction.invited) continue;
      const info = FACTION_TABLE[faction.name];
      // Special factions are joined through their own mechanic, never by an
      // invitation — modelling them as invitable would let the planner
      // "join" Bladeburners by satisfying an empty requirement list.
      if (!info || info.special) continue;
      if (info.inviteReqs.length === 0) continue;
      if (!satisfies(info.inviteReqs as PlayerRequirement[])) continue;
      faction.invited = true;
      if (!this.#player.factionInvitations.includes(faction.name)) {
        this.#player.factionInvitations.push(faction.name);
      }
      this.#world.emit({ kind: "event", name: "faction.invited", data: { faction: faction.name } });
    }
  }

  /** Engine hook: `processPassiveFactionRepGain(numCycles)`.
   *
   * Skips the faction currently being worked — which is what creates the
   * work-vs-idle crossover the strategy tests for. */
  passiveGain(cycles: number, workingFaction: string | undefined): void {
    const person = this.#world.person;
    const best = Math.max(
      person.skills.hacking,
      person.skills.strength,
      person.skills.defense,
      person.skills.dexterity,
      person.skills.agility,
      person.skills.charisma,
    );
    for (const faction of this.factions.values()) {
      if (!faction.joined) continue;
      if (faction.name === workingFaction) continue;
      const rate = best * Math.min(0.1, faction.favor / 1000 + 0.01) * currentNodeMults.FactionWorkRepGain;
      faction.rep += (rate * cycles) / 1000;
    }
  }

  /** Reputation per cycle for one work type, from the vendored formulas. */
  workRepGain(type: SimWorkType, favor: number): number {
    const person = this.#world.person;
    if (type === "hacking") return getHackingWorkRepGain(person as never, favor);
    if (type === "security") return getFactionSecurityWorkRepGain(person as never, favor);
    return getFactionFieldWorkRepGain(person as never, favor);
  }

  /** Engine hook: `processWork(numCycles)` for faction work.
   *
   * Reputation BEFORE experience, and the work never self-terminates — both
   * matter: reversing them shifts every rate by one cycle's skill gain, and a
   * self-terminating model would hide the fact that a re-issued
   * `workForFaction` silently restarts the activity. */
  processWork(cycles: number): void {
    const work = this.#player.currentWork;
    if (!work || work.kind !== "faction") return;
    const faction = this.factions.get(work.subject);
    if (!faction || !faction.joined) return;

    const type = (work.workType ?? "hacking") as SimWorkType;
    const focusPenalty = work.focused || this.#player.hasAugmentation("Neuroreceptor Management Implant") ? 1 : 0.8;
    faction.rep += this.workRepGain(type, faction.favor) * focusPenalty * cycles;
    work.cyclesWorked += cycles;

    // Experience AFTER reputation, matching FactionWork.tsx.
    const person = this.#world.person;
    const expRate = 0.15 * cycles;
    if (type === "hacking") person.exp.hacking += expRate;
    else {
      person.exp.strength += expRate;
      person.exp.defense += expRate;
      person.exp.dexterity += expRate;
      person.exp.agility += expRate;
      if (type === "field") person.exp.charisma += expRate;
    }
  }

  /** `donate` @ v3.0.1. Returns the reputation gained, or 0 when refused. */
  donate(name: string, amount: number, favorToDonate: number): number {
    const faction = this.factions.get(name);
    if (!faction || !faction.joined) return 0;
    if (faction.favor < favorToDonate) return 0;
    if (!(amount > 0) || this.#player.money < amount) return 0;
    const gained = repFromDonation(amount, this.#world.person as never);
    this.#player.money -= amount;
    faction.rep += gained;
    return gained;
  }

  /** Bank this run's reputation into favor. Happens ONLY at install — which is
   * why a donation-gated faction is a reset decision, not something to wait
   * for inside a run. */
  bankFavor(): void {
    for (const faction of this.factions.values()) {
      if (!faction.joined) continue;
      faction.favor = addRepToFavor(faction.favor, faction.rep);
      faction.rep = 0;
    }
  }

  /** Augmentations a joined faction offers that are not owned. */
  augmentationsFrom(name: string): string[] {
    const out: string[] = [];
    for (const aug of Object.values(AUGMENTATION_TABLE)) {
      if (!aug.factions.includes(name)) continue;
      if (this.#player.hasAugmentation(aug.name)) continue;
      out.push(aug.name);
    }
    return out;
  }
}
