import { expect, test } from "bun:test";
import { AUGMENTATIONS } from "../shared/features/augmentations.ts";
import { buildFrontiers } from "../shared/strategy/factions/packages.ts";
import { chooseBudget, repricePortfolio, solvePortfolio } from "../shared/strategy/factions/portfolio.ts";
import { weightsFromMarginals, type AugInfo, type PriceContext } from "../shared/strategy/factions/augs.ts";
import type { FactionStanding, FactionsView } from "../shared/strategy/factions/state.ts";
import { INSTALL_OVERHEAD_SEC } from "../shared/strategy/progression/eta.ts";
import type { ChannelWorth } from "../shared/strategy/income.ts";

/** The set solver runs inside the controller's planning budget, and its inner
 * loop is an evaluation over the whole catalogue. The predecessor's frontier
 * carries a comment about a pass that grew from milliseconds to seconds when a
 * noisy estimate appeared; this pins that the same thing cannot happen here.
 *
 * A full board: every faction the game has, the whole 137-entry catalogue, and
 * a 24-budget sweep — the most expensive shape a real run can present. */

const WORTH: ChannelWorth = new Map<string, number>([
  ["money", 1_000], ["hacking", 5_000], ["combat", 1_000],
  ["reputation", 500], ["augmentations", 900],
]) as ChannelWorth;

function fullBoard(): FactionsView {
  const catalog = new Map<string, AugInfo>();
  const factionNames = new Set<string>();
  for (const [name, info] of Object.entries(AUGMENTATIONS)) {
    catalog.set(name, {
      name,
      baseCost: info.cost,
      baseRepRequirement: info.rep,
      factions: [...info.factions],
      prereqs: [...(info.prereqs ?? [])],
      mults: { ...(info.mults ?? {}) },
      ...(info.multsUnknown ? { multsUnknown: true } : {}),
    });
    for (const faction of info.factions) factionNames.add(faction);
  }
  const factions: FactionStanding[] = [...factionNames].map((name) => ({
    name,
    joined: true,
    invited: false,
    rep: 0,
    favor: 0,
    requirements: [],
    enemies: [],
    offers: { hacking: true, field: true, security: true },
    special: false,
  }));
  const priceContext: PriceContext = {
    queuedNonSoA: 0, ownedSoA: 0, neurofluxLevel: 0, sf11Level: 0, augMoneyCost: 1, augRepCost: 1,
  };
  return {
    time: 0,
    person: {
      skills: { hacking: 1_500, strength: 800, defense: 800, dexterity: 800, agility: 800, charisma: 800, intelligence: 50 },
      mults: { faction_rep: 1 },
    } as FactionsView["person"],
    requirementView: { augCount: 0 } as FactionsView["requirementView"],
    repContext: { factionWorkRepGain: 1, shareBonus: 1, sf15Level: 0, hasFocusAug: false },
    priceContext,
    factions,
    catalog,
    owned: new Set(),
    queued: new Set(),
    weights: weightsFromMarginals(WORTH),
    horizonSec: 100_000,
    rates: { best: new Map(), worth: WORTH },
    targetAugCount: 30,
    favorToDonate: 150,
    moneyGranted: 0,
    moneyAvailable: 1e12,
    pendingProceeds: 0,
    proceedsSettling: false,
    holdsWorkSlot: true,
    incomePerSec: 1e7,
    sf4Level: 3,
    bitNode: 4,
  };
}

test("a full-board budget sweep stays inside the controller's planning budget", () => {
  const view = fullBoard();
  const blockers = new Map(view.factions.map((faction) => [faction.name, []]));
  const { frontiers } = buildFrontiers(view, blockers);
  expect(frontiers.size).toBeGreaterThan(10);

  // A single re-solve at a committed budget is what runs on an ordinary pass.
  const singleStart = performance.now();
  const single = solvePortfolio(frontiers, view, 3_600);
  const singleMs = performance.now() - singleStart;


  // The full sweep runs only on the forecast's recalibration tick.
  const sweepStart = performance.now();
  const { curve } = chooseBudget(frontiers, view, INSTALL_OVERHEAD_SEC);
  const sweepMs = performance.now() - sweepStart;

  // What an ORDINARY controller pass costs: the committed set re-priced against
  // today's frontiers. The search runs on the forecast's recalibration cadence,
  // not twice a second, so this is the number the controller actually pays.
  const committed = single.choices.map((choice) => ({
    faction: choice.faction,
    repTarget: choice.pkg.repTarget,
  }));
  const repriceStart = performance.now();
  for (let i = 0; i < 20; i++) repricePortfolio(committed, frontiers, fullBoard());
  const repriceMs = (performance.now() - repriceStart) / 20;

  expect(curve.length).toBeGreaterThan(1);
  const breakpoints = [...frontiers.values()].reduce((count, frontier) => count + frontier.length, 0);
  console.log(
    `bench: ${frontiers.size} factions / ${breakpoints} breakpoints -> set of ${single.choices.length}; ` +
      `reprice ${repriceMs.toFixed(2)}ms/pass, cold solve ${singleMs.toFixed(1)}ms, sweep ${sweepMs.toFixed(1)}ms`,
  );
  // Generous ceilings: guards against an accidental quadratic, not performance
  // targets. A change that trips them has changed complexity class.
  expect(repriceMs).toBeLessThan(15);
  expect(singleMs).toBeLessThan(400);
  expect(sweepMs).toBeLessThan(4_000);
});
