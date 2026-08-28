/** `authentication.ts`'s failure switch, `darknetAuthUtils.ts` and
 * `packetSniffing.ts`'s `capturePackets` — what a WRONG password answers.
 *
 * This is the oracle every iterative solver reads. All upstream failure arms
 * are modeled so solver behavior transfers to the game.
 *
 * Nothing in this file returns randomness of its own except `capturePackets`,
 * which is genuinely random upstream; the caller hands it a stream.
 *
 * Source: ../bitburner-src @ 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/authentication.ts:33-243
 *   src/DarkNet/utils/darknetAuthUtils.ts
 *   src/DarkNet/models/packetSniffing.ts:16-88 */

import { WHRNG } from "../vendor/bitburner/src/Casino/RNG.ts";
import { LocationName } from "../vendor/bitburner/src/Locations/Enums.ts";
import { COMMON_PASSWORDS } from "../../shared/strategy/dnet/dictionaries.ts";
import { getPassword, LETTERS, romanNumeralEncoder } from "../../shared/strategy/dnet/codecs.ts";
import { generateSimpleArithmeticExpression } from "./dnet-generators.ts";
import { PACKET_SNIFF_PHRASES } from "../../shared/strategy/dnet/phrases.ts";

/** The four `darknetAuthUtils` helpers the switch is built out of. Transcribed
 * rather than reimplemented because `getMisplacedCorrectCharsCount`'s duplicate
 * handling is subtle and a solver's arithmetic is only as right as this is.
 * Source: src/DarkNet/utils/darknetAuthUtils.ts:21-51 */
export const getExactCorrectChars = (password: string, attemptedPassword: string): boolean[] =>
  password.split("").map((digit, i) => digit === attemptedPassword[i]);

export const getExactCorrectCharsCount = (password: string, attemptedPassword: string): number =>
  getExactCorrectChars(password, attemptedPassword).filter((isCorrect) => isCorrect).length;

/** `getSharedChars`: how many LEADING characters match. The input to the
 * `2G_cellular` timing leak — each one adds 50 ms to the authenticate call. */
export const getSharedChars = (password: string, attemptedPassword: string): number => {
  for (let i = 0; i < password.length; i++) {
    if (password[i] !== attemptedPassword[i]) return i;
  }
  return password.length;
};

export const getMisplacedCorrectCharsCount = (password: string, attemptedPassword: string): number => {
  const remainingPasswordChars = password.split("").filter((digit, i) => digit !== attemptedPassword[i]);
  const remainingAttemptedPasswordChars = attemptedPassword.split("").filter((digit, i) => digit !== password[i]);

  const misplacedCorrectChars = remainingAttemptedPasswordChars.filter((digit, i) => {
    const isPresentInPassword = remainingPasswordChars.includes(digit);
    const countInAttemptedPasswordThusFar = remainingAttemptedPasswordChars
      .slice(0, i)
      .filter((prevDigit) => prevDigit === digit).length;
    const countInPassword = remainingPasswordChars.filter((prevDigit) => prevDigit === digit).length;
    return isPresentInPassword && countInAttemptedPasswordThusFar < countInPassword;
  });

  return misplacedCorrectChars.length;
};

export const getMastermindResponse = (password: string, attemptedPassword: string): {
  exactCharacters: number;
  misplacedCharacters: number;
} => ({
  exactCharacters: getExactCorrectCharsCount(password, attemptedPassword),
  misplacedCharacters: getMisplacedCorrectCharsCount(password, attemptedPassword),
});

/** `getTwoCharsInPassword`. Two DISTINCT indices, so on a one-character
 * password the modulo folds both back onto index 0.
 * Source: src/DarkNet/utils/darknetAuthUtils.ts:11-19 */
export const getTwoCharsInPassword = (password: string, rand: () => number): [string, string] => {
  const index1 = Math.floor(rand() * password.length);
  const containedChar1 = password[index1]!;
  let index2 = Math.floor(rand() * password.length);
  if (index2 === index1) {
    index2 = (index2 + 1) % password.length;
  }
  return [containedChar1, password[index2]!];
};

