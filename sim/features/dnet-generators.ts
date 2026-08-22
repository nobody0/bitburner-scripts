/** `ServerGenerator.ts`, transcribed: how every one of the twenty-four darknet
 * models mints its password and its hint.
 *
 * This exists as its own file because the transcription is long and because it
 * is the half a solver is written AGAINST. Until it landed, nineteen of the
 * twenty-four models had a stub numeric password with an invented hint, which
 * made every solver for them untestable — a sim that answers "you cannot guess
 * this" measures nothing about a strategy that could.
 *
 * Two shapes are deliberate and not cosmetic:
 *
 * 1. **Every builder takes an explicit `rand`.** Three upstream generators are
 *    UNBOUNDED rejection loops (`getXorMaskEncryptedPasswordConfig`'s
 *    `do/while`, `getPasswordMadeUpOfPrimesProduct`'s `do/while` and
 *    `generateSimpleArithmeticExpression`'s recursion-and-retry), so the number
 *    of draws a host consumes is unbounded too. The simulator's per-host draw
 *    budget is fixed-width on purpose — see the `dnet.mutationPlacement` entry
 *    in `DNET_ASSUMPTIONS` — so the caller takes ONE draw from the shared
 *    stream, derives a per-host `mulberry32` from it with `passwordRng`, and
 *    passes that in. Fixed cost, faithful distribution, and a host's secret
 *    becomes reproducible from its recorded seed alone, which is exactly what a
 *    convergence test wants.
 * 2. **The encoders are imported, not copied.** `shared/strategy/dnet/codecs.ts`
 *    owns them because the solvers need the DECODER of everything encoded here,
 *    and two transcriptions of one function drift the moment one is corrected.
 *
 * Source: ../bitburner-src @ 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/controllers/ServerGenerator.ts
 *   src/DarkNet/models/dictionaryData.ts (the dictionaries and `filler`)
 *   src/DarkNet/Constants.ts (MAX_PASSWORD_LENGTH) */

import {
  COMMON_PASSWORDS,
  DEFAULT_SETTINGS,
  DOG_NAMES,
  EU_COUNTRIES,
} from "../../shared/strategy/dnet/dictionaries.ts";
import {
  cleanArithmeticExpression,
  encodeNumberInBaseN,
  FILLER,
  getPassword,
  getPasswordType,
  LARGE_PRIMES,
  parseSimpleArithmeticExpression,
  romanNumeralEncoder,
  SMALL_PRIMES,
} from "../../shared/strategy/dnet/codecs.ts";
import { mulberry32 } from "../core/rng.ts";

export interface ServerConfig {
  modelId: string;
  password: string;
  staticPasswordHint: string;
  passwordHintData?: string;
}

export type PasswordFormat = ReturnType<typeof getPasswordType>;

/** `getFillerChars`: one to three characters of `filler`, none of them a digit
 * — which is the whole of `CloudBlare(tm)`'s weakness.
 * Source: src/DarkNet/controllers/ServerGenerator.ts:170-177 */
function getFillerChars(rand: () => number): string {
  let result = "";
  const num = Math.ceil(rand() * 3);
  for (let i = 0; i < num; i++) {
    result += FILLER[Math.floor(rand() * FILLER.length)];
  }
  return result;
}

// --- the per-model config builders ----------------------------------------

function getEchoVulnConfig(__difficulty: number, rand: () => number): ServerConfig {
  const hintTemplates = [
    "The password is",
    "The PIN is",
    "Remember to use",
    "It's set to",
    "The key is",
    "The secret is",
  ];
  const password = getPassword(3, false, rand);
  const hint = `${hintTemplates[Math.floor(rand() * hintTemplates.length)]} ${password}`;
  return { modelId: "DeskMemo_3.1", password, staticPasswordHint: hint };
}

