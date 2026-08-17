import { expect, test } from "bun:test";
import {
  goBoardWords,
  goLegalWords,
  packGoBoard,
  packGoTactical,
} from "../shared/strategy/go/neural/backend.ts";

test("tactical-v1 derives liberties and candidate consequences exactly", () => {
  const extent = 5;
  const board = { size: extent, rows: [".X...", "XOX..", ".....", ".....", "....."] };
  const packed = new Uint32Array(goBoardWords(extent));
  packGoBoard(board, extent, packed, 0);
  const legal = new Uint32Array(goLegalWords(extent));
  const capture = 2 * extent + 1;
  legal[capture >> 5]! |= 1 << (capture & 31);
  const tactical = packGoTactical(packed, legal, 1, extent);
  const words = goLegalWords(extent);
  const bit = (plane: number, point: number): number =>
    (tactical[plane * words + (point >> 5)]! >>> (point & 31)) & 1;

  expect(bit(2, extent + 1)).toBe(1); // White group has exactly one liberty.
  expect(bit(4, capture)).toBe(1); // Playing the liberty captures it.
  expect(bit(5, capture)).toBe(0); // Only one stone is captured.
  expect(bit(6, capture)).toBe(0); // The capture is not self-atari.
  expect(bit(7, capture)).toBe(0); // It does not join two Black groups.
});
