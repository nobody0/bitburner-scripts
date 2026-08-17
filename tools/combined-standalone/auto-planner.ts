/** Automatic target selection for the combined standalone driver.
 *
 * Goal: spread wins across every opponent equally while minimizing idle
 * dodging. Each call plans exactly one next game and the driver replans after
 * every game (and after any miss or overrun), so recovery is inherent:
 *
 *   1. the enemy with the fewest wins is the target (ties break toward the
 *      enemy whose entries are rarest right now, i.e. the longer current
 *      dodge, so scarce windows are reserved rather than skipped);
 *   2. the target's next entry window defines a phase budget;
 *   3. the least-win filler whose own entry wait plus expected game length
 *      fits inside that budget plays first — replanning after it naturally
 *      asks "could I fit another?";
 *   4. when nothing fits, dodge to the target's window.
 */

export interface AutoPlanRoute {
  entryPhase: number;
  waits: number;
}

export interface AutoPlanInput {
  enemies: readonly string[];
  routeFor(enemy: string): AutoPlanRoute | undefined;
  winsFor(enemy: string): number;
  /** Expected phases a complete game against this enemy consumes after its
   * entry (driver-measured rolling mean). */
  expectedGamePhases(enemy: string): number;
  /** Targets whose next window is further than this are deferred to the next
   * candidate for this round only. */
  maxDodgePhases?: number;
}

export interface AutoPlanDecision {
  enemy: string;
  route: AutoPlanRoute;
  kind: "target" | "filler";
  target: string;
  targetWaits: number;
  reason: string;
}

export function planNextGame(input: AutoPlanInput): AutoPlanDecision {
  const maxDodge = input.maxDodgePhases ?? Number.POSITIVE_INFINITY;
  const candidates = input.enemies
    .map((enemy) => ({ enemy, route: input.routeFor(enemy), wins: input.winsFor(enemy) }))
    .filter((candidate): candidate is { enemy: string; route: AutoPlanRoute; wins: number } =>
      candidate.route !== undefined)
    .sort((left, right) => left.wins - right.wins
      || right.route.waits - left.route.waits
      || left.enemy.localeCompare(right.enemy));
  if (!candidates.length) throw new Error("no playable opponent routes");

  const target = candidates.find((candidate) => candidate.route.waits <= maxDodge)
    ?? candidates[0]!;
  for (const filler of candidates) {
    if (filler.enemy === target.enemy) continue;
    const cost = filler.route.waits + input.expectedGamePhases(filler.enemy);
    if (cost <= target.route.waits) {
      return {
        enemy: filler.enemy,
        route: filler.route,
        kind: "filler",
        target: target.enemy,
        targetWaits: target.route.waits,
        reason: `${filler.enemy} (${filler.wins} wins) fits in ~${Math.round(cost)} phases before `
          + `${target.enemy}'s window in ${target.route.waits}`,
      };
    }
  }
  return {
    enemy: target.enemy,
    route: target.route,
    kind: "target",
    target: target.enemy,
    targetWaits: target.route.waits,
    reason: `${target.enemy} has the fewest wins (${target.wins}); dodging ${target.route.waits} `
      + `phases to its next window`,
  };
}
