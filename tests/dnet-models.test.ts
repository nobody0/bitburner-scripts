import { describe, expect, test } from "bun:test";
import {
  MODEL_IDS,
  describeModel,
  modelEntry,
  modelFamily,
  planAttempt,
  probePassword,
  type ModelId,
} from "../shared/strategy/dnet/models.ts";
import { solverFor } from "../shared/strategy/dnet/solvers/index.ts";
import { COMMON_PASSWORDS, DEFAULT_SETTINGS, DOG_NAMES, EU_COUNTRIES } from "../shared/strategy/dnet/dictionaries.ts";

/** The model registry is groundwork for a cracker nobody has written yet, so
 * what these tests actually guard is that it stays TOTAL and stays HONEST:
 * every model upstream can generate has an arm, every arm names its oracle, and
 * nothing claims to be implemented that is not. */

describe("the model registry covers the game's taxonomy", () => {
  test("MODEL_IDS is exactly the 24 minigames plus the labyrinth sentinel", () => {
    // Transcribed from src/DarkNet/Enums.ts ModelIds. If upstream adds a model
    // this fails here rather than at 3am on a darknet host.
    const upstream = [
      "DeskMemo_3.1", "PHP 5.4", "ZeroLogon", "CloudBlare(tm)", "FreshInstall_1.0", "Pr0verFl0",
      "DeepGreen", "2G_cellular", "PrimeTime 2", "BellaCuore", "Laika4", "AccountsManager_4.2",
      "TopPass", "EuroZone Free", "NIL", "110100100", "RateMyPix.Auth", "OctantVoxel",
      "MathML", "Factori-Os", "BigMo%od", "KingOfTheHill", "OpenWebAccessPoint", "OrdoXenos",
      "(The Labyrinth)",
    ];
    expect([...MODEL_IDS].sort() as string[]).toEqual(upstream.sort());
  });

  test("describeModel is total, and every arm says what the oracle IS", () => {
    for (const id of MODEL_IDS) {
      const entry = describeModel(id);
      expect(entry.id, `${id} returns the wrong id`).toBe(id);
      // The upstream ModelIds KEY is the only place the mechanic is named, so an
      // empty name would throw away the one piece of meaning we have.
      expect(entry.name.length, `${id} has no upstream name`).toBeGreaterThan(0);
      expect(entry.oracle.length, `${id} does not describe its oracle`).toBeGreaterThan(20);
    }
  });

  test("an unrecognised model id is undefined, never a silent default", () => {
    // This is the loud-failure contract: a model we have never seen must reach
    // the caller as "I do not know this", so it can be counted and reported.
    expect(modelEntry("SomethingNew_9.9")).toBeUndefined();
    expect(modelEntry(undefined)).toBeUndefined();
    expect(modelEntry("")).toBeUndefined();
    expect(modelEntry("ZeroLogon")?.name).toBe("NoPassword");
    // ...but the UI still gets a family, so an unknown model draws a box rather
    // than crashing the map.
    expect(modelFamily("SomethingNew_9.9")).toBe("oracle");
  });

  test("the never arm throws rather than returning a fabricated entry", () => {
    expect(() => describeModel("NotAModel" as ModelId)).toThrow(/unhandled darknet model/);
  });
});