function getSortedEchoVulnConfig(difficulty: number, rand: () => number): ServerConfig {
  const hintTemplates = [
    "The password is shuffled",
    "The key is made from",
    "I accidentally sorted the password:",
    "The PIN uses",
  ];
  const password = getPassword(Math.min(2 + difficulty / 7, 9), false, rand);
  const sortedPassword = password.split("").sort().join("");
  const hint = `${hintTemplates[Math.floor(rand() * hintTemplates.length)]} ${sortedPassword}`;
  return { modelId: "PHP 5.4", password, staticPasswordHint: hint, passwordHintData: sortedPassword };
}

function getDictionaryAttackConfig(
  dictionary: readonly string[],
  hintTemplates: readonly string[],
  modelId: string,
  rand: () => number,
): ServerConfig {
  return {
    modelId,
    password: dictionary[Math.floor(rand() * dictionary.length)]!,
    staticPasswordHint: hintTemplates[Math.floor(rand() * hintTemplates.length)]!,
  };
}

function getNoPasswordConfig(__difficulty: number, rand: () => number): ServerConfig {
  return getDictionaryAttackConfig(
    [""],
    [
      "The password is not set",
      "There is no password",
      "The PIN is empty",
      "Did I set a code?",
      "I didn't set a password",
    ],
    "ZeroLogon",
    rand,
  );
}

function getDefaultPasswordConfig(__difficulty: number, rand: () => number): ServerConfig {
  return getDictionaryAttackConfig(
    DEFAULT_SETTINGS,
    [
      "The password is the default password",
      "It's still the default",
      "The default password is set",
      "I never changed the password",
      "It's still the factory settings",
    ],
    "FreshInstall_1.0",
    rand,
  );
}

/** `CloudBlare(tm)`. The last character takes no filler, which is why the blob
 * ends on a digit. Source: ServerGenerator.ts:153-168 */
function getCaptchaConfig(difficulty: number, rand: () => number): ServerConfig {
  const password = getPassword(difficulty / 2 + 3, false, rand);
  const filledPassword = password
    .split("")
    .map((char, i) => {
      if (i >= password.length - 1) return char;
      return char + getFillerChars(rand);
    })
    .join("");
  return {
    modelId: "CloudBlare(tm)",
    password,
    staticPasswordHint: "Type the numbers to prove you are human",
    passwordHintData: filledPassword,
  };
}

function getDogNameConfig(__difficulty: number, rand: () => number): ServerConfig {
  return getDictionaryAttackConfig(
    DOG_NAMES,
    ["It's my dog's name", "It's the dog's name", "my first dog's name"],
    "Laika4",
    rand,
  );
}

function getMastermindHintConfig(difficulty: number, rand: () => number): ServerConfig {
  const alphanumeric = difficulty > 16 && rand() < 0.3;
  const passwordLength = Math.min((alphanumeric ? -1 : 2) + difficulty / 5, 10);
  return {
    modelId: "DeepGreen",
    password: getPassword(passwordLength, alphanumeric, rand),
    staticPasswordHint: "Only a true master may pass",
  };
}

function getTimingAttackConfig(difficulty: number, rand: () => number): ServerConfig {
  const hintTemplates = [
    "I thought about it for some time, but that is not the password.",
    "I spent a while on it, but that's not right",
    "I considered it for a bit, but that's not it",
    "I spent some time on it, but that's not the password",
  ];
  const alphanumeric = difficulty > 16 && rand() < 0.3;
  const length = Math.min((alphanumeric ? 0 : 3) + difficulty / 4, 8);
  return {
    modelId: "2G_cellular",
    password: getPassword(length, alphanumeric, rand),
    staticPasswordHint: hintTemplates[Math.floor(rand() * hintTemplates.length)]!,
  };
}

/** `BellaCuore`. Below difficulty 8 the hint IS the answer in Latin numerals;
 * at or above it the hint is a bracket and the failure arm is the oracle.
 * Source: ServerGenerator.ts:210-236 */