/** `isCloseToCorrectPassword` — the tolerance that makes `OctantVoxel` and
 * `MathML` solvable at all.
 *
 * Both models' answers come out of floating-point arithmetic (a fractional
 * base above difficulty 12; a chain of `/` above difficulty 4), so upstream
 * accepts an absolute miss under 0.01 OR a relative miss under 0.005. A
 * simulator that demanded exact equality would fail those two solvers while
 * they succeeded in the real game — the worst direction for a divergence to
 * point.
 *
 * The relative clause is transcribed with its sign quirk intact: a MathML
 * expression can evaluate NEGATIVE, and `difference / negative` is then
 * negative and always under 0.005, so every parseable attempt is accepted on
 * such a host. That is upstream's behaviour, not ours to fix.
 * Source: src/DarkNet/effects/authentication.ts:151-163 */
export const isCloseToCorrectPassword = (correctPassword: string, attemptedPassword: number): boolean => {
  const difference = Math.abs(attemptedPassword - Number(correctPassword));
  return difference < 0.01 || difference / Number(correctPassword) < 0.005;
};

/** The KingOfTheHill landscape.
 *
 * Seeded by the PASSWORD through the game's own Wichmann-Hill generator, which
 * is vendored rather than re-transcribed — so the hill layout a solver climbs
 * here is bit-for-bit the one it climbs in the game.
 *
 * The 3% band is what makes the model closed-form: inside it the side hills
 * switch off and the reading is a single clean gaussian, invertible from one
 * sample.
 * Source: src/DarkNet/effects/authentication.ts:222-243 */
export const getAltitudeGivenHillSpecs = (x: number, location: number, height: number, width: number): number =>
  height * Math.exp(((x - location) ** 2 / width ** 2) * -1);

export function getKingOfTheHillAltitude(
  server: { password: string; difficulty: number },
  attemptedPassword: string,
): number {
  const password = Number(server.password);
  const x = Number(attemptedPassword);
  const rng = new WHRNG(password);
  const hillCount = Math.min(Math.floor(server.difficulty / 8), 4) * 2 + 1;
  const passwordHillIndex = Math.floor(rng.random() * (hillCount - 2)) + 1;
  const width = 10 ** Math.max(server.password.length - 2, 0) + 1;

  if (Math.abs((x - password) / password) < 0.03) {
    return getAltitudeGivenHillSpecs(x, password, 10000, width);
  }

  let altitude = 0;
  for (let i = 0; i < hillCount; i++) {
    const locationOffset = (i - passwordHillIndex) * width * 3 * (rng.random() * 0.2 + 0.9);
    const heightOffset = Math.abs((i - passwordHillIndex) * 2600) * (rng.random() * 0.1 + 0.95);
    altitude += getAltitudeGivenHillSpecs(x, password + locationOffset, 10000 - heightOffset, width);
  }
  return altitude;
}

// --- packet sniffing ------------------------------------------------------

/** What `capturePackets` needs from the net around it. Passed in rather than
 * reached for, because the sim's net lives in `DarknetSystem` and this file
 * must stay a pure function of its inputs. */
export interface PacketWorld {
  /** Every movable host's password, for the `--<password>--` leak. */
  movablePasswords: () => readonly string[];
  /** Darknet hostnames, standing in for upstream's `generateDarknetServerName`
   *  — see the `dnet.models` entry in DNET_ASSUMPTIONS. */
  serverNames: () => readonly string[];
  /** The password of the most recent authentication attempt in this host's log
   *  ring, or null. `getMostRecentAuthLog`. */
  lastAttempted: () => string | null;
  rand: () => number;
}

/** `getExactCharactersHint`. Source: packetSniffing.ts:80-88 */
function getExactCharactersHint(lastPassword: string, realPassword: string): string {
  const correctCharPlacement = getExactCorrectChars(realPassword, lastPassword);
  const rightChars = realPassword
    .split("")
    .filter((_, i) => correctCharPlacement[i])
    .slice(0, 2);
  if (rightChars.length === 0) return "No characters are in the right place.";
  return `The characters ${rightChars.join(", ")} are in the right place. `;
}