describe("the registry says what is really implemented", () => {
  test("every model but the labyrinth is implemented, and status is DERIVED", () => {
    // `status` is no longer written on each arm by hand; `describeModel` reads
    // it off the solver registry (`solvers/index.ts`), so this is checking a
    // fact rather than a comment. The labyrinth is the one holdout and it is
    // not a password at all — it is a maze, walked by a process.
    const unattempted = MODEL_IDS.filter((id) => describeModel(id).status === "unattempted");
    expect([...unattempted] as string[]).toEqual(["(The Labyrinth)"]);
    expect(describeModel("(The Labyrinth)").blocked).toBeDefined();
  });

  test("nothing claims to be implemented without something that implements it", () => {
    // The honesty rule, now mechanical: a model is implemented if and only if it
    // has a dictionary to walk or a solver to run.
    for (const id of MODEL_IDS) {
      const entry = describeModel(id);
      const backed = entry.candidates !== undefined || solverFor(id) !== undefined;
      expect(entry.status === "implemented", `${id} status disagrees with its backing`).toBe(backed);
      // And a solved model must not still carry the note explaining why it was
      // not written, or the panel reports a reason that stopped being true.
      if (entry.status === "implemented") expect(entry.blocked, `${id} still claims to be blocked`).toBeUndefined();
    }
  });

  test("the five dictionary models stay dictionaries, with no solver", () => {
    // Their attack is an ordered list resumed through `AttemptLedger.tried`,
    // which is the one well-tested path in this feature. A solver here would be
    // a rewrite of something that already works.
    const dictionaries = MODEL_IDS.filter((id) => describeModel(id).candidates !== undefined);
    expect([...dictionaries].sort() as string[]).toEqual(
      ["EuroZone Free", "FreshInstall_1.0", "Laika4", "TopPass", "ZeroLogon"].sort(),
    );
    for (const id of dictionaries) expect(solverFor(id), `${id} has both a dictionary and a solver`).toBeUndefined();
  });

  test("each implemented model offers exactly its upstream dictionary", () => {
    const candidates = (id: ModelId) => describeModel(id).candidates?.({});
    expect(candidates("ZeroLogon")).toEqual([""]);
    expect(candidates("FreshInstall_1.0")).toEqual(DEFAULT_SETTINGS);
    expect(candidates("Laika4")).toEqual(DOG_NAMES);
    expect(candidates("EuroZone Free")).toEqual(EU_COUNTRIES);
    expect(candidates("TopPass")).toEqual(COMMON_PASSWORDS);
  });

  test("every unattempted model states why, and offers no candidates", () => {
    for (const id of MODEL_IDS) {
      const entry = describeModel(id);
      if (entry.status === "implemented") continue;
      expect(entry.blocked, `${id} is unattempted without saying why`).toBeDefined();
      expect(entry.blocked!.length).toBeGreaterThan(0);
      expect(entry.candidates, `${id} is unattempted but offers candidates`).toBeUndefined();
    }
  });

  test("the two models a human is most likely to solve first name their exact oracle", () => {
    // These are the ones the registry exists to hand over, so the text has to
    // carry the actual format rather than a gesture at it.
    expect(describeModel("2G_cellular").oracle).toContain("50ms");
    expect(describeModel("2G_cellular").feedback).toBe("timing");
    expect(describeModel("DeepGreen").oracle).toContain("<exact>,<misplaced>");
    expect(describeModel("DeepGreen").feedback).toBe("mastermind");
    // And the buffer model, whose whole trick is that a wrong string can win.
    expect(describeModel("Pr0verFl0").oracle).toContain("NON-EQUAL");
  });

  test("models whose answer is already in the hint are marked as details reads", () => {
    // These need a decoder, not a search, and the input arrives free from
    // getServerDetails. Mislabelling one as `heartbleed` would send a future
    // solver hunting for feedback that was never needed.
    for (const id of ["DeskMemo_3.1", "CloudBlare(tm)", "110100100", "OrdoXenos", "OctantVoxel", "PrimeTime 2"] as const) {
      expect(describeModel(id).via, `${id} should be readable without an attempt`).toBe("details");
    }
    // The labyrinth is the one model whose data really does come back on
    // authenticate(), because it is handled before the model switch.
    expect(describeModel("(The Labyrinth)").via).toBe("authenticate");
  });
});

