import { describe, expect, test } from "bun:test";
import { ownedDirectories } from "../shared/deployment.ts";
import type { RfaSession } from "../tools/rfa-session.ts";
import { planSweep, sweepStaleFiles } from "../tools/rfa-sweep.ts";
import { selectSweepHosts } from "../tools/sync.ts";

const OWNED = ownedDirectories(["start.js", "lib/ns-resident.js", "worker/worker.js"]);
const KEEP = new Set(["worker/worker.js", "lib/ns-resident.js"]);

/** Transcribed from a real `ls -l` on home: every category of file the game
 * generates, a player-authored file, the run-lineage file the controller writes
 * itself, our current helpers, and stale files in directories this project owns. */
const HOME_LISTING = [
  "19dfj3l1nd.msg",
  "csec-test.msg",
  "nitesec-test.msg",
  "j0.msg",
  "j1.msg",
  "j2.msg",
  "j3.msg",
  "j4.msg",
  "hackers-starting-handbook.lit",
  "BruteSSH.exe",
  "FTPCrack.exe",
  "Formulas.exe",
  "HTTPWorm.exe",
  "NUKE.exe",
  "SQLInject.exe",
  "relaySMTP.exe",
  "DeepscanV1.exe",
  "contract-4823-foodnstuff.cct",
  "start.js",
  "restore.js",
  "restore-payload.txt",
  "notes.txt",
  "data/run-lineage.txt",
  "worker/worker.js",
  "worker/unused.js",
  "worker/diagnostic.js",
  "lib/ns-resident.js",
  "lib/obsolete.js",
];

function fakeSession(
  listings: Record<string, string[]>,
  refuse: ReadonlySet<string> = new Set(),
): { session: RfaSession; deletions: string[] } {
  const deletions: string[] = [];
  const session = {
    getFileNames: (server: string) =>
      listings[server] ? Promise.resolve(listings[server]) : Promise.reject(new Error("no such server")),
    deleteFile: (server: string, filename: string) => {
      deletions.push(`${server}:${filename}`);
      return Promise.resolve(!refuse.has(filename));
    },
  } as unknown as RfaSession;
  return { session, deletions };
}

describe("sync stale-file sweep", () => {
  test("includes darkweb even though the game does not mark it rooted", () => {
    expect(selectSweepHosts("home", [
      { hostname: "home", hasAdminRights: true },
      { hostname: "darkweb", hasAdminRights: false },
      { hostname: "rooted", hasAdminRights: true },
      { hostname: "locked", hasAdminRights: false },
    ])).toEqual(["home", "darkweb", "rooted"]);
  });

  test("deletes only this project's stale artifacts, never a game or player file", () => {
    expect(planSweep(HOME_LISTING, OWNED, KEEP)).toEqual([
      "lib/obsolete.js",
      "worker/diagnostic.js",
      "worker/unused.js",
    ]);
  });

  test("leaves everything alone when nothing is stale", () => {
    const stale = new Set(["lib/obsolete.js", "worker/diagnostic.js", "worker/unused.js"]);
    const current = HOME_LISTING.filter((name) => !stale.has(name));
    expect(planSweep(current, OWNED, KEEP)).toEqual([]);
  });

  test("reports a refused delete to its caller", async () => {
    const { session, deletions } = fakeSession(
      { home: HOME_LISTING },
      new Set(["worker/unused.js"]),
    );
    await expect(sweepStaleFiles(session, OWNED, KEEP, ["home"])).rejects.toThrow("failed to delete stale file");
    expect(deletions).toHaveLength(3);
  });

  test("reports an unlistable host to its caller", async () => {
    const { session, deletions } = fakeSession({ home: HOME_LISTING, blade: ["worker/unused.js"] });
    await expect(sweepStaleFiles(session, OWNED, KEEP, ["home", "vanished", "blade"])).rejects.toThrow("no such server");
    expect(deletions).toHaveLength(3);
  });
});
