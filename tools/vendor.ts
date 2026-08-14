import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Re-extracts the pure formula core from the pinned game source tag into
 * sim/vendor/bitburner/. Reads git objects directly (`git show tag:path`), so
 * the sparse checkout stays untouched. Patches hard-fail when their find
 * string is absent — that is the drift detector when bumping TAG. */

const TAG = "v3.0.1";
const COMMIT = "3162fd2590e221eadd0c0fbd46151913f7c4c41c";
// Keep machine-specific checkout locations out of the repository. A sibling
// checkout is the zero-config convention on every OS; BITBURNER_SRC remains
// available for layouts that do not follow it.
const SRC_REPO = path.resolve(process.env.BITBURNER_SRC ?? path.join(import.meta.dir, "..", "..", "bitburner-src"));
const OUT_DIR = "sim/vendor/bitburner";

/** Upstream files whose behavior is handwritten in sim/. Their hashes are
 * emitted separately from vendored output hashes so a release bump forces an
 * explicit audit even when these files are not importable in isolation. */
const TRANSCRIPTION_SOURCE_PATHS = [
  "src/engine.tsx",
  "src/Netscript/RamCostGenerator.ts",
  "src/Netscript/NetscriptHelpers.tsx",
  "src/NetscriptFunctions.ts",
  "src/NetscriptWorker.ts",
  "src/Netscript/killWorkerScript.ts",
  "src/Prestige.ts",
  "src/PersonObjects/Person.ts",
  "src/PersonObjects/Player/PlayerObjectGeneralMethods.ts",
  "src/PersonObjects/Player/PlayerObjectServerMethods.ts",
  "src/Server/Server.ts",
  "src/Server/ServerHelpers.ts",
  "src/Server/ServerPurchases.ts",
  "src/NetscriptFunctions/Singularity.ts",
  "src/NetscriptFunctions/Stanek.ts",
  "src/NetscriptFunctions/Hacknet.ts",
  "src/DarkWeb/DarkWebItems.ts",
  "src/Faction/FactionHelpers.tsx",
  "src/Faction/FactionJoinCondition.ts",
  "src/Work/FactionWork.tsx",
  "src/PersonObjects/Grafting/GraftingHelpers.ts",
  "src/CotMG/StaneksGift.ts",
  "src/Company/Company.ts",
  "src/Work/CompanyWork.tsx",
  "src/Work/ClassWork.tsx",
  "src/Work/CrimeWork.ts",
  "src/Work/CreateProgramWork.ts",
  "src/Hacknet/HacknetHelpers.tsx",
  "src/StockMarket/BuyingAndSelling.tsx",
  "src/Gang/Gang.ts",
  "src/Bladeburner/Bladeburner.ts",
  "src/Corporation/Corporation.ts",
  "src/PersonObjects/Sleeve/Sleeve.ts",
] as const;

interface Patch {
  find: string;
  replace: string;
}

interface VendorFile {
  path: string;
  patches?: Patch[];
}

const CONTRACT_IMPLEMENTATIONS = [
  "AlgorithmicStockTrader",
  "ArrayJumpingGame",
  "Compression",
  "Encryption",
  "FindAllValidMathExpressions",
  "FindLargestPrimeFactor",
  "GenerateIPAddresses",
  "HammingCode",
  "LargestRectangle",
  "MergeOverlappingIntervals",
  "MinimumPathSumInATriangle",
  "Proper2ColoringOfAGraph",
  "SanitizeParenthesesInExpression",
  "ShortestPathInAGrid",
  "SpiralizeMatrix",
  "SquareRoot",
  "SubarrayWithMaximumSum",
  "TotalPrimesInRange",
  "TotalWaysToSum",
  "UniquePathsInAGrid",
] as const;

const CONTRACTS_WITH_ENUM_ALIAS: ReadonlySet<string> = new Set(
  CONTRACT_IMPLEMENTATIONS.filter((name) => name !== "Encryption" && name !== "SubarrayWithMaximumSum"),
);

