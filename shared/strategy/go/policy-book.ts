import type { GoRewardOpponent } from "./decide.ts";
import { illuminatiPolicyMove, illuminatiPolicySize } from "./illuminati-book.ts";

export type GoPolicyBookOpponent = Exclude<GoRewardOpponent, "????????????">;

/** Storage budgets follow held-out difficulty only. They never change the
 * bounded search widths or depths; lookup happens after every finalist has
 * already received its normal analysis. */
export const GO_POLICY_BOOK_CAPACITY: Readonly<Record<GoPolicyBookOpponent, number>> = {
  Netburners: 4,
  "Slum Snakes": 8,
  "The Black Hand": 12,
  Tetrads: 24,
  Daedalus: 64,
  Illuminati: 164,
};

/** Qualified by the same recurrence/counterfactual filter. Easier opponents
 * keep only a few decisive corrections; harder opponents retain more. */
const NETBURNERS = [["........O...X.........#..",13],["....#....................",13],["..#......................",17],["..#.........XO...........",7]] as const satisfies readonly (readonly [string, number])[];
const SLUM_SNAKES = [["..............#..........",12],[".......X......#...O......",16],[".......X...O..#..XO......",16],[".......X...OOX#..XO......",2],["..#......................",13],[".X.....XO..OO.#..XO......",16],[".X.X.X.XO..OOO#..XO......",15],["#.......X...XO....O......",16]] as const satisfies readonly (readonly [string, number])[];
const BLACK_HAND = [["......................#.#",11],[".......X..#.X...O.O......",17],["......XXO...O.#..........",11],["....#..XO.#..............",12],["..#.....X...OX...OOX.....",23],["..O....X..#XX...O.O......",17],["..X..OXXO...O.#..........",11],["..X..OXXO.XOO.#..........",15],[".XOO...X..#XX...O.O......",4],["#....#.XO.#.X..#..O.#....",13],["#...##....#....#....#....",12],["#...##.XO.#....#....#....",6]] as const satisfies readonly (readonly [string, number])[];
const TETRADS = [["......................#..",11],["..........#.X...O........",11],[".......XO.............#..",12],["......XXO..XO.#.O........",10],["....#.........#.....#....",7],["....#.......X.#..O..#....",11],["....#...X..OX.#..O..#....",7],["....#..OX..O.O#..OX.#.X..",23],["....#..OX..OX.#..OX.#....",13],["..#......................",12],["..#..........X....O......",12],["..#...O.O...XX...........",17],["..#...OXO...X............",17],["..#...OXO..XXO...........",17],["..#...OXX...OXX...OO.....",23],["..#...OXX..OOXX..XOO.....",16],["..#..OOXXO.OOXXOOX...XXXX",1],["..X....XO...O.........#..",6],["..X....XO..XO...O.....#..",15],["..X.#O.OX..OOO#OXOX.#.X..",1],["..XX..OXO...O.........#..",9],["#....#....#....#....#...#",7],["#.#..#....#....#....#...#",17],["#.#..#....#.X..#..O.#...#",13]] as const satisfies readonly (readonly [string, number])[];
const DAEDALUS = [["......................#..",7],["......................#.#",7],["............OXO...X...#.#",11],["............X.....O...#..",13],["............X...O.....#..",11],["...........OXO....X...#..",8],["..........#............#.",12],["..........#.O....X.....#.",16],["..........#.O...XX..#.O..",11],[".........##..............",13],["........O...X.........#..",13],["........O...X....XO...#..",13],["........O...X.#..........",7],["........XO.OOXO...XX..#.#",3],[".......XO.............#..",11],[".......XO.....#..........",6],[".......XO...OX........#..",9],[".......XO..XO.#..........",17],[".......XO..XOX...O....#..",9],["......O.....X...OX....#..",7],["......O.....X.#..........",11],["......O...#XO....X.....#.",7],["......O.O...XX#..........",11],["......O.O...XX#..XO......",7],["......OOO.#XOX..XX.X...#.",9],["......OOX...X...OX....#..",9],["......OXO...X.........#..",2],["......OXO...XX..O.....#..",3],["......XOO...X....XO...#..",5],[".....OO.O.XOXX#.X........",3],["....#...................#",7],["....#.........#..........",12],["....#.......OX........#.#",11],["....#.....#..............",13],["....#.....#.........#....",12],["....#...X...OXO.......#.#",2],["....#..X....O.#..........",17],["...#..................#..",7],["...O..OXOX.OXX..OX....#..",1],["...X...XOO.XOX...O....#..",18],["..#.....O...X............",17],["..#.....X..OX.X.OOX......",19],["..#...X....O.............",7],["..#...X...XO...O.........",12],["..#..OOXX..OX.X.OOX....X.",15],["..#..OOXX..OX.XOOOX..X.X.",1],["..#..XX...XOO..O.........",16],["..#..XXO..XOO..O.X.......",8],["..#..XXOX.XOOO.OXXO......",14],["..O.#..XX...O.#..........",17],["..OX..OOX...X...OX....#..",15],["..XO.OOXOX.OXX..OX....#..",21],[".XO...XOO...X....XO...#..",19],["#....#....#....#....#...#",12],["#....#....#....#....#..#.",13],["#....#....#..X.#..O.#...#",12],["#....#....#.O..#.X..#..#.",16],["#....#....#.OX.#.XO.#...#",11],["#....#.X..#OOX.#.XO.#...#",16],["#....#O...#XO..#.X..#..#.",7],["#....#O.O.#XO..#XX..#..#.",13],["#....#O.O.#XO..#XXOX#..#.",7],["#....#OOO.#XOX.#XX.X#..#.",3],["#...#...................#",7]] as const satisfies readonly (readonly [string, number])[];

const POLICY: Readonly<Record<Exclude<GoPolicyBookOpponent, "Illuminati">, ReadonlyMap<string, number>>> = {
  Netburners: new Map(NETBURNERS),
  "Slum Snakes": new Map(SLUM_SNAKES),
  "The Black Hand": new Map(BLACK_HAND),
  Tetrads: new Map(TETRADS),
  Daedalus: new Map(DAEDALUS),
};

export function goPolicyMove(
  opponent: GoPolicyBookOpponent,
  rows: readonly string[],
): readonly [number, number] | undefined {
  if (opponent === "Illuminati") return illuminatiPolicyMove(rows);
  const encoded = POLICY[opponent].get(rows.join(""));
  return encoded === undefined ? undefined : [Math.floor(encoded / 5), encoded % 5];
}

export function goPolicyEntryCount(opponent: GoPolicyBookOpponent): number {
  return opponent === "Illuminati" ? illuminatiPolicySize : POLICY[opponent].size;
}
