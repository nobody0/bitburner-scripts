export {};

const filters = process.argv.slice(2);
const files: string[] = [];
for await (const file of new Bun.Glob("sim/tests/scenario-*.test.ts").scan(".")) {
  const normalized = file.replaceAll("\\", "/");
  if (filters.length === 0 || filters.some((filter) => normalized.includes(filter))) files.push(normalized);
}
files.sort();
if (files.length === 0) throw new Error(`no scenario files matched: ${filters.join(", ")}`);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let failures = 0;
let cases = 0;
for (const file of files) {
  const source = await Bun.file(file).text();
  const names = [...source.matchAll(/\btest\(\s*(["'])(.*?)\1/g)].map((match) => match[2]!);
  if (names.length === 0) throw new Error(`${file} contains no statically named tests`);
  for (const name of names) {
    cases++;
    console.log(`\n=== ${file} :: ${name} ===`);
    const child = Bun.spawn([
      "bun",
      "test",
      file,
      "--test-name-pattern",
      escapeRegex(name),
      "--timeout",
      "30000",
    ], {
      env: { ...process.env, SIM_SCENARIOS: "1" },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await child.exited !== 0) failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${cases} scenario cases failed`);
  process.exit(1);
}
console.log(`\n${cases} scenario cases passed`);
