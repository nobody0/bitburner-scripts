import { describe, expect, test } from "bun:test";
import { deriveCapabilities } from "../shared/features/unlock.ts";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import type { StateMap } from "../shared/telemetry/state-map.ts";
import { appendRecords, project, emptyState, EVENT_RING, SERIES_LIMIT, type ProjectedState } from "../ui/app/project.ts";
import { NO_SORT, setView, sortOf, toggleSort } from "../ui/app/lib/viewstate.ts";
import { groupRequests } from "../ui/app/tabs/career.ts";
import { DEFAULT_BITNODE_MULTIPLIERS } from "../shared/features/bitnode.ts";
import { skillFromExp } from "../shared/formulas.ts";
import { TABS, type TabId } from "../ui/app/tabs/index.ts";

/** Tab renderers are pure string builders (only `mount` touches the DOM), so
 * they can be exercised headlessly against empty and populated state. */

const ALL_TABS = Object.keys(TABS) as TabId[];

function renderAll(state: ProjectedState): void {
  for (const id of ALL_TABS) {
    const html = TABS[id].render(state);
    expect(html.length, `${id} rendered nothing`).toBeGreaterThan(0);
  }
}

describe("tab rendering", () => {
  test("every tab renders with no data at all", () => {
    renderAll(emptyState());
  });

  test("Hacking server table shows and explains host CPU cores", () => {
    const state = emptyState();
    state.servers.set("iron-gym", {
      hostname: "iron-gym",
      cpuCores: 8,
      maxRam: 32,
      ramUsed: 0,
      moneyMax: 1,
      moneyAvailable: 1,
      numOpenPortsRequired: 1,
    } as StateMap["servers"][string]);

    const html = TABS.hacking.render(state);
    expect(html).toContain('data-sort-key="ports"');
    expect(html).not.toContain('data-sort-key="roll"');
    expect(html).toContain("1.4375x grow/weaken effect");
    expect(html).toContain("1 required for NUKE; 0 port-opening programs available globally");
    expect(html).toContain(">1</span>");
    expect(html).toContain("0/32 · 8c</span>");
  });

  test("the Hacking panel reads its pipelines, landing order and allocation from the rollup", () => {
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      pipelines: [
        {
          host: "phantasy", role: "farm", mode: "hgw", segment: "farm", gb: 1_024,
          inFlight: { hack: 3, grow: 4, weaken: 8 },
          planThreads: { hack: 16, grow: 5, weaken: 4 },
        },
        {
          host: "n00dles", role: "prep", segment: "prep", gb: 64,
          inFlight: { hack: 0, grow: 2, weaken: 4 },
          eta: { seconds: 252, bound: "ram", prepped: false },
        },
      ],
      landingOrder: {
        batches: 1_000,
        inOrder: 990,
        patterns: [
          { planned: "h-w1-g-w2", observed: "h-w1-g-w2", batches: 980 },
          { planned: "h-w1-w1-g-w2", observed: "h-w1-w1-g-w2", batches: 10 },
          { planned: "h-w1-g-w2", observed: "h-h-g-w2", batches: 10 },
        ],
        incomplete: 7,
        anomalies: [{ at: 5_000, observed: "h-h-g-w2", planned: "h-w1-g-w2", target: "phantasy" }],
      },
      allocation: {
        threads: { farm: { hack: 1_600, grow: 500, weaken: 400 } },
        effectThreads: { farm: { hack: 1_600, grow: 625, weaken: 500 } },
      },
      batches: {
        // `landed === ops` on both: a settled batch cannot have lost an op.
        // Loss lives on the abandoned counters.
        hgw: {
          batches: 100, ops: 300, landed: 300, threads: { hack: 1_700, grow: 4_000, weaken: 600 },
          gb: 100_000, moneyEarned: 5e9, hacks: 99, spanMs: 2_000_000, graded: 100, inOrder: 98, noHack: 1,
          abandoned: 2, abandonedOps: 6, abandonedLanded: 4,
        },
        prep: {
          batches: 4, ops: 40, landed: 40, threads: { hack: 0, grow: 800, weaken: 400 },
          gb: 20_000, moneyEarned: 0, hacks: 0, spanMs: 800_000, inOrder: 0, noHack: 0,
          abandoned: 0, abandonedOps: 0, abandonedLanded: 0,
        },
      },
      recentBatches: [
        {
          id: 41, kind: "hgw", target: "phantasy", at: 9_000, spanMs: 20_000, ops: 3, landed: 3,
          threads: { hack: 17, grow: 40, weaken: 6 }, gb: 1_000, moneyEarned: 5e7,
          order: "h-g-w2", planned: "h-g-w2",
        },
        {
          id: 42, kind: "hgw", target: "phantasy", at: 9_500, spanMs: 21_000, ops: 3, landed: 2,
          threads: { hack: 17, grow: 40, weaken: 6 }, gb: 1_000, moneyEarned: 0,
          order: "g-h", planned: "h-g-w2",
        },
      ],
    } as StateMap["farm"];

    const html = TABS.hacking.render(state);
    // Per-batch analytics: a prep wave and a farm cycle are different units of
    // work, so they get a column each rather than one blended op count.
    expect(html).toContain(">hgw<");
    expect(html).toContain(">prep<");
    expect(html).toContain(`class="batchgrid"`);
    // The per-batch view is the headline; the per-kind grid is a disclosure
    // under it. A cumulative mean per kind is a number no individual batch
    // resembles, which is the reason for the demotion.
    expect(html).toContain(`data-open-key="hacking.batchKinds"`);
    // 300 ops over 100 batches, 100_000 GB over 100 batches, $5e9 over 100.
    expect(html).toContain("3.0");
    expect(html).toContain("1.00TB");
    // Batches that landed support with no steal. There is deliberately no
    // "N lost" assertion here any more: a settled batch has `landed === ops` by
    // construction, so that badge could never fire. Loss is the abandoned
    // counters and the global op residual instead.
    expect(html).toContain("1 no-hack");
    // There is deliberately NO launched-against-landed band any more. Those two
    // counters are equal by construction — a batch settles only once its last op
    // lands — so the chart that plotted them against each other drew one curve
    // twice, and the gap it was captioned as showing was always exactly zero.
    expect(html).not.toContain("launched</span> →");
    expect(html).not.toContain("300 launched");
    // Loss is reported where it can actually be observed: batches evicted
    // without ever settling, and the ops they took with them.
    expect(html).toContain("2 abandoned, 2 ops lost");
    // Ops launched that are neither in flight nor landed, as a run-level tile.
    expect(html).toContain("ops adrift");
    // In-order is a FRACTION, so the denominator is visible: it counts every
    // batch of the kind, including ones that never had a grid to be right about.
    expect(html).toContain("98 / 99 hack-bearing batches in order");
    // And a kind that has never produced a verdict says so instead of showing
    // a red 0%. Which kinds those are is not hardcoded — prep qualifies here
    // because it has graded nothing, not because it is called "prep".
    expect(html).toContain("no landing grid");

    // Throughput and allocation are per batch kind now, so the run-wide
    // op-rate card and its kind selector are gone.
    expect(html).not.toContain("ratechart");
    expect(html).not.toContain(`data-view-key="hacking.rate"`);
    // Batches lead the tab: you must be able to see one without scrolling.
    expect(html.indexOf("Batches")).toBeLessThan(html.indexOf("Landing order"));

    // A pipeline names itself rather than being labelled "farm target" by the
    // panel, so a mode or a role the viewer has never heard of still reads.
    expect(html).toContain("phantasy");
    expect(html).toContain("hgw");
    expect(html).toContain("n00dles");
    // The prep's ETA, and WHICH constraint set it — buying RAM does nothing
    // for a latency-bound prep, so the panel must not blur the two.
    expect(html).toContain("RAM-bound");

    // Landing order: the share that landed as planned, and the reorder named
    // rather than left as two strings to diff by eye.
    expect(html).toContain("h-w1-g-w2");
    expect(html).toContain("99.00%");
    expect(html).toContain("h-w1-w1-g-w2");
    expect(html).toContain("h landed where w1 was due");
    // Batches that never launched a hack are counted apart from the reorders.
    expect(html).toContain("no hack launched");

    // Allocation: the ratio normalised against hack, and the measured core
    // multiplier — 625/500 grow effect per thread.
    expect(html).toContain("1.00 : 0.31 : 0.25");
    expect(html).toContain("1.250x");
    // Hack is the control: cores do nothing for it.
    expect(html).toContain("1.000x");
  });

  test("the Hacking panel states what planning costs the main thread", () => {
    // The failure this exists for: a planner at ~100% main-thread occupancy
    // looked healthy because the only cost row was a peak duration, and the
    // consequence (landing error) lags the cause by a whole weaken time.
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      pumpMaxMs: 92,
      pumpOccupancy: 0.63,
      pumpMs: { meanMs: 58.2, maxMs: 92, count: 11 },
      wakePumps: 5823,
      wakePumpRate: 10.8,
      wakePumpsSkipped: { gap: 812, frame: 41 },
      weakenWindow: { pumps: 1204 },
      engineLatenessMs: { meanMs: 4210, maxMs: 28900 },
      ledger: { tracked: 21438, pendingBatches: 5102, pendingOps: 20408, onTarget: 21100 },
    } as StateMap["farm"];

    const html = TABS.hacking.render(state);
    // Occupancy, not just the peak: 63% of wall time is the finding.
    expect(html).toContain(">planner<");
    expect(html).toContain("63.0%");
    expect(html).toContain("58.2ms mean");
    // Past the critical threshold it is called out rather than merely shown.
    expect(html).toContain('class="bad">63.0%');
    expect(html).toContain('class="bad">4210.0ms mean');
    // The refusals are what say whether the planner is asked too often or is
    // simply too expensive, and the weaken window bypasses both throttles.
    expect(html).toContain("10.8/s");
    expect(html).toContain("refused 812 gap / 41 frame");
    expect(html).toContain("1.204e3 weaken window");
    // Depth is the independent variable of the cost above it.
    expect(html).toContain("2.144e4 ops");
    expect(html).toContain("5.102e3 pending batches");
  });

  test("the Hacking panel falls back to the peak pump before occupancy exists", () => {
    // Replay coverage: records written before the occupancy fields existed
    // must still render their one cost number rather than a dash.
    const state = emptyState();
    state.topics.farm = { totals: { moneyEarned: 0, hacks: 0 }, pumpMaxMs: 4.6 } as StateMap["farm"];
    const html = TABS.hacking.render(state);
    expect(html).toContain("4.6ms worst");
    expect(html).not.toContain("</span> of wall");
  });

  test("dense entity tables expose sortable views", () => {
    const state = emptyState();
    state.topics.hacknet = {
      servers: false, numNodes: 1, maxNumNodes: 30, purchaseNodeCost: 1e5,
      totalProduction: 500, productionPerSec: 1.5,
      nodes: [{ name: "hacknet-node-0", level: 10, ram: 2, cores: 1, production: 1.5, totalProduction: 500, timeOnline: 3600 }],
      nextUpgrades: [],
    } as StateMap["hacknet"];
    state.topics.stock = {
      hasWseAccount: true, hasTixApiAccess: true, has4SData: false, has4SDataApi: true,
      positions: [{ sym: "ECP", price: 100, ask: 100.2, bid: 99.8, maxShares: 1e6, shares: 100, avgPx: 90, sharesShort: 0, avgPxShort: 0, value: 9980, costBasis: 9000 }],
      signals: {}, portfolioValue: 9980, portfolioCost: 9000, orders: {},
      market: { tick: 120, ticksUntilCycle: 43, cyclesSeen: 1, lastFlipCount: 15, lastV: 0.42 },
    } as StateMap["stock"];
    state.topics.gang = {
      faction: "Slum Snakes", isHacking: false, respect: 100, respectGainRate: 1,
      wantedLevel: 2, wantedLevelGainRate: 0.1, wantedPenalty: 0.9, moneyGainRate: 500,
      power: 10, territory: 0.2, territoryClashChance: 0.1, territoryWarfareEngaged: false,
      respectForNextRecruit: 200, recruitsAvailable: 1, canRecruit: true, clashChances: {},
      members: [{
        name: "a", task: "Mug People", earnedRespect: 10, respectGain: 0.5,
        wantedLevelGain: 0.01, moneyGain: 100,
        skills: { hack: 1, str: 10, def: 10, dex: 10, agi: 10, cha: 1 },
        ascMults: { hack: 1, str: 1, def: 1, dex: 1, agi: 1, cha: 1 },
        upgrades: 2, augmentations: 1,
      }],
    } as StateMap["gang"];
    state.topics.bladeburner = {
      rank: 100, skillPoints: 5, stamina: [50, 100], city: "Sector-12",
      current: { type: "Contract", name: "Tracking", elapsedMs: 1000 }, skills: {},
      actions: [{ type: "contract", name: "Tracking", chance: [0.5, 0.7], timeMs: 30000, countRemaining: 100, level: 1, maxLevel: 5 }],
      cities: [],
    } as StateMap["bladeburner"];
    state.topics.sleeves = {
      count: 1,
      sleeves: [{
        index: 0, shock: 10, sync: 90, memory: 1, storedCycles: 0, city: "Sector-12",
        hp: { current: 10, max: 10 },
        skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1 },
        task: { type: "CRIME", detail: "Mug" }, purchasableAugs: [],
      }],
    } as StateMap["sleeves"];
    state.caps = deriveCapabilities({
      bitNode: 1, sourceFiles: { "2": 1, "7": 1, "9": 1, "10": 1 },
      inGang: true, inBladeburner: true, hasWseAccount: true, hasTixApiAccess: true,
    });

    for (const [tab, table] of [
      ["gang", "gang.members"],
      ["sleeves", "sleeves.list"],
      ["bladeburner", "bladeburner.actions"],
      ["stock", "stock.positions"],
      ["stock", "stock.market"],
      ["hacknet", "hacknet.nodes"],
    ] as const) {
      expect(TABS[tab].render(state)).toContain(`data-sort-table="${table}"`);
    }
  });

  test("the stock tab reads the whole ledger the topic publishes", () => {
    const state = emptyState();
    state.topics.stock = {
      hasWseAccount: true,
      hasTixApiAccess: true,
      has4SDataApi: false,
      positions: [{ sym: "ECP", price: 100, ask: 100.2, bid: 99.8, maxShares: 1e6, shares: 100, avgPx: 90, sharesShort: 0, avgPxShort: 0, value: 9980, costBasis: 9000 }],
      portfolioValue: 9980,
      portfolioCost: 9000,
      // A book underwater and a market that has not yet earned back its access.
      tradeCashFlow: -4e8,
      unlockSpend: 5.2e9,
      wealth: 1.2e10,
      orders: { ECP: [{ type: "Limit Buy Order", position: "Long", shares: 500, price: 95 }] },
      market: { tick: 120, ticksUntilCycle: 43, cyclesSeen: 1, lastFlipCount: 15, lastV: 0.42 },
      plan: {
        actions: [],
        ranked: [{ sym: "ECP", side: "long", forecast: 0.6, volatility: 0.0045, exact: true, manipulable: true, breakEvenTicks: 4.2, expectedProfit: 5e5 }],
        // No entry, only a reserve: the case that used to render as an idle tab.
        reserve: { amount: 2e8, ratePerSec: 5e4 },
        unlock: { type: "buy4SApi", cost: 25e9, investmentCost: 30.2e9, gainPerSec: 1e6, paybackSec: 25000, netOverHorizon: 1e9 },
        horizons: { positionSec: 258, unlockSec: 4320 },
        flat: false,
      },
    } as StateMap["stock"];
    const html = TABS["stock"].render(state);

    // Realised net is cost-basis, so holding leaves it at the cash flow plus
    // the book at cost: -4e8 + 9000, still a loss.
    expect(html).toContain("realised P/L");
    expect(html).toContain("contribution");
    // A P/L is signed OUTSIDE the currency mark, and coloured by direction.
    expect(html).toContain(`<span class="bad">-$4.000e8</span>`);
    // No records were folded, so the projection never watched this ledger open.
    // `tradeCashFlow` is cumulative and survives a controller handoff, so a first
    // sighting of it says nothing about when trading started: the denominator is
    // genuinely absent, and "unknown" is a different statement from "has not
    // traded yet". Dividing here is what produced a rate against the age of the
    // browser tab.
    expect(html).toContain("rate unknown");
    expect(html).not.toContain("/s since first trade");
    // The unlock ladder, three rungs rather than two loose yes/no bits. 4S is
    // unpaid here, so it is the one rung that is not `good`.
    expect(html).toContain("the unlock ladder");
    expect(html).toContain(`<span class="dot wait"`);
    // The cycle countdown now shows the flip count it was derived from.
    expect(html).toContain("15 flips");
    expect(html).toContain("v 0.42");
    // Total capital is DISTINCT from the next rung's price — the whole point of
    // publishing investmentCost.
    expect(html).toContain("total capital");
    expect(html).toContain("<td>$2.500e10</td><td>$3.020e10</td>");
    // The reserve explains a tab with no actions.
    expect(html).toContain("no entry clears its round trip yet");
    // The horizon, and the manipulable flag joining market to farm.
    expect(html).toContain("horizon");
    expect(html).toContain("the farm can drive this symbol's host");
    // Open orders are the game's, never ours, and the probe pays for them.
    expect(html).toContain("Limit Buy Order");
    // Nothing has been folded, so there is no curve and the charts are withheld
    // rather than drawn as two empty boxes.
    expect(html).not.toContain('id="stock-book"');
  });

  test("the capital charts appear once the fold has a curve to draw", () => {
    const record = (t: number, stock: Partial<StateMap["stock"]>): LogRecord =>
      ({ t, seq: t, run: "r", src: "sim", kind: "state", key: "stock", data: { hasWseAccount: true, hasTixApiAccess: true, ...stock } }) as LogRecord;
    // The first record carries an explicit `tradeCashFlow: 0` — the one
    // observation that proves this install had not traded yet, and so the only
    // thing that can arm the rate's denominator. Without it the fold cannot tell
    // "opened just now" from "opened before we attached", and the tile has to say
    // unknown (covered by the test above).
    const state = appendRecords(emptyState(), [
      record(0, { tradeCashFlow: 0, portfolioValue: 0, portfolioCost: 0, unlockSpend: 5.2e9 }),
      record(1_000, { tradeCashFlow: -10_000, portfolioValue: 10_000, portfolioCost: 10_000, unlockSpend: 5.2e9 }),
      record(2_000, { tradeCashFlow: -10_000, portfolioValue: 12_000, portfolioCost: 10_000, unlockSpend: 5.2e9 }),
    ]);
    const html = TABS["stock"].render(state);
    // Both canvases, each paired with its own tooltip — the id convention
    // mountChart resolves against.
    expect(html).toContain('id="stock-book"');
    expect(html).toContain('id="stock-booktip"');
    expect(html).toContain('id="stock-earnings"');
    expect(html).toContain('id="stock-earningstip"');
    // The rate tile now has an interval to divide by.
    expect(html).toContain("/s since first trade");
  });

  test("a collapsed position horizon is named, not left as an empty action list", () => {
    const state = emptyState();
    state.topics.stock = {
      hasWseAccount: true,
      hasTixApiAccess: true,
      plan: { actions: [], ranked: [], horizons: { positionSec: 0, unlockSec: 0 }, flat: true },
    } as StateMap["stock"];
    const html = TABS["stock"].render(state);
    expect(html).toContain("collapsed");
    expect(html).toContain("no trade can clear its round trip");
  });

  test("the stock tab no longer carries a decision history card", () => {
    // The trade log moved to the arbiter drawer's decision log: funding
    // decisions are cross-feature, so their history is too.
    const state = appendRecords(emptyState(), [
      { t: 10, seq: 1, run: "r", src: "sim", kind: "event", name: "investment.decision", data: { subsystem: "stock", plan: { entry: { sym: "ECP", side: "long" } } } } as never,
      { t: 20, seq: 2, run: "r", src: "sim", kind: "event", name: "investment.result", data: { subsystem: "stock", result: { action: "buy", ok: true, detail: "bought 1000 ECP" } } } as never,
    ]);
    state.topics.stock = { hasWseAccount: true, hasTixApiAccess: true } as StateMap["stock"];
    const html = TABS["stock"].render(state);
    expect(html).not.toContain("Decision history");
    // The fold still captured both episodes for the drawer.
    expect(state.decisionLog.map((episode) => episode.choice)).toEqual(["long ECP", "buy"]);
  });

  test("the darknet plan exposes operational evidence without authored rationale", () => {
    const state = emptyState();
    state.topics.dnet = {
      maxDepth: 1, stasisLinkLimit: 2, stasisLinked: [], topologyComplete: true,
      instability: { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0.1 },
      knowledge: {
        at: 1_000,
        generation: "15:0",
        truncated: true,
        totalHosts: 220,
        agents: { live: 1, seenEver: 1, lostSinceBoot: 0 },
        controller: { host: "darkweb", pid: 42, lastBeatAt: 900, alive: true, seedAttempts: 2 },
        hosts: [
          {
            hostname: "dn-1", depth: 1, lastSeenAt: 1_000, requiredCharisma: 50,
            maxRam: 16, blockedRam: 4, usableRam: 12,
            ram: { at: 1_000, total: 16, blocked: 4, used: 5 },
            modelId: "2G_cellular", passwordLength: 6,
            passwordFormat: "numeric", passwordHint: "the dog, obviously", data: "rex",
            logTrafficInterval: 0.5, difficulty: 3, isStationary: true,
            authState: "auth-required",
            facts: { depth: 1_000, modelId: 1_000, maxRam: 1_000 },
            caches: ["loot.cache", "hunt.d.cache"],
            attempt: {
              modelId: "2G_cellular", status: "failed", tried: 3, probes: 1,
              lastCode: 401, lastAt: 1_000 - 30_000,
              solving: true, solve: { phase: "narrowing", spent: 12 },
            },
            agent: {
              role: "resident", lastBeatAt: 1_000, alive: true, pending: 2,
              active: "phish", targets: ["dn-gone"],
              ram: { jobGb: 12, proberGb: 3.15, controllerGb: 0 },
            },
          },
        ],
      },
      plan: {
        ranked: [{ hostname: "dn-1", depth: 1, unlocks: 3 }],
        charismaNeeded: 50,
      },
      netDepth: 7,
      charisma: 400,
      grammar: { unrecognised: 5, shapes: { "a a: a#": 3 } },
      hold: {
        admitted: { pin: 1, walk: 1 },
        refused: { "no-slot": 2 },
        examples: [{ host: "dn-1", why: "no-slot", detail: "all 2 stasis links are spent" }],
        backdoors: {
          install: ["dn-1"],
          refused: { unstable: 1 },
          examples: [{ host: "dn-gone", why: "unstable", detail: "authentication already costs x1.30" }],
        },
      },
      labCache: { host: "th3_l4byr1nth", filename: "lab.cache", openable: false },
      // A live walk, mid-maze. The grid is the real produced size for the first
      // rung — 21x13, not the 20x14 `labData` asks for — with one corridor
      // resolved and the rest still fog, which is what a walk a few dozen moves
      // in actually looks like.
      lab: {
        host: "th3_l4byr1nth",
        width: 21,
        height: 13,
        grid: Array.from({ length: 13 }, (_, y) => Array.from({ length: 21 }, (_, x) => {
          if (x === 0 || y === 0 || x === 20 || y === 12) return "#";
          if ((x % 2) + (y % 2) === 0) return "#";
          if ((x % 2) + (y % 2) === 2) return ".";
          return y === 1 && x < 8 ? "." : x === 4 && y === 2 ? "#" : "?";
        }).join("")).join(""),
        candidates: ["19,11"],
        exitKnown: true,
        walkers: [
          {
            from: "dn-1", at: "7,1", moves: 24, walls: 0, radars: 1, attempts: 25,
            believedLeft: 30, startedAt: 1_000 - 60_000, beatAt: 1_000, pinned: true,
          },
        ],
      },
      farm: {
        admitted: { phish: 1 },
        refused: { "cache-none": 2 },
        examples: [{ host: "dn-1", why: "cache-none", detail: "no .cache file on this host" }],
        cacheHunter: "dn-1",
        expectedMoneyPerSec: 125_000,
        expectedCharismaExpPerSec: 42,
        // Two minutes into a three-minute window, so the countdown is a real
        // number rather than "open".
        lastPhishCacheAt: 1_000 - 120_000,
      },
      profit: {
        phishAttempts: 12,
        phishSuccesses: 3,
        phishCash: 125_000,
        phishCachesCreated: 1,
        phishCachesOpened: 1,
        cacheContractsCreated: 0,
        cacheDataFilesRead: 0,
        cacheDataFilesParsed: 0,
        cachesOpened: 4,
        cacheCash: 2_500_000,
        cacheShares: 17,
        cacheRewards: { "program: BruteSSH.exe": 1, "shares: ECP": 1, money: 2 },
        promotionAttempts: 3,
        promotionBatches: 2,
        promotionThreads: 16,
        promotionSymbols: { ECP: 2 },
      },
      spread: {
        planted: 2,
        refused: { "not-enough-ram": 3 },
        examples: [{ host: "dn-1", why: "not-enough-ram", detail: "1.00GB free, needs 2.60GB" }],
      },
    };
    const rendered = TABS["dnet"].render(state);
    expect(rendered).toContain("servers kept reachable");
    expect(rendered).not.toContain("invented");
    // The darknet's discovery surface is rendered, because the whole point of
    // acquiring it is to be able to look at it.
    expect(rendered).toContain("2G_cellular");
    expect(rendered).toContain("6 × numeric");
    expect(rendered).toContain("the dog, obviously");
    expect(rendered).toContain("16GB total");
    expect(rendered).toContain("4.00GB blocked");
    expect(rendered).toContain("5.00GB used");
    expect(rendered).toContain("7.00GB unused");
    expect(rendered).toContain("dnet RAM");
    expect(rendered).toContain("15.15GB");
    expect(rendered).toContain("job 12.00GB");
    expect(rendered).toContain("phish → dn-gone");
    expect(rendered).toContain("job-phish");
    // getDepth's -1 sentinel is "unknown", never a depth to render or sort on.
    expect(rendered).not.toContain(">-1<");
    // Why the net is not growing. `planSpread` has named its refusals since it
    // was written and nothing rendered them, so a planner that had run out of
    // reachable hosts read identically to one that had stopped working.
    expect(rendered).toContain("not-enough-ram");
    expect(rendered).toContain("1.00GB free, needs 2.60GB");

    // Solve progress, not "why untouched". Nineteen solvers exist and the five
    // dictionary models are walked, so the old column answered a question
    // nobody is asking; what an operator wants is how far each host got.
    expect(rendered).toContain("solve progress, every host");
    expect(rendered).not.toContain("why untouched");
    // The last response code, WITH its age — a code alone does not say whether
    // the conversation is live or was abandoned.
    expect(rendered).toContain("30s ago");

    // The digest caps at KNOWLEDGE_MAX_HOSTS, and a capped count that does not
    // say so is a smaller net than the one we are flying.
    expect(rendered).toContain("220");

    // Where the controller is standing, not merely that it is. The fixture
    // publishes the controller under its current name.
    expect(rendered).toContain("pid 42");

    // The labyrinth cache is a DECISION — opening it multiplies every
    // augmentation still unbought by 1.9x — so it is named and its gate stated.
    expect(rendered).toContain("lab.cache");
    expect(rendered).toContain("th3_l4byr1nth");
    // The ladder's charisma gate, against what we actually hold.
    expect(rendered).toContain("Labyrinth");

    // THE WALK, which had no readout at all until the maze started travelling:
    // a walk holds a host for hours and the panel could only say "active: walk".
    // The map itself, drawn from the published grid...
    expect(rendered).toContain("labmaze");
    // ...the single PID-bound walker and its pinned vantage...
    expect(rendered).toContain("finisher");
    // ...and the exit, which on this rung is known before the first move.
    expect(rendered).toContain("19,11");

    // Solver progress: spent against a budget DERIVED from the published
    // password facts, plus the phase. A multi-hundred-attempt solve used to be
    // indistinguishable from an idle host.
    expect(rendered).toContain("narrowing");
    expect(rendered).toMatch(/12\/\d+/);

    // An unopened cache dies with its host, and `.d.cache` is the only kind that
    // can carry a coding contract.
    expect(rendered).toContain("loot.cache");
    expect(rendered).toContain("a .d.cache can carry a contract");

    // The net-wide phishing window, counted down. It is engine state no ns
    // member exposes, so our own sightings are the only evidence there is.
    expect(rendered).toContain("phish window");
    expect(rendered).toContain("shut — 60s left");

    // Farm returns are cumulative state, not a per-call event stream. Cash is
    // kept separate from promotion activity because volatility has no honest
    // direct-P&L attribution.
    expect(rendered).toContain("Returns");
    expect(rendered).toContain("$2.625e6");
    expect(rendered).toContain("3 successful / 12 attempts");
    expect(rendered).toContain("program: BruteSSH.exe");
    expect(rendered).toContain("2 successful / 3 attempts");
    expect(rendered).toContain("promoted ECP ×2");

    // Farm refusals are a snapshot of ladder evaluation, not cumulative error
    // counters. The same host can legitimately miss cache, reclaim and an
    // already-running job in one derivation, so the table must say what `n`
    // actually counts instead of presenting several identical mystery totals.
    expect(rendered).toContain("latest planner pass");
    expect(rendered).toContain("host counts, not failures or lifetime totals");
    expect(rendered).toMatch(/ladder step skipped.*hosts.*why/s);

    // What grinding the owner's block would actually cost, as a number rather
    // than prose buried in a refusal.
    expect(rendered).toContain("4.00GB blocked");

    // Grammar drift is the same class of event as an unrecognised model id, and
    // it reaches the screen as a SHAPE. The line itself never leaves the game:
    // an unparsed line is one we failed to read, and the noise generator writes
    // cleartext passwords into log lines.
    expect(rendered).toContain("unparsed log lines");
    expect(rendered).toContain("a a: a#");

    // The three actions with a real price. Their refusals get as much room as
    // the actions, because "why not" is the usual answer for all three.
    expect(rendered).toContain("Deliberate");
    expect(rendered).toContain("no-slot");
    expect(rendered).toContain("all 2 stasis links are spent");
    // The backdoor plan used to be ADVICE — no ns.dnet member installs one — and
    // said so. It is now carried out, from HOME: `singularity.installBackdoor`
    // acts on the terminal's current server, so the one process with a terminal
    // is the one that can spend the allowance. The panel says where it happens
    // and what refuses it, because the refusal is still the usual answer.
    expect(rendered).toContain("backdoors — installed from HOME");
    expect(rendered).toContain("ns.scan cannot see the darknet");
    expect(rendered).not.toContain("nothing out there can act on it");
  });

  test("the darknet panel survives a driver tick that no probe has preceded", () => {
    // `knowledge` comes from the DRIVER; `instability`, `stasisLinkLimit` and
    // `stasisLinked` come only from the priced probe. The panel guarded on the
    // first and then dereferenced the other three, so the first tick of a run
    // whose probe had not landed threw a TypeError and took the whole panel
    // with it. Every other dnet fixture in this file supplies all four, which
    // is exactly why nothing caught it.
    const state = emptyState();
    state.topics.dnet = {
      maxDepth: -1,
      knowledge: {
        at: 1_000,
        generation: "15:0",
        agents: { live: 0, seenEver: 0, lostSinceBoot: 0 },
        hosts: [{ hostname: "darkweb", lastSeenAt: 1_000, isDarkweb: true, depth: -1, facts: {} }],
      },
    };

    const html = TABS.dnet.render(state);
    // It renders at all — the assertion the crash made impossible.
    expect(html).toContain("darkweb");
    // The unobserved readings say so rather than inventing a number.
    expect(html).toContain("awaiting the probe");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    // -1 is getDepth's "no idea". It is not a depth, so it is not rendered as
    // one — in the TILE as well as in the table.
    expect(html).not.toContain(">-1<");
  });

  test("the darknet map identifies a credential-only checkpoint instead of implying an edgeless network", () => {
    const state = emptyState();
    state.topics.dnet = {
      knowledge: {
        at: 1_000,
        generation: "test",
        hosts: [{
          hostname: "remembered",
          lastSeenAt: 500,
          facts: {},
          credentialKnown: true,
          authState: "authenticated",
        }],
        agents: { live: 0, seenEver: 0, lostSinceBoot: 0 },
      },
      maxDepth: -1,
    };

    expect(TABS.dnet.render(state)).toContain("credential-only checkpoint has no depths or links to draw");
  });

  test("the labyrinth card degrades through every state, and is absent when there is no lab", () => {
    // MOST RUNS NEVER REACH A LAB. The card carries the maze, the walkers and
    // the ETA now, so every one of those has to fold away cleanly rather than
    // leave a headed card with four dashes in it — and the states are not a
    // gradient: a lab we cannot walk yet, a map whose walker died, and a maze
    // already behind us each want a different sentence.
    const at = (dnet: Record<string, unknown>): string => {
      const state = emptyState();
      state.topics.dnet = dnet as never;
      return TABS.dnet.render(state);
    };
    const knowledge = {
      at: 1_000, generation: "15:0",
      agents: { live: 1, seenEver: 1, lostSinceBoot: 0 },
      hosts: [{ hostname: "dn-1", depth: 1, lastSeenAt: 1_000, facts: { depth: 1_000 }, authState: "auth-required" }],
    };
    const labHost = {
      hostname: "th3_l4byr1nth", lastSeenAt: 1_000, modelId: "(The Labyrinth)",
      facts: { modelId: 1_000 }, authState: "auth-required",
    };

    // 1. Nothing has ever seen a lab: no card at all, not an empty one.
    expect(at({ maxDepth: 1, knowledge, charisma: 120 })).not.toContain(">Labyrinth<");

    // 2. A lab we can see and cannot walk. The reason used to be reachable only
    // by hunting the Deliberate card's refusal table, which put the answer to
    // "why has the maze not started" in a different card from the maze.
    const gated = at({
      maxDepth: 1, charisma: 120, netDepth: 7,
      knowledge: { ...knowledge, hosts: [...knowledge.hosts, labHost] },
      hold: {
        admitted: {}, refused: { charisma: 1 },
        examples: [{ host: "th3_l4byr1nth", why: "charisma", detail: "the maze needs charisma 300" }],
      },
    });
    expect(gated).toContain(">Labyrinth<");
    expect(gated).toContain("the maze needs charisma 300");
    expect(gated).not.toContain("labmaze");

    // 3. A map with nobody on it. The walk died with its host; the shared field
    // did not, which is the whole reason the next walker is cheap.
    const orphaned = at({
      maxDepth: 1, charisma: 400, netDepth: 7, knowledge,
      lab: {
        host: "th3_l4byr1nth", width: 21, height: 13, grid: "?".repeat(21 * 13),
        candidates: ["19,11"], exitKnown: true, walkers: [],
      },
    });
    expect(orphaned).toContain("labmaze");
    expect(orphaned).toContain("outlives them");

    // 4. Finished. A credential for a lab host can only have come from reaching
    // the exit — the engine refuses the lab's own password on purpose.
    const done = at({
      maxDepth: 1, charisma: 400, netDepth: 7,
      knowledge: { ...knowledge, hosts: [{ ...labHost, credentialKnown: true, authState: "session" }] },
    });
    expect(done).toContain("this maze is finished");

    for (const html of [gated, orphaned, done]) {
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("undefined");
    }
  });

  test("the raw event view renders payload facts and observed codes", () => {
    // Planner prose no longer exists anywhere in the pipeline, so the payload
    // renders verbatim: structured values and categorical reason codes.
    const state = emptyState();
    state.runId = "test";
    state.events.push({
      kind: "event", name: "feature.decision", data: { score: 7, reason: "insufficient-money" },
      seq: 1, t: 1_000, run: "test", src: "game",
    });
    const html = TABS.overview.render(state);
    expect(html).toContain("score");
    expect(html).toContain("insufficient-money");
  });

  test("Go shows reproducible decision inputs, forecast support, and the observed reply", () => {
    const state = emptyState();
    state.topics.go = {
      status: "inProgress",
      currentPlayer: "Black",
      opponent: "Netburners",
      boardSize: 5,
      board: ["X....", ".X...", "..O..", ".....", "....."],
      previousBoards: [],
      stats: [],
      plan: {
        action: { type: "move", x: 1, y: 1 },
        ranked: [{
          x: 1, y: 1, score: 0.84, powerPerRound: 5.5, captures: 1,
          predictedReplies: [{ x: 2, y: 2, count: 5 }, { x: null, y: null, count: 1 }],
        }],
        input: { at: 1_000, board: [".....", ".....", ".....", ".....", "....."], previousBoards: [], status: "inProgress", currentPlayer: "Black" },
        planning: { finalistCount: 4, positionValue: 0.25 },
        selection: {
          preferred: {
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, aligned: false, waitSec: 0, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          },
          candidates: [{
            opponent: "Netburners", boardSize: 5, observedBoardSize: 5, aligned: false, waitSec: 0, winProbability: 0.8,
            expectedBlackScore: 15, expectedGameSec: 70, difficultyMultiplier: 0.5,
            currentWinStreak: 0, powerIfWin: 15, powerIfLoss: 5, expectedNodePower: 12,
            multiplierBefore: 1, multiplierAfter: 1.01, transientSecSaved: 20,
            favorEventProbability: 0, favorBefore: 0, favorAfter: 0, favorRemainingWorkSec: 0,
            expectedFavorGain: 0, favorSecSaved: 0, totalSecSaved: 20, utilityPerSec: 20 / 70,
            planningGames: 8, horizonNodePower: 80, horizonTransientSecSaved: 60, horizonFavorSecSaved: 0,
          }],
          context: {
            goPower: 1, hasSourceFile14: false, favorRepCap: 100_000, installRemainingSec: 3_600,
            joinedFactions: [], demands: {},
          },
        },
      },
      lastTurn: {
        at: 1_100,
        durationMs: 205,
        action: { type: "move", x: 1, y: 1 },
        opponentResponse: { type: "move", x: 2, y: 2 },
        predictionSupport: { matching: 5, total: 6 },
        prediction: {
          model: "clean-room-v3.0.1",
          sampledTotalPlaytime: 100_000,
          sampledAt: 900,
          decisionAt: 1_000,
          preparationMs: 1.2,
          finalizationMs: 0.8,
          totalPlanningMs: 2,
          dispatchBreakdown: {
            totalMs: 320,
            admitMs: 18, prepareMs: 242, leaseMs: 12, finalizeMs: 8, alignMs: 38, dispatchMs: 1, residualMs: 1,
          },
          engineCycleMs: 200,
          aiWaitMs: 200,
          seedCandidates: [100_200],
          dispatchPlaytime: 100_000,
          boundaryRetries: 0,
        },
        ok: true,
        detail: "move; opponent move",
      },
    };
    const html = TABS.go.render(state);
    expect(html).toContain("Candidate analysis");
    expect(html).toContain("5.00/6");
    expect(html).toContain("forecast weight on the reply that arrived");
    expect(html).toContain("clean-room-v3.0.1");
    expect(html).toContain("exact seed");
    // Fixed game parameters sit apart from what this turn measured, so
    // neither can be read as the other.
    expect(html).toContain("engine constants — 200 ms cycle, 200 ms AI wait");
    expect(html).toContain("worker — 1.2ms preparation; 0.8ms evaluation");
    // Alignment is read off the prediction; nothing mirrors it separately.
    expect(html).toContain("same-slot; full turn 205ms");
    expect(html).toContain("dispatch tick 100.000s");
    // The total alone cannot separate a slow worker from a deliberate wait for
    // the next engine cycle, which is the reason the segments exist.
    expect(html).toContain("ready to play");
    expect(html).toContain("admit 18ms");
    expect(html).toContain("plan 242ms");
    expect(html).toContain("align 38ms (deliberate)");
    expect(html).toContain("slowest plan");
    // One board, not two: the pre-move grid said nothing the markers do not.
    expect(html.split("class=\"goboard\"").length - 1).toBe(1);
    // The ranking table changes height every turn; the stable tables sit above.
    expect(html.indexOf("Opponent reward choice")).toBeLessThan(html.indexOf(">Record<"));
    expect(html.indexOf(">Record<")).toBeLessThan(html.indexOf("Candidate analysis"));
    expect(html).toContain("class=\"go-point black chosen\"");
    expect(html).toContain("class=\"go-point white reply\"");
    expect(html).toContain("class=\"go-marker chosen\"");
    expect(html).toContain("class=\"go-marker reply\"");
    expect(html).toContain("class=\"go-link north black\"");
    expect(html).toContain("class=\"go-link east black\"");
    expect(html).toContain("aria-label=\"5 by 5 IPvGO board\"");
    expect(html.indexOf("A5 (0,4)")).toBeLessThan(html.indexOf("A1 (0,0)"));
    expect(html).toContain("Opponent reward choice");
    expect(html).toContain("GoPower");
    expect(html).toContain("install runway");
    expect(html).toContain("favor event");
  });

  test("Go renders controlled and broken nodes without inventing another probe", () => {
    const state = emptyState();
    state.topics.go = {
      status: "inProgress",
      currentPlayer: "Black",
      opponent: "Netburners",
      boardSize: 5,
      board: ["XXXXX", "X...X", "X.#.X", "X...X", "XXXXX"],
      previousBoards: [],
      stats: [],
    };

    const html = TABS.go.render(state);
    expect(html).toContain("go-point empty territory-black");
    expect(html).toContain("go-point dead");
    expect(html).toContain("go-link north black");
    expect(html).toContain("C3 (2,2) — no signal");
  });

  test("Go shades exactly the space the territory count awards", () => {
    const state = emptyState();
    state.topics.go = {
      status: "inProgress",
      currentPlayer: "Black",
      opponent: "Netburners",
      boardSize: 5,
      // One opening stone borders all 24 remaining nodes. IPvGO deliberately
      // awards no such almost-board-sized region, so the picture must not
      // claim territory the count beside it does not include.
      board: ["X....", ".....", ".....", ".....", "....."],
      previousBoards: [],
      territory: { black: 0, white: 0 },
      stats: [],
    };

    const html = TABS.go.render(state);
    expect(html).not.toContain("territory-black");
    expect(html).toContain("controlled empty nodes — black 0, white 0");
  });

  test("Side shows compact status plus the latest report-once replay", () => {
    const state = emptyState();
    state.lastT = 2_000;
    state.topics.side = {
      contracts: [{ host: "n00dles", file: "next.cct" }],
      contractTotal: 2,
      solvableTotal: 1,
      contractsByOrigin: {
        network: { observed: 2, solvable: 1 },
        darknet: { observed: 0, solvable: 0 },
      },
      registryComplete: true,
      contractTypeTotal: 30,
      supportedTypeTotal: 30,
      failures: [{
        host: "n00dles", file: "bad.cct", type: "Array Jumping Game", reason: "answer rejected", triesBefore: 1, at: 1_000,
      }],
      quarantinedTotal: 1,
    };
    state.events.push({
      seq: 1,
      t: 1_000,
      run: "r",
      src: "game",
      kind: "event",
      name: "contract.quarantined",
      data: {
        host: "n00dles",
        file: "bad.cct",
        type: "Array Jumping Game",
        data: "[2,<script>]",
        answer: "1",
        triesBefore: 1,
        reason: "answer rejected",
        at: 1_000,
      },
    });
    state.contractReplay = state.events[0]!.data as NonNullable<typeof state.contractReplay>;

    const html = TABS.side.render(state);
    expect(html).toContain("30/30");
    expect(html).toContain("network 1/2");
    expect(html).toContain("darknet 0/0 solvable/observed");
    expect(html).toContain("input · 12 chars");
    expect(html).toContain("[2,&lt;script&gt;]");
    expect(html).not.toContain("[2,<script>]");
    expect(html).toContain("submitted answer · 1 chars");
    expect(html).not.toContain("Infiltration value");
    expect(html).not.toContain("Casino");
  });

  test("Side attributes rewards by origin and marks the money approximate", () => {
    const state = emptyState();
    state.lastT = 5_000;
    state.topics.progression = {
      moneySources: {
        sinceInstall: { codingcontract: 3_000_000 },
        sinceStart: { codingcontract: 3_000_000 },
      },
    } as never;
    state.topics.side = {
      contracts: [{ host: "dn-1", file: "next.cct", origin: "darknet" }],
      contractTotal: 1,
      solvableTotal: 1,
      contractsByOrigin: {
        network: { observed: 0, solvable: 0 },
        darknet: { observed: 1, solvable: 1 },
      },
      rewardsSince: 1_000,
      rewards: {
        network: {
          attempted: 4, solved: 3, unrewarded: 0, quarantined: 1,
          moneyApprox: 2_000_000, moneySolves: 2,
          factionRep: 7_500, companyRep: 0,
          unparsed: 0,
        },
        darknet: {
          attempted: 2, solved: 2, unrewarded: 0, quarantined: 0,
          moneyApprox: 1_000_000, moneySolves: 1,
          factionRep: 0, companyRep: 4_000,
          unparsed: 1,
        },
      },
      recentSolves: [{
        at: 4_000, origin: "darknet", host: "dn-1", file: "a.cct", type: "Spiralize Matrix",
        reward: "Gained $1.000m", currency: "money", moneyApprox: 1_000_000,
      }],
    } as never;

    const html = TABS.side.render(state);
    // Both origins are attributed separately.
    expect(html).toContain("network");
    expect(html).toContain("darknet");
    // Money is never presented as exact, and the game's exact ledger is shown
    // beside it for the combined figure.
    expect(html).toContain("≈");
    expect(html).toContain("game ledger, exact (no origin split)");
    // An unreadable reward is loud, not absorbed as a zero.
    expect(html).toContain("did not match this build's parser");
    // The verbatim reward string reaches the recent-solves card.
    expect(html).toContain("Gained $1.000m");
    // The old hardcoded claim is gone.
    expect(html).not.toContain("v3 registry complete");
  });

});

