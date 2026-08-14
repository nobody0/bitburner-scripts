import type { Multipliers } from "../vendor/bitburner/src/PersonObjects/Multipliers.ts";
import { defaultMultipliers } from "../vendor/bitburner/src/PersonObjects/Multipliers.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { ActiveFragment } from "../vendor/bitburner/src/CotMG/ActiveFragment.ts";
import { BaseGift } from "../vendor/bitburner/src/CotMG/BaseGift.ts";
import { Fragment, FragmentById } from "../vendor/bitburner/src/CotMG/Fragment.ts";
import { FragmentTypeEnum } from "../vendor/bitburner/src/CotMG/FragmentType.ts";
import { StanekConstants } from "../vendor/bitburner/src/CotMG/data/Constants.ts";
import { CalculateEffect } from "../vendor/bitburner/src/CotMG/formulas/effect.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import type { FactionSystem } from "./factions.ts";

const GENESIS = "Stanek's Gift - Genesis";
const COTMG = "Church of the Machine God";

/** Simulator-owned Stanek's Gift mechanics.
 *
 * Transcribed from bitburner-src v3.0.1 src/CotMG/StaneksGift.ts because the
 * upstream class reaches through Player, Factions, Augmentations, event and
 * JSON-reviver singletons. Geometry, fragment data, multiplier defaults and
 * CalculateEffect remain vendored; only stateful singleton glue lives here.
 * Each method group cites its upstream source below.
 */
export class StanekSystem extends BaseGift {
  isBonusCharging = false;
  justCharged = true;
  storedCycles = 0;

  #world: SimWorld;
  #player: SimPlayer;
  #factions: FactionSystem;

  constructor(world: SimWorld, player: SimPlayer, factions: FactionSystem) {
    super();
    this.#world = world;
    this.#player = player;
    this.#factions = factions;
    // Player.applyEntropy: Stanek is reapplied before Go after every base
    // multiplier rebuild (PlayerObjectAugmentationMethods.ts:8-18).
    this.#world.onMultipliersReset.push(() => this.applyMultipliersAfterReset());
  }

