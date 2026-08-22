/** What an agent is told, and in what order.
 *
 * Args only — free, atomic, and guaranteed present at launch. An agent reads its
 * whole identity here rather than from the page realm, so a resident planted by
 * an overseer that has since died still knows which run it belongs to.
 *
 * Two shapes, because there are two roles (always launched via `ns.exec` from
 * home, or `ns.spawn` from the agent itself — never typed at a terminal):
 *
 *     dnet/overseer.js <missionId> <generation> <identityJson> <charisma> <agentFile>
 *     dnet/agent.js    <missionId> <generation> <identityJson> <role> <agentId> [jobId]
 *
 * The agent's optional SIXTH argument selects its mode: absent, it is the host's
 * resident; present, it is the one job with that id. One binary in two modes,
 * the way `game/lib/dodge-stub.ts` serves both dodge lanes — and one fewer
 * artifact to sync, scp and keep versioned on every host we ever reach.
 *
 * There are no port numbers here any more. Everything the darknet says travels
 * through the `globalThis` rendezvous: a resident registers itself there, the
 * overseer finds it there, and home reads the overseer's state there. See
 * `game/dnet/realm.ts` for why that is sound and what it costs.
 *
 * `generation` ties everything to the world it was gathered in and must match
 * what the overseer publishes (`<bitNode>:<lastAugReset>`). Agents outlive
 * overseers, so this is not a formality: a live script from a dead run really
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
   *  artifact as the overseer's without reading the page realm. */
  identity: string;
  /** Charisma at launch. The overseer cannot afford `getPlayer` (0.5 GB out of
   *  1.65), and it needs this to know which hosts a job may heartbleed at all.
   *  Refreshed by home through the rendezvous rather than re-read. */
  charisma: number;
  /** The build-versioned agent filename. The overseer spreads what home
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

/** How many arguments a RESIDENT carries. The sixth, when present, is a job id,
 * and every spawn carries the first five forward unchanged. It lives here rather
 * than in `game/dnet/agent.ts` because it is a property of the positional
 * contract this file owns, and the agent is the only reader left. */
const RESIDENT_ARG_COUNT = 5;

/** The job id an agent was launched with. Private: `parseAgentMode` is the only
 * caller, because reading the mode out of two places is how "argv length six"
 * became an unwritten rule in the first place. */
function jobIdFrom(args: readonly unknown[]): string | undefined {
  return typeof args[RESIDENT_ARG_COUNT] === "string" ? args[RESIDENT_ARG_COUNT] : undefined;
}

/** What an agent process was launched to BE, named rather than inferred.
 *
 * The two modes used to be told apart by argv length at the call site, which
 * made the positional contract something a reader had to reconstruct from a
 * `slice(0, 5)` and an index. Naming it puts the whole rule in this file. */
export type AgentMode =
  | { kind: "resident"; mission: WorkerArgs }
  | { kind: "job"; mission: WorkerArgs; jobId: string };

export function parseAgentMode(args: readonly unknown[]): AgentMode | undefined {
  const mission = parseWorkerArgs(args);
  if (!mission) return undefined;
  const jobId = jobIdFrom(args);
  return jobId === undefined ? { kind: "resident", mission } : { kind: "job", mission, jobId };
}

/** The arguments a spawn back to resident mode must carry: this process's own,
 * minus any job id. Takes the raw args rather than a `WorkerArgs` so a resident
 * re-launches itself with exactly what it was given, byte for byte. */
export function residentArgsFrom(args: readonly unknown[]): (string | number)[] {
  return args.slice(0, RESIDENT_ARG_COUNT) as (string | number)[];
}

/** Args for a resident, as a job that plants one must pass them on. Kept beside
 * the parsers so the positional order exists in exactly one place. */
export function residentArgs(base: Omit<WorkerArgs, "role">): (string | number)[] {
  return workerArgs({ ...base, role: "resident" });
}
