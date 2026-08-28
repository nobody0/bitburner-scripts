import { describe, expect, test } from "bun:test";
import { capturePackets, type PacketWorld } from "../sim/features/dnet-feedback.ts";
import { mulberry32 } from "../sim/core/rng.ts";
import { PACKET_SNIFF_PHRASES } from "../shared/strategy/dnet/phrases.ts";
import {
  extractPacketCredentials,
  harvestLogs,
  logShape,
  looseCandidates,
  parseHeartbleedLine,
} from "../shared/strategy/dnet/oracle.ts";


/** Every fixture here is a literal from the pinned checkout
 * (src/DarkNet/models/packetSniffing.ts), not an invention. That matters more
 * than usual: this parser reads strings the game builds with template literals,
 * so a near-miss does not fail loudly — it silently drops a free password.
 *
 * The credential cases are the ones worth reading. The BitNode's own description
 * promises "weak passwords and leaky logs", and these lines are the leak: a
 * neighbour's plaintext password, handed over by a call that needs no session. */

describe("the log lines that hand over a password", () => {
  test("`Connecting to <host>:<password> ...` attributes the credential", () => {
    // getLogNoise: `Connecting to ${connectedServerName}:${connectedServer.password} ...`
    const capture = parseHeartbleedLine("Connecting to dn-4-2:hunter2 ...");
    expect(capture).toEqual({ kind: "credential", host: "dn-4-2", password: "hunter2", via: "connecting" });
  });

  test("a password containing punctuation survives the parse", () => {
    // getPassword can emit alphanumerics, and the hostname/password split is on
    // the FIRST colon, so a greedy match would eat the host.
    const capture = parseHeartbleedLine("Connecting to zenith-networks:a1b2:c3 ...");
    expect(capture).toEqual({
      kind: "credential",
      host: "zenith-networks",
      password: "a1b2:c3",
      via: "connecting",
    });
  });

  test("`Logging in with passcode:` is the bleeding host's OWN password", () => {
    // addPacketSnifferNoise: `Logging in with passcode: ${server.password} ...`
    // It names no host because upstream never had to; attribution comes from
    // knowing which server we bled.
    expect(parseHeartbleedLine("Logging in with passcode: 4815 ...")).toEqual({
      kind: "credential",
      password: "4815",
      via: "passcode",
    });
    const attributed = harvestLogs(["Logging in with passcode: 4815 ..."], { bledFrom: "dn-2-0" });
    expect(attributed.credentials).toEqual([
      { kind: "credential", host: "dn-2-0", password: "4815", via: "passcode" },
    ]);
    // Without the host it degrades to a loose candidate rather than being
    // attributed to the wrong server, which would cost a wasted authenticate.
    expect(harvestLogs(["Logging in with passcode: 4815 ..."]).loose).toEqual(["4815"]);
  });

  test("`--<password>--` is a real password belonging to nobody in particular", () => {
    // getLogNoise picks a random MOVABLE server, so this is a live credential
    // with no owner attached — worth spraying, not worth trusting.
    const summary = harvestLogs(["--swordfish--"], { bledFrom: "dn-1-1" });
    expect(summary.loose).toEqual(["swordfish"]);
    expect(summary.credentials).toEqual([]);
  });

  test("the empty-password form is parsed rather than counted as drift", () => {
    expect(parseHeartbleedLine("----")).toEqual({
      kind: "credential",
      password: "",
      via: "bare",
    });
  });

  test("a capturePackets blob gives up the host:password pair buried in it", () => {
    // capturePackets embeds ` ${hostname}:${password} ` at a random offset in
    // ~130 characters of dictionary junk when difficulty <= 16.
    const blob = "123456monkeyXVII dn-3-5:qwerty letmein/Chongqing/football";
    expect(extractPacketCredentials(blob)).toContainEqual({
      kind: "credential",
      host: "dn-3-5",
      password: "qwerty",
      via: "packet",
    });
  });

  test("a packet blob arriving as an oracle's data is mined too", () => {
    // packetSniffer returns its blob as the failed attempt's `data`, so the
    // credential arrives wrapped in an authentication record rather than as a
    // noise line. Callers must not have to know which model they hit.
    const line = JSON.stringify({
      code: 401,
      message: "Unauthorized",
      passwordAttempted: "0000",
      data: "filler dn-6-1:trustno1 filler",
    });
    const summary = harvestLogs([line], { bledFrom: "dn-6-1" });
    expect(summary.oracles).toHaveLength(1);
    expect(summary.credentials).toContainEqual({
      kind: "credential",
      host: "dn-6-1",
      password: "trustno1",
      via: "packet",
    });
  });

  test("a packet blob can carry a whole unattributed password too", () => {
    const line = JSON.stringify({
      code: 401,
      passwordAttempted: "0000",
      data: "packet-prefix--swordfish--packet-suffix",
    });
    const summary = harvestLogs([line], { bledFrom: "dn-6-1" });
    expect(summary.loose).toContain("swordfish");
  });
});

