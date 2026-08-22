import { solverFor } from "./solvers/index.ts";
import { candidateMatchesEvidence, type PasswordEvidence } from "./evidence.ts";
import { COMMON_PASSWORDS, DEFAULT_SETTINGS, DOG_NAMES, EU_COUNTRIES } from "./dictionaries.ts";
import { getPasswordType } from "./codecs.ts";

/** The twenty-four darknet server models, and what each one tells you when you
 * guess wrong.
 *
 * This registry is total: all 24 non-labyrinth models have either an ordered
 * dictionary or a solver, while the labyrinth is routed to its PID-bound maze
 * walker. Raw entries retain their upstream audit metadata; `modelEntry`
 * derives implementation status from the actual dispatcher.
 *
 * Two facts decide the shape of everything here, and both are the opposite of
 * what the API docs suggest:
 *
 * 1. **`authenticate()` does not return the oracle.** It forwards `data` only
 *    for the labyrinth; every other model gets a generic `AuthFailure`. The
 *    model-specific response is written to the server's LOG RING and comes back
 *    through `heartbleed`, JSON-stringified. So `via` is `"heartbleed"` for most
 *    of these, and reading an oracle costs a second call on the same host from
 *    the same agent.
 * 2. **Several models put their answer in `passwordHint` / `data`**, which
 *    `getServerDetails` hands over for free with no attempt at all. Where that is
 *    true, `via` is `"details"`, because it means the model needs a decoder
 *    rather than a search.
 *
 * `ModelIds` is "not exposed to the player; they find them through discovery"
 * upstream, so the ids below are transcribed rather than imported, and
 * `modelEntry()` returns undefined for anything unrecognised — a model we have
 * never seen becomes a loud, counted event instead of a silent skip.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/Enums.ts                         (ModelIds)
 *   src/DarkNet/effects/authentication.ts:33-147 (the feedback switch)
 *   src/DarkNet/controllers/ServerGenerator.ts   (what each hint contains)
 *   src/NetscriptFunctions/Darknet.ts:163-177    (why `via` is heartbleed) */

