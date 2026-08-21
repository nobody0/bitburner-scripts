/** What an agent is told, and in what order.
 *
 * Args only — free, atomic, and guaranteed present at launch. An agent reads its
 * whole identity here rather than from the page realm, so a resident planted by
 * a controller that has since died still knows which run it belongs to.
 *
 * Two shapes, because there are two roles:
 *
 *     run dnet/overseer.js <missionId> <generation> <identityJson> <charisma> <agentFile>
 *     run dnet/agent.js    <missionId> <generation> <identityJson> <role> <agentId> [jobId]
 *
 * The agent's optional SIXTH argument selects its mode: absent, it is the host's
 * resident; present, it is the one job with that id. One binary in two modes,
 * the way `game/lib/dodge-stub.ts` serves both dodge lanes — and one fewer
 * artifact to sync, scp and keep versioned on every host we ever reach.
 *
 * There are no port numbers here any more. Everything the darknet says travels
 * through the `globalThis` rendezvous: a resident registers itself there, the
 * controller finds it there, and home reads the controller's state there. See
 * `game/dnet/realm.ts` for why that is sound and what it costs.
 *
 * `generation` ties everything to the world it was gathered in and must match
 * what the controller publishes (`<bitNode>:<lastAugReset>`). Agents outlive
 * controllers, so this is not a formality: a live script from a dead run really
 * can still be talking to us. */

export type AgentRole = "overseer" | "resident";

export const AGENT_ROLES: readonly AgentRole[] = ["overseer", "resident"];

function isRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

export interface OverseerArgs {
  missionId: string;
  generation: string;
  /** JSON ArtifactIdentity, so the agent's telemetry lands in the same run
   *  artifact as the controller's without reading the page realm. */
  identity: string;
  /** Charisma at launch. The controller cannot afford `getPlayer` (0.5 GB out of
   *  1.65), and it needs this to know which hosts a job may heartbleed at all.
   *  Refreshed by home through the rendezvous rather than re-read. */
  charisma: number;
  /** The build-versioned agent filename. The controller spreads what home
   *  shipped and never constructs a filename itself, so a build handoff cannot
   *  leave it exec'ing a version that is no longer on disk. */
  agentFile: string;
}

export interface WorkerArgs {
  missionId: string;
  generation: string;
  identity: string;
  role: AgentRole;
  /** For the panel and the log. A host's queue is keyed by hostname, so identity
   *  does not depend on this. */
  agentId: string;
}

export function overseerArgs(args: OverseerArgs): (string | number)[] {
  return [args.missionId, args.generation, args.identity, args.charisma, args.agentFile];
}

export function workerArgs(args: WorkerArgs): (string | number)[] {
  return [args.missionId, args.generation, args.identity, args.role, args.agentId];
}

/** Returns undefined rather than throwing: an agent launched with the wrong
 * argument shape should exit quietly, not crash into the game's log. Nothing
 * else can have happened yet, so there is nothing to report either. */
export function parseOverseerArgs(args: readonly unknown[]): OverseerArgs | undefined {
  if (args.length < 5) return undefined;
  const [missionId, generation, identity, charisma, agentFile] = args;
  if (typeof missionId !== "string" || typeof generation !== "string" || typeof identity !== "string") return undefined;
  if (typeof charisma !== "number" || typeof agentFile !== "string") return undefined;
  return { missionId, generation, identity, charisma, agentFile };
}

export function parseWorkerArgs(args: readonly unknown[]): WorkerArgs | undefined {
  if (args.length < 5) return undefined;
  const [missionId, generation, identity, role, agentId] = args;
  if (typeof missionId !== "string" || typeof generation !== "string" || typeof identity !== "string") return undefined;
  if (!isRole(role) || typeof agentId !== "string") return undefined;
  return { missionId, generation, identity, role, agentId };
}

/** The job id an agent was launched with, when it was launched as a job rather
 * than as a resident. Positional, so it lives here beside the parsers. */
export function jobIdFrom(args: readonly unknown[]): string | undefined {
  return typeof args[5] === "string" ? args[5] : undefined;
}

/** Args for a resident, as a job that plants one must pass them on. Kept beside
 * the parsers so the positional order exists in exactly one place. */
export function residentArgs(base: Omit<WorkerArgs, "role">): (string | number)[] {
  return workerArgs({ ...base, role: "resident" });
}
