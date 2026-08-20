import { isSweepableFile } from "../shared/deployment.ts";
import type { RfaSession } from "./rfa-session.ts";

export interface SweepResult {
  deleted: string[];
  /** Files the game refused to delete — normally the outgoing build's workers,
   * which are still running. They clear on the next sync. */
  skipped: string[];
  hosts: number;
}

/** Pure half: which of `fileNames` this sweep would delete. Kept free of I/O so
 * the ownership rule can be tested against a real in-game listing without a
 * socket. */
export function planSweep(
  fileNames: readonly string[],
  owned: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): string[] {
  return fileNames.filter((filename) => isSweepableFile(filename, owned, keep)).sort();
}

/** Remove every stale artifact of this project from `hosts`.
 *
 * A refusal is never fatal: `deleteFile` returns false for a script the game is
 * still running, which is exactly what protects the outgoing generation during
 * a build handoff. */
export async function sweepStaleFiles(
  session: RfaSession,
  owned: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  hosts: readonly string[],
  options: { dryRun?: boolean } = {},
): Promise<SweepResult> {
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const host of hosts) {
    const names = await session.getFileNames(host).catch(() => undefined);
    // A host that cannot be listed is skipped rather than aborting the sweep:
    // the fleet changes between the server listing and this loop.
    if (!names) continue;
    for (const filename of planSweep(names, owned, keep)) {
      if (options.dryRun) {
        deleted.push(`${host}:${filename}`);
        continue;
      }
      if (await session.deleteFile(host, filename)) deleted.push(`${host}:${filename}`);
      else skipped.push(`${host}:${filename}`);
    }
  }
  return { deleted, skipped, hosts: hosts.length };
}
