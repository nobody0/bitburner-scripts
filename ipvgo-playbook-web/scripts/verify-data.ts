import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const root = join(import.meta.dir, "../public/data");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
  phases: number;
  shardSize: number;
  enemies: { key: string; name: string }[];
};

for (const enemy of manifest.enemies) {
  const routes = gunzipSync(await readFile(join(root, enemy.key, "routes.bin")));
  if (routes.length !== manifest.phases * 9) throw new Error(`${enemy.name}: malformed route table`);
  const required = new Set<number>();
  for (let offset = 0; offset < routes.length; offset += 9) {
    required.add(routes[offset]! | (routes[offset + 1]! << 8) | (routes[offset + 2]! << 16));
  }
  const byShard = new Map<number, number[]>();
  for (const phase of required) {
    const shard = Math.floor(phase / manifest.shardSize);
    const phases = byShard.get(shard) ?? [];
    phases.push(phase);
    byShard.set(shard, phases);
  }
  for (const [shard, phases] of byShard) {
    const stem = `policies-${String(shard).padStart(3, "0")}`;
    const index = JSON.parse(await readFile(join(root, enemy.key, `${stem}.json`), "utf8")) as Record<string, unknown[]>;
    for (const phase of phases) if (!index[String(phase)]?.length) {
      throw new Error(`${enemy.name}: routed entry ${phase} has no certificate`);
    }
    const graph = gunzipSync(await readFile(join(root, enemy.key, `${stem}.bin`)));
    const nodeCount = new DataView(graph.buffer, graph.byteOffset, graph.byteLength).getUint32(0, true);
    for (const phase of phases) for (const item of index[String(phase)] as { root: number }[]) {
      if (!Number.isInteger(item.root) || item.root < 0 || item.root >= nodeCount) {
        throw new Error(`${enemy.name}: invalid root for entry ${phase}`);
      }
    }
  }
  console.log(`${enemy.name}: ${required.size.toLocaleString()} routed entries verified`);
}