const MANIFEST: VendorFile[] = [
  {
    path: "src/Hacking.ts",
    patches: [
      // DarknetServer's import graph detonates into the whole game UI. Branded
      // Darknet values are refused at the simulator boundary until that
      // subsystem is modeled, so this removed special case cannot run silently.
      { find: `import { DarknetServer } from "./Server/DarknetServer";\n`, replace: "" },
      { find: `  if (server instanceof DarknetServer) return 16;\n`, replace: "" },
    ],
  },
  {
    path: "src/Server/formulas/grow.ts",
    patches: [
      // ServerHelpers pulls in the game; getCoreBonus is one line.
      {
        find: `import { getCoreBonus } from "../ServerHelpers";`,
        replace: `const getCoreBonus = (cores = 1): number => 1 + (cores - 1) / 16;`,
      },
    ],
  },
  { path: "src/PersonObjects/formulas/skill.ts" },
  { path: "src/PersonObjects/formulas/intelligence.ts" },
  { path: "src/PersonObjects/Multipliers.ts" },
  // --- Stanek's Gift -------------------------------------------------------
  // The data, geometry and effect formula are import-light upstream, so keep
  // them verbatim instead of proving a second hand transcription against
  // itself. StaneksGift.ts is deliberately excluded: its class methods reach
  // through Player/Factions/Augmentations/events/save revivers and are glued
  // to simulator-owned state in sim/features/stanek.ts.
  { path: "src/CotMG/data/Constants.ts" },
  { path: "src/CotMG/formulas/effect.ts" },
  { path: "src/CotMG/FragmentType.ts" },
  { path: "src/CotMG/data/Shapes.ts" },
  { path: "src/CotMG/Fragment.ts" },
  { path: "src/CotMG/BaseGift.ts" },
  {
    path: "src/CotMG/ActiveFragment.ts",
    patches: [
      // Save serialization only; the simulator owns its in-memory gift state.
      {
        find: `import { Generic_fromJSON, Generic_toJSON, IReviverValue, constructorsForReviver } from "../utils/JSONReviver";\n`,
        replace: "",
      },
      {
        find: [
          `  /** Serialize an active fragment to a JSON save state. */`,
          `  toJSON(): IReviverValue {`,
          `    return Generic_toJSON("ActiveFragment", this);`,
          `  }`,
          ``,
          `  /** Initializes an active fragment from a JSON save state */`,
          `  static fromJSON(value: IReviverValue): ActiveFragment {`,
          `    return Generic_fromJSON(ActiveFragment, value.data);`,
          `  }`,
          `}`,
          ``,
          `constructorsForReviver.ActiveFragment = ActiveFragment;`,
        ].join("\n"),
        replace: `}`,
      },
    ],
  },
  // --- Network share -------------------------------------------------------
  {
    path: "src/NetworkShare/Share.ts",
    patches: [
      // @player is a process-global singleton upstream. The sim supplies the
      // live intelligence immediately before each contribution starts.
      {
        find: `import { Player } from "@player";`,
        replace: [
          `const Player = { skills: { intelligence: 0 } };`,
          `export function setShareContext(ctx: { intelligence: number }): void {`,
          `  Player.skills.intelligence = ctx.intelligence;`,
          `}`,
        ].join("\n"),
      },
      // ServerHelpers pulls in the game; this exact one-line formula is the
      // same portability patch already used by the vendored grow formula.
      {
        find: `import { getCoreBonus } from "../Server/ServerHelpers";`,
        replace: `export const getCoreBonus = (cores = 1): number => 1 + (cores - 1) / 16;`,
      },
      // A Bun process can execute several unit simulations. Without this reset
      // the upstream module-level accumulator would leak between them.
      {
        find: `let shareThreads = 1;`,
        replace: [
          `let shareThreads = 1;`,
          `export function resetShareThreads(): void { shareThreads = 1; }`,
        ].join("\n"),
      },
    ],
  },
  {
    path: "src/SourceFile/applySourceFile.ts",
    patches: [
      {
        find: `import { SourceFiles } from "./SourceFiles";`,
        replace: `const SourceFiles: Record<string, true> = Object.fromEntries(Array.from({ length: 15 }, (_, i) => ["SourceFile" + (i + 1), true]));`,
      },
      {
        find: `import { Player } from "@player";`,
        replace: `import { Player } from "./SourceFileAdapter";`,
      },
    ],
  },
  { path: "src/Hacknet/formulas/HacknetNodes.ts" },
  { path: "src/Hacknet/formulas/HacknetServers.ts" },
  {
    path: "src/BitNode/BitNodeMultipliers.ts",
    patches: [
      // Mixed type/value import fails our verbatimModuleSyntax typecheck.
      {
        find: `import { PartialRecord, getRecordEntries } from "../Types/Record";`,
        replace: `import { getRecordEntries, type PartialRecord } from "../Types/Record";`,
      },
    ],
  },
  { path: "src/Constants.ts" },
  { path: "src/Exploits/Exploit.ts" },
  { path: "src/Casino/RNG.ts" },
  { path: "src/Go/Enums.ts" },
  {
    path: "src/Go/Types.ts",
    patches: [{ find: `from "@enums";`, replace: `from "./Enums";` }],
  },
  {
    path: "src/Go/Constants.ts",
    patches: [{ find: `from "@enums";`, replace: `from "./Enums";` }],
  },
  {
    path: "src/Go/boardAnalysis/boardAnalysis.ts",
    patches: [
      { find: `from "@enums";`, replace: `from "../Enums";` },
      { find: `from "../Go";`, replace: `from "../OracleStubs";` },
      {
        find: `board.highlightedPoints = getEmptyHighlightedPoints(Go.currentGame.board.length);`,
        replace: `board.highlightedPoints = getEmptyHighlightedPoints(board.board.length);`,
      },
    ],
  },
  {
    path: "src/Go/boardState/boardState.ts",
    patches: [
      {
        find: `import { Board, BoardState, Move, Neighbor, PointState, SimpleBoard } from "../Types";`,
        replace: `import type { Board, BoardState, Move, Neighbor, PointState, SimpleBoard } from "../Types";`,
      },
      { find: `from "@enums";`, replace: `from "../Enums";` },
      { find: `from "../boardAnalysis/scoring";`, replace: `from "../OracleStubs";` },
    ],
  },
  {
    path: "src/Go/boardState/offlineNodes.ts",
    patches: [
      { find: `import { Player } from "@player";`, replace: `import { Player } from "../OracleStubs";` },
      { find: `from "@enums";`, replace: `from "../Enums";` },
    ],
  },
  {
    path: "src/Go/boardAnalysis/controlledTerritory.ts",
    patches: [{ find: `from "@enums";`, replace: `from "../Enums";` }],
  },
  {
    path: "src/Go/boardAnalysis/patternMatching.ts",
    patches: [
      { find: `from "@enums";`, replace: `from "../Enums";` },
      { find: `from "../../utils/Utility";`, replace: `from "../OracleStubs";` },
    ],
  },
  {
    path: "src/Go/boardAnalysis/goAI.ts",
    patches: [
      { find: `import { Player } from "@player";`, replace: `import { Player } from "../OracleStubs";` },
      {
        find: `import { AugmentationName, GoColor, GoOpponent, GoPlayType } from "@enums";`,
        replace: `import { GoColor, GoOpponent, GoPlayType } from "../Enums";\nimport { AugmentationName } from "../OracleStubs";`,
      },
      { find: `from "../Go";`, replace: `from "../OracleStubs";` },
      { find: `from "../../utils/helpers/exceptionAlert";`, replace: `from "../OracleStubs";` },
      { find: `from "../../utils/Utility";`, replace: `from "../OracleStubs";` },
    ],
  },
  { path: "src/Server/data/Constants.ts" },
  // --- the stock market ------------------------------------------------------
  //
  // The market is the one subsystem whose MECHANICS (not just its formulas) we
  // need verbatim: the second-order forecast is what hack/grow manipulate, and
  // a transcription of `cycleForecast` that got the direction of
  // `getForecastIncreaseChance` backwards would make the whole strategy look
  // profitable in the sim and lose money in the game. So the Stock class, the
  // per-symbol metadata and the transaction helpers all vendor, and only the
  // three things that reach for live singletons are injected (see MarketAdapter).
  {
    path: "src/StockMarket/Enums.ts",
    patches: [{ find: `from "@enums";`, replace: `from "../Locations/Enums";` }],
  },
  { path: "src/StockMarket/data/Constants.ts" },
  {
    path: "src/StockMarket/Stock.ts",
    patches: [
      // ../types is 200 lines of unrelated numeric brands for one interface.
      {
        find: `import { IMinMaxRange } from "../types";`,
        replace: [
          `export interface IMinMaxRange {`,
          `  /** Value by which the bounds are to be divided for the final range */`,
          `  divisor?: number;`,
          `  /** The maximum bound of the range. */`,
          `  max: number;`,
          `  /** The minimum bound of the range. */`,
          `  min: number;`,
          `}`,
        ].join("\n"),
      },
      // Save serialization only; the simulator never round-trips a Stock.
      {
        find: `import { Generic_fromJSON, Generic_toJSON, IReviverValue, constructorsForReviver } from "../utils/JSONReviver";\n`,
        replace: "",
      },
      {
        find: [
          `  /** Serialize the Stock to a JSON save state. */`,
          `  toJSON(): IReviverValue {`,
          `    return Generic_toJSON("Stock", this);`,
          `  }`,
          ``,
          `  /** Initializes a Stock from a JSON save state */`,
          `  static fromJSON(value: IReviverValue): Stock {`,
          `    return Generic_fromJSON(Stock, value.data);`,
          `  }`,
          `}`,
          ``,
          `constructorsForReviver.Stock = Stock;`,
        ].join("\n"),
        replace: `}`,
      },
      // Seeded randomness: a market that rolls the global Math.random cannot be
      // A/B tested, which is the entire point of running it in the simulator.
      {
        find: `import { getRandomIntInclusive } from "../utils/helpers/getRandomIntInclusive";`,
        replace: `import { getRandomIntInclusive, stockRandom } from "./MarketAdapter";`,
      },
      { find: `    if (Math.random() < increaseChance) {`, replace: `    if (stockRandom() < increaseChance) {` },
      { find: `    if (Math.random() < 0.5) {`, replace: `    if (stockRandom() < 0.5) {` },
    ],
  },
  {
    path: "src/StockMarket/StockMarketHelpers.ts",
    patches: [{ find: `import { PositionType } from "@enums";`, replace: `import { PositionType } from "./Enums";` }],
  },
  // The BitNode-multiplied unlock prices. Import-free apart from the vendored
  // multipliers, and the reason `shared/strategy/stock/market.ts#unlockCosts`
  // has a parity test: BN9 charges 5x for the data and 4x for the API, which is
  // the difference between "buy the forecast" and "never afford it".
  { path: "src/StockMarket/StockMarketCosts.ts" },
  {
    path: "src/StockMarket/data/InitStockMetadata.ts",
    patches: [
      {
        find: `import { LocationName, StockSymbol } from "@enums";`,
        replace: [
          `import { LocationName } from "../../Locations/Enums";`,
          `import { StockSymbol } from "../Enums";`,
        ].join("\n"),
      },
      { find: `import { IConstructorParams } from "../Stock";`, replace: `import type { IConstructorParams } from "../Stock";` },
    ],
  },
  // Enums and data constants: import-free upstream, so they vendor verbatim.
  // These are also the SCOPE for extractDataTable below — the faction table is
  // keyed by FactionName and references the others, so having one source of
  // truth for them is what keeps the extracted table honest.
  { path: "src/Faction/Enums.ts" },
  { path: "src/Company/Enums.ts" },
  { path: "src/Locations/Enums.ts" },
  { path: "src/Work/Enums.ts" },
  { path: "src/Literature/Enums.ts" },
  { path: "src/Message/Enums.ts" },
  { path: "src/Augmentation/Enums.ts" },
  { path: "src/Programs/Enums.ts" },
  { path: "src/Crime/Enums.ts" },
  { path: "src/Server/data/SpecialServers.ts" },
  { path: "src/Bladeburner/data/Constants.ts" },
  { path: "src/Faction/formulas/favor.ts" },
  { path: "src/Hacknet/data/Constants.ts" },
  { path: "src/Types/Record.ts" },
  { path: "src/utils/helpers/clampNumber.ts" },
  { path: "src/utils/helpers/isValidNumber.ts" },
  { path: "src/utils/helpers/isPowerOfTwo.ts" },
  { path: "src/utils/helpers/getRandomIntInclusive.ts" },
  { path: "src/utils/helpers/randomBigIntExclusive.ts" },
  { path: "src/CodingContract/Enums.ts" },
  {
    path: "src/CodingContract/ContractTypes.ts",
    patches: [{ find: `from "@enums";`, replace: `from "./Enums";` }],
  },
  ...CONTRACT_IMPLEMENTATIONS.map((name): VendorFile => ({
    path: `src/CodingContract/contracts/${name}.ts`,
    ...(CONTRACTS_WITH_ENUM_ALIAS.has(name)
      ? { patches: [{ find: `from "@enums";`, replace: `from "../Enums";` }] }
      : {}),
  })),
];

function gitShow(objectPath: string): string {
  return execFileSync("git", ["-C", SRC_REPO, "show", `${COMMIT}:${objectPath}`], { encoding: "utf8" });
}

function gitRevParse(revision: string): string {
  return execFileSync("git", ["-C", SRC_REPO, "rev-parse", revision], { encoding: "utf8" }).trim();
}

/** Refuse a moving tag or a checkout on another revision before it can become
 * the evidence base for a vendor refresh.
 * Source: https://github.com/bitburner-official/bitburner-src/releases/tag/v3.0.1 */
function assertPinnedCheckout(): void {
  const taggedCommit = gitRevParse(`${TAG}^{commit}`);
  if (taggedCommit !== COMMIT) {
    throw new Error(`${TAG} resolves to ${taggedCommit}, expected pinned commit ${COMMIT}`);
  }
  const head = gitRevParse("HEAD");
  if (head !== COMMIT) {
    throw new Error(
      `bitburner-src checkout is at ${head}, expected ${TAG} (${COMMIT}); ` +
        `check out the pinned release before inspecting or vendoring it`,
    );
  }
}

function vendorStatusDirty(): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", OUT_DIR], { encoding: "utf8" }).trim() !== "";
  } catch {
    return false;
  }
}

assertPinnedCheckout();

if (vendorStatusDirty() && !process.argv.includes("--force")) {
  throw new Error(`${OUT_DIR} has uncommitted changes; commit or discard them (or pass --force)`);
}

