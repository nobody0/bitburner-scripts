import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { CRIME_TABLE, type VendoredCrime } from "../vendor/bitburner/src/Crime/CrimeTable.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { calculateIntelligenceBonus } from "../vendor/bitburner/src/PersonObjects/formulas/intelligence.ts";

/** The crime subsystem.
 *
 * Crimes resolve on a SEEDED roll at completion, exactly as the game does, so
 * a run is reproducible while still exercising the failure path. The failure
 * path matters: a failed player crime awards one-quarter experience and karma,
 * but no money or kills, so a planner that assumed every crime succeeded would over-value the
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

  /** Start a valid crime and return its duration. Enum validation throws for
   * an unknown crime; there is no ordinary-refusal sentinel. */
  start(type: string, focus = true): number {
    const crime = CRIME_TABLE[type];
    if (!crime) throw new Error(`Invalid crime: '${type}'`);
    // Silently CANCELS whatever was running, like every other work start.
    this.#player.startWork({
      kind: "crime",
      subject: type,
      startedAt: this.#world.clock.now(),
      cyclesWorked: 0,
      unitCycles: 0,
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
    work.unitCycles = (work.unitCycles ?? 0) + cycles;
    const cyclesNeeded = crime.timeMs / 200;
    while (work.unitCycles >= cyclesNeeded) {
      work.unitCycles -= cyclesNeeded;
      this.#complete(crime);
    }
  }

  #complete(crime: VendoredCrime): void {
    const person = this.#world.person;
    const focused = this.#player.currentWork?.focused ?? true;
    const focusBonus = focused || this.#player.augmentations.has("Neuroreceptor Management Implant") ? 1 : 0.8;
    const success = this.#rng() < this.successChance(crime);
    const exp = person.exp as unknown as Record<string, number>;
    const mults = person.mults as unknown as Record<string, number>;
    const addExp = (scale: number): void => {
      for (const [skill, amount] of Object.entries(crime.exp)) {
        if (amount <= 0 || (skill === "intelligence" && !success)) continue;
        const mult = skill === "intelligence" ? 1 : mults[`${skill}_exp`] ?? 1;
        exp[skill] = (exp[skill] ?? 0) + amount * mult * currentNodeMults.CrimeExpGain * focusBonus * scale;
      }
    };

    if (success) {
      const moneyMult = ((person.mults as unknown as Record<string, number>)["crime_money"] ?? 1) * currentNodeMults.CrimeMoney;
      const money = crime.money * moneyMult * focusBonus;
      this.#player.money += money;
      this.#world.moneyEarned += money;
      this.#world.recordMoney("crime", money);
      // Karma is POSITIVE in the table and SUBTRACTED here.
      this.#player.karma -= crime.karma * focusBonus;
      this.#player.numPeopleKilled += crime.kills;
      addExp(1);
      this.#world.emit({
        kind: "event",
        name: "crime.done",
        data: { crime: crime.type, success: true, money, karma: -crime.karma * focusBonus },
      });
    } else {
      // Player CrimeWork scales experience and karma to one quarter on failure.
      this.#player.karma -= crime.karma * focusBonus / 4;
      addExp(0.25);
      this.#world.emit({ kind: "event", name: "crime.done", data: { crime: crime.type, success: false, karma: -crime.karma * focusBonus / 4 } });
    }
    this.#world.recalculateSkills();
    this.#player.completeWorkUnit();
  }
}
