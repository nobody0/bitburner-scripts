/** Which solver owns each conversational or decoded password model.
 *
 * The five DICTIONARY models are deliberately absent. Their attack is an ordered
 * candidate list with no feedback at all, `planAttempt` already walks it, and
 * `AttemptLedger.tried` already resumes it across a mutation. Wrapping them in a
 * state machine would buy nothing and would put the one well-tested path in the
 * feature at risk. `solverFor` returning undefined therefore means "no
 * conversation needed", not "cannot be opened" — the caller falls back to the
 * dictionary walk.
 *
 * The labyrinth is absent for the opposite reason: it is a maze, not a password,
 * and its solver is a process that walks it. */

import type { ModelId, PasswordFacts } from "../models.ts";
import { CLOSED_FORM_SOLVERS } from "./closed-form.ts";
import { SEARCH_SOLVERS } from "./search.ts";
import { DEEP_SOLVERS } from "./deep.ts";
import { GROUP_SOLVERS } from "./group.ts";
import { HILL_SOLVERS } from "./hill.ts";
import type { Solver } from "./types.ts";

/** Which of `BellaCuore`'s two regimes a host is in, read off the SHAPE of
 * `data` rather than off its difficulty — the shape is a fact we are always
 * handed, and the difficulty is one we may not hold.
 *
 * Below difficulty 8 `data` is a single Roman numeral naming the password
 * outright; at or above it is `"<min>,<max>"` bounding a binary search.
 * Source: src/DarkNet/controllers/ServerGenerator.ts, getRomanNumeralConfig */
function bellaCuoreFor(facts: PasswordFacts): Solver {
  return (facts.data ?? "").includes(",") ? SEARCH_SOLVERS.romanRange : CLOSED_FORM_SOLVERS.romanNumeral;
}

/** The dispatcher, and it has to live at THIS level rather than inside either
 * half.
 *
 * The search solver gives up by name on a `data` with no comma, and a `give-up`
 * from `first()` is what `planAttempt` turns into `{ kind: "none" }` — which
 * stops `deriveTasks` filing an attempt task at all. So routing the decode
 * regime through the range solver did not merely cost an exchange: every
 * BellaCuore host below difficulty 8 was permanently unattemptable, and
 * `ROMAN_DECODE` was exported and never called by anything. */
const BELLA_CUORE: Solver = {
  // The pessimistic half. Only `planAttempt` reads this field, to decide whether
  // an attempt is worth filing below the charisma gate, and the per-step
  // `needsOracle` each regime returns is what the job actually acts on.
  needsOracle: true,
  budget: (facts) => bellaCuoreFor(facts).budget(facts),
  first: (facts) => bellaCuoreFor(facts).first(facts),
  next: (facts, state, seen) => bellaCuoreFor(facts).next(facts, state, seen),
};

/** Every model whose password is won by a conversation or a decode.
 *
 * `BellaCuore` appears once and is DISPATCHED between its two regimes by
 * `BELLA_CUORE` above: below difficulty 8 its `data` is the numeral itself and
 * the answer is a decode, at or above it is a range and the answer is a search.
 * The dispatcher reads which from the shape of `data`, so nothing here has to
 * know the difficulty. */
const BY_MODEL: Partial<Record<ModelId, Solver>> = {
  // Published, one call, no oracle, no charisma.
  "DeskMemo_3.1": CLOSED_FORM_SOLVERS.echo,
  "CloudBlare(tm)": CLOSED_FORM_SOLVERS.captcha,
  "110100100": CLOSED_FORM_SOLVERS.binary,
  "OrdoXenos": CLOSED_FORM_SOLVERS.xorMask,
  "PrimeTime 2": CLOSED_FORM_SOLVERS.largestPrimeFactor,
  "OctantVoxel": CLOSED_FORM_SOLVERS.baseN,
  "MathML": CLOSED_FORM_SOLVERS.arithmetic,
  "Pr0verFl0": CLOSED_FORM_SOLVERS.bufferOverflow,
  // Feedback-driven.
  "BellaCuore": BELLA_CUORE,
  "AccountsManager_4.2": SEARCH_SOLVERS.guessNumber,
  "BigMo%od": SEARCH_SOLVERS.tripleModulo,
  "NIL": SEARCH_SOLVERS.yesNo,
  "PHP 5.4": SEARCH_SOLVERS.sortedEcho,
  "2G_cellular": DEEP_SOLVERS.timingAttack,
  "Factori-Os": DEEP_SOLVERS.divisibility,
  "OpenWebAccessPoint": DEEP_SOLVERS.packetSniffer,
  "DeepGreen": GROUP_SOLVERS.mastermind,
  "RateMyPix.Auth": GROUP_SOLVERS.spiceLevel,
  "KingOfTheHill": HILL_SOLVERS.kingOfTheHill,
};

export function solverFor(modelId: string | undefined): Solver | undefined {
  if (modelId === undefined) return undefined;
  return BY_MODEL[modelId as ModelId];
}

/** Every dispatched model, used by registry consistency tests. */
export function solvedModels(): ModelId[] {
  return Object.keys(BY_MODEL) as ModelId[];
}
