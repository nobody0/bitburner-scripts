import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CONNECTORS,
  L33T,
  LORE_NAMES,
  PRESET_NAMES,
  SERVER_NAME_PREFIXES,
  SERVER_NAME_SUFFIXES,
  generateDarknetServerName,
  generatedNameCharacters,
  safelyReverseString,
} from "../features/dnet-names.ts";
import {
  DNET_ASSUMPTIONS,
  STOCK_PROMOTION_GROWTH_RATE,
  attemptCharismaExp,
  promoteStockCharges,
} from "../features/dnet.ts";
import { LAB_LADDER, labMazeSize } from "../../shared/strategy/dnet/rates.ts";
import { COMMON_PASSWORDS } from "../../shared/strategy/dnet/dictionaries.ts";
import { mulberry32 } from "../core/rng.ts";
import { passwordFromNamedPacket } from "../../shared/strategy/dnet/solvers/deep.ts";

/** The darknet's parity suite, and the gate on `dnet: "full"`.
 *
 * `spec/game-source.md` requires this before that line in `sim/fidelity.ts`
 * may claim full coverage, and it requires this SHAPE: `tools/vendor.ts`
 * strips `DarknetServer` because "its import graph detonates into the whole
 * game UI", so there is no `sim/vendor/bitburner/src/DarkNet/` to import and
 * compare against. What is left is the checkout's SOURCE TEXT, matched the way
 * `sim/tests/stock-parity.test.ts` matches the price engine's inline literals:
 * splice the transcribed constant into the line it is expected to appear in,
 * so the assertion fails whichever side moves.
 *
 * Hash pinning (`sim/transcription-sources.ts`) already covers nineteen
 * `src/DarkNet/**` files, and it is not this. A hash says the file CHANGED; it
 * cannot say WHICH formula did, which is exactly the question a transcription
 * has to keep answering.
 *
 * It runs only where the checkout is, which is what the spec says it can
 * promise. `describe.skipIf` rather than `lane()`: a lane would also skip on a
 * default `bun test`, and a drift pin that only runs when asked for is not a
 * drift pin. */
const SRC_REPO = path.resolve(
  process.env["BITBURNER_SRC"] ?? path.join(import.meta.dir, "..", "..", "..", "bitburner-src"),
);
const CHECKOUT = existsSync(path.join(SRC_REPO, "src/DarkNet/models/DarknetServerOptions.ts"));
const read = (relative: string): Promise<string> => Bun.file(path.join(SRC_REPO, relative)).text();

/** Pull one `export const <name> = [...] as const;` array out of source text.
 * Deliberately dumb: it reads what is written rather than evaluating it, which
 * is the whole point of matching source text. */
function sourceList(text: string, name: string): string[] {
  const head = `export const ${name} = [`;
  const start = text.indexOf(head);
  expect(start, name).toBeGreaterThan(-1);
  const body = text.slice(start + head.length, text.indexOf("] as const;", start));
  const DOUBLE = String.fromCharCode(34);
  const BACKTICK = String.fromCharCode(96);
  return body.split("\n").map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .flatMap((line) => {
      const out: string[] = [];
      for (let i = 0; i < line.length;) {
        const quote = line[i];
        if (quote === DOUBLE || quote === BACKTICK) {
          const end = line.indexOf(quote, i + 1);
          if (end < 0) break;
          out.push(line.slice(i + 1, end));
          i = end + 1;
        } else i += 1;
      }
      return out;
    });
}

// The one test that always runs: a silent skip is how a machine without the
// checkout quietly stops gating `dnet: "full"`. The suite may skip — the spec
// only promises parity where the checkout is — but never without saying so.
test("absence of the parity checkout is announced, never silent", () => {
  if (!CHECKOUT) {
    console.warn(
      `darknet source parity SKIPPED: no bitburner-src checkout at ${SRC_REPO} — `
      + `the dnet "full" fidelity claim is ungated on this machine. `
      + `Clone the pinned checkout there or point BITBURNER_SRC at one.`,
    );
  }
});

