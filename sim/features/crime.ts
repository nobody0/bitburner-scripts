import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { CRIME_TABLE, type VendoredCrime } from "../vendor/bitburner/src/Crime/CrimeTable.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { calculateIntelligenceBonus } from "../vendor/bitburner/src/PersonObjects/formulas/intelligence.ts";

/** The crime subsystem.
 *
 * Crimes resolve on a SEEDED roll at completion, exactly as the game does, so
 * a run is reproducible while still exercising the failure path. The failure
 * path matters: a failed crime awards HALF experience and NO money, karma or
 * kills, so a planner that assumed every crime succeeded would over-value the
 * hard ones badly.
 *
 * Karma is stored positive in the table and SUBTRACTED here. */

/** CONSTANTS @ v3.0.1. */
const INTELLIGENCE_CRIME_WEIGHT = 0.025;
const MAX_SKILL_LEVEL = 975;

export class CrimeSystem {
  #world: SimWorld;
  #player: SimPlayer;
  #rng: () => number;

  constructor(world: SimWorld, player: SimPlayer, rng: () => number) {
    this.#world = world;
    this.#player = player;
    this.#rng = rng;
  }

  get(type: string): VendoredCrime | undefined {
    return CRIME_TABLE[type];
  }

  list(): VendoredCrime[] {
    return Object.values(CRIME_TABLE);
  }

  /** `Crime.successRate` @ v3.0.1. */
  successChance(crime: VendoredCrime): number {
    const person = this.#world.person;
    const skills = person.skills as unknown as Record<string, number>;
    let chance =
      (crime.weights["hacking"] ?? 0) * (skills["hacking"] ?? 0) +
      (crime.weights["strength"] ?? 0) * (skills["strength"] ?? 0) +
      (crime.weights["defense"] ?? 0) * (skills["defense"] ?? 0) +
      (crime.weights["dexterity"] ?? 0) * (skills["dexterity"] ?? 0) +
      (crime.weights["agility"] ?? 0) * (skills["agility"] ?? 0) +
      (crime.weights["charisma"] ?? 0) * (skills["charisma"] ?? 0) +
      INTELLIGENCE_CRIME_WEIGHT * (skills["intelligence"] ?? 0);
    chance /= MAX_SKILL_LEVEL;
    chance /= crime.difficulty;
    chance *= (person.mults as unknown as Record<string, number>)["crime_success"] ?? 1;
    chance *= currentNodeMults.CrimeSuccessRate;
    chance *= calculateIntelligenceBonus(skills["intelligence"] ?? 0, 1);
    return Math.min(chance, 1);
  }

  /** Start a crime. Returns its duration in ms, or 0 when refused —
   * `commitCrime`'s real contract. */
  start(type: string, focus = true): number {
    const crime = CRIME_TABLE[type];
    if (!crime) return 0;
    // Silently CANCELS whatever was running, like every other work start.
    this.#player.startWork({
      kind: "crime",
      subject: type,
      startedAt: this.#world.clock.now(),
      cyclesWorked: 0,
      focused: focus,
    });
    this.#player.focus = focus;
    return crime.timeMs;
  }

  /** Engine hook, called from processWork. A crime completes when it has
   * accumulated its full duration in cycles, then IMMEDIATELY restarts —
   * matching the game, where singularity crime loops until stopped. */
  processWork(cycles: number): void {
    const work = this.#player.currentWork;
    if (!work || work.kind !== "crime") return;
    const crime = CRIME_TABLE[work.subject];
    if (!crime) return;

    work.cyclesWorked += cycles;
    const cyclesNeeded = crime.timeMs / 200;
    while (work.cyclesWorked >= cyclesNeeded) {
      work.cyclesWorked -= cyclesNeeded;
      this.#complete(crime);
    }
  }

  #complete(crime: VendoredCrime): void {
    const person = this.#world.person;
    const success = this.#rng() < this.successChance(crime);
    const exp = person.exp as unknown as Record<string, number>;

    if (success) {
      const moneyMult = ((person.mults as unknown as Record<string, number>)["crime_money"] ?? 1) * currentNodeMults.CrimeMoney;
      this.#player.money += crime.money * moneyMult;
      // Karma is POSITIVE in the table and SUBTRACTED here.
      this.#player.karma -= crime.karma;
      this.#player.numPeopleKilled += crime.kills;
      for (const [skill, amount] of Object.entries(crime.exp)) {
        if (amount > 0) exp[skill] = (exp[skill] ?? 0) + amount;
      }
      this.#world.emit({
        kind: "event",
        name: "crime.done",
        data: { crime: crime.type, success: true, money: crime.money * moneyMult, karma: -crime.karma },
      });
    } else {
      // Failure awards HALF experience and nothing else. Omitting this makes
      // every hard crime look strictly better than it is.
      for (const [skill, amount] of Object.entries(crime.exp)) {
        if (amount > 0) exp[skill] = (exp[skill] ?? 0) + amount / 2;
      }
      this.#world.emit({ kind: "event", name: "crime.done", data: { crime: crime.type, success: false } });
    }
    this.#world.recalculateSkills();
    this.#player.completeWorkUnit();
  }
}
