import type { SimProcess } from "./process.ts";
import type { StanekSystem } from "../features/stanek.ts";
import { Fragments } from "../vendor/bitburner/src/CotMG/Fragment.ts";
import { FragmentTypeEnum } from "../vendor/bitburner/src/CotMG/FragmentType.ts";
import { getCoreBonus } from "../vendor/bitburner/src/NetworkShare/Share.ts";

export interface StanekNsOptions {
  system: StanekSystem;
  process: SimProcess;
  hostCores: () => number;
  delay: (ms: number) => Promise<void>;
}

/** v3.0.1 src/NetscriptFunctions/Stanek.ts surface over StanekSystem.
 * acceptGift remains intentionally absent: eligibility/augmentation mutation
 * is a separate unmodeled lifecycle, so the root namespace reports it. */
export function makeStanek(options: StanekNsOptions): Record<string, unknown> {
  const { system, process } = options;

  const requireGift = (): void => {
    if (!system.hasGift(true)) throw new Error("Stanek's Gift is not installed");
  };
  const number = (name: string, value: unknown): number => {
    const result = Number(value);
    if (Number.isNaN(result)) throw new Error("stanek: " + name + " must be a number");
    return result;
  };
  const publicFragment = (rootX: number, rootY: number) => {
    const active = system.findFragment(rootX, rootY);
    if (!active) return undefined;
    return {
      ...active.copy(),
      ...active.fragment().copy(),
      chargedEffect: system.effect(active),
    };
  };

  return {
    giftWidth: (): number => {
      requireGift();
      return system.width();
    },
    giftHeight: (): number => {
      requireGift();
      return system.height();
    },
    chargeFragment: (rawX: unknown, rawY: unknown): Promise<void> => {
      const rootX = number("rootX", rawX);
      const rootY = number("rootY", rawY);
      requireGift();
      const fragment = system.findFragment(rootX, rootY);
      if (!fragment) throw new Error("No fragment with root (" + rootX + ", " + rootY + ").");
      if (fragment.fragment().type === FragmentTypeEnum.Booster) {
        throw new Error(
          "The fragment with root (" + rootX + ", " + rootY + ") is a Booster Fragment and thus cannot be charged.",
        );
      }
      const threads = process.threads * getCoreBonus(options.hostCores());
      const inBonus = system.inBonus();
      if (inBonus) system.isBonusCharging = true;
      // Deliberately .then(), not .finally(): ScriptDeath cancels the charge.
      return options.delay(inBonus ? 200 : 1000).then(() => {
        system.charge(fragment, threads);
      });
    },
    fragmentDefinitions: () => {
      requireGift();
      return Fragments.map((fragment) => fragment.copy());
    },
    activeFragments: () => {
      requireGift();
      return system.fragments.map((fragment) => publicFragment(fragment.x, fragment.y)!);
    },
    clearGift: (): void => {
      requireGift();
      system.clear();
    },
    canPlaceFragment: (rawX: unknown, rawY: unknown, rawRotation: unknown, rawId: unknown): boolean => {
      const rootX = number("rootX", rawX);
      const rootY = number("rootY", rawY);
      const rotation = number("rotation", rawRotation);
      const id = number("fragmentId", rawId);
      requireGift();
      const fragment = system.fragmentById(id);
      if (!fragment) throw new Error("Invalid fragment id: " + id);
      return system.canPlace(rootX, rootY, rotation, fragment);
    },
    placeFragment: (rawX: unknown, rawY: unknown, rawRotation: unknown, rawId: unknown): boolean => {
      const rootX = number("rootX", rawX);
      const rootY = number("rootY", rawY);
      const rotation = number("rotation", rawRotation);
      const id = number("fragmentId", rawId);
      requireGift();
      const fragment = system.fragmentById(id);
      if (!fragment) throw new Error("Invalid fragment id: " + id);
      return system.place(rootX, rootY, rotation, fragment);
    },
    getFragment: (rawX: unknown, rawY: unknown) => {
      const rootX = number("rootX", rawX);
      const rootY = number("rootY", rawY);
      requireGift();
      return publicFragment(rootX, rootY);
    },
    removeFragment: (rawX: unknown, rawY: unknown): boolean => {
      const rootX = number("rootX", rawX);
      const rootY = number("rootY", rawY);
      requireGift();
      return system.delete(rootX, rootY);
    },
  };
}
