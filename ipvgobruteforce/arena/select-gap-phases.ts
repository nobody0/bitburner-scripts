import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PHASES = 150_000;

function valueAfter(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  if (index >= 0) return Bun.argv[index + 1];
  return Bun.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function valuesAfter(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < Bun.argv.length; index++) {
    const argument = Bun.argv[index]!;
    if (argument === name && Bun.argv[index + 1] !== undefined) values.push(Bun.argv[++index]!);
    else if (argument.startsWith(`${name}=`)) values.push(argument.slice(name.length + 1));
  }
  return values;
}

const policies = valueAfter("--policies");
const output = valueAfter("--output");
const targetGap = Number(valueAfter("--target-gap") ?? 5);
const limit = Number(valueAfter("--limit") ?? PHASES);
const excludeProgress = valuesAfter("--exclude-progress");
if (!policies || !output) {
  throw new Error("usage: select-gap-phases.ts --policies DIR --output FILE [--target-gap N] [--limit N] [--exclude-progress FILE ...]");
}
if (!Number.isInteger(targetGap) || targetGap < 1 || !Number.isInteger(limit) || limit < 1) {
  throw new Error("target gap and limit must be positive integers");
}

const solved = [...new Set(readdirSync(resolve(policies), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".tsv"))
  .map((entry) => Number(entry.name.match(/^(\d+)/)?.[1]))
  .filter((phase) => Number.isInteger(phase) && phase >= 0 && phase < PHASES))]
  .sort((left, right) => left - right);
if (solved.length === 0) throw new Error("policy directory contains no phase certificates");
const excluded = new Set<number>();
for (const progress of excludeProgress) {
  for (const line of readFileSync(resolve(progress), "utf8").split("\n").slice(1)) {
    const phase = Number(line.slice(0, line.indexOf("\t")));
    if (Number.isInteger(phase) && phase >= 0 && phase < PHASES) excluded.add(phase);
  }
}

interface Gap { begin: number; length: number }
const betterGap = (left: Gap, right: Gap) =>
  left.length > right.length || (left.length === right.length && left.begin < right.begin);
const gaps: Gap[] = [];
function pushGap(gap: Gap): void {
  if (gap.length <= 0) return;
  gaps.push(gap);
  for (let index = gaps.length - 1; index > 0;) {
    const parent = (index - 1) >> 1;
    if (!betterGap(gaps[index]!, gaps[parent]!)) break;
    [gaps[index], gaps[parent]] = [gaps[parent]!, gaps[index]!];
    index = parent;
  }
}
function popGap(): Gap | undefined {
  const first = gaps[0];
  const last = gaps.pop();
  if (!first || !last || gaps.length === 0) return first;
  gaps[0] = last;
  for (let index = 0;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let best = index;
    if (left < gaps.length && betterGap(gaps[left]!, gaps[best]!)) best = left;
    if (right < gaps.length && betterGap(gaps[right]!, gaps[best]!)) best = right;
    if (best === index) break;
    [gaps[index], gaps[best]] = [gaps[best]!, gaps[index]!];
    index = best;
  }
  return first;
}
for (const gap of solved.map((begin, index) => {
  const end = solved[(index + 1) % solved.length]!;
  return { begin, length: (end - begin + PHASES) % PHASES };
})) pushGap(gap);
const selected: number[] = [];
while (selected.length < limit) {
  const gap = popGap();
  if (!gap || gap.length <= targetGap) break;
  const leftLength = Math.floor(gap.length / 2);
  const phase = (gap.begin + leftLength) % PHASES;
  if (!excluded.has(phase)) selected.push(phase);
  pushGap({ begin: gap.begin, length: leftLength });
  pushGap({ begin: phase, length: gap.length - leftLength });
}

writeFileSync(resolve(output), `${selected.join("\n")}\n`);
console.log(JSON.stringify({
  policies: solved.length,
  excluded: excluded.size,
  selected: selected.length,
  targetGap,
  remainingMaximumGap: Math.max(...gaps.map((gap) => gap.length)),
  output: resolve(output),
}, null, 2));