/** `getRandomCharsInPassword`. Source: packetSniffing.ts:62-78 */
export function getRandomCharsInPassword(password: string, rand: () => number): string {
  if (!password) return "There's definitely nothing in that password...";
  const [containedChar1, containedChar2] = getTwoCharsInPassword(password, rand);
  const hints = [
    `There's definitely a ${containedChar1} and a ${containedChar2}...`,
    `I can see a ${containedChar1} and a ${containedChar2}.`,
    `I must use ${containedChar1} & ${containedChar2}!`,
    `Did it have a ${containedChar1} and a ${containedChar2}?`,
    `Note to self: ${containedChar1} and ${containedChar2} are important.`,
    `I think ${containedChar1} with ${containedChar2} is key.`,
    `I need to remember ${containedChar1} 'n ${containedChar2}.`,
    `Theres a ${containedChar1}, and maybe a ${containedChar2}...`,
  ];
  return hints[Math.floor(rand() * hints.length)]!;
}

const LOCATION_NAME_KEYS = Object.keys(LocationName);

/** `getRandomData`: the junk `capturePackets` hides a password inside.
 *
 * Every branch is an INDEPENDENT roll upstream — they are sequential `if`s, not
 * an `else if` chain, so the later branches are reached only when the earlier
 * ones miss — and one of them returns early with a stranger's password, which
 * is why a blob is sometimes far shorter than the requested length. Transcribed
 * with that shape intact, because it is what decides how much junk a
 * length-`L` substring intersection has to survive.
 * Source: src/DarkNet/models/packetSniffing.ts:26-60 */
function getRandomData(
  server: { hostname: string; password: string },
  length: number,
  world: PacketWorld,
): string {
  const { rand } = world;
  const password = server.password;
  let result = "";
  while (result.length < length) {
    if (rand() < 0.1) {
      result += " " + PACKET_SNIFF_PHRASES[Math.floor(rand() * PACKET_SNIFF_PHRASES.length)] + " ";
    } else if (rand() < 0.25) {
      result += COMMON_PASSWORDS[Math.floor(rand() * COMMON_PASSWORDS.length)];
    } else if (rand() < 0.2) {
      result += " " + getRandomCharsInPassword(password, rand);
    } else if (rand() < 0.8) {
      result += getPassword(password.length, !!password.split("").find((c) => LETTERS.includes(c)), rand);
    } else if (rand() < 0.3) {
      result += generateSimpleArithmeticExpression(Math.floor(rand() * 5 + 2), rand);
    } else if (rand() < 0.33) {
      const mostRecent = world.lastAttempted();
      if (mostRecent !== null) {
        result += " " + getExactCharactersHint(mostRecent, password);
      }
    } else if (rand() < 0.6) {
      const names = world.serverNames();
      result += " " + (names[Math.floor(rand() * names.length)] ?? server.hostname) + " ";
    } else if (rand() < 0.15) {
      result += "/" + LOCATION_NAME_KEYS[Math.floor(rand() * LOCATION_NAME_KEYS.length)] + "/";
    } else if (rand() < 0.05) {
      const passwords = world.movablePasswords();
      // Upstream indexes a pool it assumes is non-empty and would throw on
      // `randomServer.password`; a net with no online movable host is a state
      // only this sim can reach, so falling through to the next branch is the
      // faithful reading. Emitting `--undefined--` instead would put the literal
      // string `undefined` where a password goes, and `oracle.ts`'s bare-
      // credential parser would harvest it and spend an authenticate on it.
      if (passwords.length > 0) {
        return `--${passwords[Math.floor(rand() * passwords.length)]}--`;
      }
      result += romanNumeralEncoder(Math.floor(rand() * 5000));
    } else {
      result += romanNumeralEncoder(Math.floor(rand() * 5000));
    }
  }
  return result;
}

/** `capturePackets`: the blob `OpenWebAccessPoint` hands back on every failure.
 *
 * At difficulty <= 16 it embeds ` <hostname>:<password> ` — a credential in
 * plain sight, and the reason one failed attempt is the whole attack. Above 16
 * it embeds the BARE password with no delimiters, which is why the attack there
 * is to intersect candidate substrings across several blobs.
 *
 * `insertIndex` can go negative when an early-returning `getRandomData` gives
 * back a blob shorter than the payload; `slice` with a negative index then
 * counts from the end, and upstream lives with it. Kept.
 * Source: src/DarkNet/models/packetSniffing.ts:16-24 */