describe("stream projection", () => {
  const base = { seq: 0, t: 0, run: "r", src: "sim" as const };

  test("the money chart follows both the getPlayer mirror and the player topic", () => {
    const viaMirror = project(
      [{ ...base, kind: "state", key: "getPlayer", data: { money: 5 } } as LogRecord],
      Infinity,
      { id: "r", src: "sim", live: false, t0: 0 },
    );
    expect(viaMirror.moneySeries).toEqual([[0, 5]]);
    // Regression: the old viewer charted only `getPlayer`, so a run that
    // published the typed `player` topic drew an empty chart.
    const viaTopic = project(
      [{ ...base, kind: "state", key: "player", data: { money: 7 } } as LogRecord],
      Infinity,
      { id: "r", src: "sim", live: false, t0: 0 },
    );
    expect(viaTopic.moneySeries).toEqual([[0, 7]]);
  });

  test("totals prefer the farm rollup, fall back to hack.done, else report absence", () => {
    // Regression: totals used to be blanked on `src === "game"` rather than on
    // the absence of a totals source, so sim runs without per-op events showed
    // a confident 0.
    const none = project([{ ...base, kind: "event", name: "start.boot" } as LogRecord], Infinity, {
      id: "r",
      src: "game",
      live: true,
      t0: 0,
    });
    expect(none.hasTotals).toBe(false);

    const viaEvents = project(
      [{ ...base, kind: "event", name: "hack.done", data: { success: true, moneyGained: 250 } } as LogRecord],
      Infinity,
      { id: "r", src: "sim", live: false, t0: 0 },
    );
    expect(viaEvents.hasTotals).toBe(true);
    expect(viaEvents.earned).toBe(250);
    expect(viaEvents.hacks).toBe(1);

    const viaFarm = project(
      [
        { ...base, kind: "event", name: "hack.done", data: { success: true, moneyGained: 250 } },
        { ...base, seq: 1, kind: "state", key: "farm", data: { totals: { moneyEarned: 9000, hacks: 42 } } },
      ] as LogRecord[],
      Infinity,
      { id: "r", src: "game", live: true, t0: 0 },
    );
    expect(viaFarm.earned).toBe(9000);
    expect(viaFarm.hacks).toBe(42);
  });

  test("the replay cutoff truncates the fold", () => {
    const records = [
      { ...base, kind: "state", key: "getPlayer", data: { money: 1 } },
      { ...base, seq: 1, t: 100, kind: "state", key: "getPlayer", data: { money: 2 } },
    ] as LogRecord[];
    const full = project(records, Infinity, { id: "r", src: "sim", live: false, t0: 0 });
    expect(full.moneySeries.length).toBe(2);
    const clipped = project(records, 50, { id: "r", src: "sim", live: false, t0: 0 });
    expect(clipped.moneySeries).toEqual([[0, 1]]);
  });

  test("a game run's replay range is its own timeline, not 0..now", () => {
    // Regression: the scrub slider used min=0 while game records carry
    // Date.now() timestamps, so the whole run occupied its final pixel and
    // every drag produced a cutoff decades before t0 — an empty page and a
    // hugely negative "elapsed". The slider must span [t0, tLast].
    const t0 = 1_786_117_518_978;
    const records = [
      { ...base, src: "game" as const, t: t0, kind: "state", key: "getPlayer", data: { money: 1 } },
      { ...base, src: "game" as const, seq: 1, t: t0 + 60_000, kind: "state", key: "getPlayer", data: { money: 2 } },
    ] as LogRecord[];
    const min = records[0]!.t;
    const max = records[records.length - 1]!.t;
    expect(min).toBe(t0);

    // Midpoint of the correct range keeps the run visible and elapsed positive.
    const mid = min + (max - min) / 2;
    const clipped = project(records, mid, { id: "r", src: "game", live: false, t0 });
    expect(clipped.moneySeries).toEqual([[t0, 1]]);
    expect(clipped.lastT - t0).toBeGreaterThanOrEqual(0);

    // Midpoint of the old 0-based range fell before the run entirely.
    const broken = project(records, max / 2, { id: "r", src: "game", live: false, t0 });
    expect(broken.moneySeries).toEqual([]);
  });

  test("state records are folded into topics and kept out of the event feed", () => {
    const state = project(
      [
        { ...base, kind: "state", key: "capabilities", data: deriveCapabilities({ bitNode: 3 }) },
        { ...base, seq: 1, kind: "event", name: "probe.failed", data: { id: "corp.core" } },
      ] as LogRecord[],
      Infinity,
      { id: "r", src: "game", live: true, t0: 0 },
    );
    expect(state.caps.bitNode).toBe(3);
    expect(state.topics.capabilities).toBeDefined();
    expect(state.events.length).toBe(1);
    expect(state.events[0]!.kind).toBe("event");
  });

  test("a contract replay survives eviction from the bounded event feed", () => {
    const replay = {
      host: "n00dles", file: "bad.cct", type: "Array Jumping Game", data: "[0]", answer: "1",
      reason: "answer rejected", at: 0,
    };
    const records: LogRecord[] = [
      { ...base, kind: "event", name: "contract.quarantined", data: replay },
      ...Array.from({ length: EVENT_RING + 1 }, (_, index) => ({
        ...base,
        seq: index + 1,
        t: index + 1,
        kind: "debug" as const,
        msg: "noise",
      })),
    ];
    const state = project(records, Infinity, { id: "r", src: "game", live: false, t0: 0 });
    expect(state.events.some((record) => record.kind === "event" && record.name === "contract.quarantined")).toBe(false);
    expect(state.contractReplay).toEqual(replay);
  });

  test("sim validity and authoritative gap counts survive event-ring eviction", () => {
    const records: LogRecord[] = [
      { ...base, kind: "event", name: "sim.meta", data: { driver: "game", seed: 7, scenario: "synthetic-early-game" } },
      { ...base, seq: 1, kind: "event", name: "sim.unmodeled", data: { kind: "ns", name: "go.getBoardState", detail: "runtime missing" } },
      ...Array.from({ length: EVENT_RING + 1 }, (_, index) => ({
        ...base, seq: index + 2, t: index + 2, kind: "debug" as const, msg: "noise",
      })),
      {
        ...base,
        seq: EVENT_RING + 3,
        t: EVENT_RING + 3,
        kind: "event",
        name: "sim.result",
        data: {
          validity: "invalid-for-goal", reached: false, stoppedBecause: "horizon",
          scenario: "synthetic-early-game", unmodeled: { "ns go.getBoardState": 7 },
        },
      },
    ] as LogRecord[];
    const state = project(records, Infinity, { id: "r", src: "sim", live: false, t0: 0 });

    expect(state.events.some((record) => record.kind === "event" && record.name === "sim.unmodeled")).toBe(false);
    expect(state.simResult?.validity).toBe("invalid-for-goal");
    const html = TABS["overview"].render(state);
    expect(html).toContain("invalid-for-goal");
    expect(html).toContain("go.getBoardState");
    expect(html).toContain(">7<");
    expect(html).not.toContain("this run stayed inside what the simulator models");
  });
});

