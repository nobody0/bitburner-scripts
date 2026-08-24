import { parseGoals } from "../shared/goals/presets.ts";
import { only } from "../shared/features/profile.ts";
import { runGame } from "../sim/game-run.ts";
import { findProfile } from "../sim/profiles.ts";

/** Reproduce the conservative pre-BN15 Darkscape valuation.
 *
 * Both arms start with identical post-purchase cash. The treatment receives
 * only DarkscapeNavigator.exe and the dnet feature; everything else, including
 * ordinary coding contracts and the aggregate Go runtime, is shared. */
const requested = process.argv.slice(2).map(Number).filter(Number.isFinite);
const seeds = requested.length > 0 ? requested : [1, 2, 3];
const profile = findProfile("bn1-full");
const baseFeatures = ["hacking", "factions", "progression", "go", "career", "hacknet", "stock", "side"] as const;
const calibrationHorizonMs = 12 * 60_000;

const rows: { seed: number; controlMs: number; treatmentMs: number; rawSavedSec: number; savedSec: number }[] = [];
for (const seed of seeds) {
  const common = {
    goal: parseGoals(["bn:1", "installs:2"]),
    seed,
    horizonMs: calibrationHorizonMs,
    bitnode: 1,
    homeRam: profile.homeRam,
    startingMoney: profile.startingMoney,
    ...profile.world,
    telemetry: false,
  } as const;
  const control = await runGame({ ...common, features: only(...baseFeatures) });
  const treatment = await runGame({
    ...common,
    features: only(...baseFeatures, "dnet"),
    homeFiles: [...(profile.world?.homeFiles ?? []), "DarkscapeNavigator.exe"],
  });
  if (control.validity !== "valid" || treatment.validity !== "valid") {
    throw new Error(`invalid calibration seed ${seed}: ${JSON.stringify({ control, treatment })}`);
  }
  let rawSavedSec: number;
  if (control.reached && treatment.reached) {
    rawSavedSec = (control.timeToGoalMs - treatment.timeToGoalMs) / 1_000;
  } else {
    const controlRemaining = control.strategy.nodeRemainingSec;
    const treatmentRemaining = treatment.strategy.nodeRemainingSec;
    if (!Number.isFinite(controlRemaining) || !Number.isFinite(treatmentRemaining)) {
      throw new Error(`seed ${seed} produced no comparable route forecast`);
    }
    rawSavedSec = controlRemaining! - treatmentRemaining!;
  }
  const row = {
    seed,
    controlMs: control.timeToGoalMs,
    treatmentMs: treatment.timeToGoalMs,
    rawSavedSec,
    savedSec: Math.min(24 * 60 * 60, Math.max(0, rawSavedSec)),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const ordered = rows.map((row) => row.savedSec).sort((a, b) => a - b);
const median = ordered[Math.floor(ordered.length / 2)]!;
console.log(JSON.stringify({
  medianSavedSec: median,
  conservativeSavedSec: Math.floor(median * 0.9),
  policy: "floor(90% of three-seed median)",
}));
