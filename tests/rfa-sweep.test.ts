import { describe, expect, test } from "bun:test";
import { ownedDirectories } from "../shared/deployment.ts";
import type { RfaSession } from "../tools/rfa-session.ts";
import { planSweep, sweepStaleFiles } from "../tools/rfa-sweep.ts";

const OWNED = ownedDirectories(["start.js", "lib/dodge-stub.js", "worker/worker.js"]);
const KEEP = new Set(["worker/worker.new-id.js", "lib/dodge-stub.new-id.js"]);

/** Transcribed from a real `ls -l` on home: every category of file the game
 * generates, a player-authored file, the run-lineage file the controller writes
 * itself, and several accumulated generations of our own helpers. */
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
  "build-id.txt",
  "start.js",
  "restore.js",
  "restore-payload.txt",
  "notes.txt",
  "data/run-lineage.txt",
  "worker/worker.new-id.js",
  "worker/worker.old-id.js",
  "worker/worker.older-id.js",
  "worker/starter.js",
  "lib/dodge-stub.new-id.js",
  "lib/dodge-stub.old-id.js",
  "lib/go-dodge-stub.old-id.js",
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
  test("deletes only this project's stale artifacts, never a game or player file", () => {
    expect(planSweep(HOME_LISTING, OWNED, KEEP)).toEqual([
      "lib/dodge-stub.old-id.js",
      "lib/go-dodge-stub.old-id.js",
      "worker/starter.js",
      "worker/worker.old-id.js",
      "worker/worker.older-id.js",
    ]);
  });

  test("leaves everything alone when nothing is stale", () => {
    const current = HOME_LISTING.filter((name) => !name.includes("old") && name !== "worker/starter.js");
    expect(planSweep(current, OWNED, KEEP)).toEqual([]);
  });

  test("a refused delete is a skip, not a failed sync", async () => {
    const { session, deletions } = fakeSession(
      { home: HOME_LISTING },
      new Set(["worker/worker.old-id.js"]),
    );
    const result = await sweepStaleFiles(session, OWNED, KEEP, ["home"]);
    expect(result.skipped).toEqual(["home:worker/worker.old-id.js"]);
    expect(result.deleted).toHaveLength(4);
    expect(deletions).toHaveLength(5);
  });

  test("a dry run deletes nothing", async () => {
    const { session, deletions } = fakeSession({ home: HOME_LISTING });
    const result = await sweepStaleFiles(session, OWNED, KEEP, ["home"], { dryRun: true });
    expect(deletions).toEqual([]);
    expect(result.deleted).toHaveLength(5);
  });

  test("an unlistable host is skipped rather than aborting the fleet sweep", async () => {
    const { session, deletions } = fakeSession({ home: HOME_LISTING, blade: ["worker/worker.old-id.js"] });
    const result = await sweepStaleFiles(session, OWNED, KEEP, ["home", "vanished", "blade"]);
    expect(result.deleted).toContain("blade:worker/worker.old-id.js");
    expect(deletions).toHaveLength(6);
  });
});
