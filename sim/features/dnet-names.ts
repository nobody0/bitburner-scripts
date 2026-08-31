/** Upstream's darknet hostname generator, transcribed.
 *
 * Hostnames were SYNTHETIC (`dnet-<depth>-x<n>` off a counter) until this
 * file existed, and the `dnet.hostnames` entry in DNET_ASSUMPTIONS recorded
 * the two costs. Both were real. Upstream spends draws on every name and the
 * sim spent none, so the shared stream advanced differently from the game's;
 * and every consumer that reasons about the SHAPE of a hostname — the
 * `hostish` character class in `shared/strategy/dnet/solvers/deep.ts`, and
 * every packet-sniffing leak that quotes one — saw a shape the game never
 * produces. Password solving IS the darknet, so that second cost was the one
 * that mattered.
 *
 * ENTROPY. Upstream's generator is a VARIABLE-WIDTH draw block: `getBaseName`
 * spends 2-6, `decorateName` 6-11 per iteration of a loop bounded only by
 * hostname collisions, and `l33tifyName` 2-5 inside that. `MUTATION_DRAWS` is
 * fixed precisely so topology cannot perturb the stock stream across an A/B,
 * so every draw here is a `subDraw` off the ONE stream draw `#addHost` has
 * already taken — the same treatment the offline-name-reuse branch beside it
 * already uses. Same distributions, same independence, fixed cost.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/models/DarknetServerOptions.ts:98-197
 *   src/DarkNet/models/dictionaryData.ts:157-285
 *   src/Paths/Directory.ts:28-33
 *   src/utils/StringHelperFunctions.ts:118-122 */

import { FactionName } from "../vendor/bitburner/src/Faction/Enums.ts";
import { LocationName } from "../vendor/bitburner/src/Locations/Enums.ts";
import { COMMON_PASSWORDS } from "../../shared/strategy/dnet/dictionaries.ts";

export const PRESET_NAMES = [
  "localhost", "h0me", "d0s_slippers", "omuretsu",
  "cat_lover", "laptop", "grandma-s_phone", "smart_tv",
  "smart_fridge", "smart_toaster", "smart_doorbell", "pl0x_server",
  "bitcoin_miner", "m1n3cr4ft_server", "n0t_a_bot", "n0t_a_server",
  "bitburner", "null", "GOTO_10", "...",
  "....", "echo_chamber", "firewall", ":)",
  "XD", "UwU", ");DROP-TABLE-SERVERS;--", "茶店",
  "bungo", "microhard", "groogle", "facebucks",
  "tweeter", "sun_megasystems", "EZ_BAKE_OVEN", "SmartLamp",
  "OrangeTV", "SamsongSmartTv", "FatBit", "PineappleCorp",
  "Oriath", "Lost_Izalith", "Anor_Londo", "The_Painted_World",
  "The_Depths",
] as const;

export const SERVER_NAME_PREFIXES = [
  "neo", "bit", "hydro", "apex", "zenith", "granny-s",
  "quantum", "hyper", "ultra", "meta", "cyber", "digital",
  "net", "dark", "light", "blade", "cell", "hacker",
  "crack", "zero_day", "neon", "echo", "cryptic", "crypto",
  "data", "terminal", "byte", "giga", "rogue",
] as const;

export const SERVER_NAME_SUFFIXES = [
  "corp", "sys", "net", "web", "inc", "tech",
  "com", "org", "blade", "flame", "anonymous", "security",
  "solutions", "industries", "systems", "networks", "services", "matrix",
  "grid", "citadel", "phantom", "oasis", "sanctuary", "genesis",
  "hub",
] as const;

export const CONNECTORS = [
  "", ".", "-", "_", ";", ":", "::", "$", "^", "%", "@", "&",
] as const;

/** `oneInvalidCharacter` (`Paths/Directory.ts:28-33`) as a character set: the
 * twelve invalid path characters plus whitespace. `loreNames` replaces each
 * with `_`. */
const INVALID_PATH_CHARS = new Set([
  "/", "*", "?", "[", "]", "!", "\u005c", "~", "|", "#", '"', "'",
  " ", "\t", "\n", "\r", "\f", "\v",
]);

/** `loreNames`: every faction and location name, path-sanitised and lowered.
 * Derived rather than transcribed — both enums are vendored, so a copy here
 * could only drift. */
export const LORE_NAMES: readonly string[] = [
  ...Object.values(FactionName),
  ...Object.values(LocationName),
].map((name) => [...name].map((ch) => (INVALID_PATH_CHARS.has(ch) ? "_" : ch)).join("").toLowerCase());

/** `l33t`. The KEY ORDER is load-bearing: upstream indexes `Object.keys(l33t)`
 * with a draw, so reordering changes which substitution a given draw picks.
 * `b` maps to a multi-code-unit emoji, which is why upstream reverses by
 * grapheme and normalises with `toWellFormed`. */
export const L33T: Readonly<Record<string, string>> = {
  a: "4", b: "\ud83c\udd71\ufe0f", e: "3", i: "1", l: "1", o: "0", s: "5", t: "7",
};
const L33T_KEYS = Object.keys(L33T);

