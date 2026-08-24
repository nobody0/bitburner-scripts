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

/** The three darknet facts only HOME can read, and the whole reason they are
 * here rather than in a RAM dodge: every one is 0 GB
 * (`RamCostGenerator.ts` — getStasisLinkLimit/getStasisLinkedServers/
 * getDarknetInstability all cost nothing), so a dodge stub bought nothing but
 * latency. They are home-owned facts, so home reads them inline and ships them
 * over the order channel.
 *
 * Everything ELSE the old `dnet.core` dodge read — darkweb's own details, its
 * neighbours, its RAM — was redundant: the resident standing on darkweb runs
 * `ns.dnet.probe()` + `getServerDetails` every mutation and drains the result
 * home. Home re-reading the same host from a stub was a second, slower,
 * hardcoded-cadence copy of a fact the beachhead already reports on the
 * mutation clock. So the darknet keeps exactly one prober — the agent — and
 * home contributes only what the agent structurally cannot see. `stasisLinked`
 * is read here too as a complete timestamped snapshot; the newest complete
 * direct or controller-produced set wins downstream. */
const dnetFacts: DirectProbe = {
  id: "dnet.facts",
  kind: "direct",
  feature: "dnet",
  requires: "dnet",
  // These change on lab-aug installs (the limit) and backdoor churn
  // (instability), not on the mutation clock, so a slow cadence is honest —
  // but the warm-up burst runs it once immediately on unlock, so the controller
  // has its stasis limit and instability from the first order it receives.
  everyMs: 30_000,
  merge: true,
  methods: ["dnet.getStasisLinkLimit", "dnet.getStasisLinkedServers", "dnet.getDarknetInstability"],
  run(ns: NS) {
    return [emitPartial("dnet", {
      stasisLinkLimit: ns["dnet"]["getStasisLinkLimit"](),
      stasisLinked: ns["dnet"]["getStasisLinkedServers"]().map(String),
      stasisObservedAt: Date.now(),
      instability: ns["dnet"]["getDarknetInstability"](),
    })];
  },
};

export const DIRECT_PROBES: readonly DirectProbe[] = [goCore, dnetFacts];
