import { pathToFileURL } from "node:url";

export type PlaybookMove =
  | { kind: "move"; x: number; y: number }
  | { kind: "pass" | "align" | "miss" }
  | { kind: "sleep"; variant: number };

interface PhasePlaybookBase {
  PLAYBOOK_SCHEMA: number;
  BOARD_SIZE: number;
  PHASES: number;
  MISS: number;
  phaseNow(milliseconds: number): number;
  describeMove(move: number): PlaybookMove;
}

export interface SinglePhasePlaybook extends PhasePlaybookBase {
  ENEMY: string;
  MODEL_RUNTIME_TICKS: number;
  MODEL_AI_SEED_SLIP: number;
  MODEL_PLAYTIME_EPOCH?: number;
  MODEL_ALIGNMENT_BOARDS: number;
  MODEL_MAX_ROUNDS: number;
  skipPhase(phase: number): number;
  rootEntryPhase(phase: number): number;
  rootWaits(phase: number): number;
  lookupMove(
    phase: number,
    board: bigint,
    passes?: number,
    credit?: number,
    history?: readonly bigint[],
  ): number;
  lookupHashed?(phase: number, hash: number, hash2?: number): number;
}

export interface MultiPhasePlaybook extends PhasePlaybookBase {
  OPPONENTS: readonly string[];
  selectRoot(phase: number, requestedEnemy?: string): PlaybookRoute;
  modelFor(enemy: string): PlaybookModel | undefined;
  lookupMove(
    enemy: string,
    phase: number,
    board: bigint,
    passes?: number,
    credit?: number,
    history?: readonly bigint[],
  ): number;
  lookupHashed(enemy: string, phase: number, hash: number, hash2?: number): number;
  entryExpectedPowerPerTurn(enemy: string, phase: number): number | undefined;
  certifiedAction(
    enemy: string,
    actualPhase: number,
    bonusCycles: number,
    board: bigint,
    passes: number,
    credit: number,
    history: readonly bigint[],
  ): {
    action: PlaybookMove;
    modelPhase: number;
    dispatchPhase: number;
    alignmentCredit: number;
  } | undefined;
}

export type PhasePlaybook = SinglePhasePlaybook | MultiPhasePlaybook;

export interface PlaybookModel {
  runtimeTicks: number;
  aiSeedSlip: number;
  playtimeEpoch: number;
  alignmentBoards: number;
  maximumProofRounds: number;
}

export interface PlaybookRoute {
  enemy: string;
  entryPhase: number;
  waits: number;
  expectedPowerPerTurn?: number;
}

function requireInteger(module: Record<string, unknown>, name: string): number {
  const value = module[name];
  if (!Number.isInteger(value)) throw new Error(`playbook ${name} must be an integer`);
  return value as number;
}

function requireFunction(module: Record<string, unknown>, name: string): (...args: never[]) => unknown {
  const value = module[name];
  if (typeof value !== "function") throw new Error(`playbook ${name} must be a function`);
  return value as (...args: never[]) => unknown;
}

export function validatePhasePlaybook(value: unknown): PhasePlaybook {
  if (!value || typeof value !== "object") throw new Error("playbook module is not an object");
  const module = value as Record<string, unknown>;
  const schema = requireInteger(module, "PLAYBOOK_SCHEMA");
  const boardSize = requireInteger(module, "BOARD_SIZE");
  const phases = requireInteger(module, "PHASES");
  if (schema < 2) throw new Error(`unsupported playbook schema ${schema}`);
  if (boardSize !== 5) throw new Error(`arena requires a 5x5 playbook, got ${boardSize}`);
  if (phases !== 150_000) throw new Error(`unexpected playbook phase count ${phases}`);

  requireInteger(module, "MISS");
  requireFunction(module, "phaseNow");
  requireFunction(module, "lookupMove");
  requireFunction(module, "describeMove");
  if (schema >= 5) {
    if (!Array.isArray(module.OPPONENTS) || module.OPPONENTS.length === 0
        || module.OPPONENTS.some((enemy) => typeof enemy !== "string")) {
      throw new Error("multi-playbook OPPONENTS must be a non-empty string array");
    }
    for (const name of ["selectRoot", "modelFor", "lookupHashed", "certifiedAction"]) {
      requireFunction(module, name);
    }
  } else {
    if (typeof module.ENEMY !== "string") throw new Error("playbook ENEMY must be a string");
    requireInteger(module, "MODEL_RUNTIME_TICKS");
    requireInteger(module, "MODEL_AI_SEED_SLIP");
    requireInteger(module, "MODEL_ALIGNMENT_BOARDS");
    requireInteger(module, "MODEL_MAX_ROUNDS");
    for (const name of ["skipPhase", "rootEntryPhase", "rootWaits"]) requireFunction(module, name);
    if (schema >= 3) requireFunction(module, "lookupHashed");
  }

  return module as unknown as PhasePlaybook;
}

export async function loadPhasePlaybook(path: string): Promise<PhasePlaybook> {
  return validatePhasePlaybook(await import(pathToFileURL(path).href));
}

