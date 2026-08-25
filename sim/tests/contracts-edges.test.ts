import { describe, expect, test } from "bun:test";
import { solveContract } from "../../game/lib/features/side.ts";
import { mulberry32 } from "../core/rng.ts";
import { CodingContractTypes } from "../vendor/bitburner/src/CodingContract/ContractTypes.ts";

/** The official generators only ever emit one shape per contract type: prime
 * ranges at least 100000 wide, digit strings of at least four digits, plaintext
 * of at least fifty characters. The solvers for those three do index arithmetic
 * — an odd-only sieve padded to 32-bit words, a packed token path, a suffix cost
 * table — whose boundaries live entirely outside what a generated case reaches.
 * These cases hold those boundaries down against brute force and against the
 * game's own implementations. */

// Indexing the registry by name resolves each entry's Answer to `{}`, so the
// official answers are bound here with the signatures the contracts document.
const officialPrimes = CodingContractTypes["Total Number of Primes"]
  .getAnswer as (data: [number, number]) => number;
const officialUniquePaths = CodingContractTypes["Unique Paths in a Grid I"]
  .getAnswer as (data: [number, number]) => number;
const officialTotalWays = CodingContractTypes["Total Ways to Sum"]
  .getAnswer as (data: number) => number;
const officialLargestPrimeFactor = CodingContractTypes["Find Largest Prime Factor"]
  .getAnswer as (data: number) => number;
const officialMath = CodingContractTypes["Find All Valid Math Expressions"]
  .getAnswer as (data: [string, number]) => string[];
const officialLz = CodingContractTypes["Compression III: LZ Compression"]
  .getAnswer as (data: string) => string;
const lzDecode = CodingContractTypes["Compression II: LZ Decompression"]
  .getAnswer as (data: string) => string;

function isPrime(value: number): boolean {
  if (value < 2) return false;
  for (let divisor = 2; divisor * divisor <= value; divisor++) if (value % divisor === 0) return false;
  return true;
}