function getRomanNumeralConfig(difficulty: number, rand: () => number): ServerConfig {
  const password = Math.floor(rand() * 10 * (10 * (difficulty + 1)));
  if (difficulty < 8) {
    const encodedPassword = romanNumeralEncoder(password);
    return {
      modelId: "BellaCuore",
      password: `${password}`,
      staticPasswordHint: `The password is the value of the number '${encodedPassword}'`,
      passwordHintData: encodedPassword,
    };
  }
  const passwordRangeMin = rand() < 0.3 ? 0 : Math.floor(password * (rand() * 0.2 + 0.6));
  const passwordRangeMax = password + Math.floor(rand() * difficulty * 10 + 10);
  const encodedMin = romanNumeralEncoder(passwordRangeMin);
  const encodedMax = romanNumeralEncoder(passwordRangeMax);
  return {
    modelId: "BellaCuore",
    password: `${password}`,
    staticPasswordHint: `The password is between '${encodedMin}' and '${encodedMax}'`,
    passwordHintData: `${encodedMin},${encodedMax}`,
  };
}

/** `getLargestPrimeFactorPassword`. The large prime is drawn from index 2 up,
 * so the first two entries of `LARGE_PRIMES` can never be the answer.
 * Source: ServerGenerator.ts:684-697 */
function getLargestPrimeFactorPassword(difficulty: number, rand: () => number): {
  largestPrime: number;
  targetNumber: number;
} {
  const factorCount = 1 + Math.min(5, Math.floor(difficulty / 3));
  const largePrimeIndex = 2 + Math.floor(rand() * (LARGE_PRIMES.length - 2));
  const largestPrime = LARGE_PRIMES[largePrimeIndex]!;
  let number = largestPrime;
  for (let i = 1; i <= factorCount; i++) {
    number *= SMALL_PRIMES[Math.floor(rand() * SMALL_PRIMES.length)]!;
  }
  return { largestPrime, targetNumber: number };
}

function getLargestPrimeFactorConfig(difficulty: number, rand: () => number): ServerConfig {
  const details = getLargestPrimeFactorPassword(difficulty, rand);
  return {
    modelId: "PrimeTime 2",
    password: `${details.largestPrime}`,
    staticPasswordHint: `The password is the largest prime factor of ${details.targetNumber}`,
    passwordHintData: `${details.targetNumber}`,
  };
}

function getGuessNumberConfig(difficulty: number, rand: () => number): ServerConfig {
  const password = `${Math.floor((rand() * 10 * (difficulty + 3)) / 3)}`;
  const maxNumber = 10 ** password.length;
  return {
    modelId: "AccountsManager_4.2",
    password,
    staticPasswordHint: `The password is a number between 0 and ${maxNumber}`,
  };
}

function getLargeDictionaryConfig(__difficulty: number, rand: () => number): ServerConfig {
  return getDictionaryAttackConfig(COMMON_PASSWORDS, ["It's a common password"], "TopPass", rand);
}

function getEuCountryDictionaryConfig(__difficulty: number, rand: () => number): ServerConfig {
  return getDictionaryAttackConfig(EU_COUNTRIES, ["My favorite EU country"], "EuroZone Free", rand);
}

function getYesn_tConfig(difficulty: number, rand: () => number): ServerConfig {
  return {
    modelId: "NIL",
    password: getPassword(3 + difficulty / 2, difficulty > 8, rand),
    staticPasswordHint: "you are one who's'nt authorized",
  };
}

/** `Pr0verFl0`. The hint states the buffer length outright, which is the whole
 * of what the one crafted attempt needs. Ignores difficulty upstream.
 * Source: ServerGenerator.ts:274-282 */
function getBufferOverflowConfig(__difficulty: number, rand: () => number): ServerConfig {
  const length = Math.floor(4 + rand() * 4);
  const password = getPassword(length, true, rand);
  return {
    modelId: "Pr0verFl0",
    password,
    staticPasswordHint: `Warning: password buffer is ${length} bytes`,
  };
}