describe.skipIf(!CHECKOUT)("darknet source parity", () => {
  test("the name generator's coins, tables and loop bounds", async () => {
    const text = await read("src/DarkNet/models/DarknetServerOptions.ts");
    // generateDarknetServerName: the offline-reuse coin, then the generator.
    expect(text).toContain("if (Math.random() < 0.03 && DarknetState.offlineServers.size > 0 && hasFullDarknetAccess())");
    expect(text).toContain("return decorateName(getBaseName());");
    // getBaseName: three coins in sequence, each of which RETURNS.
    expect(text).toContain("return commonPasswordDictionary[Math.floor(Math.random() * commonPasswordDictionary.length)];");
    expect(text).toContain("return loreNames[Math.floor(Math.random() * loreNames.length)];");
    expect(text).toContain("return presetNames[Math.floor(Math.random() * presetNames.length)];");
    // decorateName: the escape hatch, the five decoration coins, and the loop
    // whose bound is hostname collision rather than a count.
    expect(text).toContain("if (count++ > 20) {");
    expect(text).toContain("updatedName = l33tifyName(updatedName);");
    expect(text).toContain("updatedName = safelyReverseString(updatedName);");
    expect(text).toContain("} while (GetServer(updatedName) !== null);");
    // l33tifyName: the FLOAT bound is why the loop runs one to four times, and
    // an integer reading of it would be a quietly different distribution.
    expect(text).toContain("const amount = Math.random() * 3 + 1;");
    expect(text).toContain("for (let i = 0; i < amount; i++) {");
    expect(text).toContain("const char = Object.keys(l33t)[Math.floor(Math.random() * Object.keys(l33t).length)];");
  });

  test("the name tables are transcribed entry for entry", async () => {
    const text = await read("src/DarkNet/models/dictionaryData.ts");
    expect(sourceList(text, "presetNames")).toEqual([...PRESET_NAMES]);
    expect(sourceList(text, "ServerNamePrefixes")).toEqual([...SERVER_NAME_PREFIXES]);
    expect(sourceList(text, "ServerNameSuffixes")).toEqual([...SERVER_NAME_SUFFIXES]);
    expect(sourceList(text, "connectors")).toEqual([...CONNECTORS]);
    // l33t is a Record, and its KEY ORDER is load-bearing: upstream indexes
    // `Object.keys(l33t)` with a draw, so a reordering silently changes which
    // substitution a given draw picks.
    expect(Object.keys(L33T)).toEqual(["a", "b", "e", "i", "l", "o", "s", "t"]);
    for (const [key, value] of Object.entries(L33T)) {
      expect(text, key).toContain(`${key}: "${value}"`);
    }
    // loreNames is DERIVED from two vendored enums rather than copied, so what
    // is pinned is the derivation upstream performs on them.
    expect(text).toContain("export const loreNames = [...Object.values(FactionName), ...Object.values(LocationName)].map((n) =>");
    expect(text).toContain("oneInvalidCharacterRegex");
    expect(LORE_NAMES).toContain("illuminati");
    expect(LORE_NAMES.every((name) => name === name.toLowerCase())).toBe(true);
    // "Bachman & Associates" is the case that proves the sanitiser runs: the
    // spaces become underscores and nothing else does.
    expect(LORE_NAMES).toContain("bachman_&_associates");
  });

  test("the invalid-path characters loreNames strips, and the grapheme reverse", async () => {
    const paths = await read("src/Paths/Directory.ts");
    expect(paths).toContain("export const invalidCharacters = [");
    expect(paths).toContain("export const oneInvalidCharacter = ");
    const strings = await read("src/utils/StringHelperFunctions.ts");
    expect(strings).toContain("export function safelyReverseString(input: string): string {");
    expect(strings).toContain("return Array.from(graphemeSegmenter.segment(input), (s) => s.segment)");
    // The emoji is why this is grapheme-wise: a code-unit reverse tears the
    // surrogate pair apart and yields ill-formed UTF-16.
    const b = L33T["b"]!;
    expect(safelyReverseString(`a${b}c`)).toBe(`c${b}a`);
  });

  test("the authentication and charisma formulas", async () => {
    const effects = await read("src/DarkNet/effects/effects.ts");
    expect(effects).toContain("const baseTime = 850;");
    expect(effects).toContain("(person.skills.charisma + 150)");
    // The SF15 auth discount is gated on level > 2, not > 1, however the
    // Source-File description and upstream's own variable name read it.
    expect(effects).toContain("Player.activeSourceFileLvl(15) > 2 ? 0.8 : 1");
    // calculatePasswordAttemptChaGain, term by term.
    expect(effects).toContain("const baseXpGain = 3;");
    expect(effects).toContain("const difficultyBase = 1.1;");
    expect(effects).toContain("const alreadyHackedMult = server.hasAdminRights ? 0.2 : 1;");
    expect(effects).toContain("const successMult = success && !server.hasAdminRights ? 10 : 1;");
    // A successful authentication is what ROOTS a darknet host. Nothing else
    // does: `nuke` and the port openers go through `getNormalServer`, which
    // throws for a DarknetServer.
    expect(effects).toContain("server.hasAdminRights = true;");
    const helpers = await read("src/Netscript/NetscriptHelpers.tsx");
    expect(helpers).toContain("errorMessage += \" The server must not be a darknet server.\";");
    // Ours against theirs: a failed attempt on an unrooted host, one thread.
    expect(attemptCharismaExp(10, false, 1, false)).toBeCloseTo(3 + 1.1 ** 10, 10);
    // A first success on an unrooted host pays ten times as much, which is what
    // makes the first crack of a host worth more than the grind after it.
    expect(attemptCharismaExp(10, false, 1, true)).toBeCloseTo(10 * (3 + 1.1 ** 10), 10);
    // A rooted host pays a fifth, which is why rooting a darknet server for
    // free would have quietly changed the whole feature's charisma economy.
    expect(attemptCharismaExp(10, true, 1, false)).toBeCloseTo(0.2 * (3 + 1.1 ** 10), 10);
  });

  test("the propaganda curve's growth rate and the charge per call", async () => {
    const effects = await read("src/DarkNet/effects/effects.ts");
    expect(effects).toContain(`const growthRate = ${STOCK_PROMOTION_GROWTH_RATE};`);
    const darknet = await read("src/NetscriptFunctions/Darknet.ts");
    expect(darknet).toContain("threads * ((500 + Player.skills.charisma) / 500)");
    // One thread at charisma 500 buys two charges.
    expect(promoteStockCharges(1, 500)).toBe(2);
  });

  test("the labyrinth ladder, and what actually roots a lab", async () => {
    const labyrinth = await read("src/DarkNet/effects/labyrinth.ts");
    // `labData` is keyed by SpecialServers name and carries depth/cha/maze
    // size per rung, in ladder order. Match each rung's block rather than the
    // fields separately, so two rungs cannot pass by borrowing each other's.
    for (const stage of LAB_LADDER) {
      expect(labyrinth, stage.hostname).toContain(
        `    depth: ${stage.depth},
    cha: ${stage.cha},
`
        + `    mazeWidth: ${stage.mazeWidth},
    mazeHeight: ${stage.mazeHeight},
`,
      );
      expect(labyrinth, stage.hostname).toContain(`offsetStartAndEnd: ${stage.offsetStartAndEnd}`);
    }
    // BN15 is the only node that moves the Pill forward, and it moves it to
    // the FOURTH unclaimed reward — which is why five walks finish this node.
    expect(labyrinth).toContain("// On BN15, the fourth lab has the Red Pill");
    // A lab is rooted by ARRIVAL and by nothing else: the correct password is
    // refused outright. This is the fact the hold planner's "walked" test rests
    // on, and reading it as `hasCredential` instead cost BN15 its whole ladder.
    expect(labyrinth).toContain("if (labServer.hasAdminRights) {");
    expect(labyrinth).toContain("attemptedPassword === labServer.password");
    expect(labyrinth).toContain("hasAdminRights = true");
    // 20x14 declared, 21x13 produced — and the exit is at [cols-2, rows-2], so
    // a walker aiming at the declared size searches the wrong corner.
    expect(labMazeSize(LAB_LADDER[0]!)).toEqual({ width: 21, height: 13 });
  });
});

