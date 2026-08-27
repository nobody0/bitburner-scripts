import { makeOrder } from './support/dnet-order.ts';
import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { runOrder } from "../game/dnet/orders.ts";
import {
  DNET_PROTOCOL,
  dnetRealm,
  type AgentIo,
  type ControllerDeps,
  type ControllerHandle,
  type Order,
  type OrderKind,
} from "../game/dnet/shared.ts";
import { checkPassword, logEntryFor, type PacketWorld } from "../sim/features/dnet-feedback.ts";
import { generateSecret, passwordRng } from "../sim/features/dnet-generators.ts";
import type { AttemptLedger } from "../shared/strategy/dnet/host.ts";
import type { ProvisionalCredential, VaultEntry } from "../shared/strategy/dnet/courier.ts";

/** The wiring, not the algorithms.
 *
 * `tests/dnet-solvers-vs-sim.test.ts` proves every solver opens a minted host.
 * What that cannot see is the half between them: whether the `attempt` order
 * runs the conversation in ONE process, whether it reads the response back out
 * of the log ring the way the game delivers it, whether it survives a host
 * moving mid-solve, and whether the place it got to actually rides home.
 *
 * Those are the parts that fail silently. A solver that is handed no oracle
 * looks like a solver that cannot solve; a job that restarts the conversation
 * every time looks like a slow net. So this drives the real order body against a
 * fake `ns` whose `authenticate` and `heartbleed` are backed by the simulator's
 * transcription of upstream. */

const world: PacketWorld = {
  movablePasswords: () => [],
  serverNames: () => ["darkweb"],
  lastAttempted: () => null,
  rand: () => 0.5,
};


function makeDeps(over: Partial<ControllerDeps> = {}): ControllerDeps {
  return {
    charisma: () => 1000,
    ledgerFor: () => undefined,
    ringFor: () => undefined,
    recordAttempt: () => {},
    recordLogDrain: () => {},
    recordCredential: () => {},
    recordLoose: () => {},
    recordProvisional: () => {},
    recordNeighbourPassword: () => {},
    recordFileEvidence: () => {},
    labField: () => undefined,
    publishLabField: () => {},
    ...over,
    timing: over.timing ?? (() => ({ charisma: 1_000, intelligence: 0, hasBoots: false, sf15Level: 0, authenticationDurationMultiplier: 1 })),
    expectedDelayMs: over.expectedDelayMs ?? (() => 0),
  };
}

/** The `io` an agent hands the order body, with test hooks where needed. */
function makeIo(
  ledger?: AttemptLedger,
  over: Partial<ControllerDeps> = {},
  cancelled?: () => string | undefined,
): AgentIo {
  return {
    beat: () => {},
    setExpectedDoneAt: () => {},
    hold: () => {},
  inFlight: () => {},
    cancelled: cancelled ?? (() => undefined),
    deps: makeDeps({ ledgerFor: () => ledger, ...over }),
  };
}

interface Rig {
  ns: NS;
  /** Every password the job sent, in order. */
  sent: string[];
  /** How many times the log ring was read. */
  /** Options prove reads consume the complete upstream ring. */
  bleedOptions: { peek: boolean; logsToCapture: number }[];
  bleeds: number;
  /** Flip to make the host answer as though it had moved away. */
  moved: boolean;
  /** Refuse calls after this many authenticate requests. */
  moveAfter?: number;
  /** Flip to make the next authenticate time out. */
  timeoutOnce: boolean;
  password: string;
}