const written: { path: string; output: string; sha256: string }[] = [];
for (const file of MANIFEST) {
  let content = gitShow(file.path);
  for (const patch of file.patches ?? []) {
    if (!content.includes(patch.find)) {
      throw new Error(`${file.path}: patch target not found (source drifted?):\n${patch.find}`);
    }
    content = content.replace(patch.find, patch.replace);
  }
  // @nsdefs exports only types; make that explicit so the import erases at
  // runtime (Bun would otherwise try to load the .d.ts as a module).
  content = content.replace(/^import \{([^}]*)\} from "@nsdefs";$/gm, `import type {$1} from "@nsdefs";`);
  if (file.path.startsWith("src/CodingContract/contracts/")) {
    // Upstream's compiler permits value-style imports for this type. Our
    // verbatimModuleSyntax build deliberately does not.
    content = content.replace(
      /^import \{([^}]*)\} from "\.\.\/ContractTypes";$/gm,
      (line, members: string) => line.replace(members, members.replace(/(?<!type )\bCodingContractTypes\b/, "type CodingContractTypes")),
    );
  }

  const outPath = path.join(OUT_DIR, file.path);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const header = `// Vendored from bitburner-src ${TAG}:${file.path} by tools/vendor.ts — DO NOT EDIT\n`;
  writeFileSync(outPath, header + content, "utf8");
  written.push({ path: file.path, output: file.path, sha256: createHash("sha256").update(header + content).digest("hex") });
  console.log(`vendored ${file.path}`);
}

const sourceFileAdapter = `// Portability adapter generated by tools/vendor.ts - DO NOT EDIT
import type { Multipliers } from "../PersonObjects/Multipliers";

export const Player = { mults: undefined as unknown as Multipliers };
export function setSourceFileMultipliers(mults: Multipliers): void { Player.mults = mults; }
`;
const sourceFileAdapterPath = "src/SourceFile/SourceFileAdapter.ts";
const sourceFileAdapterOut = path.join(OUT_DIR, sourceFileAdapterPath);
mkdirSync(path.dirname(sourceFileAdapterOut), { recursive: true });
writeFileSync(sourceFileAdapterOut, sourceFileAdapter, "utf8");
written.push({
  path: sourceFileAdapterPath,
  output: sourceFileAdapterPath,
  sha256: createHash("sha256").update(sourceFileAdapter).digest("hex"),
});

// Minimal adapters for branches outside the board-rules oracle. They keep the
// source importable in tests without dragging Player, React, AI timing, or the
// live singleton into the simulator. Parity tests never call these branches.
const goOracleStubs = `// Test-only portability adapters generated by tools/vendor.ts — DO NOT EDIT
import type { Board, BoardState, Move, PointState } from "./Types";

export const Go = { currentGame: undefined as unknown as BoardState, storedCycles: 0 };
export const GoEvents = { emit(): void {} };
export const Player = {
  totalPlaytime: 1,
  hasAugmentation: (_name: unknown, _includeQueued?: boolean): boolean => false,
  activeSourceFileLvl: (_node: number): number => 0,
};
export const AugmentationName = { TheRedPill: "The Red Pill" } as const;
export const sleepLog: number[] = [];
export const sleep = async (milliseconds: number): Promise<void> => { sleepLog.push(milliseconds); };
export function exceptionAlert(error: unknown, _caught?: boolean): never { throw error; }
export const getEmptyHighlightedPoints = (size = 7): null[][] =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => null));
export const getExpansionMoveArray = (_board: Board, _spaces: PointState[]): Move[] => [];
export function endGoGame(state: BoardState): void { state.previousPlayer = null; }
export function addObstacles(_state: BoardState): void {}
export function resetCoordinates(board: Board): Board { return board; }
export function rotate90Degrees(board: Board): Board { return board; }
`;
const goOracleStubPath = "src/Go/OracleStubs.ts";
const goOracleStubOut = path.join(OUT_DIR, goOracleStubPath);
mkdirSync(path.dirname(goOracleStubOut), { recursive: true });
writeFileSync(goOracleStubOut, goOracleStubs, "utf8");
written.push({ path: goOracleStubPath, output: goOracleStubPath, sha256: createHash("sha256").update(goOracleStubs).digest("hex") });

// Contract validators call this only for impossible internal states. Keep
// those failures loud without pulling React, Player, or the live UI into sim.
const contractExceptionStub = `// Test-only portability adapter generated by tools/vendor.ts — DO NOT EDIT
export function exceptionAlert(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}
`;
const contractExceptionPath = "src/utils/helpers/exceptionAlert.ts";
const contractExceptionOut = path.join(OUT_DIR, contractExceptionPath);
mkdirSync(path.dirname(contractExceptionOut), { recursive: true });
writeFileSync(contractExceptionOut, contractExceptionStub, "utf8");
written.push({
  path: contractExceptionPath,
  output: contractExceptionPath,
  sha256: createHash("sha256").update(contractExceptionStub).digest("hex"),
});

/** The market's three live-singleton dependencies, made explicit.
 *
 * Upstream `StockMarket.ts` owns a module-level singleton, reads the wall
 * clock, and rolls the global Math.random. All three are hostile to a
 * simulator: one market per process, no virtual time, no reproducible seeds.
 * They are the ONLY substitutions — every price, forecast and cost still comes
 * from the vendored source.
 *
 * `getRandomIntInclusive` is re-implemented over the injected stream on purpose:
 * upstream's version calls Math.random, and it is what rolls a Stock's price
 * cap, spread and volatility in the constructor. Left global, two runs with the
 * same seed would face different markets. */
const marketAdapter = `// Portability adapters generated by tools/vendor.ts — DO NOT EDIT
import type { Stock } from "./Stock";

export interface IOrderBook {
  [key: string]: unknown[];
}

export type IStockMarket = Record<string, Stock> & {
  lastUpdate: number;
  Orders: IOrderBook;
  storedCycles: number;
  ticksUntilCycle: number;
};

/** Upstream: \`export let StockMarket\` in StockMarket.ts. Mutated in place by
 *  initStockMarket, never reassigned by anything we vendor. */
export const StockMarket: IStockMarket = {
  lastUpdate: 0,
  Orders: {},
  storedCycles: 0,
  ticksUntilCycle: 0,
} as IStockMarket;

export const SymbolToStockMap: Record<string, Stock> = {};

export const StockMarketPromise: { promise: Promise<number> | null; resolve: ((value: number) => void) | null } = {
  promise: null,
  resolve: null,
};

/** Limit/stop orders (BN8.3) are not modelled: nothing in shared/strategy
 *  places one, so a no-op is the truth rather than an approximation. Wire this
 *  to a real order book the day the solver learns to place orders. */
export function processOrders(
  _stock: Stock,
  _orderType: unknown,
  _posType: unknown,
  _refs: { stockMarket: IStockMarket; symbolToStockMap: Record<string, Stock> },
): void {}

let random: () => number = Math.random;
let now: () => number = () => Date.now();

export function setMarketContext(ctx: { random?: () => number; now?: () => number }): void {
  if (ctx.random) random = ctx.random;
  if (ctx.now) now = ctx.now;
}

export function stockRandom(): number {
  return random();
}

export function stockNow(): number {
  return now();
}

/** Upstream src/utils/helpers/getRandomIntInclusive.ts, over the seeded stream. */
export function getRandomIntInclusive(min: number, max: number): number {
  if (!Number.isInteger(min)) throw new Error(\`Min is not an integer. Min: \${min}.\`);
  if (!Number.isInteger(max)) throw new Error(\`Max is not an integer. Max: \${max}.\`);
  if (min > max) throw new Error(\`Min is greater than max. Min: \${min}. Max: \${max}.\`);
  return Math.floor(random() * (max - min + 1) + min);
}

/** BN15's darknet can raise a symbol's volatility (src/DarkNet/effects/effects.ts),
 *  decaying by 0.4x at every market cycle. \`dnet\` has no simulation model, so the
 *  neutral 1x is the truth for every run we can currently produce — NOT an
 *  approximation of a modelled effect. Wire these to the darknet system the day
 *  it lands, and the price engine picks it up with no further change. */
export function getDarknetVolatilityMult(_symbol: string): number {
  return 1;
}

export function scaleDarknetVolatilityIncreases(_scalar: number): void {}
`;
const marketAdapterPath = "src/StockMarket/MarketAdapter.ts";
const marketAdapterOut = path.join(OUT_DIR, marketAdapterPath);
mkdirSync(path.dirname(marketAdapterOut), { recursive: true });
writeFileSync(marketAdapterOut, marketAdapter, "utf8");
written.push({ path: marketAdapterPath, output: marketAdapterPath, sha256: createHash("sha256").update(marketAdapter).digest("hex") });

/** Is this line a complete declaration on its own? A one-line
 * `export const MaxFavor = 35331;` has no column-zero closer to look for. */
function selfContained(line: string): boolean {
  let depth = 0;
  for (const char of line) {
    if (char === "{" || char === "[" || char === "(") depth++;
    else if (char === "}" || char === "]" || char === ")") depth--;
  }
  return depth === 0 && /[;}]\s*$/.test(line);
}

/** Slice one top-level declaration out of a source file whose other contents
 * are not portable (react/@player imports).
 *
 * Terminates at the first COLUMN-ZERO `}`, `};` or `} as const;` — column zero
 * being the whole trick, since any nested closer is indented. A declaration
 * that fits on one line is taken as-is. */
function sliceSymbol(lines: string[], name: string, sourcePath: string): string {
  const declaration = new RegExp(`^(export )?(async )?(function|const|class|interface|type) ${name}\\b`);
  const start = lines.findIndex((line) => declaration.test(line));
  if (start === -1) throw new Error(`${sourcePath}: ${name} not found (source drifted?)`);
  if (selfContained(lines[start]!)) return lines[start]!;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "}" || line === "};" || line === "} as const;") return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`${sourcePath}: ${name} has no column-zero terminator (source drifted?)`);
}