/** `safelyReverseString`: reverse by GRAPHEME, not by code unit, or the emoji
 * in `L33T` comes back as a lone surrogate pair in the wrong order. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function safelyReverseString(input: string): string {
  return Array.from(graphemeSegmenter.segment(input), (s) => s.segment).reverse().join("");
}

/** `String.prototype.toWellFormed`, which upstream calls at the end of
 * `decorateName` and `l33tifyName`.
 *
 * Its own comment says it is "currently redundant" — every operation above it
 * preserves well-formed UTF-16 — and that is true here too, because the only
 * multi-code-unit value is spliced in whole by `replaceAll` and the reverse is
 * grapheme-aware. It is called anyway rather than dropped, so a future
 * upstream change that makes it load-bearing does not silently diverge; the
 * guard is only because this project targets ES2022 and the method is ES2024.
 * Source: src/DarkNet/models/DarknetServerOptions.ts:176-181,190-197 */
function wellFormed(value: string): string {
  const normalize = (value as { toWellFormed?: () => string }).toWellFormed;
  return typeof normalize === "function" ? normalize.call(value) : value;
}

/** `getBaseName`. Three coins in sequence, each of which RETURNS, so a later
 * one is reached only when every earlier one missed: 5% common password, then
 * 20% lore name, then 30% preset, then prefix+connector+suffix. Upstream
 * spends 2 draws on the luckiest path and 6 on the fallback; the sub-draws
 * here are salted per slot, so the cost is fixed whichever branch is taken. */
export function getBaseName(draw: (salt: number) => number): string {
  const pick = <T>(list: readonly T[], salt: number): T => list[Math.floor(draw(salt) * list.length)]!;
  if (draw(0) < 0.05) return pick(COMMON_PASSWORDS, 1);
  if (draw(2) < 0.2) return pick(LORE_NAMES, 3);
  if (draw(4) < 0.3) return pick(PRESET_NAMES, 5);
  const prefix = pick(SERVER_NAME_PREFIXES, 6);
  const suffix = pick(SERVER_NAME_SUFFIXES, 7);
  const connector = pick(CONNECTORS, 8);
  return `${prefix}${connector}${suffix}`;
}

/** `l33tifyName`. `amount` is a FLOAT bound, so the loop runs 1-4 times. */
export function l33tifyName(name: string, draw: (salt: number) => number): string {
  let updated = name;
  const amount = draw(0) * 3 + 1;
  for (let i = 0; i < amount; i++) {
    const char = L33T_KEYS[Math.floor(draw(1 + i) * L33T_KEYS.length)]!;
    updated = updated.replaceAll(char, L33T[char] ?? "");
  }
  return wellFormed(updated);
}

/** `decorateName`, with upstream's own 20-iteration escape hatch as the bound.
 *
 * Upstream loops `while (GetServer(updatedName) !== null)`; `taken` is that
 * predicate. Past twenty it appends `/T${Date.now()}` and keeps going — which
 * under the simulator's virtual clock is deterministic, so the escape hatch
 * transcribes exactly rather than needing a substitute. */
export function decorateName(
  name: string,
  taken: (candidate: string) => boolean,
  draw: (salt: number) => number,
  now: () => number,
): string {
  let updated = name;
  let count = 0;
  do {
    const salt = 100 + count * 20;
    if (count++ > 20) {
      updated += `/T${now()}`;
      continue;
    }
    const connector = CONNECTORS[Math.floor(draw(salt) * CONNECTORS.length)]!;
    if (draw(salt + 1) < 0.3) {
      updated = l33tifyName(updated, (s) => draw(salt + 2 + s));
    }
    if (draw(salt + 8) < 0.05) updated = safelyReverseString(updated);
    if (draw(salt + 9) < 0.1) {
      const suffix = SERVER_NAME_SUFFIXES[Math.floor(draw(salt + 10) * SERVER_NAME_SUFFIXES.length)]!;
      updated = `${updated}${connector}${suffix}`;
    }
    if (draw(salt + 11) < 0.1) {
      const prefix = SERVER_NAME_PREFIXES[Math.floor(draw(salt + 12) * SERVER_NAME_PREFIXES.length)]!;
      updated = `${prefix}${connector}${updated}`;
    }
    if (draw(salt + 13) < 0.05 && updated) {
      updated = `${updated}:${Math.floor(draw(salt + 14) * 10000)}`;
    }
  } while (taken(updated));
  return wellFormed(updated);
}

/** `generateDarknetServerName`'s generated branch. The 3% offline-name reuse
 * that precedes it upstream stays in `#addHost`, where the offline set is. */
export function generateDarknetServerName(
  taken: (candidate: string) => boolean,
  draw: (salt: number) => number,
  now: () => number,
): string {
  return decorateName(getBaseName((s) => draw(s)), taken, draw, now);
}

/** Every character any generated hostname can contain.
 *
 * Exported so `sim/tests/dnet-parity.test.ts` can hold `hostish`
 * (`shared/strategy/dnet/solvers/deep.ts`) to it: that validator gates
 * credential extraction out of packet noise, and it accepted only
 * `[A-Za-z0-9_.-]` while this set includes every connector, the `:` of the
 * digit suffix, and the l33t emoji. */
export function generatedNameCharacters(): Set<string> {
  const chars = new Set<string>();
  const add = (s: string): void => { for (const ch of s) chars.add(ch); };
  for (const list of [COMMON_PASSWORDS, LORE_NAMES, PRESET_NAMES, SERVER_NAME_PREFIXES, SERVER_NAME_SUFFIXES, CONNECTORS]) {
    for (const entry of list) add(entry);
  }
  for (const value of Object.values(L33T)) add(value);
  add(":0123456789");
  add("/T");
  return chars;
}
