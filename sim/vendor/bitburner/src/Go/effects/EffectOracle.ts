// Vendored from bitburner-src v3.0.1:src/Go/effects/effect.ts (5 symbols, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import { GoOpponent } from "../Enums";
import { opponentDetails } from "../Constants";
export const EffectOracleState = { sourceFile14Level: 0, goPower: 1 };
const Player = { activeSourceFileLvl: (node: number): number => node === 14 ? EffectOracleState.sourceFile14Level : 0 };
const currentNodeMults = { get GoPower(): number { return EffectOracleState.goPower; } };

export function CalculateEffect(nodes: number, faction: GoOpponent): number {
  const power = getEffectPowerForFaction(faction);
  const sourceFileBonus = Player.activeSourceFileLvl(14) ? 2 : 1;
  return (
    1 + Math.log(nodes + 1) * Math.pow(nodes + 1, 0.3) * 0.002 * power * currentNodeMults.GoPower * sourceFileBonus
  );
}

export function getMaxRep() {
  const sourceFileLevel = Player.activeSourceFileLvl(14);

  if (sourceFileLevel === 1) {
    return 200_000;
  }
  if (sourceFileLevel === 2) {
    return 300_000;
  }
  if (sourceFileLevel >= 3) {
    return 400_000;
  }

  return 100_000;
}

export function getWinstreakMultiplier(winStreak: number, previousWinStreak: number) {
  if (winStreak < 0) {
    return 0.5;
  }
  // If you break a dry streak, gain extra bonus based on the length of the dry streak (up to 5x bonus)
  if (previousWinStreak < 0 && winStreak > 0) {
    const dryStreakBroken = -1 * previousWinStreak;
    return 1 + 0.5 * Math.min(dryStreakBroken, 8);
  }
  // Win streak bonus caps at x3
  return 1 + 0.25 * Math.min(winStreak, 8);
}

export function getDifficultyMultiplier(komi: number, boardSize: number) {
  const isTinyBoardVsIlluminati = boardSize === 5 && komi === opponentDetails[GoOpponent.Illuminati].komi;
  return isTinyBoardVsIlluminati ? 8 : (komi + 0.5) * 0.25;
}

function getEffectPowerForFaction(opponent: GoOpponent) {
  return opponentDetails[opponent].bonusPower;
}
