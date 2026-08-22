import { describe, expect, test } from "bun:test";
import {
  MAX_LOG_LINES,
  expectedNewLines,
  logTrafficInterval,
  looseCandidates,
  shouldListen,
  valuablePerLine,
  rankListening,
  type ListenTarget,
} from "../shared/strategy/dnet/listen.ts";

/** When a heartbleed is worth its 0.6 GB and its authentication-time-and-a-half.
 *
 * The two refusals are the point. A host that has written nothing since we last
 * looked, and a host that CAN only write things we already know, both cost the
 * same to bleed and both pay nothing — but they clear on completely different
 * events, so they must not read alike. */

const target = (over: Partial<ListenTarget> & { hostname: string }): ListenTarget => ({
  hasCredential: false,
  uncrackedNeighbours: 0,
  topologyStale: false,
  solveInFlight: false,
  ...over,
});

const NOW = 1_000_000;

describe("the line count is predictable without any call", () => {
  test("chattiness runs BACKWARDS from intuition: deep hosts write more", () => {
    // Restating `1 + 30 * 0.9^d` would prove nothing. What the ranking actually
    // depends on is the direction — and it is the opposite of what "deep servers
    // are quiet and careful" would suggest.
    const intervals = [0, 10, 20, 30].map(logTrafficInterval);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]!, "a deeper host must write MORE often").toBeLessThan(intervals[i - 1]!);
    }
    // The two ends, because the ratio is what makes deep hosts worth bleeding.
    expect(intervals[0]!).toBeGreaterThan(30);
    expect(intervals[3]!).toBeLessThan(3);
  });

  test("lines are the back-fill's own arithmetic", () => {
    // missingLogs = floor(msSinceLastLog / (interval * 1000)).
    expect(expectedNewLines(30, 90_000)).toBe(3);
    expect(expectedNewLines(30, 29_000)).toBe(0);
    expect(expectedNewLines(2.5, 10_000)).toBe(4);
  });

  test("the ring is capped, so waiting forever banks nothing more", () => {
    expect(expectedNewLines(1, 10 ** 9)).toBe(MAX_LOG_LINES);
  });
});

describe("a host that can only write spam is refused by name", () => {
  test("everything known and nothing in flight means every line is worthless", () => {
    // Branches 2, 4, 5 and 7 all need something we lack; 1 and 8 are spam and
    // heartbeat; 3 needs stale adjacency. That leaves nothing.
    const owned = target({
      hostname: "dn-1",
      hasCredential: true,
      uncrackedNeighbours: 0,
      topologyStale: false,
      solveInFlight: false,
      difficulty: 4,
      lastBleedAt: NOW - 10 * 60_000,
    });
    // ...and the net holds nothing else we cannot open, so even the net-wide
    // branch 6 lottery has no prize left.
    const done = { netHasUncrackedMovable: false };
    expect(valuablePerLine(owned, done)).toBe(0);
    const verdict = shouldListen(owned, NOW, done);
    expect(verdict.worth).toBe(false);
    expect(verdict.refusal).toBe("nothing-to-learn");
  });

  test("a fully-owned host is a LISTENING POST while any movable host is closed", () => {
    // Branch 6 leaks a random movable host's password from ANY host. Discounting
    // it as "we will get that from whatever we were bleeding anyway" fails in
    // exactly the state where it matters: with the local neighbourhood owned,
    // every other branch is zero, so we would bleed nothing and collect nothing
    // while the frontier elsewhere is still closed.
    const owned = target({ hostname: "dn-1", hasCredential: true, difficulty: 0, lastBleedAt: 0 });
    expect(valuablePerLine(owned, { netHasUncrackedMovable: true })).toBeGreaterThan(0);
    expect(valuablePerLine(owned, { netHasUncrackedMovable: false })).toBe(0);
    // And it really is worth a call, not merely non-zero.
    expect(shouldListen(owned, NOW, { netHasUncrackedMovable: true }).worth).toBe(true);
  });

  test("a host with plenty to say is still refused until it has SAID it", () => {
    // The two refusals are independent, and this one clears itself by waiting.
    const quiet = target({ hostname: "dn-1", difficulty: 0, lastBleedAt: NOW - 5_000 });
    const verdict = shouldListen(quiet, NOW);
    expect(verdict.worth).toBe(false);
    expect(verdict.refusal).toBe("no-new-lines");
    // Same host, one interval later.
    expect(shouldListen(quiet, NOW + 31_000).worth).toBe(true);
  });

  test("above the charisma requirement it refuses for a third, different reason", () => {
    const verdict = shouldListen(
      target({ hostname: "dn-1", lastBleedAt: 0 }),
      NOW,
      { netHasUncrackedMovable: true, charismaOk: false },
    );
    expect(verdict.refusal).toBe("charisma");
  });
});