function rig(modelId: string, difficulty: number, opts: { charismaGate?: number; initialLogs?: string[] } = {}): Rig {
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
  // The host's facts come from the CONTROLLER'S MAP now, not from a call the
  // body makes. Every script shares one realm, so a worker reads what the
  // controller already folded for nothing — where `dnet.getServerDetails`
  // charged 0.1 GB on every thread to re-learn it. Publishing the record here
  // is what the real controller's own describe does.
  dnetRealm().dnet_controller = {
    protocol: DNET_PROTOCOL,
    hosts: new Map([[host, {
      hostname: host,
      lastSeenAt: 0,
      seenAt: {},
      dirty: {},
      modelId,
      passwordHint: secret.hint,
      data: secret.data,
      logTrafficInterval: 30,
      passwordLength: secret.passwordLength,
      passwordFormat: secret.passwordFormat,
      blockedRam: 0,
      difficulty,
      depth: 0,
      requiredCharisma: opts.charismaGate ?? 1,
      isStationary: false,
    }]]),
  } as unknown as ControllerHandle;

  const ring: string[] = [...(opts.initialLogs ?? [])];
  const state: Rig = { ns: undefined as unknown as NS, sent: [], bleeds: 0, bleedOptions: [], moved: false, timeoutOnce: false, password: secret.password };

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
      // The engine's own gate: a session is granted only when the host is
      // ALREADY rooted and the password is right. This rig's hosts start
      // unrooted, so every check falls through to `authenticate` — which is
      // what makes these cases still exercise the expensive path.
      connectToSession: (_target: string, _password: string) =>
        ({ success: false, code: 401, message: "Unauthorized" }),
      authenticate: (_target: string, password: string) => {
        state.sent.push(password);
        if (state.timeoutOnce) {
          state.timeoutOnce = false;
          // 408 fires AFTER the delay and BEFORE the model is consulted, so no
          // log line is written — that is the whole point of the case.
          return Promise.resolve({ success: false, code: 408, message: "RequestTimeOut" });
        }
        if (state.moved || (state.moveAfter !== undefined && state.sent.length > state.moveAfter)) {
          return Promise.resolve({ success: false, code: 351, message: "DirectConnectionRequired" });
        }
        const response = checkPassword(server, password, 1000, world);
        // The ring holds the JSON the game serialises, which is what
        // `heartbleed` hands back and `harvestLogs` parses.
        ring.unshift(JSON.stringify(logEntryFor(modelId, password, response.ok ? 200 : 401, response)));
        return Promise.resolve({
          success: response.ok,
          code: response.ok ? 200 : 401,
          message: response.message,
        });
      },
      heartbleed: (_target: string, options: { peek: boolean; logsToCapture: number }) => {
        state.bleeds++;
        state.bleedOptions.push(options);
        const logs = ring.slice(0, options.logsToCapture);
        if (!options.peek) ring.splice(0, options.logsToCapture);
        return Promise.resolve({ success: true, code: 200, message: "ok", logs });
      },
    },
    getServerMaxRam: () => 32,
    getServerUsedRam: () => 0,
    // A successful authenticate can create this without mentioning the roll
    // in its response. The job must return the post-auth listing.
    ls: () => ["auth-reward.cache"],
  } as unknown as NS;
  return state;
}

