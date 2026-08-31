import { describe, expect, test } from "bun:test";
import { SimWorld } from "../world.ts";
import { ProcessTable } from "../ns/process.ts";
import { DarknetSystem, requiredCharismaSkill } from "../features/dnet.ts";
import { mulberry32 } from "../core/rng.ts";
import { darkwebServerSpec } from "../network.ts";
import {
  generateSecret,
  MODEL_BUILDERS,
  passwordRng,
  type ServerConfig,
} from "../features/dnet-generators.ts";
import {
  capturePackets,
  checkPassword,
  getKingOfTheHillAltitude,
  isCloseToCorrectPassword,
  logEntryFor,
  type CheckableServer,
  type PacketWorld,
} from "../features/dnet-feedback.ts";
import {
  getPasswordType,
  LARGE_PRIMES,
  parseBaseNNumberString,
  parseSimpleArithmeticExpression,
  romanNumeralDecoder,
} from "../../shared/strategy/dnet/codecs.ts";

/** The password models: what each one generates, and what each one answers.
 *
 * This is the file that decides whether a solver written against the simulator
 * means anything. Before it, nineteen of the twenty-four models had an invented
 * password with an invented hint and ten of upstream's fifteen feedback arms
 * were missing — so a solver could be "correct" here and find nothing in the
 * game, which is the exact direction of divergence AGENTS.md calls worse than
 * not simulating at all.
 *
 * So the assertions are round trips, not spot values: every encoder is inverted
 * with the DECODER the solvers use (`shared/strategy/dnet/codecs.ts`), which is
 * the machine-checkable form of "the hint really does contain the answer".
 *
 * Source: ../bitburner-src @ 3162fd2590e221eadd0c0fbd46151913f7c4c41c */

/** Every model id `ModelIds` names, minus the labyrinth — which is a maze and
 * has no config builder. Source: src/DarkNet/Enums.ts:15-41 */
const ALL_MODELS = [
  "DeskMemo_3.1", "PHP 5.4", "ZeroLogon", "CloudBlare(tm)", "FreshInstall_1.0",
  "Pr0verFl0", "DeepGreen", "2G_cellular", "PrimeTime 2", "BellaCuore",
  "Laika4", "AccountsManager_4.2", "TopPass", "EuroZone Free", "NIL",
  "110100100", "RateMyPix.Auth", "OctantVoxel", "MathML", "Factori-Os",
  "BigMo%od", "KingOfTheHill", "OpenWebAccessPoint", "OrdoXenos",
] as const;

const DIFFICULTIES = [0, 2, 4, 8, 12, 18, 24, 30];

/** The five models that draw a fixed word instead of minting one. They are the
 * exception to every property of `getPassword`. */
const DICTIONARY_MODELS: readonly string[] = ["ZeroLogon", "FreshInstall_1.0", "Laika4", "TopPass", "EuroZone Free"];

/** A deterministic secret for one model at one difficulty. Seeded exactly as
 * the simulator seeds a real host, so anything asserted here is a property of
 * the hosts a run actually generates. */
function secretFor(modelId: string, difficulty: number, seed: number) {
  return generateSecret(modelId, difficulty, passwordRng(seed / 1000, `probe-${modelId}-${seed}`));
}

function configFor(modelId: string, difficulty: number, seed: number): ServerConfig {
  return MODEL_BUILDERS[modelId]!(difficulty, passwordRng(seed / 1000, `probe-${modelId}-${seed}`));
}

/** A server shaped as the failure switch wants it, for arm-by-arm tests. */
function server(over: Partial<CheckableServer> & { password: string }): CheckableServer {
  return {
    modelId: "ZeroLogon",
    hostname: "probe-0",
    passwordHint: "hint",
    data: "",
    difficulty: 4,
    ...over,
  };
}

const QUIET_WORLD: PacketWorld = {
  rand: mulberry32(99),
  movablePasswords: () => ["1111"],
  generateName: () => "probe-0",
  lastAttempted: () => null,
};

