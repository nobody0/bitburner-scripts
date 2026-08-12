import {
  GO_ARENA_OPPONENTS,
  playGoArenaPolicyGame,
} from "../teacher/arena.ts";

const illuminati = GO_ARENA_OPPONENTS.find(({ name }) => name === "Illuminati")!;
const seed = 1_234_000;
const first = await playGoArenaPolicyGame(illuminati, seed, 0.5, true, undefined, 111);
const second = await playGoArenaPolicyGame(illuminati, seed, 0.5, true, undefined, 222);
const firstTrace = first.trace ?? [];
const secondTrace = second.trace ?? [];
if (firstTrace.length < 2 || secondTrace.length < 2) {
  throw new Error("future-seed test game ended before a second decision");
}
const immediate = (turn: typeof firstTrace[number]) => JSON.stringify({
  black: turn.black,
  white: turn.white,
});
if (immediate(firstTrace[0]!) !== immediate(secondTrace[0]!)) {
  throw new Error("future seed salt changed the known immediate candidate/response");
}
if (firstTrace[1]!.dispatchPlaytime === secondTrace[1]!.dispatchPlaytime) {
  throw new Error("future seed salt did not resample the following turn");
}
console.log("future seed resampling preserves the immediate reply and varies the next turn");