describe("incremental projection", () => {
  const base = { seq: 0, t: 0, run: "r", src: "sim" as const };

  function stream(n: number): LogRecord[] {
    const records: LogRecord[] = [];
    for (let i = 0; i < n; i++) {
      records.push({ ...base, seq: i * 2, t: i, kind: "state", key: "getPlayer", data: { money: i } } as LogRecord);
      records.push({ ...base, seq: i * 2 + 1, t: i, kind: "event", name: "hack.done", data: { success: true, moneyGained: 2 } } as LogRecord);
    }
    return records;
  }

  test("folding in batches gives the same state as folding the whole stream", () => {
    // This is the property that lets a live run stop re-folding its history on
    // every frame — the reason the viewer degraded the longer it was open.
    const records = stream(50);
    const whole = project(records, Infinity, { id: "r", src: "sim", live: true, t0: 0 });

    const incremental = emptyState();
    incremental.runId = "r";
    incremental.src = "sim";
    incremental.live = true;
    incremental.t0 = 0;
    for (let i = 0; i < records.length; i += 7) appendRecords(incremental, records.slice(i, i + 7));

    expect(incremental.moneySeries).toEqual(whole.moneySeries);
    expect(incremental.events.length).toBe(whole.events.length);
    expect(incremental.earned).toBe(whole.earned);
    expect(incremental.hacks).toBe(whole.hacks);
    expect(incremental.lastT).toBe(whole.lastT);
    expect(incremental.topics).toEqual(whole.topics);
  });

  test("the event feed is a ring, not an unbounded log", () => {
    // A 12-hour run emits far more than the feed can show; retaining all of it
    // just to slice the tail is how a viewer tab reaches a gigabyte.
    const state = project(stream(EVENT_RING * 2), Infinity, { id: "r", src: "sim", live: true, t0: 0 });
    expect(state.events.length).toBe(EVENT_RING);
    // The ring keeps the NEWEST records — an old tail would be useless.
    expect(state.events[state.events.length - 1]!.t).toBe(EVENT_RING * 2 - 1);
  });

  test("the money series is downsampled but keeps its endpoints", () => {
    const points = SERIES_LIMIT * 3;
    const state = project(stream(points), Infinity, { id: "r", src: "sim", live: true, t0: 0 });
    expect(state.moneySeries.length).toBeLessThanOrEqual(SERIES_LIMIT);
    // The axis labels are drawn from the first and last points, so losing
    // either would mislabel the whole chart.
    expect(state.moneySeries[0]).toEqual([0, 0]);
    expect(state.moneySeries[state.moneySeries.length - 1]).toEqual([points - 1, points - 1]);
  });
});