export const MODEL_IDS = [
  "ZeroLogon",
  "FreshInstall_1.0",
  "TopPass",
  "EuroZone Free",
  "Laika4",
  "DeskMemo_3.1",
  "PHP 5.4",
  "Pr0verFl0",
  "DeepGreen",
  "2G_cellular",
  "AccountsManager_4.2",
  "110100100",
  "PrimeTime 2",
  "BellaCuore",
  "OctantVoxel",
  "MathML",
  "Factori-Os",
  "BigMo%od",
  "KingOfTheHill",
  "CloudBlare(tm)",
  "NIL",
  "RateMyPix.Auth",
  "OpenWebAccessPoint",
  "OrdoXenos",
  "(The Labyrinth)",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

/** How a wrong guess answers. Drives the UI glyph, and tells a future solver
 * which shape of search it is writing. */
export type FeedbackShape =
  | "none"          // there is nothing to guess
  | "dictionary"    // the password is drawn from a fixed list
  | "echo"          // the hint contains the password, plainly or transformed
  | "encoded"       // the hint contains the password under a reversible encoding
  | "mastermind"    // exact/misplaced counts
  | "per-character" // per-position right/wrong
  | "timing"        // the response TIME carries the signal
  | "ordering"      // higher/lower
  | "arithmetic"    // a numeric relation over the password
  | "buffer"        // a simulated memory bug
  | "hill-climb"    // a scalar score to maximise
  | "packet"        // a captured blob with the password buried in it
  | "opaque";       // no feedback beyond failure

/** Which family the UI draws. Lives here, not in `ui/`, because a solver needs
 * the same taxonomy and it must not be born in the view layer. */
export type ModelFamily = "none" | "dictionary" | "echo" | "timing" | "math" | "oracle" | "packet" | "lab";

/** The password facts `getServerDetails` gives us, which is all a candidate
 * generator may read. Never the password. */
export interface PasswordFacts {
  passwordLength?: number;
  passwordFormat?: string;
  passwordHint?: string;
  data?: string;
  difficulty?: number;
  /** Formula time for zero matching prefix characters (2G timing baseline). */
  authenticateBaseMs?: number;
  /** Formula delta added by one matching prefix character for this job. */
  authenticateStepMs?: number;
  /** Normalized constraints drained from this target's shared log ring. */
  evidence?: readonly PasswordEvidence[];
}

export interface ModelEntry {
  id: ModelId;
  /** The upstream `ModelIds` KEY. Upstream names the mechanic only there, so
   *  this is the one place the model's actual meaning is written down. */
  name: string;
  feedback: FeedbackShape;
  family: ModelFamily;
  /** Exactly what a wrong attempt hands back, and where it appears. This is the
   *  field a future solver is written against, so it states the format. */
  oracle: string;
  /** Where the feedback surfaces. `"authenticate"` only for the labyrinth;
   *  `"details"` when no attempt is needed at all. */
  via: "heartbleed" | "authenticate" | "details";
  status: "implemented" | "unattempted";
  /** Ordered candidates, for `status: "implemented"`. Ordered so an attempt
   *  ledger of length n means "the first n are ruled out" and can resume. */
  candidates?: (facts: PasswordFacts) => readonly string[];
  /** Why not, in one line, for the UI and the report. */
  blocked?: string;
}

const dictionary = (id: ModelId, name: string, words: readonly string[], oracle: string): ModelEntry => ({
  id,
  name,
  feedback: "dictionary",
  family: "dictionary",
  oracle,
  via: "heartbleed",
  status: "implemented",
  candidates: () => words,
});

/** What this model IS — its mechanic, its feedback grammar, where that feedback
 * surfaces. Descriptive only: whether we can actually open it is decided by
 * `describeModel` below, from the solver registry.
 *
 * Total over `MODEL_IDS`. The `never` arm at the bottom is the compile-time
 * proof: adding an id without an arm fails to typecheck. */
function describeModelShape(id: ModelId): ModelEntry {
  switch (id) {
    // --- implemented: the password comes from a transcribed list -------------
    // All five go through upstream's one-line `getDictionaryAttackConfig`, so
    // implementing some and not the others would be arbitrary.
    case "ZeroLogon":
      return {
        id,
        name: "NoPassword",
        feedback: "none",
        family: "none",
        oracle: 'There is no password. The dictionary is [""], and the hint says so outright.',
        via: "details",
        status: "implemented",
        candidates: () => [""],
      };
    case "FreshInstall_1.0":
      return dictionary(
        id,
        "DefaultPassword",
        DEFAULT_SETTINGS,
        "Four factory defaults. The hint says the password was never changed.",
      );
    case "Laika4":
      return dictionary(id, "DogNames", DOG_NAMES, "Four dog names. The hint says it is the dog's name.");
    case "EuroZone Free":
      return dictionary(id, "EUCountryDictionary", EU_COUNTRIES, "The 27 EU member states.");
    case "TopPass":
      return dictionary(
        id,
        "CommonPasswordDictionary",
        COMMON_PASSWORDS,
        "A 93-entry common-password list. Bounded but long, so the ledger resumes rather than restarting.",
      );

    // --- details and closed-form decoders ------------------------------------
    // These need a DECODER, not a search, and the input arrives free in
    // getServerDetails. They are the cheapest ones to pick up next.
    case "DeskMemo_3.1":
      return {
        id,
        name: "EchoVuln",
        feedback: "echo",
        family: "echo",
        oracle:
          'passwordHint is "<template> <password>" for one of six templates: "The password is", "The PIN is", '
          + `"Remember to use", "It's set to", "The key is", "The secret is". The password is 3 characters. `
          + "No attempt is needed at all: this is a getServerDetails read.",
        via: "details",
        status: "unattempted",
        blocked: "hint decoder not written",
      };
    case "PHP 5.4":
      return {
        id,
        name: "SortedEchoVuln",
        feedback: "echo",
        family: "echo",
        oracle:
          "`data` is the password's characters SORTED, and passwordHint is one of four templates followed by the "
          + "same. So the multiset is free and only the permutation is unknown. A wrong guess of the right length "
          + 'adds "<data>; RMS Deviation:<n>" — a distance a hill-climb over permutations can descend.',
        via: "heartbleed",
        status: "unattempted",
        blocked: "permutation search not written",
      };
    case "CloudBlare(tm)":
      return {
        id,
        name: "Captcha",
        feedback: "encoded",
        family: "echo",
        oracle:
          "`data` is the password with filler characters inserted after every character but the last. Strip the "
          + "filler and you have it; no attempt needed.",
        via: "details",
        status: "unattempted",
        blocked: "filler alphabet not transcribed",
      };
    case "110100100":
      return {
        id,
        name: "BinaryEncodedFeedback",
        feedback: "encoded",
        family: "math",
        oracle: "`data` is the password as space-separated 8-bit binary char codes. Decode it directly.",
        via: "details",
        status: "unattempted",
        blocked: "decoder not written",
      };
    case "OrdoXenos":
      return {
        id,
        name: "encryptedPassword",
        feedback: "encoded",
        family: "math",
        oracle:
          "`data` is `<xor-encrypted password>;<space-separated 8-bit masks>`. XOR each character by its mask. "
          + "Fully reversible from getServerDetails alone.",
        via: "details",
        status: "unattempted",
        blocked: "decoder not written",
      };
    case "OctantVoxel":
      return {
        id,
        name: "ConvertToBase10",
        feedback: "encoded",
        family: "math",
        oracle:
          "`data` is `<base>,<encoded>`; the password is that number in base 10. The base may be fractional above "
          + "difficulty 12. A numeric answer within a rounding tolerance SUCCEEDS, so exactness is not required.",
        via: "details",
        status: "unattempted",
        blocked: "base-N decoder not written",
      };
    case "MathML":
      return {
        id,
        name: "parsedExpression",
        feedback: "encoded",
        family: "math",
        oracle:
          "The hint is an arithmetic expression and the password is its value. Like OctantVoxel, an answer within a "
          + "rounding tolerance succeeds rather than needing the exact string. DO NOT eval the hint: above difficulty "
          + "12 the operators are swapped for lookalike unicode, and above 16 the expression may carry an injected "
          + "`ns.exit()` — the generator adds both deliberately.",
        via: "details",
        status: "unattempted",
        blocked: "expression parser not written",
      };
    case "PrimeTime 2":
      return {
        id,
        name: "LargestPrimeFactor",
        feedback: "encoded",
        family: "math",
        oracle: "`data` is the target number; the password is its largest prime factor.",
        via: "details",
        status: "unattempted",
        blocked: "factoriser not written",
      };

    // --- interactive search problems -----------------------------------------
    case "DeepGreen":
      return {
        id,
        name: "MastermindHint",
        feedback: "mastermind",
        family: "oracle",
        oracle:
          "`data` is `<exact>,<misplaced>` — a literal Mastermind oracle over the password's characters. The "
          + 'message spells the same out: "Hint: N symbols match exactly,  and M symbols match but are in the '
          + 'wrong place."',
        via: "heartbleed",
        status: "unattempted",
        blocked: "mastermind solver not written",
      };
    case "2G_cellular":
      return {
        id,
        name: "TimingAttack",
        feedback: "timing",
        family: "timing",
        oracle:
          "Two channels. The message carries the INDEX of the first mismatched character, and `data` carries "
          + '"Response time: <n>ms". The real leak is the clock: authentication takes 50ms LONGER per correct '
          + "leading character (times the threads factor), so slower means closer and the attack climbs.",
        via: "heartbleed",
        status: "unattempted",
        blocked: "timing climb not written",
      };
    case "AccountsManager_4.2":
      return {
        id,
        name: "GuessNumber",
        feedback: "ordering",
        family: "oracle",
        oracle: '`data` is "Higher" or "Lower". A binary search over the numeric range.',
        via: "heartbleed",
        status: "unattempted",
        blocked: "binary search not written",
      };
    case "BellaCuore":
      return {
        id,
        name: "RomanNumeral",
        feedback: "ordering",
        family: "oracle",
        oracle: '`data` is "ALTUS NIMIS" (too high) or "PARUM BREVIS" (too low). AccountsManager_4.2 in Latin.',
        via: "heartbleed",
        status: "unattempted",
        blocked: "binary search not written",
      };
    case "NIL":
      return {
        id,
        name: "Yesn_t",
        feedback: "per-character",
        family: "oracle",
        oracle:
          `\`data\` is a comma-separated "yes"/"yesn't" per attempted character, positionally. Every position is `
          + "independent, so the password falls in length x alphabet attempts.",
        via: "heartbleed",
        status: "unattempted",
        blocked: "per-position solver not written",
      };
    case "RateMyPix.Auth":
      return {
        id,
        name: "SpiceLevel",
        feedback: "per-character",
        family: "oracle",
        oracle:
          '`data` is one chilli per exactly-correct character over the password length, e.g. "<peppers>/6", or '
          + '"0/6". Positional like NIL, but it reports only how many positions are correct, not which.',
        via: "heartbleed",
        status: "unattempted",
        blocked: "per-position solver not written; also SF15-gated, so it needs full darknet access to appear",
      };
    case "Factori-Os":
      return {
        id,
        name: "divisibilityTest",
        feedback: "arithmetic",
        family: "math",
        oracle: '`data` is "true"/"false" for whether the password is divisible by the attempt. A factor oracle.',
        via: "heartbleed",
        status: "unattempted",
        blocked: "divisibility search not written",
      };
    case "BigMo%od":
      return {
        id,
        name: "tripleModulo",
        feedback: "arithmetic",
        family: "math",
        oracle: "`data` is `(password % input) % ((input - 1) % 32 + 1)`. A CRT-style reconstruction.",
        via: "heartbleed",
        status: "unattempted",
        blocked: "modular reconstruction not written",
      };
    case "Pr0verFl0":
      return {
        id,
        name: "BufferOverflow",
        feedback: "buffer",
        family: "oracle",
        oracle:
          "A simulated overflow. `data` is `<received>,<expected>`, and the LOG additionally splits it into "
          + "`passwordAttempted` and `passwordExpected`. Critically, an over-long attempt overwrites the expected "
          + "buffer, so a NON-EQUAL attempt can still succeed: this model is beaten by crafting the buffer, not "
          + "by guessing.",
        via: "heartbleed",
        status: "unattempted",
        blocked: "overflow craft not written",
      };
    case "KingOfTheHill":
      return {
        id,
        name: "globalMaxima",
        feedback: "hill-climb",
        family: "oracle",
        oracle: "`data` is an altitude out of 10,000 m. A global-maximum search over the password space.",
        via: "heartbleed",
        status: "unattempted",
        blocked: "hill climb not written; also SF15-gated, so it needs full darknet access to appear",
      };
    case "OpenWebAccessPoint":
      return {
        id,
        name: "packetSniffer",
        feedback: "packet",
        family: "packet",
        oracle:
          "`data` is a ~130-character junk blob with ` <hostname>:<password> ` embedded verbatim at a random "
          + "offset when difficulty <= 16, or the bare password above that. This model also emits "
          + '"Logging in with passcode: <password> ..." into its own log noise. It is the leakiest model in the net.',
        via: "heartbleed",
        status: "unattempted",
        blocked: "packet extractor not written",
      };
    case "(The Labyrinth)":
      return {
        id,
        name: "labyrinth",
        feedback: "opaque",
        family: "lab",
        oracle:
          "The only model whose `data` comes back on `authenticate()` directly, because the labyrinth is handled "
          + "before the model switch. The maze itself is undocumented.",
        via: "authenticate",
        status: "unattempted",
        blocked: "the labyrinth is a maze, not a password",
      };
  }
  const exhaustive: never = id;
  throw new Error(`unhandled darknet model: ${String(exhaustive)}`);
}

const KNOWN: ReadonlySet<string> = new Set<string>(MODEL_IDS);

/** Undefined for an id we have never seen. Callers MUST treat that as a counted,
 * reported event: an unrecognised model is either a game update or a hole in our
 * transcription, and both are things we want to hear about rather than skip. */
/** The model, with `status` DERIVED from whether a solver exists for it.
 *
 * `status` used to be written by hand on each arm, which is exactly the kind of
 * claim that rots: a registry saying "implemented" for something nobody wrote,
 * or still saying "unattempted" for something now solved, is worse than no
 * registry at all. Reading it off `solverFor` means the honesty test in
 * `tests/dnet-models.test.ts` is checking a fact rather than a comment.
 *
 * The five dictionary models keep `status: "implemented"` from their own arm:
 * their attack is `candidates`, walked by `planAttempt`, and they have no
 * solver by design (see `solvers/index.ts`). */
export function describeModel(id: ModelId): ModelEntry {
  const shape = describeModelShape(id);
  if (shape.candidates !== undefined) return shape;
  const solver = solverFor(id);
  if (solver === undefined) return shape;
  // Solved: the `blocked` note explaining why it was not written must go, or the
  // panel keeps reporting a reason that is no longer true.
  const { blocked: _blocked, ...rest } = shape;
  return { ...rest, status: "implemented" };
}

export function modelEntry(raw: string | undefined): ModelEntry | undefined {
  if (raw === undefined || !KNOWN.has(raw)) return undefined;
  return describeModel(raw as ModelId);
}

/** The UI glyph family for a raw model id, falling back to "oracle" for an
 * unknown one so the map still draws a box. */
export function modelFamily(raw: string | undefined): ModelFamily {
  return modelEntry(raw)?.family ?? "oracle";
}

export type Attempt =
  /** The next entry of an ordered dictionary. */
  | { kind: "candidate"; password: string; index: number; total: number }
  /** A model with a solver: the job runs its conversation in-process rather
   *  than one attempt per job, so the plan names the opening move and how much
   *  it will cost rather than a single password. `needsOracle` decides whether
   *  the attempt is worth filing at all below the host's charisma requirement,
   *  since `heartbleed` is the only charisma-gated call. */
  | { kind: "solve"; password: string; note: string; needsOracle: boolean; budget: number }
  | { kind: "probe"; password: string; reason: string }
  | { kind: "none"; reason: string };

/** A format-shaped throwaway, used once per host on a model we cannot solve.
 *
 * This looks pointless and is not. A model's oracle only exists once you have
 * failed against it, because the response is written to the log ring BY the
 * attempt. One deliberate failure is what turns an unattempted model into a
 * captured oracle the UI can show and a human can reason from. */
export function probePassword(facts: PasswordFacts): string {
  const length = Math.max(1, Math.min(facts.passwordLength ?? 4, 16));
  return (facts.passwordFormat === "numeric" ? "0" : "a").repeat(length);
}

/** What to try next on a host, given how far its ledger got.
 *
 * `tried` is a COUNT, not a set, because `candidates` is ordered and stable: the
 * first `tried` entries are ruled out, so the ledger resumes instead of
 * restarting a 93-entry dictionary from the top after every mutation. */
export function planAttempt(
  entry: ModelEntry | undefined,
  facts: PasswordFacts,
  tried: number,
  probesUsed: number,
  probeLimit = 1,
  attempted: readonly string[] = [],
): Attempt {
  if (!entry) {
    return probesUsed < probeLimit
      ? { kind: "probe", password: probePassword(facts), reason: "unknown model: capture its oracle once" }
      : { kind: "none", reason: "unknown model" };
  }
  if (entry.candidates) {
    const list = entry.candidates(facts)
      .filter((candidate) => facts.passwordLength === undefined || candidate.length === facts.passwordLength)
      .filter((candidate) => facts.passwordFormat === undefined
        || getPasswordType(candidate) === facts.passwordFormat)
      .filter((candidate) => candidateMatchesEvidence(candidate, facts.evidence));
    const attemptedSet = new Set(attempted);
    const index = attempted.length > 0
      ? list.findIndex((candidate) => !attemptedSet.has(candidate))
      : (tried < list.length ? tried : -1);
    if (index >= 0) {
      return { kind: "candidate", password: list[index]!, index, total: list.length };
    }
    return { kind: "none", reason: `${entry.name} dictionary exhausted (${list.length} candidates)` };
  }
  const solver = solverFor(entry.id);
  if (solver) {
    // Ask the solver for its opening move, purely so the queue can say what the
    // task IS and price it. The job re-derives this and then keeps going; the
    // plan does not carry state.
    const opening = solver.first(facts);
    if (opening.kind === "give-up") {
      return { kind: "none", reason: `${entry.name}: ${opening.reason}` };
    }
    return {
      kind: "solve",
      password: opening.password,
      note: opening.note,
      needsOracle: opening.kind === "attempt" ? opening.needsOracle : false,
      budget: solver.budget(facts),
    };
  }
  if (probesUsed < probeLimit) {
    return { kind: "probe", password: probePassword(facts), reason: entry.blocked ?? "not implemented" };
  }
  return { kind: "none", reason: entry.blocked ?? "not implemented" };
}
