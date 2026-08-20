/** What an agent is told, and in what order.
 *
 * Args only — free, atomic, and guaranteed present at exec, which is all a scout
 * needs. There is deliberately no encoder here: nothing launches a scout
 * automatically yet (that waits on the simulator's darknet model), so an
 * arg-builder would be a contract with no caller. Until then a scout is launched
 * by hand, and this is the order:
 *
 *     run dnet/scout.js <missionId> <generation> <identityJson> <port> <charisma>
 *
 * `generation` ties the report to the world it was gathered in and must match
 * what the controller publishes (`<bitNode>:<lastAugReset>`), or the fold will
 * correctly discard it. */

export interface ParsedMissionArgs {
  missionId: string;
  generation: string;
  /** JSON ArtifactIdentity, so the agent's telemetry lands in the same run
   *  artifact as the controller's without reading the page realm. */
  identity: string;
  port: number;
  /** Charisma at launch. A scout cannot afford getPlayer (0.5 GB), and it needs
   *  this to know which hosts it may heartbleed at all. */
  charisma: number;
}

/** Returns undefined rather than throwing: an agent launched with the wrong
 * argument shape should exit quietly, not crash into the game's log. */
export function parseMissionArgs(args: readonly unknown[]): ParsedMissionArgs | undefined {
  if (args.length < 5) return undefined;
  const [missionId, generation, identity, port, charisma] = args;
  if (typeof missionId !== "string" || typeof generation !== "string" || typeof identity !== "string") return undefined;
  if (typeof port !== "number" || typeof charisma !== "number") return undefined;
  return { missionId, generation, identity, port, charisma };
}
