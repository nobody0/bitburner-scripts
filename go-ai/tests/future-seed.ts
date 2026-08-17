import {
  GO_ARENA_OPPONENTS,
  playGoArenaPolicyGame,
} from "../teacher/arena.ts";

const illuminati = GO_ARENA_OPPONENTS.find(({ name }) => name === "Illuminati")!;
const seed = 1_234_000;
const handicapSeed = 111;
const defenseSeed = 222;
const first = await playGoArenaPolicyGame(
  illuminati, seed, undefined, true, undefined, handicapSeed, defenseSeed,
);
const second = await playGoArenaPolicyGame(
  illuminati, seed, undefined, true, undefined, handicapSeed, defenseSeed,
);
const firstTrace = first.trace ?? [];
const secondTrace = second.trace ?? [];
if (firstTrace.length < 2 || secondTrace.length < 2) {
  throw new Error("future-seed test game ended before a second decision");
}
const deterministicTrace = (trace: typeof firstTrace) => trace.map(({ planningMs: _planningMs, ...turn }) => turn);
if (JSON.stringify(deterministicTrace(firstTrace)) !== JSON.stringify(deterministicTrace(secondTrace))) {
  throw new Error("identical timing and defense streams did not replay exactly");
}
const advances = firstTrace.slice(1).map((turn, index) =>
  turn.dispatchPlaytime - firstTrace[index]!.dispatchPlaytime);
if (advances.some((advance) => advance < 200 || advance % 200 !== 0)) {
  throw new Error(`invalid opponent time advance: ${advances.join(",")}`);
}
if (new Set(advances).size < 2) {
  throw new Error(`opponent timing never varied across the game: ${advances.join(",")}`);
}
console.log("opponent wait traces replay exactly and advance variable engine ticks");
