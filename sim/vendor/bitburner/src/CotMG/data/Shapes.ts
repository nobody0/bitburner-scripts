// Vendored from bitburner-src v3.0.1:src/CotMG/data/Shapes.ts by tools/vendor.ts — DO NOT EDIT
const _ = false;
const X = true;
export const Shapes: {
  O: boolean[][];
  I: boolean[][];
  L: boolean[][];
  J: boolean[][];
  S: boolean[][];
  Z: boolean[][];
  T: boolean[][];
} = {
  O: [
    [X, X],
    [X, X],
  ],
  I: [[X, X, X, X]],
  L: [
    [_, _, X],
    [X, X, X],
  ],
  J: [
    [X, _, _],
    [X, X, X],
  ],
  S: [
    [_, X, X],
    [X, X, _],
  ],
  Z: [
    [X, X, _],
    [_, X, X],
  ],
  T: [
    [X, X, X],
    [_, X, _],
  ],
};