describe("panel view state", () => {
  test("progression shows separate install/node countdowns and their critical-path evidence", () => {
    const state = emptyState();
    const now = Date.now();
    state.topics.progression = {
      bitNode: 14,
      sourceFiles: {},
      ownedAugs: {},
      augCount: 0,
      lastAugReset: now - 60_000,
      lastNodeReset: now - 120_000,
      plan: {
        phase: "finishUp",
        installWanted: true,
        liquidationWanted: true,
        installBlockers: ["factions"],
        installReady: false,
        queuedAugmentations: ["BitWire"],
        install: false,
        favorCrossings: [],
        forecasts: {
          install: {
            state: "estimated", estimatedAt: now, nextRecalibrationAt: now + 600_000,
            expectedAt: now + 660_000, remainingSec: 660, confidence: "mixed", basis: "package",
            components: [
              { what: "faction unlock and reputation", resource: "reputation", sec: 600, measured: true, mode: "parallel", critical: true },
              { what: "package money", resource: "money", sec: 300, measured: true, mode: "parallel", critical: false },
              { what: "final purchase and donation sweep", resource: "install", sec: 60, measured: false, mode: "sequential", critical: true },
            ],
          },
          node: {
            state: "estimated", estimatedAt: now, nextRecalibrationAt: now + 600_000,
            expectedAt: now + 172_800_000, remainingSec: 172_800, confidence: "measured", basis: "route",
            components: [{ what: "hacking level", resource: "hacking", sec: 172_800, measured: true, mode: "sequential", critical: true }],
          },
        },
      },
    };

    const html = TABS["progression"].render(state);
    expect(html).toContain("Expected next installation");
    expect(html).toContain("Expected BitNode completion");
    expect(html).toContain("faction unlock and reputation");
    expect(html).toContain("final purchase and donation sweep");
    expect(html).toContain("model/fallback");
    expect(html).toContain("2.0d");
  });

  test("progression renders the endgame route and the cadence verdict", () => {
    const state = emptyState();
    const now = Date.now();
    state.cadenceAccrued = [[0, 0.1], [60_000, 0.4]];
    state.topics.progression = {
      bitNode: 4,
      sourceFiles: {},
      ownedAugs: {},
      augCount: 0,
      lastAugReset: now - 60_000,
      lastNodeReset: now - 120_000,
      plan: {
        phase: "start",
        installWanted: false,
        liquidationWanted: false,
        installBlockers: [],
        installReady: false,
        queuedAugmentations: [],
        install: false,
        favorCrossings: [{ faction: "CyberSec", favorNow: 120, favorAfter: 152 }],
        route: "daedalus",
        decidedAt: now - 300_000,
        routes: [
          {
            id: "daedalus", available: true, complete: false, blocker: "2.5m Daedalus rep",
            etaSec: 7_200,
            parts: [{ what: "daedalus reputation", resource: "reputation", sec: 7_000, measured: true }, { what: "install overhead", resource: "install", sec: 200, measured: false }],
          },
          {
            id: "bladeburner", available: false, complete: false, blocker: "join Bladeburner",
            etaSec: 90_000,
            parts: [{ what: "bladeburner rank", resource: "combat", sec: 90_000, measured: false }],
          },
        ],
        installDecision: {
          verdict: "push",
          effective: "push",
          pushRate: 9.1e-3,
          threshold: 2.9,
          resetValueMult: 1.2,
          resetFavorValue: 0.3,
          pushEtaSec: 4_700,
          remainingSec: 7_200,
          latched: false,
        },
        forecasts: {
          install: { state: "unknown", reason: "no data", evaluatedAt: now, nextRecalibrationAt: now + 600_000, basis: "none" },
          node: { state: "unknown", reason: "no data", evaluatedAt: now, nextRecalibrationAt: now + 600_000, basis: "none" },
        },
      },
    };

    const html = TABS["progression"].render(state);
    expect(html).toContain("Endgame route");
    expect(html).toContain("daedalus");
    expect(html).toContain("2.00h ETA · available");
    expect(html).toContain("2.5m Daedalus rep");
    expect(html).toContain("daedalus reputation");
    expect(html).toContain("Install cadence");
    expect(html).toContain("push before latch");
    expect(html).not.toContain("fastest measured ending");
    expect(html).not.toContain("accrued value below the cadence threshold");
    expect(html).toContain("cadencechart");
    expect(html).toContain("CyberSec");
    // A plan recorded before these fields existed still renders.
    delete state.topics.progression!.plan!.routes;
    delete state.topics.progression!.plan!.installDecision;
    const bare = TABS["progression"].render(state);
    expect(bare).toContain("waiting for the endgame route estimates");
    expect(bare).toContain("waiting for the cadence verdict");
  });

  test("a filter chip changes what the panel renders", () => {
    const state = emptyState();
    state.runId = "r";
    state.topics = {
      progression: {
        bitNode: 12,
        sourceFiles: {},
        ownedAugs: {},
        augCount: 0,
        lastAugReset: 1,
        lastNodeReset: 1,
        multipliers: { ...DEFAULT_BITNODE_MULTIPLIERS, CrimeMoney: 0.5, HacknetNodeMoney: 4 },
      },
    } as ProjectedState["topics"];

    setView("bitnode.mults", "all");
    const all = TABS["progression"].render(state);
    expect(all).toContain("Crime Money");
    expect(all).toContain("Hacknet Node Money");

    // "harder" keeps the nerfed gain and drops the buffed one — the filter is
    // by FAVOURABILITY, not by whether the number went up.
    setView("bitnode.mults", "harder");
    const harder = TABS["progression"].render(state);
    expect(harder).toContain("Crime Money");
    expect(harder).not.toContain("Hacknet Node Money");

    setView("bitnode.mults", "all");
  });

  test("the first click on any column ranks by it, biggest first", () => {
    const tableDefault = { key: "money", dir: -1 } as const;
    // Nothing clicked yet: the table's own default applies.
    expect(sortOf("demo", tableDefault)).toEqual(tableDefault);

    // The handler passes NO_SORT, never the clicked key: passing the clicked
    // key would make the first click on ANY column read as "flip", so ranking
    // a table by skill would open with the weakest server at the top.
    toggleSort("demo", "skill", NO_SORT);
    expect(sortOf("demo", tableDefault)).toEqual({ key: "skill", dir: -1 });

    // Clicking the active column flips it.
    toggleSort("demo", "skill", NO_SORT);
    expect(sortOf("demo", tableDefault)).toEqual({ key: "skill", dir: 1 });

    // Switching columns starts descending again.
    toggleSort("demo", "host", NO_SORT);
    expect(sortOf("demo", tableDefault)).toEqual({ key: "host", dir: -1 });
  });
});

