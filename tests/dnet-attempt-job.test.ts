import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { makeJobBodies } from "../game/dnet/jobs.ts";
import { checkPassword, logEntryFor, type PacketWorld } from "../sim/features/dnet-feedback.ts";
import { generateSecret, passwordRng } from "../sim/features/dnet-generators.ts";
import type { AttemptLedger } from "../shared/strategy/dnet/knowledge.ts";

/** The wiring, not the algorithms.
 *
 * `tests/dnet-solvers-vs-sim.test.ts` proves every solver opens a minted host.
 * What that cannot see is the half between them: whether `attemptJob` runs the
 * conversation in ONE process, whether it reads the response back out of the
 * log ring the way the game delivers it, whether it survives a host moving
 * mid-solve, and whether the place it got to actually rides home.
 *
 * Those are the parts that fail silently. A solver that is handed no oracle
 * looks like a solver that cannot solve; a job that restarts the conversation
 * every time looks like a slow net. So this drives the real job body against a
 * fake `ns` whose `authenticate` and `heartbleed` are backed by the simulator's
 * transcription of upstream. */

const world: PacketWorld = {
  movablePasswords: () => [],
  serverNames: () => ["darkweb"],
  lastAttempted: () => null,
  rand: () => 0.5,
};

interface Rig {
  ns: NS;
  /** Every password the job sent, in order. */
  sent: string[];
  /** How many times the log ring was read. */
  bleeds: number;
  /** Flip to make the host answer as though it had moved away. */
  moved: boolean;
  /** Flip to make the next authenticate time out. */
  timeoutOnce: boolean;
  password: string;
}

function rig(modelId: string, difficulty: number, opts: { charismaGate?: number } = {}): Rig {
  const host = "dn-1";
  const secret = generateSecret(modelId, difficulty, passwordRng(0.4242, host));
  const server = {
    modelId,
    hostname: host,
    password: secret.password,
    passwordHint: secret.hint,
    data: secret.data,
    difficulty,
  };
  const ring: string[] = [];
  const state: Rig = { ns: undefined as unknown as NS, sent: [], bleeds: 0, moved: false, timeoutOnce: false, password: secret.password };

  state.ns = {
    dnet: {
      getServerDetails: () => ({
        isOnline: true,
        isConnectedToCurrentServer: true,
        hasSession: false,
        modelId,
        passwordHint: secret.hint,
        data: secret.data,
        logTrafficInterval: 30,
        passwordLength: secret.passwordLength,
        passwordFormat: secret.passwordFormat,
        blockedRam: 0,
        difficulty,
        depth: 0,
        requiredCharismaSkill: opts.charismaGate ?? 1,
        isStationary: false,
      }),
      authenticate: (_target: string, password: string) => {
        state.sent.push(password);
        if (state.timeoutOnce) {
          state.timeoutOnce = false;
          // 408 fires AFTER the delay and BEFORE the model is consulted, so no
          // log line is written — that is the whole point of the case.
          return Promise.resolve({ success: false, code: 408, message: "RequestTimeOut" });
        }
        if (state.moved) return Promise.resolve({ success: false, code: 351, message: "DirectConnectionRequired" });
        const response = checkPassword(server, password, 1000, world);
        // The ring holds the JSON the game serialises, which is what
        // `heartbleed` hands back and `harvestLogs` parses.
        ring.push(JSON.stringify(logEntryFor(modelId, password, response.ok ? 200 : 401, response)));
        return Promise.resolve({
          success: response.ok,
          code: response.ok ? 200 : 401,
          message: response.message,
        });
      },
      heartbleed: () => {
        state.bleeds++;
        return Promise.resolve({ success: true, code: 200, message: "ok", logs: [...ring] });
      },
    },
    getServerMaxRam: () => 32,
    getServerUsedRam: () => 0,
    getHostname: () => host,
  } as unknown as NS;
  return state;
}

function bodies(ledger?: AttemptLedger) {
  return makeJobBodies({ charisma: () => 1000, ledgerFor: () => ledger });
}

describe("attemptJob runs the whole conversation in one process", () => {
  test("a feedback model is solved without ever leaving the job", () => {
    return (async () => {
      // AccountsManager needs ~7 exchanges. Under the old one-attempt-per-job
      // shape that was seven spawns and seven controller ticks.
      const r = rig("AccountsManager_4.2", 12);
      const result = await bodies().attempt!(r.ns, { host: "dn-1", from: "darkweb" });
      expect(result.ok, result.detail).toBe(true);
      expect(r.sent.length).toBeGreaterThan(1);
      expect(r.sent[r.sent.length - 1]).toBe(r.password);
      // Every exchange is reported, so the panel can see what the solve cost.
      expect(result.attempts?.length).toBe(r.sent.length);
      // And the credential comes home.
      expect(result.credentials?.some((c) => c.hostname === "dn-1" && c.via === "cracked")).toBe(true);
    })();
  });

  test("a closed-form model costs exactly one authenticate and never reads the ring", () => {
    return (async () => {
      const r = rig("DeskMemo_3.1", 2);
      const result = await bodies().attempt!(r.ns, { host: "dn-1", from: "darkweb" });
      expect(result.ok, result.detail).toBe(true);
      expect(r.sent).toEqual([r.password]);
      // One bleed is allowed AFTER success — the ring may hold a neighbour's
      // leaked password and that is free money. What must not happen is a read
      // to obtain feedback this model does not need.
      expect(r.bleeds).toBeLessThanOrEqual(1);
    })();
  });

  test("a timeout is retried without being charged, because it taught nothing", () => {
    return (async () => {
      const r = rig("AccountsManager_4.2", 12);
      r.timeoutOnce = true;
      const result = await bodies().attempt!(r.ns, { host: "dn-1", from: "darkweb" });
      expect(result.ok, result.detail).toBe(true);
      // The same guess is sent twice in a row: once into the timeout, once for
      // real. A solver that treated 408 as a refusal would have moved its search
      // bound on no information at all.
      expect(r.sent[0]).toBe(r.sent[1]);
      expect(result.codes?.["408"]).toBe(1);
    })();
  });
});

