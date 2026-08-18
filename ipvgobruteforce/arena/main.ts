import { join, resolve } from "node:path";
import {
  auditPlaybookRoutes,
  loadPhasePlaybook,
  playbookModel,
  playbookOpponents,
} from "./playbook.ts";
import {
  auditPlaybookRuntimeRoots,
  playPlaybookArenaGame,
  type ArenaTiming,
  type PlaybookArenaGame,
} from "../../sim/ipvgobruteforce-arena.ts";

const DEFAULT_PLAYBOOK = join(
  import.meta.dir,
  "../data/seeded-phases/all-5x5-v1/merged/playbook.phase.js",
);
const GENERATION_CORPORA = [
  "netburners-5x5-epoch2697-v16-sweep",
  "slum-snakes-5x5-epoch2697-v16-sweep",
  "black-hand-5x5-epoch2697-v16-sweep",
  "tetrads-5x5-epoch2697-v16-sweep",
  "daedalus-5x5-epoch2697-v16-sweep",
  "illuminati-5x5-epoch2697-v16-sweep",
] as const;

function valueAfter(name: string): string | undefined {
  const exact = Bun.argv.indexOf(name);
  if (exact >= 0) return Bun.argv[exact + 1];
  return Bun.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function integerFlag(name: string, fallback: number): number {
  const raw = valueAfter(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function selectedTimings(): ArenaTiming[] {
  const raw = valueAfter("--timing") ?? "all";
  if (raw === "all") return ["minimum", "maximum", "random"];
  if (raw === "minimum" || raw === "maximum" || raw === "random") return [raw];
  throw new Error("--timing must be minimum, maximum, random, or all");
}

function playtimeEpochs(playbook: Awaited<ReturnType<typeof loadPhasePlaybook>>): number[] {
  const raw = valueAfter("--playtime-epochs") ?? [...new Set(
    playbookOpponents(playbook).map((enemy) => playbookModel(playbook, enemy).playtimeEpoch),
  )].join(",");
  const epochs = raw.split(",").map(Number);
  if (epochs.length === 0 || epochs.some((epoch) => !Number.isInteger(epoch) || epoch < 0)) {
    throw new Error("--playtime-epochs must be comma-separated non-negative integers");
  }
  return [...new Set(epochs)];
}

export async function auditGeneration() {
  const corpora: Record<string, {
    certifiedRoots: number;
    unknownRoots: number;
    fullyCertifiedPhases: number;
  }> = {};
  let wins = 0;
  let unknown = 0;
  let powerOptimalRoots = 0;
  for (const corpus of GENERATION_CORPORA) {
    const path = join(import.meta.dir, "../data/seeded-phases", corpus, "generated/summary.tsv");
    const metrics = Object.fromEntries((await Bun.file(path).text()).trimEnd().split("\n")
      .slice(1).map((line) => line.split("\t", 2)));
    const certifiedRoots = Number(metrics.certified_phase_board_roots);
    const expectedRoots = Number(metrics.expected_phase_board_roots);
    const fullyCertifiedPhases = Number(metrics.fully_certified_phases);
    const unknownRoots = expectedRoots - certifiedRoots;
    powerOptimalRoots += Number(metrics.power_optimal_phase_board_roots ?? 0);
    corpora[corpus] = { certifiedRoots, unknownRoots, fullyCertifiedPhases };
    wins += certifiedRoots;
    unknown += unknownRoots;
  }
  return {
    exhaustive: unknown === 0,
    optimalityProven: unknown === 0 && powerOptimalRoots === wins,
    wins,
    unknown,
    corpora,
  };
}

function auditFixedOpponentRoutes(playbook: Awaited<ReturnType<typeof loadPhasePlaybook>>, enemy: string) {
  if (!("OPPONENTS" in playbook)) return undefined;
  const entries = new Set<number>();
  let totalWaits = 0;
  let maximumWaits = 0;
  for (let phase = 0; phase < playbook.PHASES; phase++) {
    const route = playbook.selectRoot(phase, enemy);
    entries.add(route.entryPhase);
    totalWaits += route.waits;
    maximumWaits = Math.max(maximumWaits, route.waits);
  }
  return {
    enemy,
    entryPhases: entries.size,
    meanWaits: totalWaits / playbook.PHASES,
    maximumWaits,
  };
}

function summarize(games: readonly PlaybookArenaGame[]) {
  const failures = games.filter((game) => !game.won);
  const rounds = games.map((game) => game.policyRounds).sort((a, b) => a - b);
  const byTiming = Object.fromEntries(selectedTimings().map((timing) => {
    const selected = games.filter((game) => game.timing === timing);
    const wins = selected.filter((game) => game.won).length;
    return [timing, { games: selected.length, wins, losses: selected.length - wins }];
  }));
  const byOpponent = Object.fromEntries([...new Set(games.map((game) => game.enemy))].map((enemy) => {
    const selected = games.filter((game) => game.enemy === enemy);
    const wins = selected.filter((game) => game.won).length;
    return [enemy, { games: selected.length, wins, losses: selected.length - wins }];
  }));
  const totalPower = games.reduce((sum, game) => sum + game.score.X, 0);
  const playedTurns = games.reduce((sum, game) => sum + game.policyRounds, 0);
  const totalTurns = games.reduce((sum, game) => sum + game.policyRounds + game.dodgedBoards, 0);
  const processingSamples = games.flatMap((game) => [
    game.processingMilliseconds.minimum,
    game.processingMilliseconds.maximum,
  ]).filter((value): value is number => value !== null);
  return {
    games: games.length,
    wins: games.length - failures.length,
    losses: failures.length,
    winRate: games.length ? (games.length - failures.length) / games.length : 0,
    completed: games.filter((game) => game.completed).length,
    byTiming,
    byOpponent,
    aggregatePowerPerTurnIncludingDodges: totalPower / Math.max(1, totalTurns),
    aggregatePowerPerPlayedTurn: totalPower / Math.max(1, playedTurns),
    policyRounds: {
      mean: games.length ? games.reduce((sum, game) => sum + game.policyRounds, 0) / games.length : 0,
      p95: rounds[Math.min(rounds.length - 1, Math.floor(rounds.length * 0.95))] ?? 0,
      maximum: rounds.at(-1) ?? 0,
    },
    alignments: games.reduce((sum, game) => sum + game.alignments, 0),
    controlledSleeps: games.reduce((sum, game) => sum + game.controlledSleeps, 0),
    whiteNoOps: games.reduce((sum, game) => sum + game.whiteNoOps, 0),
    completionTicks: {
      one: games.reduce((sum, game) => sum + game.completionTicks.one, 0),
      two: games.reduce((sum, game) => sum + game.completionTicks.two, 0),
      three: games.reduce((sum, game) => sum + game.completionTicks.three, 0),
      four: games.reduce((sum, game) => sum + game.completionTicks.four, 0),
      fiveOrMore: games.reduce((sum, game) => sum + game.completionTicks.fiveOrMore, 0),
    },
    processingMilliseconds: {
      minimum: processingSamples.length ? Math.min(...processingSamples) : null,
      maximum: processingSamples.length ? Math.max(...processingSamples) : null,
    },
    failures: failures.slice(0, 50).map((game) => ({
      enemy: game.enemy,
      startPhase: game.startPhase,
      entryPhase: game.entryPhase,
      timing: game.timing,
      defenseSeed: game.defenseSeed,
      score: game.score,
      failure: game.failure ?? "terminal loss",
    })),
  };
}

async function main(): Promise<void> {
  const playbookPath = resolve(valueAfter("--playbook") ?? DEFAULT_PLAYBOOK);
  const playbook = await loadPhasePlaybook(playbookPath);
  const routes = auditPlaybookRoutes(playbook);
  const requestedOpponent = valueAfter("--opponent");
  const availablePolicies = requestedOpponent === undefined
    ? routes.uniqueEntryPolicies
    : "OPPONENTS" in playbook
      ? [...new Map(Array.from({ length: playbook.PHASES }, (_, phase) => {
          const route = playbook.selectRoot(phase, requestedOpponent);
          return [route.entryPhase, route] as const;
        })).values()]
      : routes.uniqueEntryPolicies.filter((route) => route.enemy === requestedOpponent);
  if (availablePolicies.length === 0) {
    throw new Error(`no committed policies for opponent ${String(requestedOpponent)}`);
  }
  const runtimeRoots = auditPlaybookRuntimeRoots(playbook, availablePolicies, playtimeEpochs(playbook));
  const fixedOpponentRoutes = requestedOpponent === undefined
    ? undefined
    : auditFixedOpponentRoutes(playbook, requestedOpponent);
  const generation = playbookPath === resolve(DEFAULT_PLAYBOOK)
      && !Bun.argv.includes("--skip-generation-audit")
    ? await auditGeneration()
    : undefined;
  const limit = Math.max(1, integerFlag("--games", availablePolicies.length));
  const repeats = Math.max(1, integerFlag("--defense-repeats", 1));
  const defenseSeed = integerFlag("--defense-seed", 0x3c6e_f372);
  const bonusCycles = valueAfter("--bonus-cycles") === undefined
    ? undefined
    : Math.max(0, integerFlag("--bonus-cycles", 0));
  const requestedStart = valueAfter("--start-phase");
  const sweepStarts = Bun.argv.includes("--sweep-start-phases");
  const starts = sweepStarts
    ? Array.from({ length: limit }, (_, index) => ({
        enemy: requestedOpponent ?? "",
        entryPhase: Math.floor(index * playbook.PHASES / limit),
        waits: 0,
      }))
    : requestedStart === undefined
    ? availablePolicies.slice(0, limit)
    : [{ enemy: "", entryPhase: Number(requestedStart), waits: 0 }];
  if (starts.some((route) => !Number.isInteger(route.entryPhase))) {
    throw new Error("--start-phase must be an integer");
  }
  const timings = selectedTimings();
  const allTies = Bun.argv.includes("--all-ties");
  const ties: (number | undefined)[] = allTies ? [0, 0.25, 0.5, 0.75, 0.999_999] : [undefined];
  const games: PlaybookArenaGame[] = [];
  for (const route of starts) for (const timing of timings) for (const tieRoll of ties) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const startPhase = route.entryPhase;
      const stream = (defenseSeed + Math.imul(repeat, 0x9e37_79b9) + startPhase) >>> 0;
      games.push(await playPlaybookArenaGame(playbook, startPhase, {
        timing,
        defenseSeed: stream,
        timingSeed: stream ^ 0xa5a5_a5a5,
        ...(tieRoll === undefined ? {} : { tieRoll }),
        enterCommittedPhase: !sweepStarts && requestedStart === undefined,
        ...((sweepStarts || requestedStart === undefined) && route.enemy
          ? { opponent: route.enemy } : {}),
        ...(bonusCycles === undefined ? {} : { bonusCycles }),
        trace: Bun.argv.includes("--trace"),
      }));
    }
  }
  const result = {
    ok: runtimeRoots.misses === 0
      && (generation?.optimalityProven ?? true)
      && games.every((game) => game.won),
    playbook: {
      path: playbookPath,
      schema: playbook.PLAYBOOK_SCHEMA,
      opponents: playbookOpponents(playbook),
      boardSize: playbook.BOARD_SIZE,
      models: Object.fromEntries(playbookOpponents(playbook).map((enemy) => [
        enemy,
        playbookModel(playbook, enemy),
      ])),
    },
    routes: {
      phases: routes.phases,
      immediateEntries: routes.enterPhases,
      initialDodges: routes.dodgePhases,
      committedEntryPolicies: routes.uniqueEntryPolicies.length,
      meanDodgedBoards: routes.meanDodges,
      maximumDodgedBoards: routes.maximumDodges,
    },
    runtimeRoots,
    ...(fixedOpponentRoutes ? { fixedOpponentRoutes } : {}),
    ...(generation ? { generation } : {}),
    arena: summarize(games),
    ...(Bun.argv.includes("--trace") ? { games } : {}),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) await main();