describe("coding contract solver boundaries", () => {
  test("bounded lookup solvers cover every official input", () => {
    for (let rows = 2; rows <= 14; rows++) {
      for (let cols = 2; cols <= 14; cols++) {
        const data: [number, number] = [rows, cols];
        expect(solveContract("Unique Paths in a Grid I", data)).toBe(officialUniquePaths(data));
      }
    }
    for (let target = 8; target <= 100; target++) {
      expect(solveContract("Total Ways to Sum", target)).toBe(officialTotalWays(target));
    }
  });

  test("largest-prime-factor wheel handles boundary factor shapes", () => {
    const values = [
      500,
      2 ** 29,
      3 ** 18,
      5 ** 12,
      31_607 * 31_609,
      999_950_000,
      999_999_937,
      1_000_000_000,
    ];
    for (const value of values) {
      expect(solveContract("Find Largest Prime Factor", value)).toBe(officialLargestPrimeFactor(value));
    }
  });

  test("Total Number of Primes counts every small range, including empty ones", () => {
    const wrong: string[] = [];
    for (let low = 0; low <= 40; low++) {
      for (let high = low; high <= 90; high++) {
        let expected = 0;
        for (let value = low; value <= high; value++) if (isPrime(value)) expected++;
        // Every residue of the segment width mod 4 appears here, so the word
        // padding in the tally is exercised in all four alignments.
        const got = solveContract("Total Number of Primes", [low, high]);
        if (got !== expected) wrong.push(`[${low},${high}] got ${got} want ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
    // A reversed range has nothing in it, and must not be read as a huge one.
    expect(solveContract("Total Number of Primes", [10, 0])).toBe(0);
    expect(solveContract("Total Number of Primes", [0, 0])).toBe(0);
  });

  test("Total Number of Primes matches the game across the full generated span", () => {
    for (const range of [[0, 1e5], [2, 100003], [999983, 1999983], [5e6, 6e6], [4999999, 5100001]] as [number, number][]) {
      expect(solveContract("Total Number of Primes", range)).toBe(officialPrimes(range));
    }
    expect(solveContract("Total Number of Primes", [-1, 100])).toBeUndefined();
    expect(solveContract("Total Number of Primes", [0, 6_000_001])).toBeUndefined();
  });

  test("Find All Valid Math Expressions matches the game on exhaustive short inputs", () => {
    const wrong: string[] = [];
    for (let length = 1; length <= 4; length++) {
      for (let value = 0; value < 10 ** length; value++) {
        const digits = String(value).padStart(length, "0");
        for (const target of [-10, 0, 1, 6, 100]) {
          const want = [...officialMath([digits, target])].sort();
          const got = [...(solveContract("Find All Valid Math Expressions", [digits, target]) as string[])].sort();
          // Duplicates count: the game compares lengths before set membership.
          if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`["${digits}",${target}]`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("Find All Valid Math Expressions prunes without losing an expression", () => {
    // The reach bound only ever removes subtrees, so a bug in it shows up as a
    // MISSING expression rather than a wrong one. These are the lengths where
    // it prunes hardest, plus shapes built to stress a bound keyed on token
    // values and products: runs of ones and nines, embedded zeros, repeats.
    const wrong: string[] = [];
    const check = (digits: string, target: number): void => {
      const want = [...officialMath([digits, target])].sort();
      const got = [...(solveContract("Find All Valid Math Expressions", [digits, target]) as string[])].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        wrong.push(`["${digits}",${target}] want ${want.length} got ${got.length}`);
      }
    };
    const random = mulberry32(0xc0ffee);
    for (let length = 6; length <= 10; length++) {
      for (let trial = 0; trial < 4; trial++) {
        let digits = String(1 + Math.floor(random() * 9));
        for (let k = 1; k < length; k++) digits += String(Math.floor(random() * 10));
        for (const target of [-100, 0, 1, 42, 100]) check(digits, target);
      }
    }
    // The reference enumeration is itself exponential, so the widest shapes are
    // spot-checked at ten digits and only two are carried to the full twelve.
    for (const digits of ["1111111111", "9999999999", "1000000000", "1201201201",
      "5000000005", "1010101010", "1234500000", "9080706050"]) {
      for (const target of [-100, 0, 1, 100]) check(digits, target);
    }
    for (const digits of ["111111111111", "120120120120"]) check(digits, 100);
    expect(wrong).toEqual([]);
  });

  test("Compression III returns a minimal, decodable encoding for every short string", () => {
    const wrong: string[] = [];
    // Two characters is the alphabet that makes back-references reachable at
    // every offset, so short binary strings cover the state machine densely.
    for (let length = 1; length <= 11; length++) {
      for (let mask = 0; mask < 2 ** length; mask++) {
        let plain = "";
        for (let bit = 0; bit < length; bit++) plain += mask >> bit & 1 ? "b" : "a";
        const got = solveContract("Compression III: LZ Compression", plain) as string;
        if (lzDecode(got) !== plain) wrong.push(`${plain} -> ${got} decodes to ${lzDecode(got)}`);
        else if (got.length > officialLz(plain).length) wrong.push(`${plain} -> ${got} is not minimal`);
      }
    }
    expect(wrong).toEqual([]);
    expect(solveContract("Compression III: LZ Compression", "")).toBe("");
    // The worked examples from the contract's own description.
    for (const plain of ["abracadabra", "mississippi", "aAAaAAaAaAA", "2718281828",
      "abcdefghijk", "aaaaaaaaaaaa", "aaaaaaaaaaaaa", "aaaaaaaaaaaaaa"]) {
      const got = solveContract("Compression III: LZ Compression", plain) as string;
      expect(lzDecode(got)).toBe(plain);
      expect(got.length).toBeLessThanOrEqual(officialLz(plain).length);
    }
  });
});