function getBinaryEncodedConfig(difficulty: number, rand: () => number): ServerConfig {
  const password = getPassword(2 + difficulty / 5, difficulty > 8, rand);
  const binaryEncodedPassword = password
    .split("")
    .map((char) => char.charCodeAt(0).toString(2).padStart(8, "0"))
    .join(" ");
  return {
    modelId: "110100100",
    password,
    staticPasswordHint: "beep boop",
    passwordHintData: binaryEncodedPassword,
  };
}

/** `OrdoXenos`. The `do/while` is what guarantees the encoded half holds no
 * `;` and no space, which is what makes `data.split(";")` safe for a solver —
 * and it is also the reason this file takes a derived RNG rather than the
 * shared stream: the loop has no bound.
 * Source: ServerGenerator.ts:298-323 */
function getXorMaskEncryptedPasswordConfig(__difficulty: number, rand: () => number): ServerConfig {
  const password = getPassword(3 + rand() * 3, true, rand);
  let passwordWithXorMaskApplied: string;
  let xorMaskStrings: string[];
  do {
    passwordWithXorMaskApplied = "";
    xorMaskStrings = [];
    for (const c of password) {
      const charCode = c.charCodeAt(0);
      const xorMask = Math.floor(rand() * 32);
      xorMaskStrings.push(xorMask.toString(2).padStart(8, "0"));
      passwordWithXorMaskApplied += String.fromCharCode(charCode ^ xorMask);
    }
  } while (passwordWithXorMaskApplied.includes(";") || passwordWithXorMaskApplied.includes(" "));

  return {
    modelId: "OrdoXenos",
    password,
    staticPasswordHint: `XOR mask encrypted password: "${passwordWithXorMaskApplied}".`,
    passwordHintData: `${passwordWithXorMaskApplied};${xorMaskStrings.join(" ")}`,
  };
}

function getSpiceLevelConfig(difficulty: number, rand: () => number): ServerConfig {
  return {
    modelId: "RateMyPix.Auth",
    password: getPassword(3 + difficulty / 3, difficulty > 8, rand),
    staticPasswordHint: "!!🌶️!!",
  };
}

/** `OctantVoxel`. Above difficulty 12 the base becomes FRACTIONAL, which is
 * why the failure arm accepts a near miss rather than an exact one.
 * Source: ServerGenerator.ts:334-348 */
function getConvertToBase10Config(difficulty: number, rand: () => number): ServerConfig {
  const password = Math.ceil(rand() * 99 * (difficulty + 1));
  const bases = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16];
  let base = bases[Math.floor(rand() * bases.length)]!;
  if (difficulty > 12) {
    base += bases[Math.floor(rand() * bases.length)]! / 10;
  }
  const encodedPassword = encodeNumberInBaseN(password, base);
  return {
    modelId: "OctantVoxel",
    password: `${password}`,
    staticPasswordHint: `the password is the base ${base} number ${encodedPassword} in base 10`,
    passwordHintData: `${base},${encodedPassword}`,
  };
}

/** The code injection upstream appends above difficulty 16 (and, one time in a
 * hundred, at any difficulty). Reproduced VERBATIM and never executed: it is
 * bait for a solver that reaches for `eval`, and a sim that omitted it would
 * let exactly that solver pass here and set `globalThis.pwn3d` in the game.
 * Source: ServerGenerator.ts:594-597 */
function getCodeInjection(): string {
  return ` , !globalThis.pwn3d && (globalThis.pwn3d=true, alert("You've been hacked! You evaluated a string and let me inject code, didn't you? HAHAHAHA!") , globalThis.openDevMenu() ) , ns.exit()`;
}

/** `generateSimpleArithmeticExpression`. Recursive, and it RETRIES from the
 * top whenever the expression evaluates to something within 0.1 of zero — an
 * unbounded loop over `rand`, hence the derived stream.
 * Source: ServerGenerator.ts:558-587 */