describe("planAttempt walks a dictionary and then stops", () => {
  test("it resumes from the ledger count rather than restarting", () => {
    const entry = describeModel("FreshInstall_1.0");
    expect(planAttempt(entry, {}, 0, 0)).toEqual({ kind: "candidate", password: "admin", index: 0, total: 4 });
    // The whole reason `tried` is a count over an ORDERED list: after a mutation
    // the ledger picks up where it left off instead of re-spending three calls.
    expect(planAttempt(entry, {}, 2, 0)).toEqual({ kind: "candidate", password: "0000", index: 2, total: 4 });
  });

  test("an exhausted dictionary says so instead of looping", () => {
    const result = planAttempt(describeModel("FreshInstall_1.0"), {}, 4, 0);
    expect(result.kind).toBe("none");
    expect(result.kind === "none" && result.reason).toContain("exhausted");
  });

  test("a solver-backed model plans a CONVERSATION, not a single guess", () => {
    const entry = describeModel("DeepGreen");
    const planned = planAttempt(entry, { passwordLength: 5, passwordFormat: "numeric" }, 0, 0);
    expect(planned.kind).toBe("solve");
    if (planned.kind !== "solve") return;
    // It declares its cost up front, which is what lets the queue rank it and
    // the job bound it.
    expect(planned.budget).toBeGreaterThan(1);
    expect(planned.needsOracle).toBe(true);
    // And unlike a probe it does not retire once a deliberate failure is spent.
    const later = planAttempt(entry, { passwordLength: 5, passwordFormat: "numeric" }, 0, 5);
    expect(later.kind).toBe("solve");
  });

  test("a closed-form model needs no oracle, so it works below the charisma gate", () => {
    // The property the queue relies on to file these against hosts whose
    // heartbleed would refuse: the answer arrives in `authenticate`'s own
    // return value, not in the log ring.
    const planned = planAttempt(
      describeModel("DeskMemo_3.1"),
      { passwordLength: 4, passwordFormat: "numeric", passwordHint: "The password is 4821" },
      0,
      0,
    );
    expect(planned.kind).toBe("solve");
    if (planned.kind !== "solve") return;
    expect(planned.needsOracle).toBe(false);
    expect(planned.password).toBe("4821");
    expect(planned.budget).toBe(1);
  });

  test("the labyrinth still gets exactly ONE probe, then nothing", () => {
    // The probe path survives for the one model with no solver. It is not a
    // guess: a model's oracle only exists once you have failed against it,
    // because the response is written to the log ring BY the attempt.
    const entry = describeModel("(The Labyrinth)");
    const first = planAttempt(entry, { passwordLength: 5, passwordFormat: "numeric" }, 0, 0);
    expect(first.kind).toBe("probe");
    expect(first.kind === "probe" && first.password).toBe("00000");
    const second = planAttempt(entry, { passwordLength: 5, passwordFormat: "numeric" }, 0, 1);
    expect(second.kind).toBe("none");
  });

  test("an unknown model also probes once, and says it is unknown", () => {
    const first = planAttempt(undefined, { passwordLength: 3, passwordFormat: "numeric" }, 0, 0);
    expect(first.kind).toBe("probe");
    expect(first.kind === "probe" && first.reason).toContain("unknown model");
    expect(planAttempt(undefined, {}, 0, 1).kind).toBe("none");
  });

  test("the probe matches the advertised format and length", () => {
    expect(probePassword({ passwordLength: 4, passwordFormat: "numeric" })).toBe("0000");
    expect(probePassword({ passwordLength: 3, passwordFormat: "alphabetic" })).toBe("aaa");
    // A zero-length or missing length must still produce something sendable:
    // authenticate() with an unusable argument would throw rather than fail.
    expect(probePassword({ passwordLength: 0, passwordFormat: "numeric" }).length).toBe(1);
    expect(probePassword({}).length).toBe(4);
    // MAX_PASSWORD_LENGTH is 50 and authenticate throws above 100, so the cap
    // keeps a garbage passwordLength from killing the agent.
    expect(probePassword({ passwordLength: 9999 }).length).toBe(16);
  });
});
