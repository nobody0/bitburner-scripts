/** WHO PAYS THE 2 GB.
 *
 * A prober cannot defend the host it stands on with `exec`. `killServerScripts`
 * drives one live iterator across the host's running-script map and runs each
 * `atExit` synchronously inside it, so anything a handler starts here is
 * appended to the map being walked and killed by the same sweep. Only
 * `ns.spawn` with a non-zero delay escapes, because upstream schedules it on a
 * `setTimeout` it never cancels — and that costs 2.0 GB on top of the prober.
 *
 * Paying it everywhere is a bad trade and we have the number: the spread lane
 * measures stranded capacity at a fraction of what a blanket fleet reserve
 * would cost. Two things justify the spend, and they are different KINDS of
 * argument:
 *
 * - **A storm we are about to fire.** Not a hazard rate at all — a certainty.
 *   `restartAllDarknetServers` restarts every movable survivor at once, so an
 *   unarmoured fleet loses every resident it has. Worth it for the seconds
 *   around the burst even at a poor steady-state price.
 * - **A backdoor.** The engine draws a restart victim from the backdoored pool
 *   alone at 10% per tick, and that branch RETURNS. `msPerRestartOfHost`
 *   (`rates.ts`) splits that term from the generic draw: a backdoored host is
 *   more than an order of magnitude hotter than a plain one, for as long as the
 *   backdoor stands.
 *
 * There is deliberately no third, arithmetic rung weighing a host's capacity
 * against its hazard. One was built and measured, and it lost: it armed most of
 * the fleet most of the time for no further recovery, because the net replants
 * itself in the same virtual instant for 96% of restarts. It was removed rather
 * than left switched off. If recovery ever gets slower that is the thing to
 * rebuild — `spec/dnet.md` keeps the storm rung's numbers as the bar to beat.
 *
 * Nothing here is a fact about our processes — it is a fact about the ENGINE's
 * appetite for each host — which is why it lives beside `planStorm` rather than
 * in the controller. */

export interface ArmourCandidate {
  hostname: string;
  /** Free RAM on top of any armour this host already wears, so the 2 GB can be
   *  checked before it is promised. */
  usableGb?: number;
  /** A live backdoor we installed, which is what puts this host in the engine's
   *  targeted restart pool. */
  backdoored?: boolean;
  /** Exempt: `restartServer` returns early on `hasStasisLink`, so armour here
   *  would be a reserve that could never be drawn on. */
  stasisLinked?: boolean;
  /** A prober is standing here to armour. An empty host has nothing to resize —
   *  the plant that arrives will size its own. */
  proberStanding?: boolean;
  goneAt?: number;
  /** The lab candidate carries no prober at all. */
  omitProber?: boolean;
}

export interface ArmourContext {
  /** A storm is being fired now, or is already burning — `StormPlan.imminent`.
   *  NOT "a storm could fire soon": that is the established net's resting state
   *  and arming on it was measured and rejected. */
  stormImminent: boolean;
  /** What `spawn` costs, passed in rather than imported so this layer stays
   *  free of `game/`. */
  armourGb: number;
}

/** The hosts that SHOULD wear armour. Callers diff this against what is
 * actually standing; nothing here knows about processes. */
export function planArmour(
  candidates: readonly ArmourCandidate[],
  ctx: ArmourContext,
): Set<string> {
  const armour = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.goneAt !== undefined) continue;
    if (candidate.stasisLinked === true) continue;
    if (candidate.omitProber === true) continue;
    if (candidate.proberStanding !== true) continue;
    // Unknown RAM never reads as room: the same rule the spread planner keeps,
    // because an exec against unknown capacity returns a silent 0.
    if (candidate.usableGb === undefined || candidate.usableGb < ctx.armourGb) continue;
    // The engine clears a backdoor as it restarts, so an unarmoured backdoored
    // host loses both at once.
    if (ctx.stormImminent || candidate.backdoored === true) armour.add(candidate.hostname);
  }
  return armour;
}
