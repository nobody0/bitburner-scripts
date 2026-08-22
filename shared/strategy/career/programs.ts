import { TOR_COST } from "../dnet/rates.ts";

/** Handwritten v3.0.1 program-creation economics. The simulator parity suite
 * compares this table with upstream; game/shared never imports upstream.
 *
 * Pinned upstream table, access requirement, and work-rate formula:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Programs/Programs.ts#L19-L193
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/CreateProgramWork.ts#L51-L75 */
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

/** What the career slot would deliver if it did NOT write this program.
 *
 * Both channels matter, and the old money-only comparison saw one of them.
 * The slot also produces posted-need progress — faction and company rep,
 * karma, combat stats — that nothing else on the board can produce. A
 * ten-minute BruteSSH write is ten minutes a blocking karma or companyRep
 * need does not advance, and that cost does not appear in dollars. Measured:
 * early runs spent the first ten to thirty minutes writing openers with the
 * whole server-access pipeline stalled behind them. */
export interface ProgramAlternative {
  /** Money per second the slot reverts to earning once the top need is
   * saturated — its income fallback, not the top option's own rate. */
  moneyPerSec: number;
  /** BN-seconds the slot would deliver to the best OTHER bidder during the
   * write window — the winning bid's sustained worth, scaled by the fraction of
   * the remaining route the write occupies. */
  valueSec: number;
}

/** Writing wins when its FULL player-slot opportunity cost is below buying.
 *
 * Both sides are denominated in BN-seconds, using the arbiter's own shadow
 * price of a dollar (`valueSecPerDollar`, a money waterline lambda). TOR is
 * included in the purchase only when it has not already been acquired.
 *
 * Without a price for money — no auction has priced a money band yet — the
 * comparison degrades to the historical money-only test rather than
 * fabricating an exchange rate. */
export function preferProgramCreation(
  program: ProgramOption,
  hacking: number,
  intelligence: number,
  alternative: ProgramAlternative,
  hasTor: boolean,
  valueSecPerDollar?: number,
): boolean {
  const timeMs = programCreateTimeMs(program, hacking, intelligence);
  if (!Number.isFinite(timeMs)) return false;
  const timeSec = timeMs / 1_000;
  const buyCost = program.purchaseCost + (hasTor ? 0 : TOR_COST);
  const forgoneMoney = timeSec * Math.max(0, alternative.moneyPerSec);
  if (valueSecPerDollar === undefined || !(valueSecPerDollar > 0)) return forgoneMoney < buyCost;
  // The larger of two estimates of ONE cost, not their sum: the money the slot
  // would have earned is itself a priced channel inside `valueSec` now, so
  // adding them counted the same forgone dollars twice.
  const writeValueSec = Math.max(forgoneMoney * valueSecPerDollar, Math.max(0, alternative.valueSec));
  return writeValueSec < buyCost * valueSecPerDollar;
}