describe("career request grouping", () => {
  test("identical asks from many factions collapse to one row", () => {
    // A late-game save posts one request per (faction, requirement) pair: the
    // panel used to show eleven consecutive rows that differed only in who was
    // asking, which is noise around a single piece of work.
    const serving = ["ECorp", "MegaCorp", "NWO", "Blade Industries"].map((company) => ({
      by: "factions",
      kind: "companyRep",
      subject: company,
      target: 400_000,
      have: 0,
      weight: 1,
      urgency: "wanted" as const,
      progress: 0,
    }));
    // ...plus one distinct, higher-priority ask that must stay separate.
    const plan = {
      serving: [
        ...serving,
        { by: "factions", kind: "skill", subject: "agility", target: 850, have: 749, weight: 4.5, urgency: "blocking" as const, progress: 0.881 },
      ],
      ranked: [],
      action: { type: "idle" },
      incomeFallback: false,
    };

    const groups = groupRequests(plan as never);
    // Four company-rep asks share a kind but not a subject, so they stay
    // distinct; what collapses is repeated (kind, subject, urgency).
    expect(groups.length).toBe(5);
    // Blocking sorts first regardless of how many wanted rows there are.
    expect(groups[0]!.urgency).toBe("blocking");
    expect(groups[0]!.subject).toBe("agility");

    // The same subject asked for twice collapses, and keeps every asker.
    const duplicated = groupRequests({
      ...plan,
      serving: [
        { by: "factions", kind: "skill", subject: "hacking", target: 1500, have: 1348, weight: 4.6, urgency: "wanted" as const, progress: 0.898 },
        { by: "career", kind: "skill", subject: "hacking", target: 2500, have: 1348, weight: 3.2, urgency: "wanted" as const, progress: 0.539 },
      ],
    } as never);
    expect(duplicated.length).toBe(1);
    expect(duplicated[0]!.askers.sort()).toEqual(["career", "factions"]);
    // Weights ADD, because that is what the planner prices: same-key requests
    // are summed by `needWeights`/`needValueSeconds` and folded per channel by
    // `channelWorth`. Taking the maximum (4.6 here) priced one asker for work
    // two askers asked for, and inverted the column an operator sorts by.
    expect(duplicated[0]!.weight).toBeCloseTo(7.8, 6);
    expect(duplicated[0]!.asks).toBe(2);
    // The displayed milestone is ONE request, whole: the nearest one, which is
    // what the work will hit first. Taking the closest progress but the
    // furthest target would draw an 89.8% bar labelled "1.35k / 2.50k" — a bar
    // and a label that disagree by 35 points.
    expect(duplicated[0]!.progress).toBeCloseTo(0.898, 3);
    expect(duplicated[0]!.have).toBe(1348);
    expect(duplicated[0]!.target).toBe(1500);
    // The harder target is still known, as the note beside it.
    expect(duplicated[0]!.finalTarget).toBe(2500);
  });

  test("a group is only done when its shown milestone is", () => {
    // The meter turns green off `progress >= 1`. Under the old independent
    // maxima, one satisfied requirement turned the whole group green while
    // harder ones were still open.
    const groups = groupRequests({
      serving: [
        { by: "a", kind: "skill", subject: "agility", target: 300, have: 300, weight: 1, urgency: "wanted" as const, progress: 1 },
        { by: "b", kind: "skill", subject: "agility", target: 850, have: 300, weight: 1, urgency: "wanted" as const, progress: 0.35 },
      ],
      ranked: [],
      action: { type: "idle" },
      incomeFallback: false,
    } as never);
    expect(groups.length).toBe(1);
    // The nearest milestone IS met, so green is correct here — and the target
    // shown is the one that was met, not the one that was not.
    expect(groups[0]!.progress).toBe(1);
    expect(groups[0]!.target).toBe(300);
    expect(groups[0]!.finalTarget).toBe(850);
  });
});

