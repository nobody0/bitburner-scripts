/** Run a real BN15 game in the simulator and render the Darknet panel from the
 * telemetry it actually emitted.
 *
 * No invented data at all, so what it shows is exactly what an operator would
 * see — including the parts that are empty because the agents genuinely have not
 * learned them yet. That is the point: a synthetic fixture will happily render a
 * panel for a net the crawler could never actually reach, and this will not.
 *
 * The trail and controller lines it prints are the fastest read on whether the
 * net is being explored or is quietly decaying; several real bugs showed up
 * there first and nowhere else.
 *
 *     bun run tools/dnet-run-preview.ts [--minutes 10] [--out runs/dnet-live.html]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runGame } from "../sim/game-run.ts";
import { parseGoals } from "../shared/goals/presets.ts";
import { only } from "../sim/feature-selection.ts";
import { emptyState } from "../ui/app/project.ts";
import { TABS } from "../ui/app/tabs/index.ts";
import { setView } from "../ui/app/lib/viewstate.ts";
import type { DarknetState } from "../shared/telemetry/topics/dnet.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
};
const minutes = Number(flag("minutes", "10"));
const out = resolve(flag("out", "runs/dnet-live.html"));

let latest: DarknetState | undefined;
let records = 0;
let controllerSays = "";
const trail: string[] = [];

const result = await runGame({
  goal: parseGoals(["wealth:1e12"]),
  seed: 3,
  horizonMs: minutes * 60_000,
  bitnode: 15,
  homeRam: 256,
  features: only("progression", "dnet"),
  onRecord: (line) => {
    const record = JSON.parse(line) as { key?: string; data?: DarknetState };
    if (typeof record.key === "string" && record.key.startsWith("dnet.controller")) {
      controllerSays = JSON.stringify(record.data);
    }
    if (record.key !== "dnet" || !record.data) return;
    records++;
    latest = record.data;
    trail.push(`${record.data.coverage?.known ?? 0}h a${record.data.knowledge?.agents.live ?? 0} [${record.data.plan?.lastResult?.action ?? "-"}:${record.data.plan?.lastResult?.ok ? "ok" : record.data.plan?.lastResult?.detail?.slice(0,28) ?? ""}]`);
  },
});

if (!latest) {
  console.error("no dnet telemetry was emitted at all");
  process.exit(1);
}

const state = emptyState();
state.topics.dnet = latest;
setView("dnet.zoom", "100");

const page = `<!doctype html><html><head><meta charset="utf-8">
<title>darknet, live</title>
<link rel="stylesheet" href="../ui/public/theme.css">
<link rel="stylesheet" href="../ui/public/app.css">
</head><body><main id="view">${TABS.dnet.render(state)}</main></body></html>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);

const known = latest.knowledge?.hosts.length ?? 0;
const withEdges = latest.knowledge?.hosts.filter((host) => host.neighbours).length ?? 0;
console.log(
  `${minutes}m BN15 run: ${records} dnet records, ${known} hosts known, ${withEdges} with adjacency, `
  + `${latest.coverage?.cracked ?? 0} cracked, agents live ${latest.knowledge?.agents.live ?? 0} `
  + `of ${latest.knowledge?.agents.seenEver ?? 0} seen`,
);
console.log(`last action: ${JSON.stringify(latest.plan?.lastResult)}`);
console.log(`codes: ${JSON.stringify(latest.codes)}`);
console.log(`controller digest: ${JSON.stringify(latest.knowledge?.controller)}`);
console.log(`crashes: ${result.crashes.length}, unmodeled: ${JSON.stringify(result.unmodeled)}`);
console.log(JSON.stringify(result.crashes.slice(0,3), null, 1));
console.log(`trail (hosts/known cracked agents): ${trail.join(" ")}`);
console.log(`controller trace: ${controllerSays.slice(0, 900)}`);
console.log(`-> ${out}`);