export function capturePackets(
  server: { hostname: string; password: string; difficulty: number },
  world: PacketWorld,
): string {
  const { rand } = world;
  const passwordData = server.difficulty > 16 ? server.password : ` ${server.hostname}:${server.password} `;
  const randomData = server.difficulty > 16
    ? getPassword(124 + rand() * 20, true, rand)
    : getRandomData(server, 124 + rand() * 20, world);
  const insertIndex = Math.floor(rand() * (randomData.length - passwordData.length));
  return randomData.slice(0, insertIndex) + passwordData + randomData.slice(insertIndex);
}

// --- the failure switch ---------------------------------------------------

export interface PasswordResponse {
  ok: boolean;
  message: string;
  data: string;
}

export interface CheckableServer {
  modelId: string;
  hostname: string;
  password: string;
  passwordHint: string;
  data: string;
  difficulty: number;
}

/** `checkPassword`, all fifteen arms.
 *
 * Upstream tests exact equality first and only then enters the switch, so the
 * `ConvertToBase10` / `parsedExpression` tolerance sits INSIDE the switch —
 * which is equivalent, since an exactly-equal attempt is trivially "close", but
 * it means the tolerance is easy to leave out and impossible to notice missing
 * from any test that only ever sends the right answer.
 *
 * The labyrinth is handled by the caller, before this: it is a maze, not a
 * password, and upstream branches on `isLabyrinthServer` above the equality
 * test.
 * Source: src/DarkNet/effects/authentication.ts:19-149 */
