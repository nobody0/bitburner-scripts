/** Handwritten v3.0.1 program-creation economics. The simulator parity suite
 * compares this table with upstream; game/shared never imports upstream. */
export interface ProgramOption {
  name: string;
  level: number;
  baseTimeMs: number;
  purchaseCost: number;
}

export const PORT_OPENER_PROGRAMS: readonly ProgramOption[] = [
  { name: "BruteSSH.exe", level: 50, baseTimeMs: 600_000, purchaseCost: 500_000 },
  { name: "FTPCrack.exe", level: 100, baseTimeMs: 1_800_000, purchaseCost: 1_500_000 },
  { name: "relaySMTP.exe", level: 250, baseTimeMs: 7_200_000, purchaseCost: 5_000_000 },
  { name: "HTTPWorm.exe", level: 500, baseTimeMs: 14_400_000, purchaseCost: 30_000_000 },
  { name: "SQLInject.exe", level: 750, baseTimeMs: 28_800_000, purchaseCost: 250_000_000 },
];

export function effectiveProgramLevel(program: ProgramOption, intelligence: number): number {
  return Math.max(1, program.level - intelligence / 2);
}

export function programCreateTimeMs(program: ProgramOption, hacking: number, intelligence: number): number {
  if (hacking < effectiveProgramLevel(program, intelligence)) return Infinity;
  const intBonus = 1 + (3 * Math.pow(intelligence, 0.8)) / 600;
  const raw = (hacking / program.level) * intBonus;
  const rate = 1 + (raw - 1) / 5;
  return program.baseTimeMs / Math.max(0.01, rate);
}

/** Writing wins when its player-slot opportunity cost is below buying. TOR is
 * included only when it has not already been acquired. */
export function preferProgramCreation(
  program: ProgramOption,
  hacking: number,
  intelligence: number,
  playerWorkIncomePerSec: number,
  hasTor: boolean,
): boolean {
  const timeMs = programCreateTimeMs(program, hacking, intelligence);
  if (!Number.isFinite(timeMs)) return false;
  const buyCost = program.purchaseCost + (hasTor ? 0 : 200_000);
  return (timeMs / 1_000) * Math.max(0, playerWorkIncomePerSec) < buyCost;
}