describe("the attempt order runs the whole conversation in one process", () => {
  test("a feedback model is solved without ever leaving the job", () => {
    return (async () => {
      // AccountsManager needs ~7 exchanges. Under the old one-attempt-per-job
      // shape that was seven spawns and seven controller ticks.
      const r = rig("AccountsManager_4.2", 12);
      const recovered: VaultEntry[] = [];
      const drained: number[] = [];
      const result = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb", targetIdentity: "10.0.0.1" }, { needsRing: true }), makeIo(undefined, {
        recordCredential: (entry) => recovered.push(entry),
        recordLogDrain: (_host, outcome) => drained.push(outcome.pendingAuthRecords),
      }));
      expect(result.ok, result.detail).toBe(true);
      expect(r.sent.length).toBeGreaterThan(1);
      expect(r.sent[r.sent.length - 1]).toBe(r.password);
      // Every exchange is reported, so the panel can see what the solve cost.
      expect(result.attempts?.length).toBe(r.sent.length);
      // A win may have dropped a `.cache`, but the job does not `ls` for it — that
      // would be 0.2 GB per authenticate thread. It flags the host dirty and the
      // controller files one instant list job.
      expect(result.hosts?.[0]?.invalidates).toEqual(["files"]);
      expect(result.hosts?.[0]?.caches).toBeUndefined();
      // And the credential writes through before the job settles.
      expect(recovered).toContainEqual({
        hostname: "dn-1",
        identity: "10.0.0.1",
        password: r.password,
        at: expect.any(Number),
      });
      expect(r.bleedOptions.every((options) => !options.peek && options.logsToCapture === 200)).toBe(true);
      // The successful record stays pending: credential write-through happens
      // synchronously, and planting must not wait for one more heartbleed.
      expect(drained.at(-1)).toBe(1);
      expect(r.bleedOptions).toHaveLength(r.sent.length);
    })();
  });

  test("a closed-form model costs one authenticate and needs no log feedback", () => {
    return (async () => {
      const r = rig("DeskMemo_3.1", 2);
      const result = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
      expect(result.ok, result.detail).toBe(true);
      expect(r.sent).toEqual([r.password]);
      // The initial drain protects existing logs from the capped-ring prepend.
      // Success writes the credential through and leaves its record for the
      // later background drain rather than delaying the plant handoff.
      expect(r.bleeds).toBe(1);
    })();
  });

  test("a completed standalone initial drain is not repeated by the first attempt", async () => {
    const r = rig("DeskMemo_3.1", 2);
    const result = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo(undefined, {
      ringFor: () => ({ pendingAuthRecords: 0, lastBleedAttemptAt: 1, lastBleedAt: 1 }),
    }));
    expect(result.ok, result.detail).toBe(true);
    // The successful authentication record remains for the later background
    // drain, so this already-drained host needs no heartbleed in the hot path.
    expect(r.bleeds).toBe(0);
  });

  test("existing leaks are drained before authenticate can evict them, but stay provisional", async () => {
    const r = rig("DeskMemo_3.1", 2, {
      initialLogs: ["Connecting to dn-2:swordfish ..."],
    });
    const recovered: VaultEntry[] = [];
    const candidates: ProvisionalCredential[] = [];
    await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo(undefined, {
      recordCredential: (entry) => recovered.push(entry),
      recordProvisional: (entry) => candidates.push(entry),
    }));
    expect(candidates).toContainEqual({ hostname: "dn-2", password: "swordfish", via: "connecting", at: expect.any(Number) });
    expect(recovered.some((entry) => entry.hostname === "dn-2")).toBe(false);
    expect(r.bleedOptions[0]).toEqual({ peek: false, logsToCapture: 200 });
  });

  test("a pre-drained leak for the current host is authenticated before the model solver", async () => {
    const r = rig("DeskMemo_3.1", 2);
    const leaked = r.password;
    const withLeak = rig("DeskMemo_3.1", 2, {
      initialLogs: [`Logging in with passcode: ${leaked} ...`],
    });
    const result = await runOrder(withLeak.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
    expect(result.ok, result.detail).toBe(true);
    expect(withLeak.sent).toEqual([leaked]);
  });

  test("attempts and log drains write through to the target ledger as they happen", async () => {
    const r = rig("AccountsManager_4.2", 12);
    const recordedAttempts: string[] = [];
    const drains: { pendingAuthRecords: number; attemptedAt?: number; drainedAt?: number }[] = [];
    const io = makeIo(undefined, {
      recordAttempt: (_host, outcome) => recordedAttempts.push(outcome.attempted ?? ""),
      recordLogDrain: (_host, outcome) => drains.push(outcome),
    });
    const result = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), io);
    expect(result.ok, result.detail).toBe(true);
    expect([...new Set(recordedAttempts)]).toEqual(r.sent);
    expect(drains.some((outcome) => outcome.pendingAuthRecords === 1)).toBe(true);
    expect(drains[drains.length - 1]).toMatchObject({
      pendingAuthRecords: 1,
      attemptedAt: expect.any(Number),
    });
  });

  test("a timeout is retried without being charged, because it taught nothing", () => {
    return (async () => {
      const r = rig("AccountsManager_4.2", 12);
      r.timeoutOnce = true;
      const result = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
      expect(result.ok, result.detail).toBe(true);
      // The same guess is sent twice in a row: once into the timeout, once for
      // real. A solver that treated 408 as a refusal would have moved its search
      // bound on no information at all.
      expect(r.sent[0]).toBe(r.sent[1]);
      expect(result.codes?.["408"]).toBe(1);
    })();
  });

  test("cooperative cancellation stops before the next authenticate boundary", async () => {
    const r = rig("DeskMemo_3.1", 2);
    const result = await runOrder(
      r.ns,
      makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }),
      makeIo(undefined, {}, () => "credential was verified elsewhere"),
    );
    expect(result.targetState).toBe("cancelled");
    expect(r.sent).toEqual([]);
  });
});

describe("a solve that loses its host keeps its place", () => {
  test("a host that moves mid-conversation ends the job but not the search", () => {
    return (async () => {
      const r = rig("AccountsManager_4.2", 12);
      const first = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
      expect(first.ok).toBe(true);

      // Now the same solve, interrupted after its opening move.
      const r2 = rig("AccountsManager_4.2", 12);
      r2.moveAfter = 1;
      const interrupted = await runOrder(r2.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
      expect(interrupted.ok).toBe(false);
      expect(interrupted.targetState).toBe("edge-lost");
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
      r.moveAfter = 1;
      const stopped = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
      const carried = stopped.attempts?.[stopped.attempts.length - 1]?.solver as Record<string, unknown>;
      expect(carried).toBeDefined();

      // A fresh job on a fresh rig for the SAME host, handed that ledger.
      const r2 = rig("AccountsManager_4.2", 16);
      const resumed = await runOrder(
        r2.ns,
        makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }),
        makeIo({ tried: 0, probes: 0, solver: carried }),
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
      const result = await runOrder(
        r.ns,
        makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }),
        makeIo({ tried: 0, probes: 0, solver: foreign }),
      );
      expect(result.ok, result.detail).toBe(true);
    })();
  });

  test("a timeout while resending a pending attempt retries that same attempt", async () => {
    const firstRig = rig("AccountsManager_4.2", 16);
    firstRig.moveAfter = 1;
    const stopped = await runOrder(firstRig.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
    const carried = stopped.attempts?.at(-1)?.solver as Record<string, unknown>;
    expect(carried).toBeDefined();

    const resumedRig = rig("AccountsManager_4.2", 16);
    resumedRig.timeoutOnce = true;
    const resumed = await runOrder(
      resumedRig.ns,
      makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }),
      makeIo({ tried: 0, probes: 0, solver: carried }),
    );
    expect(resumed.ok, resumed.detail).toBe(true);
    expect(resumedRig.sent[0]).toBe(resumedRig.sent[1]);
    expect(resumed.codes?.["408"]).toBe(1);
  });
});

