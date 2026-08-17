/** Browser-safe façade over a loaded merged phase playbook module.
 *
 * `ipvgobruteforce/arena/playbook.ts` pulls in `node:url` for its file
 * loader, which cannot bundle into the WebGPU browser harness or the
 * standalone Bitburner script. This module re-exposes the pure pieces the
 * combined runtime needs; the playbook module object itself is supplied by a
 * static import at the bundle entry.
 */
export interface PlaybookRoute {
  enemy: string;
  entryPhase: number;
  waits: number;
}

export interface PlaybookModel {
  runtimeTicks: number;
  aiSeedSlip: number;
  playtimeEpoch: number;
  alignmentBoards: number;
  maximumProofRounds: number;
}

export type PlaybookAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "pass" | "align" | "miss" }
  | { kind: "sleep"; variant: number };

/** The schema-5 merged playbook surface the combined runtime consumes. */
export interface MergedPlaybook {
  PLAYBOOK_SCHEMA: number;
  BOARD_SIZE: number;
  PHASES: number;
  MISS: number;
  OPPONENTS: readonly string[];
  phaseNow(playtimeMs: number): number;
  selectRoot(phase: number, requestedEnemy?: string): PlaybookRoute;
  modelFor(enemy: string): PlaybookModel;
  lookupMove(enemy: string, phase: number, board: bigint, passes?: number,
    credit?: number, history?: readonly bigint[]): number;
  describeMove(encoded: number): PlaybookAction;
  certifiedAction(enemy: string, actualPhase: number, bonusCycles: number,
    board: bigint, passes: number, credit: number, history: readonly bigint[]):
    { action: PlaybookAction; modelPhase: number; dispatchPhase: number;
      alignmentCredit: number } | undefined;
}

export function validateMergedPlaybook(value: unknown): MergedPlaybook {
  const playbook = value as Partial<MergedPlaybook>;
  if (typeof playbook?.PLAYBOOK_SCHEMA !== "number" || playbook.PLAYBOOK_SCHEMA < 5
    || playbook.BOARD_SIZE !== 5 || playbook.PHASES !== 150_000
    || typeof playbook.MISS !== "number" || !Array.isArray(playbook.OPPONENTS)
    || !playbook.OPPONENTS.length || typeof playbook.lookupMove !== "function"
    || typeof playbook.selectRoot !== "function"
    || typeof playbook.certifiedAction !== "function"
    || typeof playbook.describeMove !== "function"
    || typeof playbook.modelFor !== "function"
    || typeof playbook.phaseNow !== "function") {
    throw new Error("value is not a merged schema-5 phase playbook module");
  }
  return playbook as MergedPlaybook;
}

export function normalizePlaybookPhase(playbook: MergedPlaybook, phase: number): number {
  return ((phase % playbook.PHASES) + playbook.PHASES) % playbook.PHASES;
}

/** 50-bit column-major board packing, identical to the certificate corpus and
 * the generated runtime (`ns.go.getBoardState` is column-major). */
export function packCombinedBoard(columns: readonly string[]): bigint {
  if (columns.length !== 5 || columns.some((column) => column.length !== 5)) {
    throw new Error("playbook board must contain five complete columns");
  }
  let packed = 0n;
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
    const cell = columns[x]![y]!;
    const code = cell === "X" ? 1n : cell === "O" ? 2n : cell === "#" ? 3n : 0n;
    packed |= code << BigInt(2 * (x * 5 + y));
  }
  return packed;
}