/** Slice one or more named declarations out of a file. */
function extractSymbols(
  sourcePath: string,
  names: string[],
  prologue: string[],
  outRelPath: string,
  patches: Patch[] = [],
): void {
  const lines = gitShow(sourcePath).split("\n");
  let body = names.map((name) => sliceSymbol(lines, name, sourcePath)).join("\n\n");
  for (const patch of patches) {
    if (!body.includes(patch.find)) {
      throw new Error(`${sourcePath}#${names.join(",")}: patch target not found:\n${patch.find}`);
    }
    body = body.replace(patch.find, patch.replace);
  }
  const label = names.length === 1 ? `${names[0]} only` : `${names.length} symbols`;
  const synthesized = [
    `// Vendored from bitburner-src ${TAG}:${sourcePath} (${label}, extracted by`,
    `// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT`,
    ...prologue,
    ``,
    body,
    ``,
  ].join("\n");
  const outPath = path.join(OUT_DIR, outRelPath);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, synthesized, "utf8");
  written.push({
    path: `${sourcePath}#${names.join(",")}`,
    output: outRelPath,
    sha256: createHash("sha256").update(synthesized).digest("hex"),
  });
  console.log(`vendored ${sourcePath}#${names.join(",")} -> ${outRelPath}`);
}

/** Back-compat wrapper for the two original single-name call sites. */
function extractFunction(sourcePath: string, name: string, prologue: string[], outRelPath: string, patches: Patch[] = []): void {
  extractSymbols(sourcePath, [name], prologue, outRelPath, patches);
}

// Pure BitNodeMultipliers literals; the rest of BitNode.tsx imports react/@player.
extractFunction(
  "src/BitNode/BitNode.tsx",
  "getBitNodeMultipliers",
  [
    `import { BitNodeMultipliers } from "./BitNodeMultipliers";`,
    ``,
    `const defaultMultipliers = new BitNodeMultipliers();`,
    `Object.freeze(defaultMultipliers);`,
  ],
  "src/BitNode/BitNodeMults.ts",
);

// UCM's hourly roll. The work/prestige model needs the exact active
// multiplier bag, but none of the surrounding augmentation registry/UI.
extractFunction(
  "src/Augmentation/CircadianModulator.ts",
  "getRandomBonus",
  [
    `import type { Multipliers } from "../PersonObjects/Multipliers";`,
    `import { WHRNG } from "../Casino/RNG";`,
    `interface CircadianBonus { bonuses: Partial<Multipliers>; description: string; }`,
  ],
  "src/Augmentation/CircadianBonus.ts",
  [{ find: `function getRandomBonus(): CircadianBonus {`, replace: `export function getRandomBonus(): CircadianBonus {` }],
);

// The Newton-Raphson grow-thread inverse: precision-tuned, worth vendoring
// verbatim. Only patch: drop the `= Player` default so callers pass a person.
extractFunction(
  "src/Server/ServerHelpers.ts",
  "numCycleForGrowthCorrected",
  [
    `import type { Person as IPerson, Server as IServer } from "@nsdefs";`,
    `import { calculateServerGrowthLog } from "./formulas/grow";`,
  ],
  "src/Server/GrowthCycles.ts",
  [{ find: `person: IPerson = Player,`, replace: `person: IPerson,` }],
);

extractFunction(
  "src/Go/boardAnalysis/goAI.ts",
  "getKomi",
  [
    `import type { BoardState } from "../Types";`,
    `import { opponentDetails } from "../Constants";`,
  ],
  "src/Go/boardAnalysis/KomiOracle.ts",
);

// Exact score/territory oracle. Runtime strategy does not import this: tests
// compare the handcrafted engine with these verbatim functions from the pin.
extractSymbols(
  "src/Go/boardAnalysis/scoring.ts",
  ["getScore", "getColoredPieceCount", "getTerritoryScores", "checkTerritoryOwnership"],
  [
    `import type { Board, BoardState, PointState } from "../Types";`,
    `import { GoColor } from "../Enums";`,
    `import { getKomi } from "./KomiOracle";`,
    `import { getAllChains, getPlayerNeighbors } from "./boardAnalysis";`,
    `import { isNotNullish } from "../boardState/boardState";`,
  ],
  "src/Go/boardAnalysis/ScoringOracle.ts",
);

// Exact reward curve and streak/difficulty rules. Production keeps a
// handcrafted parameterized version; tests compare it with this v3.0.1 slice.
extractSymbols(
  "src/Go/effects/effect.ts",
  ["CalculateEffect", "getMaxRep", "getWinstreakMultiplier", "getDifficultyMultiplier", "getEffectPowerForFaction"],
  [
    `import { GoOpponent } from "../Enums";`,
    `import { opponentDetails } from "../Constants";`,
    `export const EffectOracleState = { sourceFile14Level: 0, goPower: 1 };`,
    `const Player = { activeSourceFileLvl: (node: number): number => node === 14 ? EffectOracleState.sourceFile14Level : 0 };`,
    `const currentNodeMults = { get GoPower(): number { return EffectOracleState.goPower; } };`,
  ],
  "src/Go/effects/EffectOracle.ts",
);

/** One slice of source feeding a data table. */
interface TableSource {
  path: string;
  /** Exact first line of the slice. Missing => throw (the drift detector). */
  from: string;
  /** Exact last line of the slice. */
  to: string;
  patches?: Patch[];
}

interface DataTableSpec {
  sources: TableSource[];
  /** Free identifiers the sliced code may use. ANY identifier not in here is a
   *  ReferenceError at evaluation time — which is exactly the drift detector
   *  for a new upstream dependency. */
  scope: Record<string, unknown>;
  /** Expression returning the plain-JSON table, evaluated after the sources. */
  shape: string;
  /** Sanity-check the extracted table. Throwing here fails the vendor run. */
  verify(table: unknown): void;
  outRelPath: string;
  /** Lines emitted above the data (imports, the exported type). */
  prologue: string[];
  /** `export const <name>: <type> = <json>;` */
  exportName: string;
  exportType: string;
}

/** Extract a data table buried in an unportable file by TRANSPILING AND
 * EVALUATING it, rather than parsing it.
 *
 * Parsing is not an option here and it is worth being explicit about why: the
 * faction table is JSX prose full of apostrophes, quotes and typographic
 * characters, so any regex that tried to find the end of an entry would be
 * wrong on the first faction whose blurb contains a brace. Evaluating the real
 * code is the only way to get the real values — including the structured
 * condition tree, where upstream's own `everyCondition` iterator flattens
 * nested ANDs but not ANDs nested inside an OR.
 *
 * JSX is mapped to inert stubs: we want the data, not the prose. */
async function extractDataTable(spec: DataTableSpec): Promise<void> {
  const chunks: string[] = [];
  for (const source of spec.sources) {
    const text = gitShow(source.path);
    const lines = text.split("\n");
    const start = lines.indexOf(source.from);
    if (start === -1) throw new Error(`${source.path}: anchor not found (source drifted?):\n${source.from}`);
    // LAST occurrence: a closing anchor is usually a bare `}`, and the first
    // one after the opening anchor would end the slice at the first nested
    // block instead of the intended one.
    const end = lines.lastIndexOf(source.to);
    if (end <= start) throw new Error(`${source.path}: end anchor not found after start (source drifted?):\n${source.to}`);
    let slice = lines.slice(start, end + 1).join("\n");
    for (const patch of source.patches ?? []) {
      if (!slice.includes(patch.find)) {
        throw new Error(`${source.path}: patch target not found (source drifted?):\n${patch.find}`);
      }
      slice = slice.replaceAll(patch.find, patch.replace);
    }
    chunks.push(slice);
  }

  // `import`/`export` cannot appear inside a Function body; the scope supplies
  // what the imports would have.
  const stripped = stripImports(chunks.join("\n\n"));
  const transpiler = new Bun.Transpiler({
    loader: "tsx",
    tsconfig: JSON.stringify({
      compilerOptions: { jsx: "react", jsxFactory: "__jsx", jsxFragmentFactory: "__jsxFrag" },
    }),
  });
  const js = transpiler.transformSync(stripped.replace(/^export /gm, ""));

  const scope: Record<string, unknown> = {
    // JSX is prose; we want the data. Inert stubs keep the elements evaluable.
    __jsx: () => null,
    __jsxFrag: () => null,
    ...spec.scope,
  };
  const evaluate = new Function(...Object.keys(scope), `${js}\nreturn (${spec.shape});`);
  const table: unknown = evaluate(...Object.values(scope));
  spec.verify(table);

  const synthesized = [
    `// Vendored from bitburner-src ${TAG} by tools/vendor.ts (extractDataTable:`,
    `// ${spec.sources.map((s) => s.path).join(", ")}) — DO NOT EDIT`,
    ...spec.prologue,
    ``,
    `export const ${spec.exportName}: ${spec.exportType} = ${serialize(table)};`,
    ``,
  ].join("\n");
  const outPath = path.join(OUT_DIR, spec.outRelPath);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, synthesized, "utf8");
  written.push({
    path: `${spec.sources.map((s) => s.path).join("+")}#${spec.exportName}`,
    output: spec.outRelPath,
    sha256: createHash("sha256").update(synthesized).digest("hex"),
  });
  console.log(`vendored data table ${spec.exportName} -> ${spec.outRelPath}`);
}

/** Serialize a table as a TypeScript literal, preserving non-finite numbers.
 *
 * `JSON.stringify(Infinity)` is `null`, and the game genuinely uses Infinity —
 * an unpurchasable special augmentation costs `Infinity`, which is meaningfully
 * different from `null` (a missing price) and from `0` (free). Emitting a
 * source file rather than JSON means we can just write `Infinity`. */