describe("each branch is a reason on its own", () => {
  const base = { hostname: "dn-1", difficulty: 4, hasCredential: true, lastBleedAt: 0 };

  test("any single unknown is enough, and knowing everything is the only zero", () => {
    // One case per branch that can carry value, driven from a table rather than
    // four near-identical tests — so a new branch in the noise generator means a
    // new row here, not a new copy of the same three lines.
    const reasons: [string, Partial<ListenTarget>][] = [
      // A neighbour's plaintext password (branch 2), and the packet sniffer's
      // neighbour leak (branch 7).
      ["an uncracked neighbour", { uncrackedNeighbours: 2 }],
      // The characters of our LAST attempt (branch 4). A model's feedback exists
      // nowhere else: authenticate returns a generic failure and writes the real
      // response to the ring.
      ["a solve in flight", { solveInFlight: true }],
      // One topology edge (branch 3).
      ["stale adjacency", { topologyStale: true }],
      // Two characters of its own password (branch 5), and the sniffer's own
      // leak (branch 7).
      ["not holding its own password", { hasCredential: false }],
    ];
    for (const [why, over] of reasons) {
      expect(valuablePerLine(target({ ...base, ...over })), `${why} should be worth listening for`)
        .toBeGreaterThan(0);
    }
    // And the control: with none of them true and the net exhausted, it is zero.
    expect(valuablePerLine(target(base), { netHasUncrackedMovable: false })).toBe(0);
  });
});

describe("the two scaling laws pull opposite ways", () => {
  test("a deep host is better for cracking ITSELF", () => {
    // Branch 5 (two of its own characters) is 10% regardless of difficulty, and
    // a deep host writes ~13x more lines per second.
    const shallow = target({ hostname: "s", difficulty: 0, lastBleedAt: 0 });
    const deep = target({ hostname: "d", difficulty: 30, lastBleedAt: 0 });
    const window = 60_000;
    const shallowValue = shouldListen(shallow, window).value;
    const deepValue = shouldListen(deep, window).value;
    expect(deepValue).toBeGreaterThan(shallowValue);
  });

  test("a shallow host is better per line for its NEIGHBOURS' passwords", () => {
    // Branch 2 scales as 1/(difficulty+1): 5% at difficulty 0, 0.16% at 30.
    const shallow = target({ hostname: "s", difficulty: 0, hasCredential: true, uncrackedNeighbours: 3 });
    const deep = target({ hostname: "d", difficulty: 30, hasCredential: true, uncrackedNeighbours: 3 });
    expect(valuablePerLine(shallow)).toBeGreaterThan(valuablePerLine(deep));
  });

  test("a packet sniffer outranks both, at any depth", () => {
    // Branch 7 fires up to 70% of the time and leaks a real password either way.
    // This is the model whose noise alone can hand over a credential, and it is
    // why bleeding hosts we do NOT own is worth doing at all.
    const sniffer = target({ hostname: "sniff", difficulty: 4, modelId: "OpenWebAccessPoint", uncrackedNeighbours: 1 });
    const ordinary = target({ hostname: "plain", difficulty: 4, uncrackedNeighbours: 1 });
    expect(valuablePerLine(sniffer)).toBeGreaterThan(valuablePerLine(ordinary) * 3);
  });

  test("a sniffer we already own, with owned neighbours, is still worthless", () => {
    // The model does not exempt it from the predicate — value comes from what we
    // LACK, never from what the host is.
    const owned = target({
      hostname: "sniff",
      difficulty: 4,
      modelId: "OpenWebAccessPoint",
      hasCredential: true,
      uncrackedNeighbours: 0,
    });
    expect(valuablePerLine(owned)).toBe(0);
  });
});

