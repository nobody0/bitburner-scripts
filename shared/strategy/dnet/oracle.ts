/** Reading the darknet's logs.
 *
 * `heartbleed` returns raw log lines, and they are the feature's real channel —
 * both halves of it:
 *
 * - **The oracle.** A failed `authenticate` writes its model-specific
 *   `PasswordResponse` into the target's log ring, and `heartbleed` hands it back
 *   JSON-stringified. That is the ONLY way a script sees model feedback:
 *   `authenticate()` itself forwards `data` for the labyrinth and nothing else.
 * - **The credentials.** The log NOISE leaks plaintext passwords outright. This
 *   is the "weak passwords and leaky logs" the BitNode description names, and it
 *   is a credential source that owes nothing to any of the 24 minigames. A
 *   neighbour's password arrives in cleartext often enough that a patient crawler
 *   spreads without solving a single puzzle.
 *
 * Everything here is pure string work over lines we did not write, so it is
 * parsed defensively: an unrecognised line is `noise`, never a throw, and the
 * counts are what tell us whether the grammar has drifted from the game.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/models/packetSniffing.ts  (getLogNoise, logPasswordAttempt,
 *                                          capturePackets, getRandomCharsInPassword)
 *   src/NetscriptFunctions/Darknet.ts:286-288 (how a line is serialised) */

/** The engine's own `PasswordResponse`, as it appears once JSON-stringified into
 * a log line. Every field is optional because we are parsing a foreign object. */
export interface OracleCapture {
  kind: "oracle";
  /** DarknetResponseCode, when the line carried one. */
  code?: number;
  message?: string;
  /** The model-specific payload. Its FORMAT is documented per model in
   *  `models.ts`; this layer deliberately does not interpret it. */
  data?: string;
  passwordAttempted?: string;
  /** `Pr0verFl0` only: the overflow half of the simulated buffer, which upstream
   *  splits out into its own log field. It is oracle output, not a credential —
   *  it is what the attempt overwrote, not the server's password. */
  passwordExpected?: string;
}

/** A plaintext password recovered from the logs. `host` is undefined when the
 * line does not say whose it is. */
export interface CredentialLeak {
  kind: "credential";
  host?: string;
  password: string;
  /** Which noise shape produced it, for the UI and for grammar-drift counting. */
  via: "connecting" | "passcode" | "bare" | "packet";
}

/** A partial constraint on a password: characters known to be in it, or known to
 * be correctly placed in the last attempt. Not a credential, but it shrinks the
 * search enough to be worth keeping. */
export interface HintCapture {
  kind: "hint";
  /** Characters the log says are somewhere in this host's password. */
  contains?: string[];
  /** Characters the log says were in the RIGHT PLACE in the last attempt. */
  placed?: string[];
  /** True for the explicit "no characters are in the right place" line, which is
   *  information too — it rules the whole attempt out positionally. */
  nonePlaced?: boolean;
}

/** A topology edge, leaked by the transaction-noise line. Free adjacency. */
export interface EdgeCapture {
  kind: "edge";
  host: string;
}

export interface NoiseLine {
  kind: "noise";
  /** Kept so an unrecognised shape can be shown rather than silently dropped —
   *  this is how we find out the grammar has drifted. */
  text: string;
  /** True for the heartbeat line, which we DO recognise and which is not drift. */
  heartbeat: boolean;
}

export type LogCapture = OracleCapture | CredentialLeak | HintCapture | EdgeCapture | NoiseLine;

/** `Connecting to <host>:<password> ...` — a neighbour's password in cleartext.
 * Upstream emits it at `0.05 * 1/(difficulty+1)` per noise line, and the packet
 * sniffer emits it far more often. The password may contain anything except a
 * space, so the trailing ` ...` is the anchor, not a character class. */
const CONNECTING = /^Connecting to ([^\s:]+):(.*) \.\.\.$/;

/** `Logging in with passcode: <password> ...` — the host's OWN password.
 * `OpenWebAccessPoint` only. */
