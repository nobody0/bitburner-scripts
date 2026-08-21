import { describe, expect, test } from "bun:test";
import {
  extractPacketCredentials,
  harvestLogs,
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
    const attributed = harvestLogs(["Logging in with passcode: 4815 ..."], "dn-2-0");
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
    const summary = harvestLogs(["--swordfish--"], "dn-1-1");
    expect(summary.loose).toEqual(["swordfish"]);
    expect(summary.credentials).toEqual([]);
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
    const summary = harvestLogs([line], "dn-6-1");
    expect(summary.oracles).toHaveLength(1);
    expect(summary.credentials).toContainEqual({
      kind: "credential",
      host: "dn-6-1",
      password: "trustno1",
      via: "packet",
    });
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
    expect(harvestLogs(lines).hints).toHaveLength(8);
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

describe("noise, topology and grammar drift", () => {
  test("the transaction line is free adjacency", () => {
    expect(parseHeartbleedLine("[sending transaction details to dn-2-7.]")).toEqual({
      kind: "edge",
      host: "dn-2-7",
    });
  });

  test("the heartbeat line is recognised, so it is not counted as drift", () => {
    const capture = parseHeartbleedLine("4:15:23 PM: dn-0-1 - heartbeat check (alive)");
    expect(capture).toEqual({
      kind: "noise",
      text: "4:15:23 PM: dn-0-1 - heartbeat check (alive)",
      heartbeat: true,
    });
    expect(harvestLogs(["4:15:23 PM: dn-0-1 - heartbeat check (alive)"]).unrecognised).toEqual([]);
  });

  test("an unrecognised line is surfaced, never swallowed", () => {
    // A rising unrecognised count is the signal that the game's log grammar has
    // moved and this parser needs revisiting. Dropping the text would hide that.
    const summary = harvestLogs(["Some phrase we have never seen before"]);
    expect(summary.unrecognised).toEqual(["Some phrase we have never seen before"]);
    expect(summary.heartbeats).toBe(0);
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
      "dn-1-0",
    );
    expect(summary.credentials).toEqual([
      { kind: "credential", host: "dn-1-3", password: "letmein", via: "connecting" },
    ]);
    expect(summary.loose).toEqual(["dragon"]);
    expect(summary.edges).toEqual(["dn-1-4"]);
    expect(summary.hints).toEqual([{ kind: "hint", contains: ["l", "n"] }]);
    expect(summary.oracles).toHaveLength(1);
    expect(summary.heartbeats).toBe(1);
    expect(summary.unrecognised).toEqual(["packet sniffing is fun"]);
  });

  test("an empty batch is not an error", () => {
    const summary = harvestLogs([]);
    expect(summary.credentials).toEqual([]);
    expect(summary.unrecognised).toEqual([]);
  });
});
