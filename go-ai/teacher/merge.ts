/** Merge teacher TSV corpora while assigning globally unique game ids. */
const outputIndex = Bun.argv.indexOf("--out");
const output = outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined;
const inputs = Bun.argv.slice(2).filter((value, index, all) => {
  if (value === "--out") return false;
  if (index > 0 && all[index - 1] === "--out") return false;
  return true;
});
if (!output || inputs.length < 1) {
  throw new Error("usage: bun run go-ai/teacher/merge.ts --out OUTPUT INPUT [INPUT ...]");
}
const writer = Bun.file(output).writer();
writer.write("# bitburner-go-teacher-v1\n");
writer.write("# game state candidate opponent size elapsed remaining won power selected bx by wx wy before after\n");
let gameOffset = 0;
let examples = 0;
for (const input of inputs) {
  const lines = (await Bun.file(input).text()).split("\n").filter((line) => line && !line.startsWith("#"));
  let maxGame = -1;
  for (const line of lines) {
    const fields = line.split("\t");
    const game = Number(fields[0]);
    if (!Number.isSafeInteger(game) || game < 0) throw new Error(`invalid game id in ${input}`);
    fields[0] = String(game + gameOffset);
    writer.write(fields.join("\t") + "\n");
    maxGame = Math.max(maxGame, game);
    examples++;
  }
  gameOffset += maxGame + 1;
}
await writer.end();
console.log(JSON.stringify({ output, inputs, games: gameOffset, examples }));
