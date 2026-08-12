/** Select rows from a teacher corpus without changing targets or game ids. */
const outputIndex = Bun.argv.indexOf("--out");
const opponentsIndex = Bun.argv.indexOf("--opponents");
const output = outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined;
const input = Bun.argv.at(-1);
const opponents = new Set((opponentsIndex >= 0 ? Bun.argv[opponentsIndex + 1] : "")
  ?.split(",").filter(Boolean).map(Number));
if (!output || !input || input === output || opponents.size === 0
  || [...opponents].some((value) => !Number.isSafeInteger(value) || value < 0 || value > 6)) {
  throw new Error("usage: bun run go-ai/teacher/filter.ts --out OUTPUT --opponents 2,3 INPUT");
}

const writer = Bun.file(output).writer();
writer.write("# bitburner-go-teacher-v1\n");
writer.write("# game state candidate opponent size elapsed remaining won power selected bx by wx wy before after\n");
let examples = 0;
const games = new Set<number>();
for (const line of (await Bun.file(input).text()).split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const fields = line.split("\t");
  const opponent = Number(fields[3]);
  if (!opponents.has(opponent)) continue;
  writer.write(line + "\n");
  games.add(Number(fields[0]));
  examples++;
}
await writer.end();
console.log(JSON.stringify({ output, input, opponents: [...opponents], games: games.size, examples }));
