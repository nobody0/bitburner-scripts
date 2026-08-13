import { legalMoves, type GoBoard } from "../teacher/strategy/decide.ts";

export const KATAGO_VERSION = "v1.16.3";
export const KATAGO_COMMIT = "802946dbb15ab7b52f6fa18e777ec8f8f65bfaff";

export const KATAGO_MODELS = {
  small5: {
    file: "go-ai/katago/models/rect15-b20c256-s343365760-d96847752.bin.gz",
    url: "https://media.katagotraining.org/uploaded/networks/models_extra/rect15-b20c256-s343365760-d96847752.bin.gz",
    sha256: "32376ad0f23e4f893bc4b99e4a9ad77dc1963832d31cabf0b165f9c4d888ab83",
  },
  daemon19: {
    file: "go-ai/katago/models/kata1-b10c128-s146897408-d54258564.txt.gz",
    url: "https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s146897408-d54258564.txt.gz",
    sha256: "af94ec4a0551a3d11236c33c22667edac1deada29d448e43d824329e8db89394",
  },
} as const;

export type KataGoMove = readonly [number, number] | "pass";

interface KataGoMoveInfo {
  move: string;
  order: number;
  visits?: number;
  prior?: number;
  winrate?: number;
  scoreLead?: number;
  utility?: number;
}

interface KataGoRootInfo {
  winrate?: number;
  scoreLead?: number;
  utility?: number;
  visits?: number;
}

interface KataGoResponse {
  id?: string;
  error?: string;
  field?: string;
  warning?: string;
  moveInfos?: KataGoMoveInfo[];
  rootInfo?: KataGoRootInfo;
  policy?: number[];
}

type KataGoPlayer = "B" | "W";

interface KataGoRules {
  ko: "POSITIONAL";
  scoring: "AREA";
  tax: "NONE";
  suicide: false;
  hasButton: false;
  whiteHandicapBonus: "0";
  friendlyPassOk: true;
}

export interface KataGoQuery {
  id: string;
  initialStones: [KataGoPlayer, string][];
  blockedPoints: string[];
  initialPlayer: KataGoPlayer;
  moves: [KataGoPlayer, string][];
  rules: KataGoRules;
  komi: number;
  boardXSize: number;
  boardYSize: number;
  maxVisits: number;
  analysisPVLen: number;
  allowMoves: [{ player: KataGoPlayer; moves: string[]; untilDepth: 1 }];
  includePolicy?: boolean;
}

function vertex(x: number, y: number): string {
  return `(${x},${y})`;
}

function moveVertex(move: KataGoMove): string {
  return move === "pass" ? "pass" : vertex(move[0], move[1]);
}

function boardSetup(board: GoBoard): {
  initialStones: [KataGoPlayer, string][];
  blockedPoints: string[];
} {
  const initialStones: [KataGoPlayer, string][] = [];
  const blockedPoints: string[] = [];
  for (let x = 0; x < board.size; x++) for (let y = 0; y < board.size; y++) {
    const cell = board.rows[x]![y]!;
    if (cell === "X") initialStones.push(["B", vertex(x, y)]);
    else if (cell === "O") initialStones.push(["W", vertex(x, y)]);
    else if (cell === "#") blockedPoints.push(vertex(x, y));
  }
  return { initialStones, blockedPoints };
}

const IPVGO_KATAGO_RULES: KataGoRules = {
  ko: "POSITIONAL",
  scoring: "AREA",
  tax: "NONE",
  suicide: false,
  hasButton: false,
  whiteHandicapBonus: "0",
  friendlyPassOk: true,
};

/** Build the complete public-position query used by the adviser. KataGo gets
 * real holes, stones, komi, positional superko semantics, area scoring and a
 * native legality mask. It intentionally gets no WHRNG seed or predicted
 * faction response. */
export function buildKataGoQuery(
  id: string,
  board: GoBoard,
  previousBoards: readonly string[][],
  komi: number,
  visits: number,
): KataGoQuery {
  const { initialStones, blockedPoints } = boardSetup(board);
  const allowed = legalMoves(board, "X", previousBoards).map(([x, y]) => vertex(x, y));
  allowed.push("pass");
  return {
    id,
    initialStones,
    blockedPoints,
    initialPlayer: "B",
    moves: [],
    rules: IPVGO_KATAGO_RULES,
    komi,
    boardXSize: board.size,
    boardYSize: board.size,
    // A one-visit analysis evaluates only the root and may return no child.
    maxVisits: Math.max(2, Math.floor(visits)),
    analysisPVLen: 3,
    allowMoves: [{ player: "B", moves: allowed, untilDepth: 1 }],
  };
}