describe("skill progress uses the multiplier the game applies", () => {
  function careerState(mult: number, nodeMult: number, exp: number): ProjectedState {
    const state = emptyState();
    state.runId = "r";
    state.player = { mults: { hacking: mult } } as never;
    state.topics = {
      progression: {
        bitNode: 1,
        sourceFiles: {},
        ownedAugs: {},
        augCount: 0,
        lastAugReset: 1,
        lastNodeReset: 1,
        multipliers: { ...DEFAULT_BITNODE_MULTIPLIERS, HackingLevelMultiplier: nodeMult },
      },
      career: {
        karma: 0,
        numPeopleKilled: 0,
        skills: { hacking: skillFromExp(exp, mult * nodeMult), strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 1 },
        exp: { hacking: exp, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 },
        city: "Sector-12",
        location: "home",
        entropy: 0,
        totalPlaytime: 1,
        jobs: {},
      },
    } as ProjectedState["topics"];
    return state;
  }

  test("a stat augmentation does not desynchronise the level from its bar", () => {
    // 1.2m experience under a 1.2x multiplier: level 297, 53% of the way to
    // 298. Reading it at 1x claims level 268 and 94% — both numbers plausible,
    // both wrong, and the panel showed the true level beside the wrong bar.
    const exp = 1.2e6;
    const state = careerState(1.2, 1, exp);
    const level = state.topics.career!.skills.hacking;
    expect(level).toBe(skillFromExp(exp, 1.2));
    expect(level).not.toBe(skillFromExp(exp, 1));

    const html = TABS["career"].render(state);
    // The bar is drawn to the NEXT real level, so the label names level+1.
    expect(html).toContain(`to ${level + 1}`);
    // And it must not be the number a 1x reading would have produced.
    expect(html).not.toContain(`to ${skillFromExp(exp, 1) + 1}`);
  });

  test("the BitNode multiplier counts too", () => {
    // BN12 scales stat levels as well; ignoring it desynchronises the same way.
    const exp = 1.2e6;
    const state = careerState(1, 0.7, exp);
    const level = state.topics.career!.skills.hacking;
    expect(level).toBe(skillFromExp(exp, 0.7));
    expect(TABS["career"].render(state)).toContain(`to ${level + 1}`);
  });

  test("an unexplained level falls back to raw experience rather than a wrong bar", () => {
    // Multipliers we cannot see (a modded save, a field we do not model) would
    // otherwise produce a confident, wrong percentage.
    const state = careerState(1, 1, 1.2e6);
    state.topics.career!.skills.hacking = 9_999;
    const html = TABS["career"].render(state);
    expect(html).toContain("9999");
    expect(html).toContain("exp");
    expect(html).not.toContain("to 10000");
  });
});