/** These two need no checkout: they hold the repository to its own
 * transcription rather than to upstream's text. */
describe("what the generated hostnames oblige", () => {
  test("`hostish` accepts every character a generated hostname can hold", () => {
    // The validator gates credential extraction out of packet noise, and it
    // used to accept only [A-Za-z0-9_.-] — rejecting every connector, the
    // digit suffix's colon, the l33t emoji and the CJK preset. A rejected head
    // means the password after it is never read at all.
    for (const ch of generatedNameCharacters()) {
      if (ch === ":") continue; // a bare colon head is the empty-hostname case
      expect(passwordFromNamedPacket(` ${ch}host:secret `, { passwordLength: 6 }), ch).toBe("secret");
    }
  });

  test("generated names look like the game's, not like a counter", () => {
    const rng = mulberry32(11);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(generateDarknetServerName(
        (candidate) => candidate.length === 0 || seen.has(candidate),
        () => rng(),
        () => 1_704_067_200_000,
      ));
    }
    const names = [...seen];
    expect(names.length).toBeGreaterThan(150);
    // None of them is the `dnet-<depth>-x<n>` shape this replaced.
    expect(names.some((name) => name.startsWith("dnet-"))).toBe(false);
    // And they are built out of the transcribed vocabulary rather than
    // anything invented here.
    const vocabulary = [
      ...COMMON_PASSWORDS, ...LORE_NAMES, ...PRESET_NAMES,
      ...SERVER_NAME_PREFIXES, ...SERVER_NAME_SUFFIXES,
    ];
    expect(names.filter((name) => vocabulary.some((word) => name.includes(word))).length)
      .toBeGreaterThan(names.length / 2);
  });

  test("the assumption ledger no longer claims synthetic hostnames", () => {
    const entry = DNET_ASSUMPTIONS.find((line) => line.startsWith("dnet.hostnames:"));
    expect(entry).toBeDefined();
    expect(entry).toContain("GENERATED");
    expect(entry).not.toContain("SYNTHETIC");
  });
});
