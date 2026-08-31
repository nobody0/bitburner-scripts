import { isSweepableFile } from "../shared/deployment.ts";
import type { RfaSession } from "./rfa-session.ts";

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

/** Remove every stale artifact of this project from `hosts`. The staging
 * caller decides whether a refusal is fatal or deferred. */
export async function sweepStaleFiles(
  session: RfaSession,
  owned: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  hosts: readonly string[],
): Promise<string[]> {
  const deleted: string[] = [];
  for (const host of hosts) {
    const names = await session.getFileNames(host);
    for (const filename of planSweep(names, owned, keep)) {
      if (!await session.deleteFile(host, filename)) {
        throw new Error(`failed to delete stale file ${host}:${filename}`);
      }
      deleted.push(`${host}:${filename}`);
    }
  }
  return deleted;
}