describe("faction decision review", () => {
  test("shows decision inputs, package economics, cycle exclusions, and transition history", () => {
    const state = emptyState();
    state.lastT = 10_000;
    const intent = {
      faction: "CyberSec",
      repTarget: 2_000,
      augmentations: ["Synaptic Enhancement Implant"],
      value: 1.03,
      etaSec: 120,
      rate: 0.0086,
      marginalRate: 0.007,
      unlockSec: 0,
      repSec: 90,
      moneySec: 120,
      favorAfterInstall: 151,
      totalCost: 2_674_166_667,
      purchaseCost: 7_500_000,
      donationCost: 2_666_666_667,
      purpose: "augmentations" as const,
    };
    const plan = {
      context: {
        evaluatedAt: 9_000,
        horizonSec: 3_600,
        route: "daedalus" as const,
        targetAugCount: 30,
        ownedAugCount: 12,
        queuedAugCount: 2,
        incomePerSec: 5_000_000,
        moneyAvailable: 1_500_000_000,
        moneyGranted: 2_674_166_667,
        holdsWorkSlot: true,
        favorToDonate: 150,
        priceQueue: { nonSoA: 2, ownedSoA: 0, neurofluxLevel: 0 },
      },
      objective: {
        factions: ["CyberSec"],
        augmentations: intent.augmentations,
        value: intent.value,
        foreclosed: [{ name: "NiteSec", bannedBy: "CyberSec" }],
        intent,
      },
      action: { type: "donate", faction: "CyberSec", amount: 2_666_666_667 },
      alternatives: [],
      blockers: [],
      invalidation: [{ label: "owned", value: 12 }],
    };
    state.topics.factions = { joined: ["CyberSec"], plan };
    state.events.push({
      kind: "event",
      name: "faction.decision",
      data: { plan },
      seq: 1,
      t: 9_000,
      run: "test",
      src: "game",
    });

    const html = TABS["factions"].render(state);
    expect(html).toContain("planning window");
    expect(html).toContain("marginal/sec");
    expect(html).toContain("forecloses this install cycle");
    expect(html).toContain("Decision history");
    expect(html).toContain("$2.667e9 to CyberSec");
    expect(html).not.toContain("income beats work");
  });
});

describe("filter badges count the rows their filter shows", () => {
  test("a pending invitation is counted by the reachable badge that includes it", () => {
    const state = emptyState();
    state.runId = "r";
    state.topics = {
      factions: {
        joined: ["CyberSec"],
        invites: ["NiteSec"],
        gates: {
          CyberSec: { joined: true, invited: false, progress: 1, reachable: true, missing: [] },
          NiteSec: { joined: false, invited: true, progress: 1, reachable: true, missing: [] },
          Tetrads: { joined: false, invited: false, progress: 0.3, reachable: true, missing: [] },
          Illuminati: { joined: false, invited: false, progress: 0, reachable: false, missing: [] },
        },
      },
    } as ProjectedState["topics"];

    setView("factions.mode", "open");
    const html = TABS["factions"].render(state);
    // Two rows are reachable-and-not-joined: NiteSec (invited) and Tetrads.
    // The badge used to exclude invited factions while the filter included
    // them, so it read "1" above a two-row table.
    // Matched on the row marker rather than the bare name: every faction also
    // appears in the augmentation table's "from" column.
    const row = (name: string) => new RegExp(`●</span>${name}`);
    expect(html).toMatch(row("NiteSec"));
    expect(html).toMatch(row("Tetrads"));
    expect(html).not.toMatch(row("Illuminati"));
    expect(html).toMatch(/reachable<span class="badge">2<\/span>/);

    setView("factions.mode", "all");
  });
});

/** The reworked Batches card, driven through the real fold so the per-batch
 * history exists — the card's primary view is a scatter over it, and setting
 * `topics.farm` directly leaves it empty. */