describe("the authentication record is the model oracle", () => {
  test("a JSON PasswordResponse parses into its fields", () => {
    // This is the ONLY way model feedback reaches a script: authenticate()
    // returns a generic failure, and heartbleed JSON-stringifies the log entry.
    const line = JSON.stringify({
      code: 401,
      message: "Hint: 2 symbols are match exactly,  and 1 symbol match but is in the wrong place.",
      data: "2,1",
      passwordAttempted: "1234",
    });
    expect(parseHeartbleedLine(line)).toEqual({
      kind: "oracle",
      code: 401,
      message: "Hint: 2 symbols are match exactly,  and 1 symbol match but is in the wrong place.",
      data: "2,1",
      passwordAttempted: "1234",
    });
  });

  test("Pr0verFl0's split buffer is kept, because it is oracle output", () => {
    // logPasswordAttempt rewrites the buffer-overflow entry into
    // {code, passwordAttempted: bufferPart, passwordExpected: overflow, message}.
    // `passwordExpected` is NOT the server's password — it is what the attempt
    // overwrote — so it must survive the parse and the report redaction alike.
    const line = JSON.stringify({
      code: 401,
      message: "auth failed: received 'ˍˍˍˍ', expected '■■■■'",
      passwordAttempted: "ˍˍˍˍ",
      passwordExpected: "■■■■",
    });
    const capture = parseHeartbleedLine(line);
    expect(capture.kind).toBe("oracle");
    expect(capture.kind === "oracle" && capture.passwordExpected).toBe("■■■■");
  });

  test("a non-string data payload is normalised rather than dropped", () => {
    // `data` is `any` upstream. Losing it would throw away the oracle for
    // whichever model happens to answer with a number.
    const line = JSON.stringify({ code: 401, passwordAttempted: "5", data: 42 });
    const capture = parseHeartbleedLine(line);
    expect(capture.kind === "oracle" && capture.data).toBe("42");
  });

  test("JSON that is not an authentication record is not mistaken for one", () => {
    expect(parseHeartbleedLine('{"unrelated":true}').kind).toBe("noise");
    expect(parseHeartbleedLine("{not json at all").kind).toBe("noise");
  });
});

describe("the partial hints, which constrain rather than reveal", () => {
  test("all eight getRandomCharsInPassword templates are recognised", () => {
    // Transcribed verbatim from packetSniffing.ts. If upstream reworded one, the
    // constraint would silently stop arriving, so each is pinned individually.
    const lines = [
      "There's definitely a 4 and a 7...",
      "I can see a 4 and a 7.",
      "I must use 4 & 7!",
      "Did it have a 4 and a 7?",
      "Note to self: 4 and 7 are important.",
      "I think 4 with 7 is key.",
      "I need to remember 4 'n 7.",
      "Theres a 4, and maybe a 7...",
    ];
    for (const line of lines) {
      expect(parseHeartbleedLine(line), `unparsed: ${line}`).toEqual({ kind: "hint", contains: ["4", "7"] });
    }
    // ...and none of them fell through to the unrecognised bucket.
    expect(harvestLogs(lines).unrecognised).toEqual([]);
    expect(harvestLogs(lines).evidence).toHaveLength(8);
  });

  test("the empty-password variant is a hint, not drift", () => {
    expect(parseHeartbleedLine("There's definitely nothing in that password...")).toEqual({
      kind: "hint",
      contains: [],
    });
  });

  test("positional feedback about the last attempt is captured both ways", () => {
    // getExactCharactersHint emits a trailing space, which upstream really does.
    expect(parseHeartbleedLine("The characters a, b are in the right place. ")).toEqual({
      kind: "hint",
      placed: ["a", "b"],
    });
    // "None" is information too: it rules the whole attempt out positionally.
    expect(parseHeartbleedLine("No characters are in the right place.")).toEqual({
      kind: "hint",
      nonePlaced: true,
    });
  });
});