export function checkPassword(
  server: CheckableServer,
  attemptedPassword: string,
  responseTime: number,
  world: PacketWorld,
): PasswordResponse {
  const success = (): PasswordResponse => ({ ok: true, message: "Success", data: "" });
  const failure = (message: string, data: string): PasswordResponse => ({ ok: false, message, data });

  if (server.password === attemptedPassword) return success();

  switch (server.modelId) {
    case "DeepGreen": {
      const { exactCharacters, misplacedCharacters } = getMastermindResponse(server.password, attemptedPassword);
      const exactCharsMessage = `${exactCharacters} symbol${exactCharacters == 1 ? " is" : "s are"} match exactly`;
      const misplacedCharsMessage = `${misplacedCharacters} symbol${misplacedCharacters == 1 ? "" : "s"} match but ${
        misplacedCharacters == 1 ? "is" : "are"
      } in the wrong place`;
      return failure(
        `Hint: ${exactCharsMessage},  and ${misplacedCharsMessage}.`,
        `${exactCharacters},${misplacedCharacters}`,
      );
    }
    case "AccountsManager_4.2":
      return failure(
        server.passwordHint,
        Number(attemptedPassword) > Number(server.password) ? "Lower" : "Higher",
      );
    case "BellaCuore":
      return failure(
        server.passwordHint,
        Number(attemptedPassword) > Number(server.password) ? "ALTUS NIMIS" : "PARUM BREVIS",
      );
    case "NIL":
      return failure(
        "that wasn't right",
        attemptedPassword.split("").map((char, i) => (char === server.password[i] ? "yes" : "yesn't")).join(","),
      );
    case "RateMyPix.Auth": {
      // The pepper string joins only the TRUE entries, so it is a count and not
      // a positional mask — and each 🌶️ is U+1F336 U+FE0F, three UTF-16 units.
      const exactChars = getExactCorrectChars(server.password, attemptedPassword);
      const pepperRepresentation = exactChars.map((val) => (val ? "🌶️" : "")).join("") || "0";
      return failure("Not spicy enough", `${pepperRepresentation}/${server.password.length}`);
    }
    case "Factori-Os": {
      // `password % 0` is NaN, which is falsy, so sending "0" reports that the
      // password IS divisible by zero. Upstream's bug, kept.
      const password = Number(server.password);
      const attemptedDivisor = Number(attemptedPassword);
      if (isNaN(+attemptedPassword) || password % attemptedDivisor || attemptedPassword === "") {
        return failure(`Password is not divisible by '${attemptedPassword}'`, "false");
      }
      return failure(`Password IS divisible by '${attemptedPassword}'`, "true");
    }
    case "BigMo%od": {
      // The inner modulus is `((n - 1) % 32) + 1`, NOT `n % 32` as the hint
      // says — so for every n <= 32 the outer modulo is a no-op.
      const password = Number(server.password);
      const input = Number(attemptedPassword);
      const result = (password % input) % (((input - 1) % 32) + 1);
      const message = input % 32 === 0
        ? `(Password % ${input}) % 32 = ${result}`
        : `(Password % ${input}) % (${input} % 32) = ${result}`;
      return failure(message, result.toString());
    }
    case "OctantVoxel":
    case "MathML": {
      const parsedAttemptedPassword = parseFloat(attemptedPassword);
      if (!isNaN(parsedAttemptedPassword) && isCloseToCorrectPassword(server.password, parsedAttemptedPassword)) {
        return success();
      }
      return failure(server.passwordHint, server.data);
    }
    case "2G_cellular": {
      // The index of the first mismatch, handed over outright. The timing leak
      // is the fallback, not the attack.
      const indexOfDifference = server.password.split("").findIndex((char, i) => char !== attemptedPassword[i]);
      return failure(
        `Found a mismatch while checking each character (${indexOfDifference})`,
        `Response time: ${responseTime}ms`,
      );
    }
    case "Pr0verFl0": {
      const maskCharacter = attemptedPassword === "■".repeat(server.password.length) ? "?" : "■";
      const buffer = "ˍ".repeat(server.password.length) + maskCharacter.repeat(server.password.length);
      const overwrittenBuffer = attemptedPassword.slice(0, buffer.length) + buffer.slice(attemptedPassword.length);

      const receivedBuffer = overwrittenBuffer.slice(0, server.password.length);
      const expectedValueBuffer = overwrittenBuffer.slice(server.password.length);

      if (receivedBuffer === expectedValueBuffer) return success();
      return failure(
        `auth failed: received '${receivedBuffer}', expected '${expectedValueBuffer}'`,
        `${receivedBuffer},${expectedValueBuffer}`,
      );
    }
    case "KingOfTheHill": {
      const altitude = getKingOfTheHillAltitude(server, attemptedPassword);
      return failure(`current altitude: ${altitude.toFixed(5)} m; highest peak: 10,000 m`, `${altitude}`);
    }
    case "PHP 5.4": {
      // The RMSD arm needs length >= 5 AND a same-length attempt; below that
      // there is no oracle at all and the sorted multiset is the whole of it.
      if (server.password.length < 5 || attemptedPassword.length !== server.password.length) {
        return failure(server.passwordHint, server.data);
      }
      let squaredError = 0;
      for (let i = 0; i < attemptedPassword.length; i++) {
        const attempted = Number(attemptedPassword[i]);
        const actual = Number(server.password[i]);
        if (!Number.isFinite(attempted)) return failure(server.passwordHint, server.data);
        squaredError += (attempted - actual) ** 2;
      }
      const rmsd = Math.sqrt(squaredError / attemptedPassword.length);
      return failure(server.passwordHint, `${server.data}; RMS Deviation:${rmsd.toFixed(3)}`);
    }
    case "OpenWebAccessPoint":
      return failure(server.passwordHint, capturePackets(server, world));
    default:
      return failure(server.passwordHint, server.data);
  }
}

/** `logPasswordAttempt`'s `BufferOverflow` branch.
 *
 * The one model whose log entry does NOT record what we sent: the response's
 * `data` is split on the comma and the two halves become `passwordAttempted`
 * and `passwordExpected`, so a solver matching captures by "the string I sent"
 * loses this model's oracle entirely.
 * Source: src/DarkNet/models/packetSniffing.ts:90-125 */
export function logEntryFor(
  modelId: string,
  attempted: string,
  code: number,
  response: PasswordResponse,
): Record<string, unknown> {
  if (modelId === "Pr0verFl0") {
    const [passwordInBuffer, overflow] = (response.data ?? "").split(",");
    // `passwordExpected` is genuinely absent on the success path, where the
    // response carries no `data` at all. JSON.stringify drops it, exactly as
    // upstream's log entry has no such key.
    return { code, passwordAttempted: passwordInBuffer, passwordExpected: overflow, message: response.message };
  }
  // `getGenericSuccess` carries no `data` key; `getFailureResponse` always does,
  // even when the model has no hint data and it is the empty string.
  if (response.ok) return { code, message: response.message, passwordAttempted: attempted };
  return { code, message: response.message, data: response.data, passwordAttempted: attempted };
}