describe("the Batches card is per-batch", () => {
  const batch = (id: number, at: number, over: Record<string, unknown> = {}) => ({
    id, kind: "hgw", target: "phantasy", at, spanMs: 2_000, ops: 4, landed: 4,
    threads: { hack: 10, grow: 20, weaken: 5 }, gb: 500, moneyEarned: 1_000,
    order: "h-w1-g-w2", planned: "h-w1-g-w2", ...over,
  });

  const farm = (t: number, over: Record<string, unknown>): LogRecord =>
    ({ t, seq: t, run: "r", src: "sim", kind: "state", key: "farm",
       data: { totals: { moneyEarned: 0, hacks: 0 }, ...over } }) as LogRecord;

  function populated(): ProjectedState {
    return appendRecords(emptyState(), [
      farm(1_000, {
        launched: { hack: 10, grow: 10, weaken: 10 },
        landed: { hack: 10, grow: 10, weaken: 10 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        pumpOccupancy: 0.04,
        batches: {
          hgw: {
            batches: 20, ops: 80, landed: 80, threads: { hack: 200, grow: 400, weaken: 100 },
            gb: 10_000, moneyEarned: 20_000, hacks: 20, spanMs: 40_000, graded: 20, inOrder: 20,
            noHack: 0, abandoned: 0, abandonedOps: 0, abandonedLanded: 0,
          },
        },
        recentBatches: [batch(1, 1_000), batch(2, 1_100)],
      }),
      farm(3_000, {
        // Three ops launched that are neither in flight nor landed: adrift.
        launched: { hack: 20, grow: 20, weaken: 20 },
        landed: { hack: 19, grow: 19, weaken: 19 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        pumpOccupancy: 0.06,
        batches: {
          hgw: {
            batches: 40, ops: 160, landed: 160, threads: { hack: 400, grow: 800, weaken: 200 },
            gb: 20_000, moneyEarned: 40_000, hacks: 40, spanMs: 80_000, graded: 40, inOrder: 39,
            noHack: 0, abandoned: 1, abandonedOps: 4, abandonedLanded: 3,
          },
        },
        recentBatches: [batch(3, 3_000, { moneyEarned: 9_000 }), batch(4, 3_100, { order: "g-h-w1-w2" })],
      }),
    ]);
  }

  test("the per-batch timeline leads, and the per-kind grid is demoted below it", () => {
    const html = TABS.hacking.render(populated());
    expect(html).toContain(`id="batch-timeline"`);
    // Both present, and in this order: the batch is the unit, the kind is a summary.
    expect(html.indexOf("batch-timeline")).toBeGreaterThan(-1);
    expect(html.indexOf(`class="batchgrid"`)).toBeGreaterThan(html.indexOf("batch-timeline"));
  });

  test("the metric chips pick what the scatter plots, defaulting to a rate", () => {
    const html = TABS.hacking.render(populated());
    // Size-normalised by default: ranking batches on raw earnings ranks them by
    // size, and a prep wave and a farm cycle differ by orders of magnitude.
    expect(html).toContain(`data-view-key="hacking.batchMetric"`);
    expect(html).toContain(">$/GB·s<");
    expect(html).toMatch(/class="chip pick sel"[^>]*data-view-value="rate"/);
  });

  test("the sample is reported as a sample, with its census beside it", () => {
    // Four batches caught out of forty settled. Presenting the four as if they
    // were the population is the trap this wording exists to avoid.
    const html = TABS.hacking.render(populated());
    expect(html).toContain("4 of 40 batches sampled");
  });

  test("loss is reported where it can be observed", () => {
    const html = TABS.hacking.render(populated());
    // The abandoned batch, and the op it took with it.
    expect(html).toContain("1 abandoned, 1 ops lost");
    // And the run-level residual: 60 launched, 57 landed, none in flight.
    expect(html).toContain("ops adrift");
    expect(html).toContain(`id="ops-lost"`);
  });

  test("picking a batch opens it, and names what it is compared against", () => {
    setView("hacking.batch", "3");
    const html = TABS.hacking.render(populated());
    expect(html).toContain("batch #3");
    expect(html).toContain("phantasy");
    // 9000 over 500 GB * 2 s = $9/GB·s against a median of $1 — the outlier is
    // the point of picking it.
    expect(html).toContain("x its kind's median");
    setView("hacking.batch", "");
  });

  test("a picked batch that has aged out says so rather than vanishing", () => {
    setView("hacking.batch", "99999");
    const html = TABS.hacking.render(populated());
    expect(html).toContain("no longer held");
    setView("hacking.batch", "");
  });

  test("$/GB·s divides by the dispatcher's RAM-time integral when it is present", () => {
    const state = appendRecords(emptyState(), [
      farm(1_000, {
        launched: { hack: 10, grow: 10, weaken: 10 },
        landed: { hack: 10, grow: 10, weaken: 10 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        // gbMs says the ops occupied half of what gb × span charges.
        recentBatches: [batch(1, 1_000, { gbMs: 500_000 }), batch(2, 1_100)],
      }),
    ]);
    const measured = state.batchHistory.find((entry) => entry.id === 1)!;
    const legacy = state.batchHistory.find((entry) => entry.id === 2)!;
    expect(measured.moneyPerGbSec).toBe(1_000 / 500);
    // A run recorded before gbMs existed falls back to charging every op for
    // the whole span: 1000 over 500 GB × 2 s.
    expect(legacy.moneyPerGbSec).toBe(1_000 / (500 * 2));
  });

  test("prep waves are their own series, not $0 noise in the farm scatter", () => {
    const prep = (id: number, at: number) =>
      batch(id, at, { kind: "prep", moneyEarned: 0, order: undefined, planned: undefined });
    const state = appendRecords(emptyState(), [
      farm(1_000, {
        launched: { hack: 10, grow: 10, weaken: 10 },
        landed: { hack: 10, grow: 10, weaken: 10 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        // Two of each: a series shorter than two points is dropped from the
        // chart, and its legend entry with it.
        recentBatches: [batch(1, 1_000), batch(2, 1_100), prep(3, 1_200), prep(4, 1_300)],
      }),
    ]);
    const html = TABS.hacking.render(state);
    expect(html).toContain(">prep<");
    expect(html).toContain("spends RAM to make a target farmable");
    expect(html).toContain(">in order<");
  });

  test("batch timestamps are based on the dispatcher clock, never wall-clock t0", () => {
    // Batch times are performance.now() values; record.t is epoch ms. Before
    // the split origin, the table subtracted t0 across clock domains and
    // labelled every batch with a huge bogus offset ("2.00h" here; negative
    // epoch seconds live).
    const state = appendRecords(emptyState(), [
      farm(1_000, {
        launched: { hack: 10, grow: 10, weaken: 10 },
        landed: { hack: 10, grow: 10, weaken: 10 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        recentBatches: [batch(1, 7_200_000), batch(2, 7_200_100)],
      }),
    ]);
    // The origin is the earliest batch START (at − span), in the batch clock.
    expect(state.batchT0).toBe(7_198_000);
    const html = TABS.hacking.render(state);
    expect(html).not.toContain("2.00h");
  });

  test("an install clears the dispatcher-clock origin along with the history", () => {
    const state = populated();
    expect(state.batchT0).not.toBeNull();
    appendRecords(state, [
      farm(9_000, {
        launched: { hack: 1, grow: 1, weaken: 1 },
        landed: { hack: 1, grow: 1, weaken: 1 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        // Counters moved backwards: an install wiped the topic, and the old
        // performance.now() origin is garbage in the new run.
        batches: {
          hgw: {
            batches: 1, ops: 4, landed: 4, threads: { hack: 10, grow: 20, weaken: 5 },
            gb: 500, moneyEarned: 1_000, hacks: 1, spanMs: 2_000, graded: 1, inOrder: 1,
            noHack: 0, abandoned: 0, abandonedOps: 0, abandonedLanded: 0,
          },
        },
      }),
    ]);
    expect(state.batchT0).toBeNull();
  });

  test("health gauges are drawn as trends, not as a row of latest values", () => {
    // A THIRD rollup, because the in-order share is now differenced over a
    // window rather than read off the rollup as a lifetime mean: the first
    // rollup has no baseline and the second yields one point, so a curve needs
    // three. That is the whole point of the change — a cumulative ratio anchored
    // near 1.0 cannot say whether landing order is getting worse, and this test
    // used to pass on exactly one lifetime average.
    const state = appendRecords(populated(), [
      farm(5_000, {
        launched: { hack: 30, grow: 30, weaken: 30 },
        landed: { hack: 29, grow: 29, weaken: 29 },
        inFlight: { hack: 0, grow: 0, weaken: 0 },
        pumpOccupancy: 0.08,
        batches: {
          hgw: {
            batches: 60, ops: 240, landed: 240, threads: { hack: 600, grow: 1_200, weaken: 300 },
            gb: 30_000, moneyEarned: 60_000, hacks: 60, spanMs: 126_000, graded: 60, inOrder: 57,
            noHack: 0, abandoned: 1, abandonedOps: 4, abandonedLanded: 3,
          },
        },
        recentBatches: [batch(5, 5_000), batch(6, 5_100)],
      }),
    ]);
    const html = TABS.hacking.render(state);
    // Occupancy is the leading indicator the tab's own notes name, and it was
    // published and drawn nowhere.
    expect(html).toContain(`id="health-occupancy"`);
    expect(html).toContain(`id="health-inorder"`);
  });

  test("support-only batches reduce hack launch health, never landing order", () => {
    const sample = (t: number, graded: number, inOrder: number, noHack: number) => farm(t, {
      launched: { hack: graded - noHack, grow: graded, weaken: graded * 2 },
      landed: { hack: graded - noHack, grow: graded, weaken: graded * 2 },
      inFlight: { hack: 0, grow: 0, weaken: 0 },
      batches: {
        hwgw: {
          batches: graded, ops: graded * 4, landed: graded * 4,
          threads: { hack: 1, grow: 1, weaken: 2 }, gb: graded, moneyEarned: 0, hacks: graded - noHack,
          spanMs: graded * 1_000, graded, inOrder, noHack,
          abandoned: 0, abandonedOps: 0, abandonedLanded: 0,
        },
      },
    });
    const state = appendRecords(emptyState(), [
      sample(1_000, 10, 10, 0),
      sample(3_000, 20, 20, 0),
      sample(5_000, 30, 20, 10),
    ]);
    expect(state.farmHealth.inOrderShare.at(-1)?.[1]).toBe(1);
    expect(state.farmHealth.hackLaunchedShare.at(-1)?.[1]).toBe(0.5);
  });

  test("a compacted run says why the card is empty", () => {
    const state = emptyState();
    state.compacted = true;
    const html = TABS.hacking.render(state);
    expect(html).toContain("served compacted");
    // Not "waiting for a batch to settle", which blames the farm for a
    // limitation of how the run was stored.
    expect(html).not.toContain("waiting for a batch to settle");
  });
});

/** The pure-failure case, end to end through the wire shape.
 *
 * A kind whose every batch dies before settling has `batches: 0`. Both the
 * emitter's publication filter and the tab's own filter tested that field
 * alone, so the mode most worth reporting rendered exactly like one the save
 * had never used. */
describe("a batch kind that only ever fails is still reported", () => {
  test("an abandoned-only kind gets a column and says what happened", () => {
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      batches: {
        hwgw: {
          batches: 0, ops: 0, landed: 0, threads: { hack: 0, grow: 0, weaken: 0 },
          gb: 0, moneyEarned: 0, hacks: 0, spanMs: 0, graded: 0, inOrder: 0, noHack: 0,
          abandoned: 7, abandonedOps: 28, abandonedLanded: 12,
        },
      },
    } as StateMap["farm"];
    const html = TABS.hacking.render(state);
    expect(html).toContain(">hwgw<");
    expect(html).toContain("7 abandoned, 16 ops lost");
    // And it is not mistaken for a farm that has not started yet.
    expect(html).not.toContain("waiting for a batch to settle");
  });
});

/** The Hacking tab's "absence is not zero" cases, one test each.
 *
 * Every one of these rendered a confident figure for something the record does
 * not say: a stalled farm as an em dash, an unmeasured eviction counter as a
 * healthy zero, an SF5-gated multiplier as 1.0. */
describe("the Hacking tab separates an unmeasured reading from a zero one", () => {
  const rollup = (t: number, over: Record<string, unknown>): LogRecord =>
    ({ t, seq: t, run: "r", src: "sim", kind: "state", key: "farm",
       data: { totals: { moneyEarned: 0, hacks: 0 }, ...over } }) as LogRecord;

  const ops = (n: number) => ({ hack: n, grow: n, weaken: n });

  const kind = (over: Record<string, unknown> = {}) => ({
    batches: 4, ops: 16, landed: 16, threads: { hack: 4, grow: 8, weaken: 4 },
    gb: 400, moneyEarned: 4_000, hacks: 4, spanMs: 8_000, inOrder: 4, noHack: 0, ...over,
  });

  test("a farm that settled nothing in the window reads 0.00/s, not a dash", () => {
    // `foldFarmSeries` pushes a real `settled / dtSec` point on every rollup
    // once a baseline exists, 0 included — so collapsing 0 to NONE showed a
    // STALLED farm exactly like a run whose window has not opened yet.
    const state = appendRecords(emptyState(), [
      rollup(1_000, { launched: ops(10), landed: ops(10), inFlight: ops(0), batches: { hgw: kind() } }),
      rollup(3_000, { launched: ops(16), landed: ops(10), inFlight: ops(2), batches: { hgw: kind() } }),
    ]);
    const html = TABS.hacking.render(state);
    // Work in flight and nothing settling is the fault case, so it is coloured.
    expect(html).toContain(`class="bad">0.00/s`);
    // Captioned with the span actually differenced over — 2 s — not with the
    // window the panel asked for.
    expect(html).toContain("nothing settled in 2s");
  });

  test("an unreported eviction counter is not a healthy zero", () => {
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      batches: { hgw: kind() },
    } as StateMap["farm"];
    const html = TABS.hacking.render(state);
    // The counters postdate this recording, so the farm may or may not have
    // lost batches and this run cannot say.
    expect(html).toContain("not reported by this run");
    expect(html).not.toContain("every batch settled");
  });

  test("per-kind in-order divides by the GRADED batches, not by every batch", () => {
    const state = emptyState();
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      // Two paths open batches under one kind string: the JIT planner lands on
      // a grid, the atomic path deliberately does not. So graded < batches is
      // normal, and dividing by `batches` painted a healthy kind critical-red.
      batches: { hwgw: kind({ batches: 40, graded: 30, inOrder: 30 }) },
    } as StateMap["farm"];
    const html = TABS.hacking.render(state);
    expect(html).toMatch(/class="good"[^>]*>30 \/ 30 hack-bearing batches in order/);
    expect(html).not.toContain("30 / 40 in order");
  });

  test("a BitNode multiplier comes from the static table, not from a 1.0 default", () => {
    // `progression.multipliers` is SF5/BN5-gated, so in most nodes it is
    // permanently absent — and 1.0 is then a wrong answer stated as a fact.
    const withNode = (bitNode: number | undefined): string => {
      const state = emptyState();
      state.player = { skills: { hacking: 500 }, mults: {} } as never;
      state.servers.set("phantasy", {
        hostname: "phantasy", moneyMax: 24_000_000, moneyAvailable: 24_000_000,
        minDifficulty: 20, hackDifficulty: 20, baseDifficulty: 20,
        requiredHackingSkill: 100, maxRam: 32, ramUsed: 0, numOpenPortsRequired: 2,
      } as StateMap["servers"][string]);
      if (bitNode !== undefined) {
        state.topics.progression = { bitNode, sourceFiles: {} } as StateMap["progression"];
      }
      return TABS.hacking.render(state);
    };
    // BN2 scales ServerMaxMoney by 0.08: $48m, not the BN1 $600m.
    expect(withNode(2)).toContain("range $4.800e7");
    expect(withNode(1)).toContain("range $6.000e8");
    // And an unknown BitNode drops the range rather than asserting BN1's.
    expect(withNode(undefined)).not.toContain("generated maximum-money range");
  });

  test("the home RAM quote renders beside the infrastructure ranking, not instead of it", () => {
    // The producer publishes `infrastructurePlan` on every rollup, so chaining
    // the two cards as one ternary made the home card unreachable for the whole
    // life of the panel.
    const state = emptyState();
    state.topics.fleet = {
      rootedHosts: 4, totalHosts: 10, maxRam: 512, usedRam: 128,
      purchased: { count: 0, totalRam: 0 },
      home: { maxRam: 128, usedRam: 32, cores: 1 },
      homeRamPlan: {
        cost: 1e9, addedRam: 128, incomePerSec: 500, paybackSec: 2e6,
        netOverHorizon: -1e8, worthBuying: false,
      },
      infrastructurePlan: {
        evaluatedAt: 1_000, horizonSec: 3_600, moneyAvailable: 1e6, moneyGranted: 0,
        incomePerSecPerGb: 12, rankedTotal: 0, ranked: [],
      },
    } as StateMap["fleet"];
    const html = TABS.hacking.render(state);
    expect(html).toContain("Infrastructure ROI");
    expect(html).toContain("Home RAM (next upgrade)");
    // An empty ranking is a verdict, not blank space: nothing here says the
    // ceiling is met, because no depth cap was published.
    expect(html).toContain("no option priced above a $0 return");
  });
});
