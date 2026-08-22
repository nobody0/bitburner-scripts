/** Combined playbook-first / neural-fallback arena driver.
 *
 * Requires the stripped merged playbook at
 * `go-ai/derivatives/playbook-combined/merged/playbook.phase.js` (built by
 * `go:playbook:pack`). Plays three arms on identical corpora through the
 * production WebGPU stack in headless Chrome:
 *
 * - `combined`    playbook-first with neural fallback (the deliverable);
 * - `playbookOnly` a miss fails the game (the old standalone behavior);
 * - `neuralOnly`  the neural stack alone (the live-game baseline).
 *
 * Usage:
 *   bun run go:combined:arena [--games N] [--start-phase N] [--phase-stride N]
 *     [--timing minimum|maximum|random] [--defense-seed N] [--opponent NAME]
 *     [--cheat] [--cheat-seeded] [--cheat-late [N]] [--cheat-chance P]
 *     [--out result.json]
 *
 * `--cheat` adds the `combinedCheat` arm (playbook-first with cheat-unlocked
 * neural fallback); `--cheat-seeded` additionally adds `combinedCheatSeeded`
 * (certified hits may become playbook-seeded double-move cheats that leave the
 * line); `--cheat-late [N]` adds `combinedCheatLate`, which delays the on-line
 * seeded offer until Black turn N (default 4, counted like the driver's
 * goBlackTurnIndex). Compare their winRate/nodePowerPerTurn against
 * `playbookOnly` before setting an opponent's `cheatSeedFromTurn` threshold in
 * GO_PLAYBOOK_OPPONENTS.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";
import { inlinePlaybookScript } from "./go-playbook-inline.ts";

const ROOT = join(import.meta.dir, "..");
const STRIPPED = join(ROOT, "go-ai", "derivatives", "playbook-combined", "merged", "playbook.phase.js");
/** The unpruned generation output. Running the same corpus against it proves
 * that residual stripping and outcome pruning cost no wins. */
const ORIGINAL = join(ROOT, "ipvgobruteforce", "data", "seeded-phases", "all-5x5-v1", "merged", "playbook.phase.js");

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

const PLAYBOOK = Bun.argv.includes("--original-playbook") ? ORIGINAL
  : resolve(ROOT, stringFlag("--playbook", STRIPPED));
if (!existsSync(PLAYBOOK)) {
  throw new Error(`merged playbook missing at ${PLAYBOOK}; run go:playbook:pack first`);
}
const timing = stringFlag("--timing", "random");
if (timing !== "minimum" && timing !== "maximum" && timing !== "random") {
  throw new Error("--timing must be minimum, maximum, or random");
}
const opponentIndex = Bun.argv.indexOf("--opponent");
const cheatEnabled = Bun.argv.includes("--cheat");
const cheatSeeded = Bun.argv.includes("--cheat-seeded");
const cheatLateIndex = Bun.argv.indexOf("--cheat-late");
const cheatLate = cheatLateIndex >= 0;
// The turn number is optional: `--cheat-late` alone means turn 4.
const cheatLateRaw = cheatLate ? Number(Bun.argv[cheatLateIndex + 1]) : Number.NaN;
const cheatLateTurn = cheatLate
  ? Math.max(0, Math.floor(Number.isFinite(cheatLateRaw) ? cheatLateRaw : 4))
  : undefined;
const cheatChance = Bun.argv.includes("--cheat-chance")
  ? numberFlag("--cheat-chance", 1)
  : undefined;
const config = {
  games: Math.max(1, Math.floor(numberFlag("--games", 96))),
  startPhase: Math.floor(numberFlag("--start-phase", 12_345)),
  phaseStride: Math.floor(numberFlag("--phase-stride", 104_729)),
  timing,
  defenseSeed: Math.floor(numberFlag("--defense-seed", 20_260_816)),
  playbook: PLAYBOOK.includes("all-5x5-v1") ? "original" : PLAYBOOK,
  ...(opponentIndex >= 0 ? { opponent: Bun.argv[opponentIndex + 1]! } : {}),
  // neuralUnrouted is the interpretability arm: the same neural stack on
  // ordinary (non-certified-root) start phases, so the routed arms' absolute
  // win rates can be read against the neural baseline of normal play.
  // The unrouted pair isolates the two independent choices: whether to dodge
  // to a certified root at all (neuralUnrouted vs neuralOnly) and whether
  // certified lookups help from wherever the game actually starts
  // (combinedUnrouted vs neuralUnrouted, which is the live controller's
  // mid-game-only policy).
  ...(cheatChance !== undefined ? { cheatChance } : {}),
  ...(cheatLateTurn !== undefined ? { cheatLateTurn } : {}),
  arms: [
    ...(Bun.argv.includes("--unrouted-baseline")
      ? ["combined", "playbookOnly", "neuralOnly", "neuralUnrouted", "combinedUnrouted"]
      : ["combined", "playbookOnly", "neuralOnly"]),
    ...(cheatEnabled || cheatSeeded || cheatLate ? ["combinedCheat"] : []),
    ...(cheatSeeded ? ["combinedCheatSeeded"] : []),
    ...(cheatLate ? ["combinedCheatLate"] : []),
  ] as readonly ("combined" | "playbookOnly" | "neuralOnly" | "neuralUnrouted"
    | "combinedUnrouted" | "combinedCheat" | "combinedCheatSeeded" | "combinedCheatLate")[],
};

const run = await runInHeadlessChrome(
  join(import.meta.dir, "webgpu", "entry-combined-arena.ts"),
  Math.max(1_800_000, config.games * config.arms.length * 20_000),
  { __goCombinedArenaConfig: config },
  [inlinePlaybookScript(await Bun.file(PLAYBOOK).text())],
);
const result = run.result as { ok: boolean; error?: string };
if (!result.ok) throw new Error(`combined arena failed: ${result.error}`);
console.log(JSON.stringify(result, null, 2));
const outPath = stringFlag("--out", join(ROOT, "go-ai", "derivatives",
  `combined-arena-${config.startPhase}.json`));
await Bun.write(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`combined arena report written to ${outPath}`);