describe("noise and grammar drift", () => {
  test("the transaction line is recognised, so it is not counted as drift", () => {
    expect(parseHeartbleedLine("[sending transaction details to dn-2-7.]")).toEqual({
      kind: "noise",
      text: "[sending transaction details to dn-2-7.]",
      recognised: true,
    });
    expect(harvestLogs(["[sending transaction details to dn-2-7.]"]).unrecognised).toEqual([]);
  });

  test("the heartbeat line is recognised, so it is not counted as drift", () => {
    const capture = parseHeartbleedLine("4:15:23 PM: dn-0-1 - heartbeat check (alive)");
    expect(capture).toEqual({
      kind: "noise",
      text: "4:15:23 PM: dn-0-1 - heartbeat check (alive)",
      recognised: true,
    });
    expect(harvestLogs(["4:15:23 PM: dn-0-1 - heartbeat check (alive)"]).unrecognised).toEqual([]);
  });

  test("an unrecognised line is surfaced, never swallowed", () => {
    // A rising unrecognised count is the signal that the game's log grammar has
    // moved and this parser needs revisiting. Dropping the text would hide that.
    const summary = harvestLogs(["Some phrase we have never seen before"]);
    expect(summary.unrecognised).toEqual(["Some phrase we have never seen before"]);
  });

  test("harvest folds a realistic mixed batch", () => {
    const summary = harvestLogs(
      [
        "4:15:23 PM: dn-1-0 - heartbeat check (alive)",
        "Connecting to dn-1-3:letmein ...",
        "[sending transaction details to dn-1-4.]",
        "I must use l & n!",
        "--dragon--",
        JSON.stringify({ code: 401, passwordAttempted: "0000", data: "Higher" }),
        "packet sniffing is fun",
      ],
      { bledFrom: "dn-1-0" },
    );
    expect(summary.credentials).toEqual([
      { kind: "credential", host: "dn-1-3", password: "letmein", via: "connecting" },
    ]);
    expect(summary.loose).toEqual(["dragon"]);
    expect(summary.evidence).toContainEqual({ kind: "contains", chars: ["l", "n"], at: expect.any(Number) });
    expect(summary.oracles).toHaveLength(1);
    expect(summary.unrecognised).toEqual(["packet sniffing is fun"]);
  });

  test("an empty batch is not an error", () => {
    const summary = harvestLogs([]);
    expect(summary.credentials).toEqual([]);
    expect(summary.unrecognised).toEqual([]);
  });

  test("the same loose password is emitted once per drain", () => {
    expect(harvestLogs(["--dragon--", "--dragon--"]).loose).toEqual(["dragon"]);
  });
});