function serialize(value: unknown): string {
  const MARKER = "@@nonfinite@@";
  const json = JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? `${MARKER}${String(v)}` : v),
    2,
  );
  const out = json.replaceAll(new RegExp(`"${MARKER}(-?Infinity|NaN)"`, "g"), "$1");
  if (out.includes(MARKER)) throw new Error("non-finite marker survived serialization");
  return out;
}

/** Drop `import ...` statements (single- and multi-line). The scope replaces
 * them, so a missing entry surfaces as a ReferenceError naming the symbol. */
function stripImports(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let inImport = false;
  for (const line of lines) {
    if (inImport) {
      if (/^\s*}\s*from\s+".*";?\s*$/.test(line) || /;\s*$/.test(line)) inImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      // Single-line import ends on the same line.
      if (!/;\s*$/.test(line)) inImport = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Donation math only. The mutating `donate` and the `canDonate` guard both
// reach for the live @player singleton; the sim owns that side itself.
extractSymbols(
  "src/Faction/formulas/donation.ts",
  ["repFromDonation", "donationForRep", "favorNeededToDonate"],
  [
    `import type { Person as IPerson } from "@nsdefs";`,
    `import { CONSTANTS } from "../../Constants";`,
    `import { currentNodeMults } from "../../BitNode/BitNodeMultipliers";`,
  ],
  "src/Faction/formulas/Donation.ts",
);

// Reputation rates per work type. Two upstream dependencies reach for live
// singletons and are turned into explicit injections rather than stubbed out:
// the share bonus (NetworkShare) and SF15 level (@player), both of which
// genuinely change the rate and would be silently wrong at 1x / 0.
extractSymbols(
  "src/PersonObjects/formulas/reputation.ts",
  ["mult", "getHackingWorkRepGain", "getFactionSecurityWorkRepGain", "getFactionFieldWorkRepGain", "getDarknetCharismaBonus"],
  [
    `import type { Person as IPerson } from "@nsdefs";`,
    `import { CONSTANTS } from "../../Constants";`,
    `import { currentNodeMults } from "../../BitNode/BitNodeMultipliers";`,
    `import { calculateIntelligenceBonus } from "./intelligence";`,
    ``,
    `/** Injected: upstream reads these from live singletons (NetworkShare and`,
    ` *  @player). They are real inputs to the rate, so they are parameters here`,
    ` *  rather than constants — a hardcoded 1x share bonus would quietly`,
    ` *  understate every rep rate on a sharing fleet. */`,
    `let shareBonus = 1;`,
    `let sf15Level = 0;`,
    `export function setReputationContext(ctx: { shareBonus?: number; sf15Level?: number }): void {`,
    `  if (ctx.shareBonus !== undefined) shareBonus = ctx.shareBonus;`,
    `  if (ctx.sf15Level !== undefined) sf15Level = ctx.sf15Level;`,
    `}`,
    `const calculateCurrentShareBonus = (): number => shareBonus;`,
  ],
  "src/PersonObjects/formulas/Reputation.ts",
  [{ find: `Player.activeSourceFileLvl(15)`, replace: `sf15Level` }],
);

// The market's tick loop. StockMarket.ts as a whole imports the netscript
// helpers and the React dialog box, but these five declarations are the entire
// price/forecast engine: the 6 s tick, the shared volatility roll `v`, the
// 75-tick cycle that flips 45% of symbols, and the world generator that rolls
// each symbol's cap, spread and volatility.
extractSymbols(
  "src/StockMarket/StockMarket.ts",
  ["initStockMarket", "initSymbolToStockMap", "stockMarketCycle", "cyclesPerStockUpdate", "processStockPrices"],
  [
    `import { CONSTANTS } from "../Constants";`,
    `import { StockMarketConstants } from "./data/Constants";`,
    `import { InitStockMetadata } from "./data/InitStockMetadata";`,
    `import { OrderType, PositionType, StockSymbol } from "./Enums";`,
    `import { Stock } from "./Stock";`,
    `import {`,
    `  getDarknetVolatilityMult,`,
    `  getRandomIntInclusive,`,
    `  processOrders,`,
    `  scaleDarknetVolatilityIncreases,`,
    `  StockMarket,`,
    `  StockMarketPromise,`,
    `  stockNow,`,
    `  stockRandom,`,
    `  SymbolToStockMap,`,
    `  type IOrderBook,`,
    `} from "./MarketAdapter";`,
  ],
  "src/StockMarket/StockPrices.ts",
  [
    // The injected reads. Each `find` carries enough context to be unique.
    { find: `    const roll = Math.random();`, replace: `    const roll = stockRandom();` },
    { find: `  const timeNow = new Date().getTime();`, replace: `  const timeNow = stockNow();` },
    { find: `  StockMarket.lastUpdate = Date.now();`, replace: `  StockMarket.lastUpdate = stockNow();` },
    { find: `  const v = Math.random();`, replace: `  const v = stockRandom();` },
    { find: `    const c = Math.random();`, replace: `    const c = stockRandom();` },
  ],
);

// Hack/grow price manipulation — four lines that decide whether BN8 is
// playable, and the reason `hacking` needs a stock-aware target score. Upstream
// takes a full Server; only two fields are read.
extractSymbols(
  "src/StockMarket/PlayerInfluencing.ts",
  [
    "forecastForecastChangeFromHack",
    "forecastForecastChangeFromCompanyWork",
    "influenceStockThroughServerHack",
    "influenceStockThroughServerGrow",
    "influenceStockThroughCompanyWork",
  ],
  [
    `import { Stock } from "./Stock";`,
    `import { StockMarket, stockRandom } from "./MarketAdapter";`,
    ``,
    `/** The two fields upstream's \`Server\` argument is actually read for. */`,
    `interface Server {`,
    `  organizationName: string;`,
    `  moneyMax: number;`,
    `}`,
    `interface Company { name: string; }`,
  ],
  "src/StockMarket/PlayerInfluence.ts",
  [
    { find: `  if (Math.random() < percTotalMoneyHacked) {`, replace: `  if (stockRandom() < percTotalMoneyHacked) {` },
    { find: `  if (Math.random() < percTotalMoneyGrown) {`, replace: `  if (stockRandom() < percTotalMoneyGrown) {` },
    { find: `  if (Math.random() < 0.002 * cyclesOfWork) {`, replace: `  if (stockRandom() < 0.002 * cyclesOfWork) {` },
  ],
);

// --- data tables ------------------------------------------------------------
//
// The 33 factions, with BOTH the flattened toJSON() requirement arrays the ns
// API returns AND the structured condition tree. Both are needed and they are
// not the same thing: upstream's `everyCondition` iterator flattens nested
// ANDs but NOT ANDs nested inside an OR, so a strategy that only ever saw the
// flattened form could not tell "A and (B or (C and D))" from something it can
// actually satisfy. Regenerating from the real code is the only way to get it
// right.

const enums = await import(`../${OUT_DIR}/src/Faction/Enums.ts`);
const companyEnums = await import(`../${OUT_DIR}/src/Company/Enums.ts`);
const locationEnums = await import(`../${OUT_DIR}/src/Locations/Enums.ts`);
const workEnums = await import(`../${OUT_DIR}/src/Work/Enums.ts`);
const literatureEnums = await import(`../${OUT_DIR}/src/Literature/Enums.ts`);
const messageEnums = await import(`../${OUT_DIR}/src/Message/Enums.ts`);
const augEnums = await import(`../${OUT_DIR}/src/Augmentation/Enums.ts`);
const specialServers = await import(`../${OUT_DIR}/src/Server/data/SpecialServers.ts`);
const bladeburnerConstants = await import(`../${OUT_DIR}/src/Bladeburner/data/Constants.ts`);
const gameConstants = await import(`../${OUT_DIR}/src/Constants.ts`);
const bitNodeMults = await import(`../${OUT_DIR}/src/BitNode/BitNodeMultipliers.ts`);

// Company careers are a progression mechanic, not merely telemetry: applying
// chooses the highest qualified position on a field's track, and company work
// supplies the reputation required by megacorp faction invitations. Extract
// both tables together so the simulator never invents job requirements,
// salaries, experience, performance weights, or company-specific offsets.
await extractDataTable({
  sources: [
    {
      path: "src/Company/data/JobTracks.ts",
      from: "export const JobTracks: Record<JobField, readonly JobName[]> = {",
      to: "export const businessConsultJobs = JobTracks[JobField.businessConsultant];",
    },
    {
      path: "src/Company/data/CompanyPositionsMetadata.ts",
      from: "export function getCompanyPositionMetadata(): Record<JobName, CompanyPositionCtorParams> {",
      to: "}",
    },
    {
      path: "src/Company/data/CompaniesMetadata.ts",
      from: "export function getCompaniesMetadata(): Record<CompanyName, CompanyCtorParams> {",
      to: "}",
    },
  ],
  scope: {
    JobName: workEnums.JobName,
    JobField: workEnums.JobField,
    CompanyName: companyEnums.CompanyName,
    FactionName: enums.FactionName,
  },
  shape: `(() => {
    const positions = getCompanyPositionMetadata();
    const companies = getCompaniesMetadata();
    const number = (value) => value ?? 0;
    return {
      jobTracks: Object.fromEntries(Object.entries(JobTracks).map(([field, names]) => [field, [...names]])),
      positions: Object.fromEntries(Object.entries(positions).map(([name, p]) => [name, {
        name,
        field: p.field,
        nextPosition: p.nextPosition,
        isStartingJob: !!p.isStartingJob,
        isPartTime: !!p.isPartTime,
        baseSalary: p.baseSalary,
        repMultiplier: p.repMultiplier,
        requiredSkills: {
          hacking: number(p.reqdHacking), strength: number(p.reqdStrength), defense: number(p.reqdDefense),
          dexterity: number(p.reqdDexterity), agility: number(p.reqdAgility), charisma: number(p.reqdCharisma),
        },
        requiredReputation: number(p.reqdReputation),
        effectiveness: {
          hacking: number(p.hackingEffectiveness), strength: number(p.strengthEffectiveness), defense: number(p.defenseEffectiveness),
          dexterity: number(p.dexterityEffectiveness), agility: number(p.agilityEffectiveness), charisma: number(p.charismaEffectiveness),
        },
        expGain: {
          hacking: number(p.hackingExpGain), strength: number(p.strengthExpGain), defense: number(p.defenseExpGain),
          dexterity: number(p.dexterityExpGain), agility: number(p.agilityExpGain), charisma: number(p.charismaExpGain),
        },
      }])),
      companies: Object.fromEntries(Object.entries(companies).map(([name, c]) => [name, {
        name,
        positions: [...c.companyPositions],
        expMultiplier: c.expMultiplier,
        salaryMultiplier: c.salaryMultiplier,
        jobStatReqOffset: c.jobStatReqOffset,
        ...(c.relatedFaction !== undefined ? { relatedFaction: c.relatedFaction } : {}),
      }])),
    };
  })()`,
  verify(table) {
    const data = table as { jobTracks: Record<string, string[]>; positions: Record<string, { effectiveness: Record<string, number> }>; companies: Record<string, { positions: string[] }> };
    if (Object.keys(data.positions).length !== Object.keys(workEnums.JobName).length) throw new Error("company position extraction lost a JobName");
    if (Object.keys(data.companies).length !== Object.keys(companyEnums.CompanyName).length) throw new Error("company extraction lost a CompanyName");
    if (data.jobTracks["Software"]?.[0] !== "Software Engineering Intern") throw new Error("software entry position drifted");
    if (!data.companies["ECorp"]?.positions.includes("Chief Technology Officer")) throw new Error("ECorp software track drifted");
    for (const [name, position] of Object.entries(data.positions)) {
      const total = Object.values(position.effectiveness).reduce((sum, value) => sum + value, 0);
      if (Math.round(total) !== 100) throw new Error(`${name} effectiveness sums to ${total}`);
    }
  },
  outRelPath: "src/Company/CompanyTable.ts",
  prologue: [
    `export interface VendoredCompanyPosition {`,
    `  name: string; field: string; nextPosition: string | null; isStartingJob: boolean; isPartTime: boolean;`,
    `  baseSalary: number; repMultiplier: number; requiredSkills: Record<string, number>; requiredReputation: number;`,
    `  effectiveness: Record<string, number>; expGain: Record<string, number>;`,
    `}`,
    `export interface VendoredCompany {`,
    `  name: string; positions: string[]; expMultiplier: number; salaryMultiplier: number; jobStatReqOffset: number; relatedFaction?: string;`,
    `}`,
    `export interface VendoredCompanyTable {`,
    `  jobTracks: Record<string, string[]>; positions: Record<string, VendoredCompanyPosition>; companies: Record<string, VendoredCompany>;`,
    `}`,
  ],
  exportName: "COMPANY_TABLE",
  exportType: "VendoredCompanyTable",
});

await extractDataTable({
  sources: [
    {
      path: "src/Faction/FactionJoinCondition.ts",
      from: "export interface PlayerCondition {",
      to: "}",
    },
    {
      path: "src/Faction/FactionInfo.tsx",
      from: "export class FactionInfo {",
      to: "}",
    },
  ],
  scope: {
    FactionName: enums.FactionName,
    CompanyName: companyEnums.CompanyName,
    CityName: locationEnums.CityName,
    LocationName: locationEnums.LocationName,
    JobName: workEnums.JobName,
    LiteratureName: literatureEnums.LiteratureName,
    MessageFilename: messageEnums.MessageFilename,
    AugmentationName: augEnums.AugmentationName,
    SpecialServers: specialServers.SpecialServers,
    BladeburnerConstants: bladeburnerConstants.BladeburnerConstants,
    CONSTANTS: gameConstants.CONSTANTS,
    currentNodeMults: bitNodeMults.currentNodeMults,
    // The gang factions are patched onto the table by a trailing loop.
    GangConstants: { Names: gangFactionNames() },
    // toJSON() on a company-reputation condition multiplies by a backdoor
    // discount that depends on LIVE game state. The vendored table is the
    // BASE requirement; the sim applies the discount itself when a company
    // server is backdoored. Returning `reputation` unchanged is therefore the
    // correct base value, not a simplification.
    calculateEffectiveRequiredReputation: (_company: unknown, reputation: number) => reputation,
  },
  // Booleans are coerced rather than passed through: an upstream field left
  // undefined would be DROPPED by JSON.stringify, and the emitted file
  // declares them non-optional. A missing `keepOnInstall` reading as
  // `undefined` at runtime is exactly the kind of quiet falsiness that works
  // until someone writes `if (f.keepOnInstall === false)`.
  shape: `Object.fromEntries(
    Object.entries(FactionInfos).map(([name, info]) => [name, {
      enemies: [...(info.enemies ?? [])],
      offerHackingWork: !!info.offerHackingWork,
      offerFieldWork: !!info.offerFieldWork,
      offerSecurityWork: !!info.offerSecurityWork,
      special: !!info.special,
      // NOTE the field rename: the constructor param is \`keepOnInstall\` but it
      // is stored as \`keep\`. Reading the param name here yields undefined for
      // every faction, which \`!!\` then turns into a plausible-looking \`false\`
      // across the board. The verify() below pins the real count.
      keepOnInstall: !!info.keep,
      inviteReqs: [...info.inviteReqs].map((c) => c.toJSON()),
      rumorReqs: [...info.rumorReqs].map((c) => c.toJSON()),
    }])
  )`,
  verify(table) {
    const factions = table as Record<
      string,
      { inviteReqs: unknown[]; enemies: string[]; keepOnInstall: boolean; special: boolean; offerHackingWork: boolean }
    >;
    const names = Object.keys(factions);
    // 34, counted from the pinned source — both `FactionName` and the table
    // itself. (Commonly miscited as 33; ShadowsOfAnarchy is easy to miss
    // because it is special-cased everywhere.)
    if (names.length !== 34) throw new Error(`expected 34 factions, extracted ${names.length}`);
    // Spot-checks against facts an incorrect extraction would get wrong.
    if (!names.includes("CyberSec")) throw new Error("CyberSec missing");
    const daedalus = factions["Daedalus"];
    if (!daedalus || daedalus.inviteReqs.length === 0) throw new Error("Daedalus has no invite requirements");
    // Bans reference real factions; the ban graph depends on it.
    for (const [name, info] of Object.entries(factions)) {
      for (const enemy of info.enemies ?? []) {
        if (!factions[enemy]) throw new Error(`${name} names unknown enemy ${enemy}`);
      }
    }
    // Guard against reading a field the class renamed: a wrong field name
    // yields undefined for EVERY faction, which coerces to a uniform false
    // that looks entirely plausible.
    const counts = {
      keepOnInstall: Object.values(factions).filter((f) => f.keepOnInstall).length,
      special: Object.values(factions).filter((f) => f.special).length,
      offerHackingWork: Object.values(factions).filter((f) => f.offerHackingWork).length,
    };
    for (const [field, count] of Object.entries(counts)) {
      if (count === 0) throw new Error(`no faction has ${field} — is the field named differently upstream?`);
      if (count === names.length) throw new Error(`every faction has ${field} — suspicious`);
    }
    // Sector-12 bans the four cities it is at war with; a ban graph that lost
    // its edges would silently let the planner join mutually exclusive
    // factions and then fail every join.
    if ((factions["Sector-12"]?.enemies ?? []).length !== 4) {
      throw new Error("Sector-12 should ban exactly 4 factions");
    }
  },
  outRelPath: "src/Faction/FactionTable.ts",
  prologue: [
    `import type { PlayerRequirement } from "@nsdefs";`,
    ``,
    `export interface VendoredFaction {`,
    `  enemies: string[];`,
    `  offerHackingWork: boolean;`,
    `  offerFieldWork: boolean;`,
    `  offerSecurityWork: boolean;`,
    `  special: boolean;`,
    `  keepOnInstall: boolean;`,
    `  /** Flattened exactly as ns.singularity.getFactionInviteRequirements returns. */`,
    `  inviteReqs: PlayerRequirement[];`,
    `  rumorReqs: PlayerRequirement[];`,
    `}`,
  ],
  exportName: "FACTION_TABLE",
  exportType: "Record<string, VendoredFaction>",
});

const programEnums = await import(`../${OUT_DIR}/src/Programs/Enums.ts`);

// Program creation requirements/times and darkweb prices come from two
// upstream tables. The shared/game strategy stays handwritten; this extracted
// copy is an independent simulator oracle that catches drift in either table.
await extractDataTable({
  sources: [
    {
      path: "src/Programs/Programs.ts",
      from: "export const Programs: Record<CompletedProgramName, Program> = {",
      to: "};",
    },
    {
      path: "src/DarkWeb/DarkWebItems.ts",
      from: "export const DarkWebItems = {",
      to: "};",
    },
  ],
  scope: {
    CompletedProgramName: programEnums.CompletedProgramName,
    CONSTANTS: gameConstants.CONSTANTS,
    DarknetConstants: { DarkscapeNavigatorPrice: 0 },
    Program: class { constructor(params: Record<string, unknown>) { Object.assign(this, params); } },
    DarkWebItem: class {
      program: string;
      price: number;
      description: string;
      constructor(program: string, price: number, description: string) {
        this.program = program;
        this.price = price;
        this.description = description;
      }
    },
    requireHackingLevel: () => () => true,
    bitFlumeRequirements: () => () => true,
  },
  shape: `Object.fromEntries(
    ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"].map((name) => {
      const program = Programs[name];
      const item = Object.values(DarkWebItems).find((entry) => entry.program === name);
      return [name, {
        name,
        level: program.create.level,
        baseTimeMs: program.create.time,
        purchaseCost: item.price,
      }];
    })
  )`,
  verify(table) {
    const programs = table as Record<string, { level: number; baseTimeMs: number; purchaseCost: number }>;
    if (Object.keys(programs).length !== 5) throw new Error("expected five port-opening programs");
    if (programs["BruteSSH.exe"]?.level !== 50 || programs["BruteSSH.exe"]?.baseTimeMs !== 600_000) {
      throw new Error("BruteSSH.exe creation metadata drifted");
    }
    if (programs["SQLInject.exe"]?.purchaseCost !== 250_000_000) throw new Error("SQLInject.exe price drifted");
  },
  outRelPath: "src/Programs/ProgramTable.ts",
  prologue: [
    `export interface VendoredProgram {`,
    `  name: string;`,
    `  level: number;`,
    `  baseTimeMs: number;`,
    `  purchaseCost: number;`,
    `}`,
  ],
  exportName: "PROGRAM_TABLE",
  exportType: "Record<string, VendoredProgram>",
});

// Every augmentation's price, reputation requirement, prerequisites, offering
// factions and multipliers.
//
// The `Augmentation` CLASS is deliberately not evaluated — it drags in the
// live player and the UI formatters. One exact patch replaces the constructing
// return with the raw metadata the constructor would have consumed, which is
// the same data without the dependencies.
await extractDataTable({
  sources: [
    {
      path: "src/Augmentation/Augmentations.ts",
      from: "export const Augmentations: Record<AugmentationName, Augmentation> = (() => {",
      to: "})();",
      patches: [
        {
          find: `  return createEnumKeyedRecord(AugmentationName, (name) => {
    const params = metadata[name] as AugmentationCtorParams;
    params.name = name;
    return new Augmentation(params);
  });`,
          replace: `  return metadata;`,
        },
      ],
    },
  ],
  scope: {
    AugmentationName: augEnums.AugmentationName,
    CompletedProgramName: programEnums.CompletedProgramName,
    FactionName: enums.FactionName,
    CONSTANTS: gameConstants.CONSTANTS,
    // UnstableCircadianModulator picks its multipliers from a random set at
    // load time (src/Augmentation/CircadianModulator.ts, seeded by WHRNG), so
    // there is no single correct answer to vendor. Its price, reputation cost
    // and offering faction ARE fixed, so those are kept and the multipliers
    // are marked unknown — rather than freezing one arbitrary roll into the
    // table, which would be a fabricated value the planner would then score.
    getUnstableCircadianModulatorParams: () => ({
      moneyCost: 5e9,
      repCost: 3.625e5,
      info: "",
      factions: [enums.FactionName.SpeakersForTheDead],
      multsUnknown: true,
    }),
  },
  shape: `Object.fromEntries(
    Object.entries(Augmentations).map(([name, m]) => {
      // Everything destructured out here is METADATA, not a multiplier.
      // \`startingMoney\` and \`programs\` are real one-off grants (CashRoot
      // Starter Kit, BitRunners' BigD's Big Brain) and are carried as their
      // own fields — folding either into \`mults\` would add a $1,000,000
      // "multiplier" to the log-sum scoring and dominate every real bonus.
      const {
        info, stats, factions, prereqs, repCost, moneyCost, isSpecial, multsUnknown,
        startingMoney, programs, name: _n, ...mults
      } = m;
      return [name, {
        name,
        baseRepRequirement: repCost ?? 0,
        baseCost: moneyCost ?? 0,
        factions: [...(factions ?? [])],
        prereqs: [...(prereqs ?? [])],
        isSpecial: !!isSpecial,
        ...(startingMoney ? { startingMoney } : {}),
        ...(programs ? { programs: [...programs] } : {}),
        ...(multsUnknown ? { multsUnknown: true } : {}),
        mults,
      }];
    })
  )`,
  verify(table) {
    const augs = table as Record<
      string,
      { baseCost: number; baseRepRequirement: number; factions: string[]; prereqs: string[]; mults: Record<string, number> }
    >;
    const names = Object.keys(augs);
    if (names.length < 100) throw new Error(`only ${names.length} augmentations extracted`);
    if (!augs["NeuroFlux Governor"]) throw new Error("NeuroFlux Governor missing");
    // Costs may be Infinity (an unpurchasable special) but never NaN or null:
    // Infinity means "cannot be bought", which the planner must distinguish
    // from free.
    for (const [name, aug] of Object.entries(augs)) {
      for (const field of ["baseCost", "baseRepRequirement"] as const) {
        const value = aug[field];
        if (typeof value !== "number" || Number.isNaN(value)) {
          throw new Error(`${name}.${field} is not a number (${JSON.stringify(value)})`);
        }
      }
    }
    // Every leftover field must be a numeric multiplier. Anything else means
    // upstream grew a metadata field this shape is silently folding into
    // `mults`, where it would corrupt the scoring sum.
    for (const [name, aug] of Object.entries(augs)) {
      for (const [field, value] of Object.entries(aug.mults)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`${name}.${field} is not a numeric multiplier (${JSON.stringify(value)})`);
        }
      }
    }
    // Prereqs must resolve, or the closure the planner computes is broken.
    for (const [name, aug] of Object.entries(augs)) {
      for (const prereq of aug.prereqs) {
        if (!augs[prereq]) throw new Error(`${name} requires unknown augmentation ${prereq}`);
      }
    }
    // A known anchor: The Red Pill is free and offered only by Daedalus.
    const redPill = augs["The Red Pill"];
    if (!redPill || redPill.baseCost !== 0) throw new Error("The Red Pill should cost 0");
    // Exactly one augmentation has unknowable multipliers. More than one means
    // a stub leaked; none means the marker stopped being emitted and the
    // planner would score a randomised augmentation as if it had no effect.
    const unknown = Object.entries(augs).filter(([, a]) => (a as { multsUnknown?: boolean }).multsUnknown);
    if (unknown.length !== 1 || unknown[0]![0] !== "Unstable Circadian Modulator") {
      throw new Error(`expected exactly UnstableCircadianModulator to have unknown mults, got ${unknown.map((u) => u[0]).join(", ")}`);
    }
  },
  outRelPath: "src/Augmentation/AugmentationTable.ts",
  prologue: [
    `export interface VendoredAugmentation {`,
    `  name: string;`,
    `  /** Base money price, before the 1.9^queued escalation. */`,
    `  baseCost: number;`,
    `  /** Reputation requirement. Does NOT scale with the purchase queue. */`,
    `  baseRepRequirement: number;`,
    `  factions: string[];`,
    `  prereqs: string[];`,
    `  isSpecial: boolean;`,
    `  /** Multiplier fields only — every value is a finite number. */`,
    `  mults: Record<string, number>;`,
    `  /** One-off cash grant on install (CashRoot Starter Kit). NOT a multiplier. */`,
    `  startingMoney?: number;`,
    `  /** Programs granted on install (BigD's Big Brain). NOT multipliers. */`,
    `  programs?: string[];`,
    `  /** Set when upstream randomises this augmentation's multipliers at load`,
    `   *  time, so \`mults\` is NOT the truth and must not be scored. Exactly one`,
    `   *  augmentation is like this (Unstable Circadian Modulator). */`,
    `  multsUnknown?: boolean;`,
    `}`,
  ],
  exportName: "AUGMENTATION_TABLE",
  exportType: "Record<string, VendoredAugmentation>",
});