describe("a solve that loses its host keeps its place", () => {
  test("a host that moves mid-conversation ends the job but not the search", () => {
    return (async () => {
      const r = rig("AccountsManager_4.2", 12);
      const first = await bodies().attempt!(r.ns, { host: "dn-1", from: "darkweb" });
      expect(first.ok).toBe(true);

      // Now the same solve, interrupted after its opening move.
      const r2 = rig("AccountsManager_4.2", 12);
      const bodiesA = bodies();
      const stepOne = bodiesA.attempt!(r2.ns, { host: "dn-1", from: "darkweb" });
      r2.moved = true;
      const interrupted = await stepOne;
      expect(interrupted.ok).toBe(false);
      expect(interrupted.detail).toContain("vantage");
      // The state rides home on the last attempt, which is what the fold writes
      // into the ledger — otherwise the next vantage restarts the binary search
      // from scratch and the work is simply lost.
      const carried = interrupted.attempts?.[interrupted.attempts.length - 1]?.solver;
      expect(carried, "the solver's place was not carried home").toBeDefined();
      expect((carried as Record<string, unknown>)["fingerprint"]).toBeDefined();
    })();
  });

  test("a carried state is resumed rather than restarted", () => {
    return (async () => {
      // Run once to get a genuine mid-solve state.
      const r = rig("AccountsManager_4.2", 16);
      const partial = bodies().attempt!(r.ns, { host: "dn-1", from: "darkweb" });
      r.moved = true;
      const stopped = await partial;
      const carried = stopped.attempts?.[stopped.attempts.length - 1]?.solver as Record<string, unknown>;
      expect(carried).toBeDefined();

      // A fresh job on a fresh rig for the SAME host, handed that ledger.
      const r2 = rig("AccountsManager_4.2", 16);
      const resumed = await bodies({ tried: 0, probes: 0, solver: carried }).attempt!(
        r2.ns,
        { host: "dn-1", from: "darkweb" },
      );
      expect(resumed.ok, resumed.detail).toBe(true);
      // The proof it resumed: the opening guess of a fresh solve is the midpoint
      // of the whole range, and this one is not that.
      const freshOpening = r.sent[0];
      expect(r2.sent[0]).not.toBe(freshOpening);
    })();
  });

  test("a state belonging to a DIFFERENT identity is discarded, not resumed", () => {
    return (async () => {
      // Hostnames are recycled upstream, so a ledger can outlive the machine it
      // describes. Resuming onto a new password would never terminate.
      const foreign = { model: "AccountsManager_4.2", fingerprint: "not-this-host", phase: "search", spent: 3, scratch: { lo: 9000, hi: 9999 } };
      const r = rig("AccountsManager_4.2", 12);
      const result = await bodies({ tried: 0, probes: 0, solver: foreign }).attempt!(
        r.ns,
        { host: "dn-1", from: "darkweb" },
      );
      expect(result.ok, result.detail).toBe(true);
    })();
  });
});

describe("the charisma gate decides which models can be attempted at all", () => {
  test("below the gate a feedback model reports that its oracle was unreadable", () => {
    return (async () => {
      // heartbleed is the one charisma-gated call, so under the gate the job
      // cannot read the response — and must say so by name rather than looking
      // like a solver that failed.
      const r = rig("AccountsManager_4.2", 12, { charismaGate: 5000 });
      const result = await bodies().attempt!(r.ns, { host: "dn-1", from: "darkweb" });
      expect(result.ok).toBe(false);
      expect(result.codes?.["908"]).toBe(1);
      expect(r.bleeds).toBe(0);
    })();
  });

  test("below the gate a CLOSED-FORM model still opens the host", () => {
    return (async () => {
      // The whole reason these are worth shipping first: the answer arrives in
      // authenticate's own return value, so charisma is irrelevant.
      const r = rig("CloudBlare(tm)", 2, { charismaGate: 5000 });
      const result = await bodies().attempt!(r.ns, { host: "dn-1", from: "darkweb" });
      expect(result.ok, result.detail).toBe(true);
      expect(r.bleeds).toBe(0);
    })();
  });
});