/** Analyze the White response that IPvGO predicts after one candidate Black
 * move. Each candidate gets its own query because KataGo's allowMoves is not
 * conditional on the parent branch. */
export function buildForcedReplyKataGoQuery(
  id: string,
  board: GoBoard,
  komi: number,
  visits: number,
  candidate: KataGoMove,
  predictedWhite: KataGoMove,
): KataGoQuery {
  const { initialStones, blockedPoints } = boardSetup(board);
  return {
    id,
    initialStones,
    blockedPoints,
    initialPlayer: "B",
    moves: [["B", moveVertex(candidate)]],
    rules: IPVGO_KATAGO_RULES,
    komi,
    boardXSize: board.size,
    boardYSize: board.size,
    maxVisits: Math.max(2, Math.floor(visits)),
    analysisPVLen: 3,
    allowMoves: [{ player: "W", moves: [moveVertex(predictedWhite)], untilDepth: 1 }],
  };
}

export function parseKataGoVertex(text: string, size: number): KataGoMove {
  if (text.toLowerCase() === "pass") return "pass";
  const explicit = /^\((\d+),(\d+)\)$/.exec(text);
  if (explicit) return [Number(explicit[1]), Number(explicit[2])];
  const gtp = /^([A-HJ-Z])(\d+)$/i.exec(text);
  if (!gtp) throw new Error(`unrecognized KataGo move ${text}`);
  const code = gtp[1]!.toUpperCase().charCodeAt(0);
  const x = code - 65 - Number(code > 73);
  const y = size - Number(gtp[2]);
  if (x < 0 || y < 0 || x >= size || y >= size) {
    throw new Error(`KataGo move outside ${size}x${size}: ${text}`);
  }
  return [x, y];
}

export interface KataGoAdvice {
  move: KataGoMove;
  visits: number;
  prior?: number;
  winrate?: number;
  scoreLead?: number;
}

export interface KataGoForcedEvaluation {
  visits: number;
  winrate: number;
  scoreLead: number;
  utility?: number;
}

export class KataGoAdvisor {
  readonly process: ReturnType<typeof Bun.spawn>;
  private readonly pending = new Map<string, {
    resolve: (response: KataGoResponse) => void;
    reject: (error: Error) => void;
  }>();
  private readonly pump: Promise<void>;
  private nextId = 0;
  private static readonly REQUEST_TIMEOUT_MS = 120_000;