describe("every model mints a real password", () => {
  test("passwordFormat is derived from the password and passwordLength measures it", () => {
    // Derive both solver seed facts from the generated password; several models
    // draw letters above difficulty 8.
    for (const modelId of ALL_MODELS) {
      for (const difficulty of DIFFICULTIES) {
        for (let seed = 1; seed <= 12; seed++) {
          const secret = secretFor(modelId, difficulty, seed);
          expect(secret.passwordFormat).toBe(getPasswordType(secret.password));
          expect(secret.passwordLength).toBe(secret.password.length);
        }
      }
    }
  });

  test("at least one model really does report a non-numeric format", () => {
    // Guards the test above from passing vacuously.
    const formats = new Set<string>();
    for (const modelId of ALL_MODELS) {
      for (const difficulty of DIFFICULTIES) {
        for (let seed = 1; seed <= 20; seed++) formats.add(secretFor(modelId, difficulty, seed).passwordFormat);
      }
    }
    expect(formats.has("numeric")).toBe(true);
    expect(formats.has("alphanumeric") || formats.has("alphabetic")).toBe(true);
  });

  test("a GENERATED numeric password of length >= 2 never starts with 0", () => {
    // `getPassword` ends in `Number(password).toString()`, which is the single
    // fact that halves the search space for every numeric solver.
    //
    // It is a property of the GENERATOR, not of the net: `FreshInstall_1.0`
    // draws "0000" out of a dictionary and never goes near `getPassword`, so a
    // solver may only lean on this where the model mints its own password. The
    // five dictionary models are excluded here for exactly that reason.
    for (const modelId of ALL_MODELS) {
      if (DICTIONARY_MODELS.includes(modelId)) continue;
      for (const difficulty of DIFFICULTIES) {
        for (let seed = 1; seed <= 30; seed++) {
          const secret = secretFor(modelId, difficulty, seed);
          if (secret.passwordFormat !== "numeric" || secret.password.length < 2) continue;
          expect(secret.password.startsWith("0")).toBe(false);
        }
      }
    }
  });

  test("a numeric password always survives a Number round trip", () => {
    // `getPassword` slices to fifteen digits above MAX_SAFE_INTEGER, and
    // `Factori-Os` rejects any product that does not round-trip — so a solver
    // may parse a numeric password with `Number` and re-print it. Note that
    // `Factori-Os` CAN exceed MAX_SAFE_INTEGER while still round-tripping, so
    // the invariant is exactness, not magnitude.
    for (const modelId of ALL_MODELS) {
      if (DICTIONARY_MODELS.includes(modelId)) continue;
      for (const difficulty of [0, 12, 30, 50]) {
        for (let seed = 1; seed <= 30; seed++) {
          const secret = secretFor(modelId, difficulty, seed);
          if (secret.passwordFormat !== "numeric") continue;
          expect(String(Number(secret.password))).toBe(secret.password);
        }
      }
    }
  });

  test("the same (draw, hostname) always regenerates the same secret, and a different one does not", () => {
    const a = generateSecret("MathML", 18, passwordRng(0.4242, "dnet-3-1"));
    const b = generateSecret("MathML", 18, passwordRng(0.4242, "dnet-3-1"));
    const c = generateSecret("MathML", 18, passwordRng(0.4242, "dnet-3-2"));
    expect(a).toEqual(b);
    expect(a.password).not.toBe(c.password);
  });
});

