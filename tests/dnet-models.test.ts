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

  test("every unattempted model states why, and offers no candidates", () => {
    for (const id of MODEL_IDS) {
      const entry = describeModel(id);
      if (entry.status === "implemented") continue;
      expect(entry.blocked, `${id} is unattempted without saying why`).toBeDefined();
      expect(entry.blocked!.length).toBeGreaterThan(0);
      expect(entry.candidates, `${id} is unattempted but offers candidates`).toBeUndefined();
    }
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

  test("reported length and format prune impossible dictionary entries", () => {
    expect(planAttempt(
      describeModel("FreshInstall_1.0"),
      { passwordLength: 5, passwordFormat: "numeric" }, 0, 0,
    )).toEqual({ kind: "candidate", password: "12345", index: 0, total: 1 });
  });

  test("drained contains hints prune a dictionary before the next attempt", () => {
    expect(planAttempt(describeModel("TopPass"), {
      passwordLength: 6, passwordFormat: "numeric",
      evidence: [{ kind: "contains", chars: ["6", "6"], at: 1 }],
    }, 0, 0)).toEqual({ kind: "candidate", password: "696969", index: 0, total: 2 });
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