export function normalizePhase(playbook: PhasePlaybook, phase: number): number {
  return ((Math.floor(phase) % playbook.PHASES) + playbook.PHASES) % playbook.PHASES;
}

export function playbookOpponents(playbook: PhasePlaybook): readonly string[] {
  return "OPPONENTS" in playbook ? playbook.OPPONENTS : [playbook.ENEMY];
}

export function playbookModel(playbook: PhasePlaybook, enemy: string): PlaybookModel {
  if ("OPPONENTS" in playbook) {
    const model = playbook.modelFor(enemy);
    if (!model) throw new Error(`playbook has no model for ${enemy}`);
    return { ...model, playtimeEpoch: model.playtimeEpoch ?? 0 };
  }
  if (enemy !== playbook.ENEMY) throw new Error(`single playbook contains ${playbook.ENEMY}, not ${enemy}`);
  return {
    runtimeTicks: playbook.MODEL_RUNTIME_TICKS,
    aiSeedSlip: playbook.MODEL_AI_SEED_SLIP,
    playtimeEpoch: playbook.MODEL_PLAYTIME_EPOCH ?? 0,
    alignmentBoards: playbook.MODEL_ALIGNMENT_BOARDS,
    maximumProofRounds: playbook.MODEL_MAX_ROUNDS,
  };
}

export function playbookRoute(playbook: PhasePlaybook, phase: number): PlaybookRoute {
  const normalized = normalizePhase(playbook, phase);
  if ("OPPONENTS" in playbook) return playbook.selectRoot(normalized);
  return {
    enemy: playbook.ENEMY,
    entryPhase: playbook.rootEntryPhase(normalized),
    waits: playbook.rootWaits(normalized),
  };
}

export function playbookLookupMove(
  playbook: PhasePlaybook,
  enemy: string,
  phase: number,
  board: bigint,
  passes = 0,
  credit = 0,
  history: readonly bigint[] = [],
): number {
  return "OPPONENTS" in playbook
    ? playbook.lookupMove(enemy, phase, board, passes, credit, history)
    : enemy === playbook.ENEMY
      ? playbook.lookupMove(phase, board, passes, credit, history)
      : playbook.MISS;
}

export function playbookLookupHashed(
  playbook: PhasePlaybook,
  enemy: string,
  phase: number,
  hash: number,
  hash2?: number,
): number {
  if ("OPPONENTS" in playbook) return playbook.lookupHashed(enemy, phase, hash, hash2);
  return enemy === playbook.ENEMY && playbook.lookupHashed
    ? playbook.lookupHashed(phase, hash, hash2)
    : playbook.MISS;
}

/** The game calls these arrays rows, but ns.go.getBoardState is column-major. */
export function packPlaybookBoard(columns: readonly string[]): bigint {
  if (columns.length !== 5 || columns.some((column) => column.length !== 5)) {
    throw new Error("playbook board must contain five complete columns");
  }
  let packed = 0n;
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
    const cell = columns[x]![y];
    const value = cell === "X" ? 1n : cell === "O" ? 2n : cell === "#" ? 3n : 0n;
    packed |= value << BigInt(2 * (x * 5 + y));
  }
  return packed;
}

export interface RouteAudit {
  phases: number;
  enterPhases: number;
  dodgePhases: number;
  uniqueEntryPolicies: PlaybookRoute[];
  totalDodges: number;
  meanDodges: number;
  maximumDodges: number;
}

export function auditPlaybookRoutes(playbook: PhasePlaybook): RouteAudit {
  const entries = new Map<string, PlaybookRoute>();
  let enters = 0;
  let totalDodges = 0;
  let maximumDodges = 0;
  for (let phase = 0; phase < playbook.PHASES; phase++) {
    const route = playbookRoute(playbook, phase);
    const entry = route.entryPhase;
    const waits = route.waits;
    if (!playbookOpponents(playbook).includes(route.enemy)) {
      throw new Error(`root ${phase} returned unknown opponent ${route.enemy}`);
    }
    if (!Number.isInteger(entry) || entry < 0 || entry >= playbook.PHASES) {
      throw new Error(`root ${phase} returned invalid entry phase ${entry}`);
    }
    if (!Number.isInteger(waits) || waits < 0 || waits >= playbook.PHASES) {
      throw new Error(`root ${phase} returned invalid wait count ${waits}`);
    }
    if (normalizePhase(playbook, phase + waits) !== entry) {
      throw new Error(`root ${phase} route does not terminate at ${entry}`);
    }
    if (!("OPPONENTS" in playbook) && Boolean(playbook.skipPhase(phase)) !== (waits !== 0)) {
      throw new Error(`root ${phase} skip bit disagrees with committed route`);
    }
    entries.set(`${route.enemy}\0${entry}`, route);
    enters += waits === 0 ? 1 : 0;
    totalDodges += waits;
    maximumDodges = Math.max(maximumDodges, waits);
  }
  return {
    phases: playbook.PHASES,
    enterPhases: enters,
    dodgePhases: playbook.PHASES - enters,
    uniqueEntryPolicies: [...entries.values()],
    totalDodges,
    meanDodges: totalDodges / playbook.PHASES,
    maximumDodges,
  };
}