describe("the encoders round-trip with the decoders the solvers use", () => {
  test("BellaCuore below difficulty 8 puts the answer in the hint, in Latin", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const config = configFor("BellaCuore", 4, seed);
      expect(romanNumeralDecoder(config.passwordHintData!)).toBe(Number(config.password));
      expect(config.staticPasswordHint).toContain(config.passwordHintData!);
    }
  });

  test("BellaCuore at or above difficulty 8 gives a bracket that contains the answer", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const config = configFor("BellaCuore", 18, seed);
      const [min, max] = config.passwordHintData!.split(",");
      expect(romanNumeralDecoder(min!)).toBeLessThanOrEqual(Number(config.password));
      expect(romanNumeralDecoder(max!)).toBeGreaterThan(Number(config.password));
    }
  });

  test("OctantVoxel's base-N encoding inverts to the password, fractional bases included", () => {
    for (const difficulty of [4, 18]) {
      for (let seed = 1; seed <= 40; seed++) {
        const config = configFor("OctantVoxel", difficulty, seed);
        const [base, encoded] = config.passwordHintData!.split(",");
        const decoded = parseBaseNNumberString(encoded!, Number(base));
        // The tolerance is upstream's own: above difficulty 12 the base is
        // fractional, so exactness is not on offer and `isCloseToCorrectPassword`
        // is what decides the attempt.
        expect(isCloseToCorrectPassword(config.password, decoded)).toBe(true);
      }
    }
  });

  test("OrdoXenos's xor mask inverts, and the encoded half never holds a ; or a space", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const config = configFor("OrdoXenos", 18, seed);
      const [encoded, masks] = config.passwordHintData!.split(";");
      expect(encoded).not.toContain(" ");
      const decoded = [...encoded!]
        .map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ parseInt(masks!.split(" ")[i]!, 2)))
        .join("");
      expect(decoded).toBe(config.password);
      expect(config.staticPasswordHint).toContain(encoded!);
    }
  });

  test("110100100's binary decodes back to the password", () => {
    for (const difficulty of [4, 18]) {
      for (let seed = 1; seed <= 30; seed++) {
        const config = configFor("110100100", difficulty, seed);
        const decoded = config.passwordHintData!
          .split(" ")
          .map((byte) => String.fromCharCode(parseInt(byte, 2)))
          .join("");
        expect(decoded).toBe(config.password);
      }
    }
  });

  test("CloudBlare(tm)'s captcha is the password with non-digit filler between the characters", () => {
    for (const difficulty of [0, 2, 8]) {
      for (let seed = 1; seed <= 30; seed++) {
        const config = configFor("CloudBlare(tm)", difficulty, seed);
        // The whole attack: `filler` contains no digits, so stripping every
        // non-digit is the answer.
        expect(config.passwordHintData!.replace(/[^0-9]/g, "")).toBe(config.password);
      }
    }
  });

  test("DeskMemo_3.1's hint ends in the password outright", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const config = configFor("DeskMemo_3.1", 2, seed);
      const tokens = config.staticPasswordHint.split(" ");
      expect(tokens[tokens.length - 1]).toBe(config.password);
    }
  });

  test("PHP 5.4 publishes the sorted multiset and nothing about the order", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const config = configFor("PHP 5.4", 18, seed);
      expect(config.passwordHintData).toBe(config.password.split("").sort().join(""));
    }
  });

  test("PrimeTime 2's target really is divisible by the password, and the password is a large prime", () => {
    for (const difficulty of [8, 18, 30]) {
      for (let seed = 1; seed <= 30; seed++) {
        const config = configFor("PrimeTime 2", difficulty, seed);
        // BigInt because the target reaches ~8.2e15 — a float modulo there is
        // not to be trusted, which is also why a solver must not trial-divide.
        expect(BigInt(config.passwordHintData!) % BigInt(config.password)).toBe(0n);
        expect(LARGE_PRIMES).toContain(Number(config.password));
      }
    }
  });

  test("MathML's expression parses to the password, payload and all, without executing anything", () => {
    const before = (globalThis as Record<string, unknown>)["pwn3d"];
    for (const difficulty of [8, 14, 18, 24, 30]) {
      for (let seed = 1; seed <= 40; seed++) {
        const config = configFor("MathML", difficulty, seed);
        expect(parseSimpleArithmeticExpression(config.passwordHintData!)).toBeCloseTo(Number(config.password), 6);
      }
    }
    // The bait: upstream appends a payload that sets `globalThis.pwn3d` and
    // opens the dev menu if it is ever evaluated. Parsing must not.
    expect((globalThis as Record<string, unknown>)["pwn3d"]).toBe(before);
  });

  test("MathML really does emit the injection payload and the parenthesis splice at high difficulty", () => {
    // Guards the test above from passing because the bait was never generated.
    let injected = 0;
    let spliced = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const data = configFor("MathML", 30, seed).passwordHintData!;
      if (data.includes("globalThis.pwn3d")) injected++;
      if (data.includes("(ns.exit(),")) spliced++;
    }
    expect(injected).toBeGreaterThan(0);
    expect(spliced).toBeGreaterThan(0);
  });

  test("Factori-Os's password is a product of the primes it is built from", () => {
    for (const difficulty of [8, 18]) {
      for (let seed = 1; seed <= 30; seed++) {
        const config = configFor("Factori-Os", difficulty, seed);
        expect(Number(config.password)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        expect(Number(config.password) % 1).toBe(0);
      }
    }
  });

  test("Pr0verFl0's hint states the buffer length, and a doubled string of it authenticates", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const config = configFor("Pr0verFl0", 8, seed);
      const stated = Number(config.staticPasswordHint.match(/(\d+) bytes/)![1]);
      expect(stated).toBe(config.password.length);
      const verdict = checkPassword(
        server({ modelId: "Pr0verFl0", password: config.password }),
        "0".repeat(stated * 2),
        0,
        QUIET_WORLD,
      );
      expect(verdict.ok).toBe(true);
    }
  });
});