// The generated network's base ranges.
//
// Upstream rolls each `{min, max}` field once at world generation
// (`ServerHelpers.toNumber` -> `getRandomIntInclusive`), so two saves of the
// same BitNode do NOT have the same megacorp. Without the ranges there is no
// way to tell a lucky roll from an unlucky one, or to explain why a server the
// wiki calls "$40b" is showing $720b — that number is `25 * roll *
// ServerMaxMoney`, and all three factors have to be known to invert it.
//
// The whole file is import-heavy prose-free data, but its hostnames come from
// two enums, so it is evaluated rather than parsed like everything else here.
await extractDataTable({
  sources: [
    {
      path: "src/Server/data/servers.ts",
      from: "export const serverMetadata: IServerMetadata[] = [",
      to: "];",
    },
  ],
  scope: {
    LocationName: locationEnums.LocationName,
    SpecialServers: specialServers.SpecialServers,
    FactionName: enums.FactionName,
    LiteratureName: literatureEnums.LiteratureName,
  },
  // Preserve both the normalized range and whether upstream actually rolls
  // it. A fixed number and {min: n, max: n} have the same value but consume a
  // different Math.random call; that distinction is load-bearing for a
  // reproducible full-network seed.
  shape: `(() => {
    const range = (v) => v === undefined ? undefined : (typeof v === "number" ? [v, v] : [v.min, v.max]);
    const rolled = (v) => typeof v === "object";
    return Object.fromEntries(serverMetadata.map((s) => [s.hostname, {
      host: s.hostname,
      org: s.organizationName,
      money: range(s.moneyAvailable),
      skill: range(s.requiredHackingSkill),
      sec: range(s.hackDifficulty),
      growth: range(s.serverGrowth),
      ramExp: range(s.maxRamExponent),
      layer: range(s.networkLayer),
      randomized: Object.fromEntries([
        ["money", s.moneyAvailable],
        ["skill", s.requiredHackingSkill],
        ["sec", s.hackDifficulty],
        ["growth", s.serverGrowth],
        ["ramExp", s.maxRamExponent],
        ["layer", s.networkLayer],
      ].filter(([, value]) => rolled(value)).map(([field]) => [field, true])),
      ports: s.numOpenPortsRequired,
    }]));
  })()`,
  verify(table) {
    const servers = table as Record<
      string,
      { money?: [number, number]; skill?: [number, number]; ports: number }
    >;
    const names = Object.keys(servers);
    if (names.length !== 70) throw new Error(`expected 70 servers, extracted ${names.length}`);
    // Hostnames that come from an enum rather than a literal — a missing scope
    // entry would yield "undefined" as a hostname and still look like a table.
    for (const host of ["ecorp", "megacorp", "nwo", "fulcrumassets", "CSEC", "w0r1d_d43m0n"]) {
      if (!servers[host]) throw new Error(`${host} missing — hostname enum not resolved?`);
    }
    if (servers["n00dles"]?.money?.[0] !== 70_000) throw new Error("n00dles base money drifted");
    // The point of the table: some fields are genuinely ranges. If NONE are,
    // the range() helper collapsed everything and the roll column is a lie.
    const ranged = Object.values(servers).filter((s) => s.money && s.money[0] !== s.money[1]).length;
    if (ranged < 20) throw new Error(`only ${ranged} servers have a money range — extraction collapsed it?`);
    if (!Object.values(servers).some((s) => s.ports > 0)) throw new Error("no server needs an open port");
  },
  outRelPath: "src/Server/data/ServerMetadata.ts",
  prologue: [
    `/** A field upstream rolls at world generation, as [min, max]. A fixed`,
    ` *  value is emitted as a degenerate range. */`,
    `export type Range = [number, number];`,
    ``,
    `export interface VendoredServer {`,
    `  host: string;`,
    `  /** The company this server belongs to. Load-bearing, not decorative: it`,
    `   *  is the key hack/grow stock influence looks the symbol up by`,
    `   *  (StockMarket/PlayerInfluencing.ts), so it is what maps a farm target`,
    `   *  onto a tradeable stock. */`,
    `  org: string;`,
    `  /** BASE money. The live \`moneyMax\` is \`25 * roll * ServerMaxMoney\`. */`,
    `  money?: Range;`,
    `  skill?: Range;`,
    `  /** Base security. \`minDifficulty\` is \`round(roll / 3)\`, both after`,
    `   *  ServerStartingSecurity. */`,
    `  sec?: Range;`,
    `  growth?: Range;`,
    `  ramExp?: Range;`,
    `  layer?: Range;`,
    `  /** Fields represented as an upstream min/max object. Only these consume`,
    `   *  a random roll; fixed numbers do not, even when normalized ranges match. */`,
    `  randomized: Partial<Record<"money" | "skill" | "sec" | "growth" | "ramExp" | "layer", true>>;`,
    `  ports: number;`,
    `}`,
  ],
  exportName: "SERVER_METADATA",
  exportType: "Record<string, VendoredServer>",
});