describe("grammar drift is reported as a shape, never as a line", () => {
  test("every digit and letter run is erased, and the structure survives", () => {

    // The shape has to be specific enough to write a fix against...
    expect(logShape("Logging in with passcode: hunter2")).toBe("a a a a: a#");
    expect(logShape("Response time: 1234ms")).toBe("a a: #a");
    // ...and identical for two lines that differ only in their secret, which is
    // what makes it safe to publish and useful to count.
    expect(logShape("passcode: swordfish")).toBe(logShape("passcode: correcthorse"));
  });

  test("every upstream packet-spam phrase is recognized rather than reported as grammar drift", () => {
    const summary = harvestLogs(PACKET_SNIFF_PHRASES);
    expect(summary.unrecognised).toEqual([]);
    expect(summary.credentials).toEqual([]);
  });

  test("no password survives being turned into a shape", () => {
    // The property this function exists for. An unrecognised line is BY
    // DEFINITION one the parser failed to read, and the noise generator puts
    // cleartext passwords in log lines — so reporting examples would report the
    // passwords we missed.
    const secret = "tr0ub4dor";
    const shape = logShape(`dn-7 accepted ${secret} at 09:41`);
    expect(shape).not.toContain(secret);
    for (const fragment of ["tr0", "ub4", "dor", "b4d"]) {
      expect(shape).not.toContain(fragment);
    }
    // Only the alphabet of the shape itself, plus punctuation.
    expect(/^[a#\s\p{P}\p{S}]*$/u.test(shape)).toBe(true);
  });

  test("a shape is bounded, however long the line was", () => {
    // Unbounded, a single pathological line would become a 200-entry map key.
    expect(logShape("x!".repeat(500)).length).toBeLessThanOrEqual(60);
  });
});

describe("target-owned log evidence", () => {
  test("newest-first placement hints attach to the next older authentication record", () => {
    const summary = harvestLogs([
      "The characters b are in the right place. ",
      JSON.stringify({ code: 401, passwordAttempted: "abc", data: "false" }),
      "I can see a x and a y.",
    ], { bledFrom: "dn-1", at: 123 });

    expect(summary.evidence).toEqual([
      { kind: "placement", attempted: "abc", placed: ["b"], at: 123 },
      { kind: "contains", chars: ["x", "y"], at: 123 },
    ]);
  });


  test("capturePackets really can bury multiple contains hints in packet junk", () => {
    const rand = mulberry32(2);
    const world: PacketWorld = {
      movablePasswords: () => ["9999"], serverNames: () => ["dn-1"],
      lastAttempted: () => "4800", rand,
    };
    const data = capturePackets({ hostname: "dn-1", password: "4827", difficulty: 8 }, world);
    expect(data).toContain("I can see a 7 and a 4.");
    expect(data).toContain("Theres a 7, and maybe a 4...");
    const summary = harvestLogs([
      JSON.stringify({ code: 401, passwordAttempted: "0000", data }),
    ], { bledFrom: "dn-1", knownHosts: ["dn-1"], at: 456 });
    expect(summary.credentials).toContainEqual({ kind: "credential", host: "dn-1", password: "4827", via: "packet" });
    expect(summary.evidence.filter((fact) => fact.kind === "contains")).toEqual([
      { kind: "contains", chars: ["7", "4"], at: 456 },
      { kind: "contains", chars: ["7", "4"], at: 456 },
    ]);
  });

  test("capturePackets can also bury placement feedback in the same junk", () => {
    const data = capturePackets({ hostname: "dn-1", password: "4827", difficulty: 8 }, {
      movablePasswords: () => ["9999"], serverNames: () => ["dn-1"],
      lastAttempted: () => "4800", rand: mulberry32(4),
    });
    expect(data).toContain("The characters 4, 8 are in the right place.");
    const summary = harvestLogs([
      JSON.stringify({ code: 401, passwordAttempted: "1111", data }),
      JSON.stringify({ code: 401, passwordAttempted: "4800", data: "older response" }),
    ], { bledFrom: "dn-1", at: 789 });
    expect(summary.evidence).toContainEqual({ kind: "placement", attempted: "4800", placed: ["4", "8"], at: 789 });
  });

  test("known hostnames disambiguate colons in both names and passwords", () => {
    expect(parseHeartbleedLine("Connecting to dn:west:p:a:ss ...", ["dn:west"])).toEqual({
      kind: "credential",
      host: "dn:west",
      password: "p:a:ss",
      via: "connecting",
    });
    expect(extractPacketCredentials("junk dn:west:p:a:ss tail", ["dn:west"])).toContainEqual({
      kind: "credential",
      host: "dn:west",
      password: "p:a:ss",
      via: "packet",
    });
  });
});

describe("unattributed passwords", () => {
  const host = (over: Partial<Parameters<typeof looseCandidates>[1][number]> & { hostname: string }) => ({
    hasCredential: false,
    ...over,
  });

  test("length and format narrow a leak to compatible hosts", () => {
    const guesses = looseCandidates(["4821"], [
      host({ hostname: "match", passwordLength: 4, passwordFormat: "numeric" }),
      host({ hostname: "too-long", passwordLength: 6, passwordFormat: "numeric" }),
      host({ hostname: "wrong-format", passwordLength: 4, passwordFormat: "alphabetic" }),
    ]);
    expect(guesses.map((guess) => guess.hostname)).toEqual(["match"]);
    expect(guesses[0]!.password).toBe("4821");
  });

  test("owned and stationary hosts are excluded", () => {
    expect(looseCandidates(["4821"], [
      host({ hostname: "owned", hasCredential: true }),
      host({ hostname: "darkweb", isStationary: true }),
    ])).toEqual([]);
  });

  test("missing identity facts do not exclude an unsurveyed host", () => {
    expect(looseCandidates(["4821"], [host({ hostname: "unknown" })]).map((guess) => guess.hostname))
      .toEqual(["unknown"]);
  });

  test("pairs are deduplicated and ordered by host", () => {
    const hosts = [host({ hostname: "b" }), host({ hostname: "a" })];
    expect(looseCandidates(["4821", "4821"], hosts).map((guess) => guess.hostname)).toEqual(["a", "b"]);
  });
});
