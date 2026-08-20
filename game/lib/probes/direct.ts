import type { NS } from "@ns";
import { GO_REWARD_OPPONENTS } from "../../../shared/strategy/go/rules.ts";
import { emitPartial, type DirectProbe } from "./index.ts";

/** Zero-RAM synchronous probes; the runner verifies every declared method. */
const goCore: DirectProbe = {
  id: "go.core",
  kind: "direct",
  feature: "go",
  requires: "go",
  everyMs: 2_000,
  merge: true,
  methods: ["go.getGameState", "go.getOpponent", "go.analysis.getStats"],
  run(ns: NS) {
    const state = ns["go"]["getGameState"]();
    const rawStats = ns["go"]["analysis"]["getStats"]();
    const stats = GO_REWARD_OPPONENTS.flatMap((opponent) => {
      const entry = rawStats[opponent];
      return entry
        ? [{
            opponent,
            wins: entry.wins,
            losses: entry.losses,
            winStreak: entry.winStreak,
            highestWinStreak: entry.highestWinStreak,
            rep: entry.rep,
            bonusPercent: entry.bonusPercent,
            bonusDescription: entry.bonusDescription,
          }]
        : [];
    });
    return [emitPartial("go", {
      status: state.currentPlayer === "None" ? "gameOver" : state.currentPlayer === "White" ? "waitingOnAI" : "inProgress",
      currentPlayer: state.currentPlayer,
      opponent: ns["go"]["getOpponent"](),
      // whiteScore/blackScore are deliberately not read here. They are exact
      // functions of the board, and this probe's clock differs from the one
      // that publishes the board, so reading them would reintroduce a score
      // that disagrees with the position it is displayed against.
      komi: state.komi,
      bonusCycles: state.bonusCycles,
      stats,
    })];
  },
};

export const DIRECT_PROBES: readonly DirectProbe[] = [goCore];