describe("the failure switch, arm by arm", () => {
  test("DeepGreen counts exact and misplaced characters, with upstream's own grammar", () => {
    const verdict = checkPassword(server({ modelId: "DeepGreen", password: "1223" }), "1232", 0, QUIET_WORLD);
    expect(verdict.data).toBe("2,2");
    expect(verdict.message).toBe("Hint: 2 symbols are match exactly,  and 2 symbols match but are in the wrong place.");
    const one = checkPassword(server({ modelId: "DeepGreen", password: "1234" }), "1555", 0, QUIET_WORLD);
    expect(one.data).toBe("1,0");
    expect(one.message).toContain("1 symbol is match exactly");
  });

  test("AccountsManager_4.2 answers Higher or Lower and nothing else", () => {
    const high = checkPassword(server({ modelId: "AccountsManager_4.2", password: "500" }), "900", 0, QUIET_WORLD);
    const low = checkPassword(server({ modelId: "AccountsManager_4.2", password: "500" }), "100", 0, QUIET_WORLD);
    expect(high.data).toBe("Lower");
    expect(low.data).toBe("Higher");
  });

  test("BellaCuore answers the same bisection in Latin", () => {
    const high = checkPassword(server({ modelId: "BellaCuore", password: "500" }), "900", 0, QUIET_WORLD);
    const low = checkPassword(server({ modelId: "BellaCuore", password: "500" }), "100", 0, QUIET_WORLD);
    expect(high.data).toBe("ALTUS NIMIS");
    expect(low.data).toBe("PARUM BREVIS");
  });

  test("NIL answers per POSITION, which is why one repeated symbol resolves a position permanently", () => {
    const verdict = checkPassword(server({ modelId: "NIL", password: "4441" }), "4444", 0, QUIET_WORLD);
    expect(verdict.data).toBe("yes,yes,yes,yesn't");
  });

  test("RateMyPix.Auth's peppers are a COUNT, not a positional mask", () => {
    const verdict = checkPassword(server({ modelId: "RateMyPix.Auth", password: "1234" }), "1934", 0, QUIET_WORLD);
    const [peppers, length] = verdict.data.split("/");
    // Three matches, joined with no gap for the miss — position is unrecoverable.
    expect(length).toBe("4");
    // U+1F336 U+FE0F is three UTF-16 units, so a naive `.length / 1` is wrong
    // by a factor of three and a solver that used it would read 9 matches.
    expect(peppers!.length).toBe(9);
    expect([...peppers!.matchAll(/\u{1F336}/gu)].length).toBe(3);
    const none = checkPassword(server({ modelId: "RateMyPix.Auth", password: "1234" }), "9999", 0, QUIET_WORLD);
    expect(none.data).toBe("0/4");
  });

  test("Factori-Os reports divisibility — and reports that the password IS divisible by zero", () => {
    const yes = checkPassword(server({ modelId: "Factori-Os", password: "30" }), "5", 0, QUIET_WORLD);
    const no = checkPassword(server({ modelId: "Factori-Os", password: "30" }), "7", 0, QUIET_WORLD);
    expect(yes.data).toBe("true");
    expect(no.data).toBe("false");
    // `30 % 0` is NaN, which is falsy. Upstream's bug, and the reason a solver
    // must never send "0": it would take the answer as evidence.
    expect(checkPassword(server({ modelId: "Factori-Os", password: "30" }), "0", 0, QUIET_WORLD).data).toBe("true");
    expect(checkPassword(server({ modelId: "Factori-Os", password: "30" }), "", 0, QUIET_WORLD).data).toBe("false");
  });

  test("BigMo%od's inner modulus is ((n-1) % 32) + 1, not the (n % 32) the hint claims", () => {
    // Which is why every n <= 32 makes the outer modulo a no-op and hands over
    // `password % n` cleanly.
    const at32 = checkPassword(server({ modelId: "BigMo%od", password: "1000" }), "32", 0, QUIET_WORLD);
    expect(at32.data).toBe("8");
    expect(at32.message).toBe("(Password % 32) % 32 = 8");
    const at27 = checkPassword(server({ modelId: "BigMo%od", password: "1000" }), "27", 0, QUIET_WORLD);
    expect(at27.data).toBe(String(1000 % 27));
    expect(at27.message).toBe("(Password % 27) % (27 % 32) = 1");
  });

  test("OctantVoxel and MathML accept a near miss — absolute under 0.01, or relative under 0.005", () => {
    // The direction of this divergence is the dangerous one: demanding exact
    // equality here would fail both solvers in the simulator while they
    // succeeded in the game.
    for (const modelId of ["OctantVoxel", "MathML"]) {
      const host = server({ modelId, password: "1234.5", data: "16,4D2.8" });
      expect(checkPassword(host, "1234.5", 0, QUIET_WORLD).ok).toBe(true);
      expect(checkPassword(host, "1234.505", 0, QUIET_WORLD).ok).toBe(true);
      expect(checkPassword(host, "1240", 0, QUIET_WORLD).ok).toBe(true);
      const miss = checkPassword(host, "1300", 0, QUIET_WORLD);
      expect(miss.ok).toBe(false);
      expect(miss.data).toBe("16,4D2.8");
      expect(checkPassword(host, "not a number", 0, QUIET_WORLD).ok).toBe(false);
    }
  });

  test("2G_cellular hands over the index of the first mismatch outright", () => {
    const verdict = checkPassword(server({ modelId: "2G_cellular", password: "13579" }), "13000", 4200, QUIET_WORLD);
    expect(verdict.message).toBe("Found a mismatch while checking each character (2)");
    expect(verdict.data).toBe("Response time: 4200ms");
  });

  test("Pr0verFl0 reports the two halves of the overflowed buffer", () => {
    const verdict = checkPassword(server({ modelId: "Pr0verFl0", password: "abcd" }), "ab", 0, QUIET_WORLD);
    const [received, expected] = verdict.data.split(",");
    expect(received).toBe("abˍˍ");
    expect(expected).toBe("■■■■");
    expect(verdict.ok).toBe(false);
  });

  test("KingOfTheHill's landscape is a function of the password alone, and peaks on it", () => {
    const host = server({ modelId: "KingOfTheHill", password: "5000", difficulty: 24 });
    const near = checkPassword(host, "5001", 0, QUIET_WORLD);
    const again = checkPassword(host, "5001", 0, QUIET_WORLD);
    expect(near.data).toBe(again.data);
    // Inside the 3% band the side hills switch off: a single clean gaussian of
    // height 10000 centred on the password, which is what makes one reading
    // enough to invert.
    const width = 10 ** Math.max(4 - 2, 0) + 1;
    expect(Number(near.data)).toBeCloseTo(10000 * Math.exp(-1 / width ** 2), 6);
    expect(getKingOfTheHillAltitude({ password: "5000", difficulty: 24 }, "5001")).toBe(Number(near.data));
    // Far away, the full multi-hill graph — and definitely not the peak.
    expect(Number(checkPassword(host, "1", 0, QUIET_WORLD).data)).toBeLessThan(10000);
  });

  test("PHP 5.4's RMSD arm needs length >= 5 AND a same-length attempt", () => {
    const long = server({ modelId: "PHP 5.4", password: "13579", data: "13579" });
    const withRmsd = checkPassword(long, "13570", 0, QUIET_WORLD);
    expect(withRmsd.data).toBe(`13579; RMS Deviation:${Math.sqrt(81 / 5).toFixed(3)}`);
    // A different length, or a short password, and there is no oracle at all —
    // which is what forces the sub-5 case to enumerate permutations blind.
    expect(checkPassword(long, "1357", 0, QUIET_WORLD).data).toBe("13579");
    const short = server({ modelId: "PHP 5.4", password: "1357", data: "1357" });
    expect(checkPassword(short, "1375", 0, QUIET_WORLD).data).toBe("1357");
  });

  test("OpenWebAccessPoint leaks host:password below difficulty 17 and the bare password above it", () => {
    const world: PacketWorld = { ...QUIET_WORLD, rand: mulberry32(11) };
    const easy = server({ modelId: "OpenWebAccessPoint", password: "8642", hostname: "dnet-2-1", difficulty: 12 });
    for (let i = 0; i < 20; i++) {
      expect(checkPassword(easy, "0000", 0, world).data).toContain(" dnet-2-1:8642 ");
    }
    const hard = server({ modelId: "OpenWebAccessPoint", password: "8642", hostname: "dnet-2-1", difficulty: 20 });
    for (let i = 0; i < 20; i++) {
      const blob = checkPassword(hard, "0000", 0, world).data;
      expect(blob).toContain("8642");
      expect(blob).not.toContain("dnet-2-1:8642");
    }
  });

  test("capturePackets hides the payload somewhere inside a blob of junk", () => {
    const blob = capturePackets(
      { hostname: "dnet-1-1", password: "24680", difficulty: 4 },
      { ...QUIET_WORLD, rand: mulberry32(3) },
    );
    expect(blob).toContain(" dnet-1-1:24680 ");
    expect(blob.length).toBeGreaterThan(100);
  });

  test("a model with no arm of its own falls through to its static hint, as upstream's default does", () => {
    const verdict = checkPassword(
      server({ modelId: "TopPass", password: "dragon", passwordHint: "It's a common password" }),
      "qwerty",
      0,
      QUIET_WORLD,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toBe("It's a common password");
    expect(verdict.data).toBe("");
  });
});

describe("what reaches the log ring", () => {
  test("Pr0verFl0's log entry rewrites passwordAttempted to the RECEIVED buffer", () => {
    // The exception every oracle matcher has to know about: match a capture by
    // "the string I sent" and this model's feedback is lost forever.
    const response = checkPassword(server({ modelId: "Pr0verFl0", password: "abcd" }), "ab", 0, QUIET_WORLD);
    const entry = logEntryFor("Pr0verFl0", "ab", 401, response);
    expect(entry["passwordAttempted"]).toBe("abˍˍ");
    expect(entry["passwordExpected"]).toBe("■■■■");
    expect(entry["data"]).toBeUndefined();
  });

  test("every other model logs what we sent, with the model's data beside it", () => {
    const response = checkPassword(server({ modelId: "NIL", password: "4441" }), "4444", 0, QUIET_WORLD);
    const entry = logEntryFor("NIL", "4444", 401, response);
    expect(entry["passwordAttempted"]).toBe("4444");
    expect(entry["data"]).toBe("yes,yes,yes,yesn't");
  });

  test("a SUCCESS carries no data key at all, exactly as getGenericSuccess does not", () => {
    const response = checkPassword(server({ modelId: "NIL", password: "4444" }), "4444", 0, QUIET_WORLD);
    const entry = logEntryFor("NIL", "4444", 200, response);
    expect(entry["data"]).toBeUndefined();
    expect(entry["message"]).toBe("Success");
  });
});

describe("the net a run actually generates", () => {
  function system(): DarknetSystem {
    const world = new SimWorld({
      seed: 1,
      bitnode: 15,
      network: [
        { hostname: "n00dles", hackDifficulty: 1, moneyAvailable: 1, requiredHackingSkill: 1, serverGrowth: 1, numOpenPortsRequired: 1, maxRam: 4 },
        darkwebServerSpec(),
      ],
    });
    const processes = new ProcessTable(world.servers, world.clock);
    const network = new Map<string, string[]>([["home", ["n00dles", "darkweb"]], ["darkweb", ["home"]]]);
    const dnet = new DarknetSystem({
      servers: world.servers,
      network,
      processes,
      generate: mulberry32(5),
      random: mulberry32(6),
      logNoise: mulberry32(7),
      bitNode: 15,
      fullAccess: () => true,
      hasProgram: () => false,
      installedAugmentations: () => new Set<string>(),
      allowRedPill: () => true,
      world,
      player: world.player,
      homeFiles: () => new Set<string>(),
      darknetMoneyMultiplier: () => 1,
    });
    dnet.populate();
    return dnet;
  }

  test("required charisma uses rolled difficulty, including the upstream variance", () => {
    expect(requiredCharismaSkill(0, 5, 300, 0)).toBe(1);
    expect(requiredCharismaSkill(1, 5, 300, 0)).toBe(9);
    expect(requiredCharismaSkill(10, 5, 300, 0.5)).toBe(726);
  });

  test("difficulty is an integer property independent of the occupied grid row", () => {
    const hosts = [...system().hosts.values()].filter((host) => !host.isStationary);
    expect(hosts.every((host) => Number.isInteger(host.difficulty))).toBe(true);
    expect(hosts.some((host) => host.difficulty !== host.depth)).toBe(true);
  });

  test("every generated host's secret re-derives from its recorded draw and hostname", () => {
    // This is what makes a solver test able to know the answer without reaching
    // into the net: one draw off the world stream, plus the hostname, is the
    // whole seed.
    const dnet = system();
    let checked = 0;
    for (const host of dnet.hosts.values()) {
      if (host.modelId === "(The Labyrinth)") continue;
      const again = generateSecret(host.modelId, host.difficulty, passwordRng(host.secretDraw, host.hostname));
      expect(again.password).toBe(host.password);
      expect(again.hint).toBe(host.passwordHint);
      expect(again.data).toBe(host.data);
      expect(again.passwordFormat).toBe(host.passwordFormat);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("the shallow net is genuinely full of the models the tier table promises", () => {
    const dnet = system();
    const shallow = [...dnet.hosts.values()].filter((host) => host.difficulty <= 2 && host.depth >= 0);
    expect(shallow.length).toBeGreaterThan(0);
    for (const host of shallow) {
      expect(["ZeroLogon", "DeskMemo_3.1", "FreshInstall_1.0", "CloudBlare(tm)"]).toContain(host.modelId);
    }
  });

  test("an attempt against a real generated host answers through the model's own arm", () => {
    const dnet = system();
    const host = [...dnet.hosts.values()].find((entry) => entry.modelId === "DeskMemo_3.1")
      ?? [...dnet.hosts.values()].find((entry) => entry.depth >= 0)!;
    expect(dnet.checkPassword(host.hostname, host.password).ok).toBe(true);
    const wrong = dnet.checkPassword(host.hostname, `${host.password}x`);
    expect(wrong.ok).toBe(false);
    dnet.logAttempt(host.hostname, `${host.password}x`, 401, wrong, 1000);
    expect(host.logs[0]).toContain("passwordAttempted");
  });
});
