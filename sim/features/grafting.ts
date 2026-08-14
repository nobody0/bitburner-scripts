import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { AUGMENTATION_TABLE, type VendoredAugmentation } from "../vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";
import { calculateIntelligenceBonus } from "../vendor/bitburner/src/PersonObjects/formulas/intelligence.ts";

const CONGRUITY = "violet Congruity Implant";

/** Controlled model of v3.0.1 GraftingWork. Money is paid at start and never
 * refunded; cancelling loses all progress; entropy and the augmentation land
 * only at completion. */
export class GraftingSystem {
  #world: SimWorld;
  #player: SimPlayer;
  #unitCompleted = 0;

  constructor(world: SimWorld, player: SimPlayer, _homeFiles?: () => Set<string>) {
    this.#world = world;
    this.#player = player;
  }

  prestige(): void {
    this.#unitCompleted = 0;
  }

  available(): string[] {
    const bladeburner = this.#player.factions.includes("Bladeburners");
    return Object.values(AUGMENTATION_TABLE)
      // Player.hasAugmentation includes queued purchases by default.
      // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Grafting/GraftingHelpers.ts#L9-L23
      .filter((aug) => !this.#player.hasAugmentation(aug.name))
      .filter((aug) => !aug.isSpecial || (bladeburner && aug.factions.includes("Bladeburners")))
      .map((aug) => aug.name);
  }

  price(name: string): number {
    const aug = this.#availableAug(name);
    return aug.baseCost * CONSTANTS.AugmentationGraftingCostMult;
  }

  timeMs(name: string): number {
    const aug = this.#availableAug(name);
    const sum = Object.values(this.#multipliers(aug)).filter((value) => value !== 1).reduce((total, value) => total + value, 0);
    const base = (CONSTANTS.AugmentationGraftingTimeBase * Math.log2(Math.max(sum, 1)) + CONSTANTS.MillisecondsPerHalfHour) / 2;
    return base / calculateIntelligenceBonus(this.#world.person.skills.intelligence, 1);
  }

  start(name: string, focus = true): boolean {
    if (this.#player.city !== "New Tokyo") throw new Error("You must be in New Tokyo to begin grafting an Augmentation.");
    if (!this.available().includes(name)) return false;
    const aug = AUGMENTATION_TABLE[name]!;
    if (aug.prereqs.some((prereq) => !this.#player.hasAugmentation(prereq))) return false;
    const price = this.price(name);
    if (this.#player.money < price) return false;
    this.#player.money -= price;
    this.#world.recordMoney("augmentations", -price);
    this.#unitCompleted = 0;
    this.#player.startWork({ kind: "graft", subject: name, startedAt: this.#world.clock.now(), cyclesWorked: 0, focused: focus });
    this.#player.focus = focus;
    this.#world.emit({ kind: "event", name: "graft.started", data: { augmentation: name, price } });
    return true;
  }

  /** Restore serialized GraftingWork progress without charging for the graft
   * a second time. Player.currentWork is restored by game-run. */
  restoreProgress(unitCompleted: number): void {
    this.#unitCompleted = Math.max(0, unitCompleted);
  }

  processWork(cycles: number): void {
    const work = this.#player.currentWork;
    if (!work || work.kind !== "graft") return;
    const focusBonus = work.focused || this.#player.augmentations.has("Neuroreceptor Management Implant") ? 1 : 0.8;
    const rate = 200 * calculateIntelligenceBonus(this.#world.person.skills.intelligence, 1) * focusBonus;
    work.cyclesWorked += cycles;
    this.#unitCompleted += rate * cycles;
    if (this.#unitCompleted < this.#baseTimeMs(work.subject)) return;

    const aug = AUGMENTATION_TABLE[work.subject]!;
    this.#player.augmentations.set(aug.name, 1);
    this.#player.queuedAugmentations.delete(aug.name);
    if (aug.name === CONGRUITY) {
      this.#player.entropy = 0;
    } else if (!this.#player.augmentations.has(CONGRUITY)) {
      this.#player.entropy += 1;
    }
    this.#world.rebuildMultipliers();
    this.#world.gainIntelligenceExp(
      (CONSTANTS.IntelligenceGraftBaseExpGain * work.cyclesWorked * CONSTANTS.MilliPerCycle) / 10_000,
    );
    this.#world.recalculateSkills();
    this.#player.stopWork(false);
    this.#world.emit({ kind: "event", name: "graft.done", data: { augmentation: aug.name, entropy: this.#player.entropy } });
  }

  #availableAug(name: string): VendoredAugmentation {
    const aug = AUGMENTATION_TABLE[name];
    if (!aug || !this.available().includes(name)) throw new Error(`Invalid aug: ${name}`);
    return aug;
  }

  #baseTimeMs(name: string): number {
    const aug = AUGMENTATION_TABLE[name]!;
    const sum = Object.values(this.#multipliers(aug)).filter((value) => value !== 1).reduce((total, value) => total + value, 0);
    return (CONSTANTS.AugmentationGraftingTimeBase * Math.log2(Math.max(sum, 1)) + CONSTANTS.MillisecondsPerHalfHour) / 2;
  }

  #multipliers(aug: VendoredAugmentation): Readonly<Record<string, number>> {
    return aug.multsUnknown ? this.#world.augmentationStats(aug.name) ?? {} : aug.mults;
  }
}