  constructor(binary: string, model: string, config: string) {
    this.process = Bun.spawn([
      binary, "analysis", "-model", model, "-config", config,
    ], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.pump = this.readResponses();
  }

  private nextQueryId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private async readResponses(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const response = JSON.parse(line) as KataGoResponse;
          if (response.warning && !response.moveInfos && !response.error) continue;
          const id = response.id;
          if (!id) throw new Error(`KataGo response has no id: ${line}`);
          const waiter = this.pending.get(id);
          if (!waiter) throw new Error(`unexpected KataGo response id ${id}`);
          this.pending.delete(id);
          if (response.error) {
            waiter.reject(new Error(`KataGo ${response.field ?? "query"}: ${response.error}`));
          } else waiter.resolve(response);
        }
      }
      const code = await this.process.exited;
      throw new Error(`KataGo analysis process exited with code ${code}`);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    }
  }

  private async query(query: KataGoQuery): Promise<KataGoResponse> {
    const { id } = query;
    const responsePromise = new Promise<KataGoResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.process.stdin.write(`${JSON.stringify(query)}\n`);
    this.process.stdin.flush();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.pending.delete(id);
        this.process.kill();
        reject(new Error(`KataGo timed out while advising ${id}`));
      }, KataGoAdvisor.REQUEST_TIMEOUT_MS);
    });
    const response = await Promise.race([responsePromise, timeoutPromise]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    return response;
  }

  async advise(
    board: GoBoard,
    previousBoards: readonly string[][],
    komi: number,
    visits: number,
  ): Promise<KataGoAdvice> {
    const id = this.nextQueryId("ipvgo");
    const response = await this.query(buildKataGoQuery(id, board, previousBoards, komi, visits));
    const selected = response.moveInfos?.reduce<KataGoMoveInfo | undefined>((best, move) =>
      !best || move.order < best.order ? move : best, undefined);
    if (!selected) throw new Error(`KataGo returned no move for ${id}`);
    return {
      move: parseKataGoVertex(selected.move, board.size),
      visits: selected.visits ?? visits,
      ...(selected.prior !== undefined ? { prior: selected.prior } : {}),
      ...(selected.winrate !== undefined ? { winrate: selected.winrate } : {}),
      ...(selected.scoreLead !== undefined ? { scoreLead: selected.scoreLead } : {}),
    };
  }

  /** Kata's raw policy supplies breadth cheaply; order-0 search is always
   * retained so the ordinary adviser remains one of the candidates. */
  async shortlist(
    board: GoBoard,
    previousBoards: readonly string[][],
    komi: number,
    visits: number,
    limit: number,
    allowed?: ReadonlySet<string>,
  ): Promise<KataGoAdvice[]> {
    const id = this.nextQueryId("shortlist");
    const query = buildKataGoQuery(id, board, previousBoards, komi, visits);
    query.includePolicy = true;
    const response = await this.query(query);
    const searched = [...(response.moveInfos ?? [])].sort((a, b) => a.order - b.order);
    const searchedByMove = new Map(searched.map((info) => [moveVertex(parseKataGoVertex(info.move, board.size)), info]));
    const legal: KataGoMove[] = legalMoves(board, "X", previousBoards);
    legal.push("pass");
    const policy = response.policy ?? [];
    const policyValue = (move: KataGoMove): number => move === "pass"
      ? policy[board.size * board.size] ?? -1
      : policy[move[1] * board.size + move[0]] ?? -1;
    const allowedKey = (move: KataGoMove): string => move === "pass"
      ? "pass" : `${move[0]},${move[1]}`;
    const ranked = legal
      .filter((move) => !allowed || allowed.has(allowedKey(move)))
      .sort((a, b) => policyValue(b) - policyValue(a));
    const selected: KataGoMove[] = [];
    for (const info of searched) {
      const move = parseKataGoVertex(info.move, board.size);
      if (allowed && !allowed.has(allowedKey(move))) continue;
      if (!selected.some((item) => moveVertex(item) === moveVertex(move))) selected.push(move);
      if (selected.length >= limit) break;
    }
    for (const move of ranked) {
      if (!selected.some((item) => moveVertex(item) === moveVertex(move))) selected.push(move);
      if (selected.length >= limit) break;
    }
    return selected.map((move) => {
      const info = searchedByMove.get(moveVertex(move));
      return {
        move,
        visits: info?.visits ?? visits,
        prior: info?.prior ?? policyValue(move),
        ...(info?.winrate !== undefined ? { winrate: info.winrate } : {}),
        ...(info?.scoreLead !== undefined ? { scoreLead: info.scoreLead } : {}),
      };
    });
  }

  async evaluateForcedReply(
    board: GoBoard,
    komi: number,
    visits: number,
    candidate: KataGoMove,
    predictedWhite: KataGoMove,
  ): Promise<KataGoForcedEvaluation> {
    const id = this.nextQueryId("forced");
    const response = await this.query(buildForcedReplyKataGoQuery(
      id, board, komi, visits, candidate, predictedWhite,
    ));
    const forced = response.moveInfos?.reduce<KataGoMoveInfo | undefined>((best, move) =>
      !best || move.order < best.order ? move : best, undefined);
    const value = forced ?? response.rootInfo;
    if (!value || value.winrate === undefined || value.scoreLead === undefined) {
      throw new Error(`KataGo returned no forced-reply value for ${id}`);
    }
    return {
      visits: value.visits ?? visits,
      winrate: value.winrate,
      scoreLead: value.scoreLead,
      ...(value.utility !== undefined ? { utility: value.utility } : {}),
    };
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    await this.process.exited;
    await this.pump;
  }
}