export function generateSimpleArithmeticExpression(difficulty: number, rand: () => number): string {
  const operators = ["+", "-", "*", "/"];
  const operatorCount = Math.floor(difficulty / 4);
  const expression: (string | number)[] = [];
  for (let i = 0; i < operatorCount; i++) {
    expression.push(Math.ceil(rand() * 98));
    expression.push(operators[Math.floor(rand() * operators.length)]!);

    if (difficulty > 5 && rand() < difficulty / (difficulty + 50)) {
      expression.push("(");
      expression.push(generateSimpleArithmeticExpression(difficulty / 2, rand));
      expression.push(")");
      expression.push(operators[Math.floor(rand() * operators.length)]!);
    }
  }
  expression.push(Math.ceil(rand() * 98));

  const result = expression.join(" ");

  try {
    const calc = parseSimpleArithmeticExpression(cleanArithmeticExpression(result));
    if (Math.abs(calc) < 0.1) {
      return generateSimpleArithmeticExpression(difficulty, rand);
    }
  } catch (__) {
    return generateSimpleArithmeticExpression(difficulty, rand);
  }

  if (difficulty > 18) {
    return result.replaceAll("*", "ҳ").replaceAll("/", "÷").replaceAll("+", "➕").replaceAll("-", "➖");
  }

  return result;
}

function getParseArithmeticExpressionConfig(difficulty: number, rand: () => number): ServerConfig {
  let expression = generateSimpleArithmeticExpression(difficulty, rand);
  const result = parseSimpleArithmeticExpression(expression);
  if (difficulty > 12) {
    expression = expression.replaceAll("*", "ҳ").replaceAll("/", "÷").replaceAll("+", "➕").replaceAll("-", "➖");
  }
  if ((difficulty > 16 && rand() < 0.3) || rand() < 0.01) {
    expression += getCodeInjection();
  }
  const parenCount = expression.split("(").length - 1;
  if (difficulty > 20 && rand() < 0.3 && parenCount > 1) {
    expression = expression.replace("(", "(ns.exit(),");
  }
  return {
    modelId: "MathML",
    password: `${result}`,
    staticPasswordHint: `The password is the evaluation of this expression`,
    passwordHintData: expression,
  };
}

/** `getPasswordMadeUpOfPrimesProduct`. The `do/while` retries until the product
 * survives a `Number` round trip, which is unbounded — the third reason for the
 * derived stream. Source: ServerGenerator.ts:699-719 */
function getPasswordMadeUpOfPrimesProduct(difficulty: number, rand: () => number): string {
  const scale = Math.min(difficulty / 2, 15);
  let password: bigint;
  do {
    password = BigInt(Math.floor(rand() * 5 * (scale + 1)) + 1);
    for (let i = 0; i < scale / 3; i++) {
      if (rand() < 0.5) {
        password *= BigInt(Math.ceil(rand() * 5));
      } else {
        password *= BigInt(SMALL_PRIMES[Math.floor(rand() * SMALL_PRIMES.length)]!);
      }
    }
    if (difficulty > 12) {
      password *= BigInt(LARGE_PRIMES[Math.floor(rand() * LARGE_PRIMES.length)]!);
    }
    if (difficulty > 24) {
      password *= BigInt(LARGE_PRIMES[Math.floor(rand() * LARGE_PRIMES.length)]!);
    }
  } while (BigInt(Number(password)) !== password);
  return password.toString();
}

function getDivisibilityTestConfig(difficulty: number, rand: () => number): ServerConfig {
  return {
    modelId: "Factori-Os",
    password: getPasswordMadeUpOfPrimesProduct(difficulty, rand),
    staticPasswordHint: `The password is divisible by 1 ;)`,
  };
}

function getTripleModuloConfig(difficulty: number, rand: () => number): ServerConfig {
  return {
    modelId: "BigMo%od",
    password: `${getPassword(3 + difficulty / 5, false, rand)}`,
    staticPasswordHint: `(password % n) % (n % 32)`,
  };
}

