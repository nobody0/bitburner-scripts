import { describe, expect, test } from "bun:test";
import { emptyState, type ProjectedState } from "../ui/app/project.ts";
import { setView } from "../ui/app/lib/viewstate.ts";
import { TABS } from "../ui/app/tabs/index.ts";
import { augRows } from "../ui/app/tabs/factions-aug.ts";

/** The augmentation panel exists to answer three questions at a glance: what is
 * already mine, what has this cycle committed to, and what does each one do.
 * Every assertion here is one of those three. */

/** Two real catalogue entries, so the static table is exercised rather than a
 * fixture of it. `Neurotrainer I` is sold by several factions — including one we
 * are not in — which is the case the seller column has to compress. */
const OWNED = "Neurotrainer I";
const QUEUED = "Neurotrainer II";
const PLANNED = "Nuoptimal Nootropic Injector Implant";

function factionsState(over: Record<string, unknown> = {}): ProjectedState {
  const state = emptyState();
  state.topics.factions = {
    joined: ["CyberSec"],
    ownedAugs: [OWNED, QUEUED],
    standings: [{ name: "CyberSec", rep: 5_000, favor: 10 }],
    offers: [
      {
        name: PLANNED,
        faction: "CyberSec",
        price: 4_000_000,
        basePrice: 2_000_000,
        repReq: 20_000,
        affordableRep: false,
        repGap: 15_000,
        owned: false,
        score: 42.5,
      },
    ],
    plan: {
      context: {
        evaluatedAt: 0,
        horizonSec: 3_600,
        ownedAugCount: 2,
        queuedAugCount: 1,
        incomePerSec: 1_000,
        moneyAvailable: 1_000,
        moneyGranted: 0,
        holdsWorkSlot: true,
        favorToDonate: 150,
        priceQueue: { nonSoA: 1, ownedSoA: 0, neurofluxLevel: 0 },
      },
      objective: {
        factions: ["CyberSec", "NiteSec"],
        augmentations: [PLANNED],
        value: 10,
        foreclosed: [],
        portfolio: {
          packages: [
            {
              faction: "CyberSec", repTarget: 20_000, augmentations: [PLANNED], value: 8,
              etaSec: 600, rate: 0.013, marginalRate: 0.013, unlockSec: 0, repSec: 600,
              moneySec: 100, favorAfterInstall: 30, totalCost: 4_000_000,
              purchaseCost: 4_000_000, donationCost: 0, purpose: "augmentations" as const,
              workSecFromNow: 0,
            },
            {
              faction: "NiteSec", repTarget: 50_000, augmentations: [], value: 4,
              etaSec: 1_200, rate: 0.003, marginalRate: 0.003, unlockSec: 300, repSec: 900,
              moneySec: 0, favorAfterInstall: 12, totalCost: 0,
              purchaseCost: 0, donationCost: 0, purpose: "augmentations" as const,
              workSecFromNow: 600,
            },
          ],
          augmentations: [PLANNED],
          value: 12,
          budgetSec: 1_800,
          etaSec: 1_860,
          workSec: 1_800,
          moneySec: 100,
          boundGap: 0.12,
          basis: "owned=2",
          previousBudgetSec: 900,
        },
        horizonCurve: [
          { sec: 60, value: 2, rate: 0.005, factions: 1 },
          { sec: 1_800, value: 12, rate: 0.006, factions: 2 },
          { sec: 7_200, value: 14, rate: 0.002, factions: 2 },
        ],
      },
      action: { type: "workForFaction", faction: "CyberSec", workType: "hacking" },
      alternatives: [],
      blockers: [],
      bankedAugmentations: [],
    },
    ...over,
  } as ProjectedState["topics"]["factions"];
  state.topics.progression = {
    plan: { queuedAugmentations: [QUEUED] },
  } as ProjectedState["topics"]["progression"];
  return state;
}

describe("an augmentation's state is a word, not a shade of dot", () => {
  test("installed, queued and planned are three different states", () => {
    const rows = augRows(factionsState());
    const by = (name: string) => rows.find((row) => row.name === name);

    // `ownedAugs` includes purchases that have not been installed yet, so the
    // queue is the only thing separating "working for us" from "paid for".
    expect(by(OWNED)?.state).toBe("installed");
    expect(by(QUEUED)?.state).toBe("queued");
    expect(by(PLANNED)?.state).toBe("planned");
    // Something no joined faction sells is locked, not merely "not ready".
    expect(rows.some((row) => row.state === "locked")).toBe(true);
  });

  test("the rendered table carries the state and the score", () => {
    setView("augs.mode", "all");
    const html = TABS["factions"].render(factionsState());
    expect(html).toContain(`class="augstate installed"`);
    expect(html).toContain(`class="augstate queued"`);
    expect(html).toContain(`class="augstate planned"`);
    // `score` is published by strategy and used to be rendered nowhere.
    expect(html).toContain("42.50");
    setView("augs.mode", "available");
  });

  test("a seller list of thirty-one factions does not become the widest column", () => {
    setView("augs.mode", "all");
    const html = TABS["factions"].render(factionsState());
    // NeuroFlux is sold by nearly every faction. The cell names one seller and
    // counts the rest; the full list lives in a tooltip and the inspector.
    const rows = augRows(factionsState());
    const nfg = rows.find((row) => row.name === "NeuroFlux Governor")!;
    expect(nfg.factions.length).toBeGreaterThan(10);
    expect(html).toContain(`+${nfg.factions.length - 1}`);
    setView("augs.mode", "available");
  });
});

describe("the inspector answers what one augmentation actually does", () => {
  test("selecting a row renders its full effect list and every seller", () => {
    setView("augs.mode", "all");
    setView("augs.selected", PLANNED);
    const html = TABS["factions"].render(factionsState());
    expect(html).toContain('<tr class="picked">');
    expect(html).toContain("server-inspector");
    expect(html).toContain("Sellers");
    expect(html).toContain("worth to this run");
    // The table shows the top three multipliers; the inspector shows all of
    // them, which is the reason it exists.
    expect(html).toContain("Effect");
    setView("augs.selected", "");
    setView("augs.mode", "available");
  });

  test("a selection hidden by the active filter renders no orphan panel", () => {
    // The panel sits under the table, so a subject that is not in the table
    // would be a detail view of nothing.
    setView("augs.mode", "installed");
    setView("augs.selected", PLANNED);
    const html = TABS["factions"].render(factionsState());
    expect(html).not.toContain("server-inspector");
    setView("augs.selected", "");
    setView("augs.mode", "available");
  });
});

describe("the plan is a set, and says how long a cycle it is for", () => {
  test("the portfolio card lists every push in work order with its budget", () => {
    const html = TABS["factions"].render(factionsState());
    expect(html).toContain("Portfolio");
    expect(html).toContain("cycle budget");
    expect(html).toContain("NiteSec");
    // A moving budget has to read as adaptation, not thrash.
    expect(html).toContain("was ");
    // The sweep the budget was chosen from is shown, so it can be argued with.
    expect(html).toContain("cycle length");
  });

  test("no portfolio published means no portfolio card, not an empty one", () => {
    const state = factionsState();
    delete (state.topics.factions!.plan!.objective as { portfolio?: unknown }).portfolio;
    const html = TABS["factions"].render(state);
    expect(html).not.toContain("cycle budget");
    // ...and the rest of the tab still renders.
    expect(html).toContain("Augmentations");
  });
});
