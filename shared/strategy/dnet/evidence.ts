export type PasswordEvidence =
  | { kind: "contains"; chars: string[]; at: number }
  | { kind: "placement"; attempted: string; placed: string[]; at: number };

export function candidateMatchesEvidence(candidate: string, evidence: readonly PasswordEvidence[] = []): boolean {
  for (const item of evidence) {
    if (item.kind === "contains") {
      const available = counts(candidate);
      // Upstream insists on two distinct INDICES, except a one-character
      // password where modulo one necessarily selects the same index twice.
      // In that edge case the duplicated prose is one occurrence, not two.
      const requiredChars = candidate.length <= 1 ? [...new Set(item.chars)] : item.chars;
      const required = counts(requiredChars.join(""));
      for (const [char, count] of required) if ((available.get(char) ?? 0) < count) return false;
      continue;
    }
    const reproduced = candidate.split("").filter((char, index) => char === item.attempted[index]).slice(0, 2);

    if (reproduced.length !== item.placed.length) return false;
    if (reproduced.some((char, index) => char !== item.placed[index])) return false;
  }
  return true;
}

/** Positions that placement evidence proves outright.
 *
 * The log lists character VALUES, not indices. An index is therefore safe only
 * when that character occurs once in the attempted string; repeated probes such
 * as `1111` still constrain candidates, but cannot tell which `1` was correct. */
export function fixedPositionsFromEvidence(
  length: number,
  evidence: readonly PasswordEvidence[] = [],
): (string | undefined)[] {
  const fixed = new Array<string | undefined>(length).fill(undefined);
  for (const item of evidence) {
    if (item.kind !== "placement") continue;
    for (const char of item.placed) {
      const at = item.attempted.indexOf(char);
      if (at >= 0 && at < length && at === item.attempted.lastIndexOf(char)) fixed[at] = char;
    }
  }
  return fixed;
}

/** Put characters known to occur at the front of a probe alphabet. This is an
 * ordering optimization only: a noisy or stale hint cannot remove a symbol and
 * make a complete solver incomplete. */
export function prioritizeAlphabet(alphabet: string, evidence: readonly PasswordEvidence[] = []): string {
  let preferred = "";
  const add = (char: string): void => {
    if (alphabet.includes(char) && !preferred.includes(char)) preferred += char;
  };
  for (const item of evidence) {
    if (item.kind === "contains") for (const char of item.chars) add(char);
    else for (const char of item.placed) add(char);
  }
  let rest = "";
  for (const char of alphabet) if (!preferred.includes(char)) rest += char;
  return preferred + rest;
}

function counts(value: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const char of value) out.set(char, (out.get(char) ?? 0) + 1);
  return out;
}
