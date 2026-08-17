/** Persistent audit trail for production-arena seed use.
 *
 * Raw playtime seeds are not identities: the game quantizes them to 200 ms and
 * wraps after 30,000 seconds. Freshness is therefore checked against every
 * effective playtime, handicap, and defense value used for the same opponent.
 */
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { goProfileArenaSeedCases } from "../sim/go-arena.ts";
import { GO_PROFILE_CANDIDATE_LIMITS } from "../shared/strategy/go/neural/engine.ts";
import type { GoProfileArenaConfig } from "./go-profile-arena.ts";

export const DEFAULT_GO_ARENA_SEED_LEDGER = join(
  import.meta.dir,
  "..",
  "go-ai",
  "promotion-seeds.json",
);

export interface GoArenaSeedUse {
  id: string;
  recordedAt: string;
  kind: "screen" | "promotion-dry-run" | "promotion-apply" | "derivative-dry-run" | "derivative-apply";
  profile: GoProfileArenaConfig["profile"];
  gamesPerOpponent: number;
  seed: number;
  effectiveFirstSeed: number;
  handicapSeed: number;
  defenseSeed: number;
  candidateSha256: string[];
  /** Effective finalist budget the corpus was played at. Absent on records
   * written before the per-profile table existed; those all used the engine
   * default of their era. Freshness never reads this field — a corpus is
   * burned regardless of K. */
  candidateLimit?: number;
}

export interface GoArenaSeedLedger {
  schema: "go-arena-promotion-seeds-v1";
  uses: GoArenaSeedUse[];
}

export interface GoArenaSeedConflict {
  priorUseId: string;
  opponent: string;
  stream: "playtime" | "handicap" | "defense";
  value: number;
}

export function seedUseFromConfig(
  config: GoProfileArenaConfig,
  kind: GoArenaSeedUse["kind"],
  candidateSha256: readonly string[],
  recordedAt = new Date().toISOString(),
): GoArenaSeedUse {
  const effectiveFirstSeed = goProfileArenaSeedCases(
    config.profile,
    1,
    config.seed,
    config.handicapSeed,
    config.defenseSeed,
  )[0]!.cases[0]!.seed;
  return {
    id: `${recordedAt}-${kind}-${config.profile}`,
    recordedAt,
    kind,
    profile: config.profile,
    gamesPerOpponent: config.games,
    seed: config.seed,
    effectiveFirstSeed,
    handicapSeed: config.handicapSeed,
    defenseSeed: config.defenseSeed,
    candidateSha256: [...candidateSha256],
    candidateLimit: config.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[config.profile],
  };
}

function firstOverlap(left: readonly number[], right: readonly number[]): number | undefined {
  const smaller = left.length <= right.length ? left : right;
  const larger = left.length <= right.length ? right : left;
  const values = new Set(smaller);
  return larger.find((value) => values.has(value));
}

export function findGoArenaSeedConflicts(
  requested: GoArenaSeedUse,
  priorUses: readonly GoArenaSeedUse[],
): GoArenaSeedConflict[] {
  const requestedCorpora = goProfileArenaSeedCases(
    requested.profile,
    requested.gamesPerOpponent,
    requested.seed,
    requested.handicapSeed,
    requested.defenseSeed,
  );
  const conflicts: GoArenaSeedConflict[] = [];
  for (const prior of priorUses) {
    if (prior.profile !== requested.profile) continue;
    const priorCorpora = goProfileArenaSeedCases(
      prior.profile,
      prior.gamesPerOpponent,
      prior.seed,
      prior.handicapSeed,
      prior.defenseSeed,
    );
    for (const requestedCorpus of requestedCorpora) {
      const priorCorpus = priorCorpora.find((value) => value.opponent === requestedCorpus.opponent);
      if (!priorCorpus) continue;
      for (const stream of ["seed", "handicapSeed", "defenseSeed"] as const) {
        const overlap = firstOverlap(
          requestedCorpus.cases.map((value) => value[stream]),
          priorCorpus.cases.map((value) => value[stream]),
        );
        if (overlap !== undefined) {
          conflicts.push({
            priorUseId: prior.id,
            opponent: requestedCorpus.opponent,
            stream: stream === "seed" ? "playtime" : stream === "handicapSeed" ? "handicap" : "defense",
            value: overlap,
          });
        }
      }
    }
  }
  return conflicts;
}

export async function readGoArenaSeedLedger(path = DEFAULT_GO_ARENA_SEED_LEDGER): Promise<GoArenaSeedLedger> {
  if (!await Bun.file(path).exists()) return { schema: "go-arena-promotion-seeds-v1", uses: [] };
  const ledger = await Bun.file(path).json() as Partial<GoArenaSeedLedger>;
  if (ledger.schema !== "go-arena-promotion-seeds-v1" || !Array.isArray(ledger.uses)) {
    throw new Error(`invalid Go arena seed ledger ${path}`);
  }
  return ledger as GoArenaSeedLedger;
}

export function writeGoArenaSeedLedger(path: string, ledger: GoArenaSeedLedger): void {
  const temporary = join(dirname(path), `.promotion-seeds-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

/** Record before evaluation. A crash or rejected gate still burns the corpus. */
export async function recordGoArenaSeedUse(
  use: GoArenaSeedUse,
  path = DEFAULT_GO_ARENA_SEED_LEDGER,
  requireFresh = false,
): Promise<void> {
  const ledger = await readGoArenaSeedLedger(path);
  if (requireFresh) {
    const conflicts = findGoArenaSeedConflicts(use, ledger.uses);
    if (conflicts.length) {
      const first = conflicts[0]!;
      throw new Error(`arena corpus is not fresh: ${first.stream} value ${first.value} for `
        + `${first.opponent} was used by ${first.priorUseId}`);
    }
  }
  ledger.uses.push(use);
  writeGoArenaSeedLedger(path, ledger);
}