const PASSCODE = /^Logging in with passcode: (.*) \.\.\.$/;

/** `--<password>--` — some random movable host's password, unattributed. Still
 * worth keeping: it is a free candidate to try against everything. */
const BARE = /^--(.+)--$/;

/** `[sending transaction details to <host>.]` — an adjacency, free. */
const TRANSACTION = /^\[sending transaction details to ([^\s\].]+)\.\]$/;

/** `<time>: <host> - heartbeat check (alive)`. Recognised so it does not count
 * as grammar drift. */
const HEARTBEAT = /- heartbeat check \(alive\)$/;

/** The eight `getRandomCharsInPassword` templates. Each names two characters
 * that are somewhere in this host's password. Transcribed verbatim, because a
 * near-miss here silently loses the constraint rather than failing. */
const CONTAINS: readonly RegExp[] = [
  /^There's definitely a (.) and a (.)\.\.\.$/,
  /^I can see a (.) and a (.)\.$/,
  /^I must use (.) & (.)!$/,
  /^Did it have a (.) and a (.)\?$/,
  /^Note to self: (.) and (.) are important\.$/,
  /^I think (.) with (.) is key\.$/,
  /^I need to remember (.) 'n (.)\.$/,
  /^Theres a (.), and maybe a (.)\.\.\.$/,
];

/** `The characters A, B are in the right place. ` — note the trailing space,
 * which upstream really does emit. At most two characters are listed. */
const PLACED = /^The characters (.+?) are in the right place\.\s*$/;
const NONE_PLACED = /^No characters are in the right place\.$/;

/** The empty-password variant of the contains-hint. */
const NO_PASSWORD_HINT = "There's definitely nothing in that password...";

/** NOTE: nothing in this file may call `RegExp.prototype.exec`.
 *
 * Bitburner's static RAM analyser charges by MEMBER NAME, so a `pattern.exec(s)`
 * anywhere in a bundle that reaches a game script bills the full 1.3 GB of
 * `ns.exec` — which is more than half a surveyor. `String.prototype.match` is
 * free and does the same job. `tests/ram-budget.test.ts` catches a regression
 * here, but it catches it as a mysterious 1.3 GB rather than as this sentence,
 * which is why the sentence is here.

 * The same trap applies to `ns` names generally: `scan`, `read`, `write`, `kill`
 * and friends are all real ns members, so a local helper named after one is not
 * free either. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Try to read a line as the JSON-serialised `PasswordResponse`.
 *
 * `heartbleed` stringifies only non-string log messages, so a JSON object here
 * is always an authentication record rather than noise. */
