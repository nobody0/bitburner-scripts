// Vendored from bitburner-src v3.0.1:src/CotMG/formulas/effect.ts by tools/vendor.ts — DO NOT EDIT
import { currentNodeMults } from "../../BitNode/BitNodeMultipliers";

export function CalculateEffect(highestCharge: number, numCharge: number, power: number, boost: number): number {
  return (
    1 +
    (Math.log(highestCharge + 1) / 60) *
      Math.pow((numCharge + 1) / 5, 0.07) *
      power *
      boost *
      currentNodeMults.StaneksGiftPowerMultiplier
  );
}