const crimeEnums = await import(`../${OUT_DIR}/src/Crime/Enums.ts`);

// The twelve crimes: time, money, difficulty, karma, kills, the six
// success-weight fields and the seven experience fields.
//
// `Crimes.ts` builds `new Crime(...)` from positional arguments, so the CLASS
// is what knows which argument is which. Rather than re-derive that mapping by
// hand — where an off-by-one in the argument list would silently swap
// `difficulty` and `karma` and look entirely plausible — the class is
// evaluated too, with its unportable `commit` removed.
await extractDataTable({
  sources: [
    {
      path: "src/Crime/Crime.ts",
      from: "export class Crime {",
      to: "}",
      patches: [
        // `commit` reaches for the live Player and the work system; the table
        // only needs the constructor's field assignments.
        {
          find: `  commit(div = 1, workerScript: WorkerScript | null = null): number {`,
          replace: `  commitRemoved(): number {\n    return this.time;\n  }\n  private unusedCommit(div = 1, workerScript: unknown = null): number {`,
        },
      ],
    },
    { path: "src/Crime/Crimes.ts", from: "export const Crimes: Record<CrimeType, Crime> = {", to: "};" },
  ],
  scope: {
    CrimeType: crimeEnums.CrimeType,
    CONSTANTS: gameConstants.CONSTANTS,
    currentNodeMults: bitNodeMults.currentNodeMults,
    Player: {},
    calculateIntelligenceBonus: () => 1,
    WorkerScript: class {},
    CrimeWork: class {},
  },
  shape: `Object.fromEntries(
    Object.entries(Crimes).map(([type, c]) => [type, {
      type,
      timeMs: c.time,
      money: c.money,
      difficulty: c.difficulty,
      karma: c.karma,
      kills: c.kills,
      weights: {
        hacking: c.hacking_success_weight,
        strength: c.strength_success_weight,
        defense: c.defense_success_weight,
        dexterity: c.dexterity_success_weight,
        agility: c.agility_success_weight,
        charisma: c.charisma_success_weight,
      },
      exp: {
        hacking: c.hacking_exp,
        strength: c.strength_exp,
        defense: c.defense_exp,
        dexterity: c.dexterity_exp,
        agility: c.agility_exp,
        charisma: c.charisma_exp,
        intelligence: c.intelligence_exp,
      },
    }])
  )`,
  verify(table) {
    const crimes = table as Record<
      string,
      { timeMs: number; money: number; difficulty: number; karma: number; kills: number; weights: Record<string, number> }
    >;
    const names = Object.keys(crimes);
    if (names.length !== 12) throw new Error(`expected 12 crimes, extracted ${names.length}`);
    // Anchors an argument-order mistake would break: shoplift is the cheapest
    // and easiest, homicide is the karma/kills workhorse the gang path needs.
    // Keyed by the enum VALUE ("Shoplift"), which is also what
    // ns.singularity.commitCrime takes.
    const shoplift = crimes["Shoplift"];
    if (!shoplift || shoplift.timeMs !== 2e3 || shoplift.money !== 15e3) {
      throw new Error("Shoplift should be 2s for $15k — are the constructor arguments in the expected order?");
    }
    const homicide = crimes["Homicide"];
    if (!homicide || homicide.kills !== 1) throw new Error("Homicide should kill exactly 1");
    for (const [name, crime] of Object.entries(crimes)) {
      if (!(crime.timeMs > 0)) throw new Error(`${name} has no duration`);
      if (!(crime.difficulty > 0)) throw new Error(`${name} has no difficulty`);
      // Karma is stored POSITIVE here and SUBTRACTED by the game.
      if (!(crime.karma > 0)) throw new Error(`${name} grants no karma`);
      if (Object.values(crime.weights).every((weight) => weight === 0)) {
        throw new Error(`${name} has no success weights — the chance would be 0 forever`);
      }
    }
  },
  outRelPath: "src/Crime/CrimeTable.ts",
  prologue: [
    `export interface VendoredCrime {`,
    `  type: string;`,
    `  timeMs: number;`,
    `  money: number;`,
    `  difficulty: number;`,
    `  /** POSITIVE here; the game SUBTRACTS it, so karma goes down. */`,
    `  karma: number;`,
    `  kills: number;`,
    `  /** Success-chance weights, per skill. */`,
    `  weights: Record<string, number>;`,
    `  /** Experience granted on success, per skill. */`,
    `  exp: Record<string, number>;`,
    `}`,
  ],
  exportName: "CRIME_TABLE",
  exportType: "Record<string, VendoredCrime>",
});