function parseOracle(raw: string): OracleCapture | undefined {
  if (!raw.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = parsed as Record<string, unknown>;
  // `passwordAttempted` is the field that makes it an authentication record
  // rather than some other object the game might log.
  if (!("passwordAttempted" in value) && !("code" in value)) return undefined;
  const capture: OracleCapture = { kind: "oracle" };
  if (typeof value["code"] === "number") capture.code = value["code"];
  const message = asString(value["message"]);
  if (message !== undefined) capture.message = message;
  // `data` is `any` upstream and is genuinely non-string for some models, so it
  // is normalised to text rather than dropped.
  if (value["data"] !== undefined && value["data"] !== null) {
    capture.data = typeof value["data"] === "string" ? value["data"] : JSON.stringify(value["data"]);
  }
  const attempted = asString(value["passwordAttempted"]);
  if (attempted !== undefined) capture.passwordAttempted = attempted;
  const expected = asString(value["passwordExpected"]);
  if (expected !== undefined) capture.passwordExpected = expected;
  return capture;
}

/** Pull ` <hostname>:<password> ` out of a `capturePackets` blob.
 *
 * Upstream embeds the pair space-delimited at a random offset inside ~130
 * characters of junk when `difficulty <= 16`. Above that it embeds the bare
 * password with no host and no delimiters, which is unrecoverable by pattern —
 * so this finds the attributed form only, and says nothing rather than guessing.
 *
 * The junk is drawn from dictionaries and generated names, so a false positive
 * is possible; the caller treats a recovered credential as a CANDIDATE to try,
 * never as a fact, which makes a wrong hit cost one `authenticate` call. */
const PACKET_PAIR = /(^|\s)([A-Za-z0-9_.-]+):(\S+)(?=\s|$)/g;

export function extractPacketCredentials(blob: string): CredentialLeak[] {
  const found: CredentialLeak[] = [];
  // matchAll on a /g regex resets lastIndex itself, but the literal is shared
  // with redactLogLine, so it is re-created per call rather than trusted.
  for (const match of blob.matchAll(new RegExp(PACKET_PAIR.source, "g"))) {
    const host = match[2];
    const password = match[3];
    if (host === undefined || password === undefined) continue;
    found.push({ kind: "credential", host, password, via: "packet" });
  }
  return found;
}

/** Classify one heartbleed log line.
 *
 * Order matters only in that the JSON check runs first: every other shape is a
 * distinct literal prefix, so they cannot collide. */
export function parseHeartbleedLine(raw: string): LogCapture {
  const line = raw.trim();

  const oracle = parseOracle(line);
  if (oracle) return oracle;

  const connecting = line.match(CONNECTING);
  if (connecting) {
    return { kind: "credential", host: connecting[1]!, password: connecting[2]!, via: "connecting" };
  }

  const passcode = line.match(PASSCODE);
  // The host is deliberately absent: this line names no host, and the caller
  // knows which server it bled. Attributing it here would be a guess.
  if (passcode) return { kind: "credential", password: passcode[1]!, via: "passcode" };

  const transaction = line.match(TRANSACTION);
  if (transaction) return { kind: "edge", host: transaction[1]! };

  if (HEARTBEAT.test(line)) return { kind: "noise", text: line, heartbeat: true };

  if (line === NO_PASSWORD_HINT) return { kind: "hint", contains: [] };
  if (NONE_PLACED.test(line)) return { kind: "hint", nonePlaced: true };

  const placed = line.match(PLACED);
  if (placed) {
    const chars = placed[1]!.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    if (chars.length > 0) return { kind: "hint", placed: chars };
  }

  for (const pattern of CONTAINS) {
    const match = line.match(pattern);
    if (match) return { kind: "hint", contains: [match[1]!, match[2]!] };
  }

  // `--pw--` is checked LAST because it is the loosest pattern here and would
  // otherwise swallow any line that happens to start and end with dashes.
  const bare = line.match(BARE);
  if (bare) return { kind: "credential", password: bare[1]!, via: "bare" };

  return { kind: "noise", text: line, heartbeat: false };
}

export interface HarvestSummary {
  oracles: OracleCapture[];
  /** Credentials whose owner the log named. Directly usable. */
  credentials: CredentialLeak[];
  /** Passwords with no owner. Candidates to spray, not facts. */
  loose: string[];
  hints: HintCapture[];
  /** Hosts the logs mentioned, which is free adjacency. */
  edges: string[];
  /** Lines we recognised as ordinary traffic. */
  heartbeats: number;
  /** Lines we did NOT recognise. A rising count means the grammar has drifted
   *  from the game and this parser needs revisiting — so it is surfaced rather
   *  than swallowed. */
  unrecognised: string[];
}

/** One unrecognised line, reduced to its SHAPE.
 *
 * A rising `unrecognised` count means our grammar has drifted from the game, and
 * a count on its own cannot say WHICH shape drifted — so the natural fix is to
 * report examples. That fix is unsafe, and dangerously so: an unrecognised line
 * is by definition one we failed to parse, and three of the noise generator's
 * branches put a plaintext password into a log line. Shipping examples would
 * ship exactly the passwords our parser missed.
 *
 * So the shape travels and the text does not. Every run of digits collapses to
 * `#` and every run of letters to `a`, which leaves the punctuation and the
 * structure — enough to say "a line like `a: a-#` stopped parsing" and to write
 * the fix against, and not enough to carry a secret.
 *
 * A character loop and `String` methods only: `RegExp.prototype.exec` anywhere
 * in a bundle that reaches a game script bills the full 1.3 GB of `ns.exec`, and
 * this module is imported by the job bodies. */
export function logShape(line: string): string {
  let out = "";
  let last = "";
  for (const ch of line.slice(0, SHAPE_SCAN)) {
    const cls = ch >= "0" && ch <= "9"
      ? "#"
      : (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")
        ? "a"
        : "";
    if (cls === "") {
      out += ch;
      last = "";
      continue;
    }
    // Collapse the RUN, so `passcode1234` and `passcode9` are one shape.
    if (cls !== last) out += cls;
    last = cls;
  }
  return out.slice(0, SHAPE_MAX);
}

/** Enough of a line to tell its shape; the rest is more of the same. */
const SHAPE_SCAN = 240;
/** What actually travels. A shape longer than this is not a shape. */
const SHAPE_MAX = 60;

/** Fold a batch of log lines into everything they gave us.
 *
 * `bledFrom` is the host these lines came off. It matters for one shape: the
 * `Logging in with passcode:` line names no host because upstream never needed
 * to — it is always the logging server's own password. Passing the host here is
 * what turns that from a loose candidate into an attributed credential; omit it
 * and the line degrades safely to `loose` rather than being mis-attributed. */
export function harvestLogs(lines: readonly string[], bledFrom?: string): HarvestSummary {
  const summary: HarvestSummary = {
    oracles: [],
    credentials: [],
    loose: [],
    hints: [],
    edges: [],
    heartbeats: 0,
    unrecognised: [],
  };
  for (const raw of lines) {
    const capture = parseHeartbleedLine(raw);
    switch (capture.kind) {
      case "oracle":
        summary.oracles.push(capture);
        // A packet-sniffer response carries its blob in `data`, and the blob is
        // where that model hides the credential. Mining it here means the caller
        // gets the password without knowing which model it was talking to.
        if (capture.data) summary.credentials.push(...extractPacketCredentials(capture.data));
        break;
      case "credential": {
        const host = capture.host ?? (capture.via === "passcode" ? bledFrom : undefined);
        if (host === undefined) summary.loose.push(capture.password);
        else summary.credentials.push({ ...capture, host });
        break;
      }
      case "hint":
        summary.hints.push(capture);
        break;
      case "edge":
        summary.edges.push(capture.host);
        break;
      case "noise":
        if (capture.heartbeat) summary.heartbeats++;
        else summary.unrecognised.push(capture.text);
        break;
    }
  }
  return summary;
}

/** The response to OUR attempt, out of a harvest that may hold several.
 *
 * The log ring is 200 lines and is shared: other agents attempt against the same
 * host, and the host writes its own noise into it between our calls. Folding
 * whichever oracle line happened to come back first would feed a solver another
 * process's feedback, which is worse than no feedback — it is wrong feedback
 * that looks right, and every solver here trusts what it is handed.
 *
 * So the match is on `passwordAttempted`, which upstream stamps on every
 * authentication record.
 *
 * **`Pr0verFl0` is the one exception, and it is not optional.** That model's
 * log entry is rewritten before it is stored: `logPasswordAttempt` replaces
 * `passwordAttempted` with the RECEIVED BUFFER — the overwritten first half of
 * the simulated buffer — rather than the string we sent
 * (`packetSniffing.ts:99-119`). A matcher that only compared the attempt would
 * therefore discard this model's response every single time, silently and
 * forever. It needs no oracle to be solved, so the honest thing is to say so
 * here rather than to loosen the rule for everyone.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/models/packetSniffing.ts:90-125 */
export function oracleFor(
  harvest: HarvestSummary,
  attempted: string,
  modelId?: string,
): OracleCapture | undefined {
  if (modelId === "Pr0verFl0") {
    // Its records cannot be attributed, and it does not need to be.
    return undefined;
  }
  return harvest.oracles.find((capture) => capture.passwordAttempted === attempted);
}
