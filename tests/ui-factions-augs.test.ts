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
const NFG = "NeuroFlux Governor";

function factionsState(
  over: Record<string, unknown> = {},
  /** The progression topic, which is what says how much of `factions.ownedAugs`
   *  is merely QUEUED. `null` means it never arrived. */
  progression: Record<string, unknown> | null = { plan: { queuedAugmentations: [QUEUED] } },
): ProjectedState {
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
  // Through `unknown`: these fixtures are deliberately PARTIAL topics, which is
  // what the wire delivers before every probe has run.
  if (progression) state.topics.progression = progression as unknown as ProjectedState["topics"]["progression"];
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
    // With no live offer there is nothing to say `rep short` or `locked` WITH:
    // the bundled table knows neither this node's sellers nor its scaled reputation gate.
    expect(rows.some((row) => row.state === "unknown")).toBe(true);
    expect(rows.some((row) => row.state === "locked")).toBe(false);
  });

  test("the rendered table carries the state and the score", () => {
    setView("augs.mode", "all");
    const html = TABS["factions"].render(factionsState());
    expect(html).toContain(`class="augstate installed"`);
    expect(html).toContain(`class="augstate queued"`);
    expect(html).toContain(`class="augstate planned"`);
    // Render the strategy-published score.
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

describe("what we own is split by the wire, not by a digest that lags it", () => {
  const by = (rows: ReturnType<typeof augRows>, name: string) => rows.find((row) => row.name === name);

  test("the two ownership lists are differenced, so a stale plan cannot report a purchase as installed", () => {
    // `factions.ownedAugs` gains a purchase the instant it is made, while the
    // plan's `queuedAugmentations` is republished once a minute — so during the
    // end-loaded sweep the plan says the queue is empty and it is not.
    const rows = augRows(factionsState({}, { ownedAugs: { [OWNED]: 1 }, plan: { queuedAugmentations: [] } }));
    expect(by(rows, OWNED)?.state).toBe("installed");
    expect(by(rows, QUEUED)?.state).toBe("queued");
  });

  test("installed ownership alone is enough — no plan needed", () => {
    const rows = augRows(factionsState({}, { ownedAugs: { [OWNED]: 1 } }));
    expect(by(rows, OWNED)?.state).toBe("installed");
    expect(by(rows, QUEUED)?.state).toBe("queued");
  });

  test("NeuroFlux installed at level 3 with one more bought still reads queued", () => {
    const rows = augRows(
      factionsState({ ownedAugs: [OWNED, NFG, NFG] }, { ownedAugs: { [OWNED]: 1, [NFG]: 3 } }),
    );
    // The duplicate list entries ARE the queued levels, so the count is
    // compared against "one installed copy", not deduped away.
    expect(by(rows, NFG)?.state).toBe("queued");
  });

  test("with no progression topic at all a purchase is owned, never installed", () => {
    const rows = augRows(factionsState({}, null));
    expect(by(rows, OWNED)?.state).toBe("owned");
    expect(by(rows, QUEUED)?.state).toBe("owned");
    expect(rows.some((row) => row.state === "installed")).toBe(false);
  });
});

describe("the bundled catalogue is not presented as a measurement", () => {
  test("an augmentation with no live offer is unknown, not rep short", () => {
    const rows = augRows(factionsState({ offers: [] }));
    const bitwire = rows.find((row) => row.name === "BitWire")!;
    // A bundled seller is not evidence of a live, scaled reputation offer.
    expect(bitwire.priced).toBe("bundled");
    expect(bitwire.state).toBe("unknown");
    expect(rows.some((row) => row.state === "short")).toBe(false);
  });

  test("a live catalogue proven complete replaces the bundled seller list", () => {
    // The Red Pill is removed from Daedalus in BN15. `offers.length === augTotal`
    // is the probe's own proof that its capped result is the whole catalogue.
    const rows = augRows(factionsState({ joined: ["CyberSec", "Daedalus"], augTotal: 1 }));
    const pill = rows.find((row) => row.name === "The Red Pill")!;
    expect(pill.sellerSource).toBe("live");
    expect(pill.factions).toEqual([]);
    expect(pill.state).not.toBe("short");
  });

  test("a capped or empty live catalogue keeps the bundled list", () => {
    const capped = augRows(factionsState({ joined: ["Daedalus"], augTotal: 99 }));
    expect(capped.find((row) => row.name === "The Red Pill")!.sellerSource).toBe("bundled");
    // `augTotal === 0` with an empty `offers` would satisfy the equality test on
    // an empty catalogue, which must NOT blank every seller list.
    const empty = augRows(factionsState({ joined: ["Daedalus"], offers: [], augTotal: 0 }));
    expect(empty.find((row) => row.name === "The Red Pill")!.factions).toContain("Daedalus");
  });

  test("the inspector marks a bundled price, and its state chip is markup not text", () => {
    setView("augs.mode", "all");
    setView("augs.selected", "BitWire");
    const html = TABS["factions"].render(factionsState({ offers: [] }));
    // A tile value is an HTML slot so the state chip remains markup.
    expect(html).toContain(`<div class="v"><span class="augstate`);
    expect(html).toContain("the bundled v3.0.1 table");
    setView("augs.selected", "");
    setView("augs.mode", "available");
  });
});
