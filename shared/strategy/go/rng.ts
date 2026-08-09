/** Exact Wichmann-Hill stream used by IPvGO v3.0.1. The seed accepted by the
 * game is Player.totalPlaytime in milliseconds. */
export function whrng(totalPlaytimeMs: number, count = 1): number[] {
  const seed = (totalPlaytimeMs / 1000) % 30000;
  let s1 = seed;
  let s2 = seed;
  let s3 = seed;
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    s1 = (171 * s1) % 30269;
    s2 = (172 * s2) % 30307;
    s3 = (170 * s3) % 30323;
    values.push((s1 / 30269 + s2 / 30307 + s3 / 30323) % 1);
  }
  return values;
}

/** Player.totalPlaytime advances by this amount in Engine.updateGame(). */
export const GO_ENGINE_CYCLE_MS = 200;

/** The AI waits once before constructing WHRNG. Bonus time shortens this wall
 * wait, but it does not change totalPlaytime's 200 ms engine-cycle quantum. */
export function goAiWaitMs(bonusCycles = 0): number {
  return bonusCycles > 0 ? 40 : 200;
}

export interface GoWaitResult {
  wallMs: number;
  bonusCycles: number;
}

/** Apply the game's waitCycle rule exactly: a positive stored-cycle balance
 * buys a 40 ms wait and is decremented by two (and may therefore reach -1). */
export function consumeGoWaits(bonusCycles: number, count: number): GoWaitResult {
  let remaining = bonusCycles;
  let wallMs = 0;
  for (let index = 0; index < Math.max(0, Math.floor(count)); index++) {
    if (remaining > 0) {
      remaining -= 2;
      wallMs += 40;
    } else {
      wallMs += GO_ENGINE_CYCLE_MS;
    }
  }
  return { wallMs, bonusCycles: remaining };
}

/** Seed obtained when black dispatches immediately after observing the given
 * engine tick. The AI constructs WHRNG after its first waitCycle. */
export function alignedAiSeed(dispatchPlaytimeMs: number, bonusCycles = 0): number {
  return dispatchPlaytimeMs + (bonusCycles > 0 ? 0 : GO_ENGINE_CYCLE_MS);
}

export interface GoResponseTiming {
  responseWallMs: number;
  responsePlaytimeMs: number;
  bonusCycles: number;
  /** Neutral later engine tick reserved for the precomputed continuation. */
  nextDispatchPlaytimeMs: number;
  nextSeed: number;
}

/** Propagate one predicted white branch to the distinct seed of the following
 * white turn. `dispatchPlaytimeMs` is a freshly observed tick. Pattern sleeps
 * advance wall time but, like all timers, affect totalPlaytime only through
 * the engine's 200 ms quantization. */
export function nextGoTurnTiming(
  dispatchPlaytimeMs: number,
  bonusCycles: number,
  trace: { cycleWaitsAfterSeed: number; fixedSleepMsAfterSeed: number },
  dispatchLeadCycles = 3,
): GoResponseTiming {
  const initial = consumeGoWaits(bonusCycles, 1);
  const remainder = consumeGoWaits(initial.bonusCycles, trace.cycleWaitsAfterSeed);
  const responseWallMs = initial.wallMs + remainder.wallMs + trace.fixedSleepMsAfterSeed;
  const elapsedTicks = Math.floor(responseWallMs / GO_ENGINE_CYCLE_MS);
  const responsePlaytimeMs = dispatchPlaytimeMs + elapsedTicks * GO_ENGINE_CYCLE_MS;
  const nextDispatchPlaytimeMs = responsePlaytimeMs
    + Math.max(1, Math.floor(dispatchLeadCycles)) * GO_ENGINE_CYCLE_MS;
  return {
    responseWallMs,
    responsePlaytimeMs,
    bonusCycles: remainder.bonusCycles,
    nextDispatchPlaytimeMs,
    nextSeed: alignedAiSeed(nextDispatchPlaytimeMs, remainder.bonusCycles),
  };
}