  hasGift(includeQueued = false): boolean {
    return this.#player.augmentations.has(GENESIS)
      || (includeQueued && this.#player.queuedAugmentations.has(GENESIS));
  }

  // v3.0.1 StaneksGift.ts:22-31 baseSize()/width()/height().
  baseSize(): number {
    return StanekConstants.BaseSize
      + currentNodeMults.StaneksGiftExtraSize
      + (this.#player.sourceFiles["13"] ?? 0);
  }

  override width(): number {
    return Math.max(2, Math.min(Math.floor(this.baseSize() / 2 + 1), StanekConstants.MaxSize));
  }

  override height(): number {
    return Math.max(3, Math.min(Math.floor(this.baseSize() / 2 + 0.6), StanekConstants.MaxSize));
  }

  // v3.0.1 StaneksGift.ts:33-44 charge().
  charge(fragment: ActiveFragment, threads: number): void {
    if (threads > fragment.highestCharge) {
      fragment.numCharge = (fragment.highestCharge * fragment.numCharge) / threads + 1;
      fragment.highestCharge = threads;
    } else {
      fragment.numCharge += threads / fragment.highestCharge;
    }

    const faction = this.#factions.get(COTMG);
    if (!faction) throw new Error("Missing simulated faction: " + COTMG);
    const reputation =
      (this.#world.person.mults.faction_rep
        * (Math.pow(threads, 0.95) * (faction.favor + 100)))
      / 1000;
    this.#factions.gainReputation(COTMG, reputation);
    this.justCharged = true;
  }

  // v3.0.1 StaneksGift.ts:46-61 inBonus()/process().
  inBonus(): boolean {
    return this.storedCycles >= 5;
  }

  process(numCycles = 1): void {
    if (!this.hasGift()) return;
    this.storedCycles += numCycles;
    const usedCycles = this.isBonusCharging ? 5 : 1;
    this.isBonusCharging = false;
    this.storedCycles = Math.max(0, this.storedCycles - usedCycles);
    if (this.justCharged) {
      this.#world.rebuildMultipliers();
      this.justCharged = false;
    }
  }

  // v3.0.1 StaneksGift.ts:64-78 effect(). ActiveFragment.neighbors() and
  // BaseGift.fragmentAt() are vendored, including orthogonal adjacency.
  effect(fragment: ActiveFragment): number {
    const boosters = fragment.neighbors()
      .map(([x, y]) => this.fragmentAt(x, y))
      .filter((value): value is ActiveFragment =>
        value !== undefined && value.fragment().type === FragmentTypeEnum.Booster);
    let boost = 1;
    for (const booster of new Set(boosters)) boost *= booster.fragment().power;
    return CalculateEffect(fragment.highestCharge, fragment.numCharge, fragment.fragment().power, boost);
  }

  // v3.0.1 StaneksGift.ts:80-132 placement/find/count/delete/clear.
  canPlace(rootX: number, rootY: number, rotation: number, fragment: Fragment): boolean {
    if (rootX < 0 || rootY < 0) return false;
    if (rootX + fragment.width(rotation) > this.width()) return false;
    if (rootY + fragment.height(rotation) > this.height()) return false;
    if (this.count(fragment) >= fragment.limit) return false;
    const candidate = new ActiveFragment({ x: rootX, y: rootY, rotation, fragment });
    return !this.fragments.some((active) => active.collide(candidate));
  }

  place(rootX: number, rootY: number, rotation: number, fragment: Fragment): boolean {
    if (!this.canPlace(rootX, rootY, rotation, fragment)) return false;
    this.fragments.push(new ActiveFragment({ x: rootX, y: rootY, rotation, fragment }));
    return true;
  }

  findFragment(rootX: number, rootY: number): ActiveFragment | undefined {
    return this.fragments.find((fragment) => fragment.x === rootX && fragment.y === rootY);
  }

  count(fragment: Fragment): number {
    return this.fragments.filter((active) => active.id === fragment.id).length;
  }

  delete(rootX: number, rootY: number): boolean {
    const index = this.fragments.findIndex((fragment) => fragment.x === rootX && fragment.y === rootY);
    if (index < 0) return false;
    this.fragments.splice(index, 1);
    return true;
  }

  clear(): void {
    this.fragments.length = 0;
  }

  // v3.0.1 StaneksGift.ts:134-184 calculateMults().
  calculateMults(): Multipliers {
    const mults = defaultMultipliers();
    for (const active of this.fragments) {
      const fragment = active.fragment();
      const power = this.effect(active);
      switch (fragment.type) {
        case FragmentTypeEnum.HackingSpeed:
          mults.hacking_speed *= power;
          break;
        case FragmentTypeEnum.HackingMoney:
          mults.hacking_money *= power;
          break;
        case FragmentTypeEnum.HackingGrow:
          mults.hacking_grow *= power;
          break;
        case FragmentTypeEnum.Hacking:
          mults.hacking *= power;
          mults.hacking_exp *= power;
          break;
        case FragmentTypeEnum.Strength:
          mults.strength *= power;
          mults.strength_exp *= power;
          break;
        case FragmentTypeEnum.Defense:
          mults.defense *= power;
          mults.defense_exp *= power;
          break;
        case FragmentTypeEnum.Dexterity:
          mults.dexterity *= power;
          mults.dexterity_exp *= power;
          break;
        case FragmentTypeEnum.Agility:
          mults.agility *= power;
          mults.agility_exp *= power;
          break;
        case FragmentTypeEnum.Charisma:
          mults.charisma *= power;
          mults.charisma_exp *= power;
          break;
        case FragmentTypeEnum.HacknetMoney:
          mults.hacknet_node_money *= power;
          break;
        case FragmentTypeEnum.HacknetCost:
          mults.hacknet_node_purchase_cost /= power;
          mults.hacknet_node_ram_cost /= power;
          mults.hacknet_node_core_cost /= power;
          mults.hacknet_node_level_cost /= power;
          break;
        case FragmentTypeEnum.Rep:
          mults.company_rep *= power;
          mults.faction_rep *= power;
          break;
        case FragmentTypeEnum.WorkMoney:
          mults.work_money *= power;
          break;
        case FragmentTypeEnum.Crime:
          mults.crime_success *= power;
          mults.crime_money *= power;
          break;
        case FragmentTypeEnum.Bladeburner:
          mults.bladeburner_max_stamina *= power;
          mults.bladeburner_stamina_gain *= power;
          mults.bladeburner_analysis *= power;
          mults.bladeburner_success_chance *= power;
          break;
      }
    }
    return mults;
  }

  /** v3.0.1 StaneksGift.ts:186-211 updateMults(), without sleeve glue (sleeves
   * are explicitly unmodeled). Called only after the base bag was rebuilt. */
  applyMultipliersAfterReset(): void {
    const target = this.#world.person.mults as unknown as Record<string, number>;
    for (const [field, factor] of Object.entries(this.calculateMults())) {
      target[field] = (target[field] ?? 1) * factor;
    }
    this.#world.recalculateSkills();
  }

  // v3.0.1 StaneksGift.ts:229-237 prestige methods.
  prestigeAugmentation(): void {
    for (const fragment of this.fragments) {
      fragment.highestCharge = 0;
      fragment.numCharge = 0;
    }
  }

  prestigeSourceFile(): void {
    this.clear();
    this.storedCycles = 0;
  }

  fragmentById(id: number): Fragment | null {
    return FragmentById(id);
  }
}