function getKingOfTheHillConfig(difficulty: number, rand: () => number): ServerConfig {
  return {
    modelId: "KingOfTheHill",
    password: getPassword(Math.min(1 + difficulty / 6, 10), false, rand),
    staticPasswordHint: "Ascend the highest mountain!",
  };
}

function getPacketSnifferConfig(difficulty: number, rand: () => number): ServerConfig {
  return {
    modelId: "OpenWebAccessPoint",
    password: getPassword(3 + rand() * 6, difficulty > 8, rand),
    staticPasswordHint: "(I'm busy browsing social media at the cafe)",
  };
}

/** Every builder, by the model id `ModelIds` gives it. The sim keeps models
 * keyed by their PLAYER-VISIBLE id throughout, because that is the only name a
 * script ever sees. Source: src/DarkNet/Enums.ts:15-41 */
export const MODEL_BUILDERS: Record<string, (difficulty: number, rand: () => number) => ServerConfig> = {
  "ZeroLogon": getNoPasswordConfig,
  "DeskMemo_3.1": getEchoVulnConfig,
  "FreshInstall_1.0": getDefaultPasswordConfig,
  "CloudBlare(tm)": getCaptchaConfig,
  "Laika4": getDogNameConfig,
  "NIL": getYesn_tConfig,
  "Pr0verFl0": getBufferOverflowConfig,
  "PHP 5.4": getSortedEchoVulnConfig,
  "DeepGreen": getMastermindHintConfig,
  "BellaCuore": getRomanNumeralConfig,
  "AccountsManager_4.2": getGuessNumberConfig,
  "OctantVoxel": getConvertToBase10Config,
  "Factori-Os": getDivisibilityTestConfig,
  "OpenWebAccessPoint": getPacketSnifferConfig,
  "KingOfTheHill": getKingOfTheHillConfig,
  "RateMyPix.Auth": getSpiceLevelConfig,
  "PrimeTime 2": getLargestPrimeFactorConfig,
  "TopPass": getLargeDictionaryConfig,
  "EuroZone Free": getEuCountryDictionaryConfig,
  "2G_cellular": getTimingAttackConfig,
  "110100100": getBinaryEncodedConfig,
  "MathML": getParseArithmeticExpressionConfig,
  "OrdoXenos": getXorMaskEncryptedPasswordConfig,
  "BigMo%od": getTripleModuloConfig,
};

/** The per-host generator stream.
 *
 * One draw comes off the world stream; the hostname is mixed in so two hosts
 * born from the same draw value cannot share a secret, and so a test holding
 * `(seed, hostname)` can regenerate a host's password without replaying the
 * whole net. Everything the builders do — including the three unbounded
 * rejection loops — then runs on this, which is what keeps the host's cost to
 * the shared stream at exactly one draw. */
export function passwordRng(draw: number, hostname: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < hostname.length; i++) {
    h = Math.imul(h ^ hostname.charCodeAt(i), 0x01000193) >>> 0;
  }
  const seed = (Math.imul(Math.floor(draw * 0x7fffffff) >>> 0, 0x9e3779b1) ^ h) >>> 0;
  return mulberry32(seed);
}

/** Build one host's secret: the password, the hint, the hint data and the
 * format `getServerDetails` reports.
 *
 * `passwordLength` is measured on the RETURNED password rather than on the
 * length the builder asked for, because `getPassword` can hand back a shorter
 * string than requested — `Number("0042").toString()` is `"42"`. */
export function generateSecret(modelId: string, difficulty: number, rand: () => number): {
  password: string;
  hint: string;
  data: string;
  passwordLength: number;
  passwordFormat: PasswordFormat;
} {
  const builder = MODEL_BUILDERS[modelId];
  if (!builder) throw new Error(`dnet: no password generator for model ${modelId}`);
  const config = builder(difficulty, rand);
  return {
    password: config.password,
    hint: config.staticPasswordHint,
    data: config.passwordHintData ?? "",
    passwordLength: config.password.length,
    passwordFormat: getPasswordType(config.password),
  };
}
