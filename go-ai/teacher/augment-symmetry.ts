/** Expand a teacher corpus by all eight square-board dihedral symmetries.
 * Candidate and exactly known reply coordinates transform with both boards.
 * Game ids retain the original modulo-five split to prevent train/heldout
 * leakage between symmetric copies of one position. */
const outputIndex = Bun.argv.indexOf("--out");
const output = outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined;
const input = Bun.argv.at(-1);
if (!output || !input || input === output) {
  throw new Error("usage: bun run go-ai/teacher/augment-symmetry.ts --out OUTPUT INPUT");
}

function transformPoint(size: number, transform: number, x: number, y: number): [number, number] {
  if (x < 0 || y < 0) return [-1, -1];
  let tx = x;
  let ty = y;
  if (transform >= 4) tx = size - 1 - tx;
  for (let rotation = 0; rotation < transform % 4; rotation++) {
    [tx, ty] = [size - 1 - ty, tx];
  }
  return [tx, ty];
}

function transformBoard(hash: string, size: number, transform: number): string {
  if (hash.length !== size * size) throw new Error("invalid board hash length");
  const output = Array<string>(hash.length);
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
    const [tx, ty] = transformPoint(size, transform, x, y);
    output[tx * size + ty] = hash[x * size + y]!;
  }
  return output.join("");
}

const writer = Bun.file(output).writer();
writer.write("# bitburner-go-teacher-v1\n");
writer.write("# game state candidate opponent size elapsed remaining won power selected bx by wx wy before after\n");
let examples = 0;
for (const line of (await Bun.file(input).text()).split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const base = line.split("\t");
  const game = Number(base[0]);
  const size = Number(base[4]);
  if (!Number.isSafeInteger(game) || !Number.isSafeInteger(size)) throw new Error("invalid row ids");
  for (let transform = 0; transform < 8; transform++) {
    const fields = [...base];
    fields[0] = String(game * 40 + transform * 5 + game % 5);
    const [bx, by] = transformPoint(size, transform, Number(base[10]), Number(base[11]));
    const [wx, wy] = transformPoint(size, transform, Number(base[12]), Number(base[13]));
    fields[10] = String(bx);
    fields[11] = String(by);
    fields[12] = String(wx);
    fields[13] = String(wy);
    fields[14] = transformBoard(base[14]!, size, transform);
    fields[15] = transformBoard(base[15]!, size, transform);
    writer.write(fields.join("\t") + "\n");
    examples++;
  }
}
await writer.end();
console.log(JSON.stringify({ input, output, symmetries: 8, examples }));
