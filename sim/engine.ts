import type { Clock } from "./clock.ts";

/** The game's SECOND clock.
 *
 * Transcribed from bitburner-src/src/engine.tsx @ v3.0.1. Bitburner has two
 * independent timebases and they never synchronise:
 *
 *   1. Wall clock via setTimeout — hack/grow/weaken, sleep, spawn. Modelled by
 *      sim/realm/timers.ts.
 *   2. This: a self-rescheduling 200 ms cycle that drives EVERYTHING else —
 *      gang, corporation, bladeburner, sleeves, hacknet, stock, faction rep,
 *      and the thirteen Engine.Counters.
 *
 * Only `hacking` is implemented in game/ today, so no subsystem is wired yet.
 * The machinery lands now anyway: every feature that follows (hacknet's linear
 * production, factions' passive rep, gang's 25x bonus time) is defined in terms
 * of these cycles, and retrofitting a second timebase under models already
 * written against the first would mean redoing all of them.
 *
 * Three quirks that are NOT approximations — code depends on each:
 *
 * - The sub-cycle remainder is carried in `lastUpdate`, so no time is lost or
 *   double-counted across ticks, and the reschedule targets the next 200 ms
 *   boundary rather than "200 ms from now".
 * - `checkCounters()` runs ONCE per updateGame call, not once per cycle. On a
 *   fat catch-up tick every counter goes deeply negative and each fires exactly
 *   once. Only passiveFactionGrowth compensates for the cycles it missed.
 * - Bonus time is per-subsystem and capped differently for each (gang 25x,
 *   sleeve 15x, corp 10x, bladeburner 5x, stanek 5x). Hacknet and player work
 *   rep have NO cap and scale linearly. */

export const MILLI_PER_CYCLE = 200;

/** Engine.Counters, verbatim including the six that drive nothing. They are
 * decremented forever and go monotonically negative; reproducing that is
 * cheaper than explaining later why our counter state diverges. */
export function initialCounters(): Record<string, number> {
  return {
    autoSaveCounter: 300,
    updateSkillLevelsCounter: 10,
    updateDisplays: 3,
    updateDisplaysLong: 15,
    updateActiveScriptsDisplay: 5,
    createProgramNotifications: 10,
    augmentationsNotifications: 10,
    checkFactionInvitations: 10,
    passiveFactionGrowth: 5,
    messages: 150,
    mechanicProcess: 5,
    contractGeneration: 3000,
    achievementsCounter: 5,
  };
}

/** Hooks for subsystems, called in updateGame's real order. Absent hooks are
 * simply not modelled — the gap surfaces where a driver reaches for the ns API,
 * not here, so an unmodelled subsystem costs nothing per tick. */
export interface EngineSubsystems {
  processWork?(cycles: number): void;
  processStockPrices?(cycles: number): void;
  gangProcess?(cycles: number): void;
  staneksGiftProcess?(cycles: number): void;
  corporationStoreCycles?(cycles: number): void;
  corporationProcess?(): void;
  bladeburnerStoreCycles?(cycles: number): void;
  sleeveProcess?(cycles: number): void;
  processHacknetEarnings?(cycles: number): void;
  /** checkCounters callbacks. */
  checkFactionInvitations?(): void;
  processPassiveFactionRepGain?(cycles: number): void;
  bladeburnerProcess?(): void;
  generateContracts?(): void;
}

export class Engine {
  readonly counters = initialCounters();
  /** Total game cycles processed — what a subsystem's bonus time is measured against. */
  cyclesProcessed = 0;
  updates = 0;
  #clock: Clock;
  #subsystems: EngineSubsystems;
  #lastUpdate = 0;
  #timer: number | undefined;

  constructor(clock: Clock, subsystems: EngineSubsystems = {}) {
    this.#clock = clock;
    this.#subsystems = subsystems;
  }

  /** Engine.start: compute elapsed cycles, carry the remainder, reschedule to
   * the next boundary. Also the tick body — the game calls it recursively. */
  start(): void {
    const now = this.#clock.now();
    let diff = now - this.#lastUpdate;
    if (diff < 0) {
      diff = 0;
      this.#lastUpdate = now;
    }
    const offset = diff % MILLI_PER_CYCLE;
    const cycles = Math.floor(diff / MILLI_PER_CYCLE);

    if (cycles > 0) {
      this.#lastUpdate = now - offset;
      this.updateGame(cycles);
    }

    this.#timer = this.#clock.in(MILLI_PER_CYCLE - offset, () => this.start());
  }

