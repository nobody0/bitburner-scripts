import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FEATURES } from "../shared/features/registry.ts";
import type { StateMap } from "../shared/telemetry/state-map.ts";
import { renderMarkdown } from "../ui/app/lib/markdown.ts";
import { emptyState } from "../ui/app/project.ts";
import { TABS } from "../ui/app/tabs/index.ts";
import { featureSpecFile } from "../ui/specs.ts";

describe("feature specification drawer", () => {
  test("every feature has its own specification file, headed by its own id", () => {
    for (const feature of FEATURES) {
      const spec = readFileSync(featureSpecFile(feature.id), "utf8");
      expect(spec, feature.id).toStartWith(`# \`${feature.id}\``);
      // One feature per file: nothing else may claim a top-level heading in it.
      expect(spec.match(/^# /gm)?.length ?? 0, feature.id).toBe(1);
    }
  });

  test("the spec renderer handles specification tables and never accepts raw HTML", () => {
    const rendered = renderMarkdown([
      "## `hacking` — the farm",
      "",
      "**Needs** RAM and `<script>` safety.",
      "",
      "| From | Need |",
      "|---|---|",
      "| `fleet` | RAM |",
    ].join("\n"));

    expect(rendered).toContain("<h2><code>hacking</code> — the farm</h2>");
    expect(rendered).toContain("<strong>Needs</strong>");
    expect(rendered).toContain("<table>");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).not.toContain("<script>");
  });
});

describe("dashboard decision summaries", () => {
  test("Overview states what is happening next and what is blocked", () => {
    const state = emptyState();
    state.topics.progression = {
      bitNode: 1,
      sourceFiles: {},
      ownedAugs: {},
      augCount: 0,
      lastAugReset: 0,
      lastNodeReset: 0,
      needs: [{
        by: "factions",
        kind: "money",
        subject: "The Red Pill",
        target: 1_000_000,
        have: 250_000,
        progress: 0.25,
        weight: 1,
        urgency: "blocking",
        satisfied: false,
      }],
      plan: {
        phase: "finishUp",
        installWanted: true,
        liquidationWanted: false,
        installBlockers: ["factions"],
        installReady: false,
        queuedAugmentations: ["Neurotrainer I"],
        install: false,
        favorCrossings: [],
        route: "daedalus",
        forecasts: {},
      },
    } as unknown as StateMap["progression"];
    state.topics.arbitration = {
      grants: [], denied: [], remaining: { money: 0 },
      slot: { by: "career", id: "company-work", priority: 2, heldMs: 5_000 },
    };
    state.topics.farm = {
      totals: { moneyEarned: 0, hacks: 0 },
      mode: "hwgw",
      pipelines: [{
        host: "n00dles", role: "farm", mode: "hwgw", segment: "farm", gb: 32,
        inFlight: { hack: 1, grow: 1, weaken: 2 },
      }],
    } as StateMap["farm"];
    state.topics.ramArena = {
      starvation: [{ by: "factions", id: "singularity-probe", gb: 64, waitMs: 12_000 }],
    } as StateMap["ramArena"];

    const html = TABS.overview.render(state);
    expect(html).toContain("Automation summary");
    expect(html).toContain("daedalus");
    expect(html).toContain("Career · company work");
    expect(html).toContain("farm n00dles");
    expect(html).toContain("The Red Pill");
    expect(html).toContain("singularity probe needs 64GB");
  });

  test("Hacking keeps the server table but adds filters and honest selection evidence", () => {
    const state = emptyState();
    state.player = { skills: { hacking: 100 }, mults: {} } as ProjectedStatePlayer;
    state.servers.set("n00dles", {
      hostname: "n00dles",
      organizationName: "Noodle Bar",
      hasAdminRights: true,
      backdoorInstalled: true,
      requiredHackingSkill: 1,
      numOpenPortsRequired: 0,
      openPortCount: 0,
      moneyAvailable: 900_000,
      moneyMax: 1_000_000,
      hackDifficulty: 2,
      minDifficulty: 1,
      baseDifficulty: 1,
      ramUsed: 4,
      maxRam: 8,
      cpuCores: 1,
    } as StateMap["servers"][string]);
    state.topics.farm = {
      target: "n00dles",
      targetSolveExact: true,
      totals: { moneyEarned: 0, hacks: 0 },
      pipelines: [{
        host: "n00dles", role: "farm", mode: "hwgw", segment: "farm", gb: 8,
        inFlight: { hack: 1, grow: 1, weaken: 2 }, moneyPerSecPerGb: 12,
      }],
    } as StateMap["farm"];
    state.topics.side = {
      contracts: [{ host: "n00dles", file: "contract.cct" }],
    } as StateMap["side"];

    const html = TABS.hacking.render(state);
    expect(html).toContain('data-view-key="hacking.selected"');
    expect(html).toContain('data-view-value="active"');
    expect(html).toContain('data-view-value="needs-prep"');
    expect(html).toContain('data-view-value="contracts"');
    expect(html).toContain("Selection");
    expect(html).toContain("Selected as the committed farm winner");
    expect(html).toContain("Current vs ideal");
    expect(html).toContain('class="picked"');
  });
});

type ProjectedStatePlayer = NonNullable<ReturnType<typeof emptyState>["player"]>;