describe("ranking picks the host with the most to say", () => {
  test("only worthwhile hosts are returned, best first", () => {
    const ranked = rankListening([
      target({ hostname: "silent", hasCredential: true, difficulty: 4, lastBleedAt: 0 }),
      target({ hostname: "chatty", difficulty: 20, lastBleedAt: 0 }),
      target({ hostname: "sniffer", difficulty: 20, modelId: "OpenWebAccessPoint", uncrackedNeighbours: 2, lastBleedAt: 0 }),
    ], NOW);
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.value).toBeGreaterThan(ranked[1]!.value);
  });

  test("a fully-known neighbourhood still listens while the NET has anything closed", () => {
    const hosts = [
      target({ hostname: "a", hasCredential: true, difficulty: 4, lastBleedAt: 0 }),
      target({ hostname: "b", hasCredential: true, difficulty: 9, lastBleedAt: 0 }),
    ];
    expect(rankListening(hosts, NOW, { netHasUncrackedMovable: true }).length).toBe(2);
    // Only a fully-cracked net finally silences them.
    expect(rankListening(hosts, NOW, { netHasUncrackedMovable: false })).toEqual([]);
  });
});

describe("an unattributed password is spent, not filed away", () => {
  /** Numeric / alphabetic / alphanumeric, as `getPasswordType` decides it. */
  const formatOf = (password: string): string => {
    if (/^[0-9]+$/.test(password)) return "numeric";
    if (/^[a-zA-Z]+$/.test(password)) return "alphabetic";
    return "alphanumeric";
  };

  const host = (over: Partial<Parameters<typeof looseCandidates>[1][number]> & { hostname: string }) => ({
    hasCredential: false,
    ...over,
  });

  test("length and format narrow a bare password to the hosts it could open", () => {
    // Both are IDENTITY facts, so they never expire underneath the guess.
    const guesses = looseCandidates(
      ["4821"],
      [
        host({ hostname: "match", passwordLength: 4, passwordFormat: "numeric" }),
        host({ hostname: "too-long", passwordLength: 6, passwordFormat: "numeric" }),
        host({ hostname: "wrong-format", passwordLength: 4, passwordFormat: "alphabetic" }),
      ],
      formatOf,
    );
    expect(guesses.map((g) => g.hostname)).toEqual(["match"]);
    expect(guesses[0]!.password).toBe("4821");
  });

  test("a host we can already open is never guessed at", () => {
    const guesses = looseCandidates(
      ["4821"],
      [host({ hostname: "owned", passwordLength: 4, passwordFormat: "numeric", hasCredential: true })],
      formatOf,
    );
    expect(guesses).toEqual([]);
  });

  test("a stationary host is never a candidate, because the leak is drawn from the MOVABLE pool", () => {
    // getAllMovableDarknetServers excludes isStationary, so darkweb and the
    // labyrinth can never be the owner of a leaked password.
    const guesses = looseCandidates(
      ["4821"],
      [host({ hostname: "darkweb", passwordLength: 4, passwordFormat: "numeric", isStationary: true })],
      formatOf,
    );
    expect(guesses).toEqual([]);
  });

  test("a host we have not surveyed is still a candidate, since nothing rules it out", () => {
    // Missing facts must not silently exclude: an unsurveyed host is exactly the
    // kind we most want a free credential for.
    const guesses = looseCandidates(["4821"], [host({ hostname: "unknown" })], formatOf);
    expect(guesses.map((g) => g.hostname)).toEqual(["unknown"]);
  });

  test("the same pair is never offered twice, and the order is stable", () => {
    const hosts = [
      host({ hostname: "b", passwordLength: 4, passwordFormat: "numeric" }),
      host({ hostname: "a", passwordLength: 4, passwordFormat: "numeric" }),
    ];
    const guesses = looseCandidates(["4821", "4821"], hosts, formatOf);
    expect(guesses.map((g) => g.hostname)).toEqual(["a", "b"]);
  });
});