/** The six gang factions, read from the pinned source rather than retyped. */
function gangFactionNames(): string[] {
  const source = gitShow("src/Gang/data/Constants.ts");
  const match = source.match(/Names:\s*\[([^\]]*)\]/);
  if (!match) throw new Error("src/Gang/data/Constants.ts: gang faction Names not found (source drifted?)");
  const names = [...match[1]!.matchAll(/FactionName\.(\w+)/g)].map((m) => m[1]!);
  if (names.length === 0) throw new Error("src/Gang/data/Constants.ts: no gang faction names parsed");
  return names.map((key) => {
    const value = (enums.FactionName as Record<string, string>)[key];
    if (!value) throw new Error(`unknown FactionName.${key}`);
    return value;
  });
}

writeFileSync(
  path.join("sim/vendor", "manifest.json"),
  JSON.stringify(
    {
      tag: TAG,
      commit: COMMIT,
      definitionsSha256: createHash("sha256")
        .update(gitShow("src/ScriptEditor/NetscriptDefinitions.d.ts"))
        .digest("hex"),
      transcriptionSources: Object.fromEntries(
        TRANSCRIPTION_SOURCE_PATHS.map((sourcePath) => [
          sourcePath,
          createHash("sha256").update(gitShow(sourcePath)).digest("hex"),
        ]),
      ),
      files: written,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log(`wrote sim/vendor/manifest.json (${written.length} files @ ${TAG}, ${COMMIT})`);