  stop(): void {
    if (this.#timer !== undefined) this.#clock.cancel(this.#timer);
    this.#timer = undefined;
  }

  updateGame(numCycles = 1): void {
    this.cyclesProcessed += numCycles;
    this.updates++;
    const s = this.#subsystems;

    s.processWork?.(numCycles);
    s.processStockPrices?.(numCycles);
    s.gangProcess?.(numCycles);
    s.staneksGiftProcess?.(numCycles);
    if (s.corporationStoreCycles) {
      s.corporationStoreCycles(numCycles);
      s.corporationProcess?.();
    }
    s.bladeburnerStoreCycles?.(numCycles);
    s.sleeveProcess?.(numCycles);
    s.processHacknetEarnings?.(numCycles);

    this.decrementAllCounters(numCycles);
    this.checkCounters();
  }

  decrementAllCounters(numCycles = 1): void {
    for (const name of Object.keys(this.counters)) this.counters[name]! -= numCycles;
  }

  /** Each counter fires at most ONCE per call, however negative it went. */
  checkCounters(): void {
    const s = this.#subsystems;

    if (this.counters["checkFactionInvitations"]! <= 0) {
      s.checkFactionInvitations?.();
      this.counters["checkFactionInvitations"] = 10;
    }
    if (this.counters["passiveFactionGrowth"]! <= 0) {
      // The one counter that compensates for a fat tick.
      const adjusted = Math.floor(5 - this.counters["passiveFactionGrowth"]!);
      s.processPassiveFactionRepGain?.(adjusted);
      this.counters["passiveFactionGrowth"] = 5;
    }
    if (this.counters["messages"]! <= 0) {
      this.counters["messages"] = 150;
    }
    if (this.counters["mechanicProcess"]! <= 0) {
      s.bladeburnerProcess?.();
      this.counters["mechanicProcess"] = 5;
    }
    if (this.counters["contractGeneration"]! <= 0) {
      s.generateContracts?.();
      this.counters["contractGeneration"] = 3000;
    }
    if (this.counters["achievementsCounter"]! <= 0) {
      this.counters["achievementsCounter"] = 5;
    }
    // Autosave is last in the game because it can serialise the world; keeping
    // the order means a future save-on-tick model lands in the right place.
    if (this.counters["autoSaveCounter"]! <= 0) {
      this.counters["autoSaveCounter"] = 300;
    }
  }
}

/** The storeCycles/bonus-time pattern shared by gang, bladeburner, corporation,
 * sleeves and Stanek: cycles accumulate while the game is throttled, then drain
 * at a capped multiple of real speed. `ns.*.getBonusTime()` reports
 * `stored * 200` in every one of them. */
export class CycleBuffer {
  stored = 0;
  readonly minToProcess: number;
  readonly maxPerProcess: number;

  constructor(minToProcess: number, maxPerProcess: number) {
    this.minToProcess = minToProcess;
    this.maxPerProcess = maxPerProcess;
  }

  store(cycles: number): void {
    this.stored += cycles;
  }

  /** Cycles to process now, or 0 when below the threshold. */
  take(): number {
    if (this.stored < this.minToProcess) return 0;
    const cycles = Math.min(this.stored, this.maxPerProcess);
    this.stored -= cycles;
    return cycles;
  }

  /** What ns.<subsystem>.getBonusTime() would report, in ms. */
  bonusTimeMs(): number {
    return this.stored * MILLI_PER_CYCLE;
  }
}

/** Per-subsystem buffers, with the caps that produce each documented
 * multiplier. Source: Gang.ts:99, Bladeburner.ts:1351, Corporation.ts:105,
 * Sleeve.ts:263 @ v3.0.1. */
export const BONUS_CAPS = {
  /** 2s minimum, 5s maximum -> "up to 25x". */
  gang: { min: 10, max: 25 },
  /** 1s ticks, at most 5 per process() -> "up to 5x". */
  bladeburner: { min: 5, max: 25 },
  /** One state cycle (2s) per engine tick -> "up to 10x". */
  corporation: { min: 10, max: 10 },
  /** 1s minimum, 3s maximum -> 15x. */
  sleeve: { min: 5, max: 15 },
  /** 1 cycle normally, 5 while charging -> 5x. */
  stanek: { min: 1, max: 5 },
} as const;