describe("a verified credential is bound to the server lifetime", () => {
  const plantNs = (identity: string) => ({
    dnet: {
      connectToSession: () => ({ success: false, code: 401, message: "wrong" }),
      authenticate: () => Promise.resolve({ success: false, code: 401, message: "wrong" }),
      getServerDetails: () => ({ isOnline: true }),
    },
    dnsLookup: () => identity,
  }) as unknown as NS;

  test("a 401 on the same identity quarantines only the credential", async () => {
    const result = await runOrder(plantNs("10.0.0.1"), makeOrder("plant", { host: "dn-1", from: "darkweb" }, { targets: [{ host: "dn-1", password: "formerly-right", identity: "10.0.0.1" }], payloads: [] }), makeIo());
    expect(result.targetState).toBe("credential-rejected");
  });

  test("a 401 with a changed IP proves hostname reuse", async () => {
    const result = await runOrder(plantNs("10.0.0.2"), makeOrder("plant", { host: "dn-1", from: "darkweb" }, { targets: [{ host: "dn-1", password: "formerly-right", identity: "10.0.0.1" }], payloads: [] }), makeIo());
    expect(result.targetState).toBe("replaced");
  });

  test("an ambiguous scp refusal is not mislabeled as RAM exhaustion", async () => {
    const ns = {
      dnet: {
        connectToSession: () => ({ success: true, code: 200, message: "ok" }),
        getServerDetails: () => ({ isOnline: true }),
      },
      dnsLookup: () => "10.0.0.1",
      scp: () => false,
    } as unknown as NS;
    const result = await runOrder(ns, makeOrder("plant", { host: "dn-1", from: "darkweb" }, { targets: [{ host: "dn-1", password: "right", identity: "10.0.0.1" }], payloads: ["agent.js", "prober.js"] }), makeIo());
    expect(result.targetState).toBe("launch-refused");
    expect(result.codes?.["903"]).toBeUndefined();
    expect(result.codes?.["913"]).toBe(1);
  });
});

describe("the charisma gate decides which models can be attempted at all", () => {
  test("below the gate a feedback model reports that its oracle was unreadable", () => {
    return (async () => {
      // heartbleed is the one charisma-gated call, so under the gate the job
      // cannot read the response — and must say so by name rather than looking
      // like a solver that failed.
      const r = rig("AccountsManager_4.2", 12, { charismaGate: 5000 });
      const result = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
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
      const result = await runOrder(r.ns, makeOrder("attempt", { host: "dn-1", from: "darkweb" }, { needsRing: true }), makeIo());
      expect(result.ok, result.detail).toBe(true);
      expect(r.bleeds).toBe(0);
    })();
  });
});

describe("a lean attempt never touches the ring it was not priced for", () => {
  test("no heartbleed, whatever the ring holds", async () => {
    // One script runs one Netscript call at a time, so an attempt cannot bleed
    // while it authenticates. Declaring both charged `heartbleed`'s 0.6 GB on
    // EVERY thread of a thread-scaled kind, for a call most attempts never
    // make — and threads are the only thing that shortens `authenticate`.
    //
    // So the common attempt is priced lean, and this is the guarantee that
    // makes that safe: a lean process which reached `heartbleed` would exceed
    // its `ramOverride` and die, taking the host's agent with it. The initial
    // drain and the ring-full harvest are both gated on the same condition, so
    // neither can fire here.
    const r = rig("DeskMemo_3.1", 2);
    const io = makeIo({ tried: 0, probes: 0 }, {
      // A ring that is BOTH undrained and full: every reason to bleed at once.
      ringFor: () => ({ pendingAuthRecords: 999 }),
    });
    const result = await runOrder(
      r.ns,
      // No `needsRing` in the payload IS the lean attempt.
      makeOrder("attempt", { host: "dn-1", from: "darkweb" }, {}),
      io,
    );
    // Whether it opened the host or not is beside the point; what matters is
    // that it did its work without ever reaching for the ring.
    expect(result).toBeDefined();
    expect(r.bleeds, "a lean attempt bled; it is not priced for that call").toBe(0);
    expect(r.sent.length, "a lean attempt did no work at all").toBeGreaterThan(0);
  });
});
