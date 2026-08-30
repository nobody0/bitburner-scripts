import { describe, expect, test } from "bun:test";
import { BITNODE_SPEEDRUN_PLAN, DISABLED_BITNODES } from "../shared/strategy/progression/bitnode-order.ts";
import {
  deriveRouteLegs,
  routeLegProfileId,
  SPEEDRUN_ROUTE_ID,
} from "../sim/route-legs.ts";

/** The chain: every leg is ONE BitNode completion, and its entrance is
 * exactly what the earlier completions earned. Source-Files are deterministic
 * in the route order; intelligence prefers a measured previous-leg exit and
 * falls back to the estimate. */

describe("route leg derivation", () => {
  const legs = deriveRouteLegs();

  test("milestones decompose into one leg per completion", () => {
    // 15 nodes to level 3 = 45 completions, however the milestones cut them.
    expect(legs.length).toBe(45);
    // Every milestone is accounted for, and none invents one.
    expect(new Set(legs.map(({ milestone }) => milestone)))
      .toEqual(new Set(BITNODE_SPEEDRUN_PLAN.map(({ node, level }) => `${node}.${level}`)));
    legs.forEach((leg, i) => {
      expect(leg.index).toBe(i);
      expect(leg.leg).toBe(`bn${leg.node}.${leg.level}`);
      expect(leg.enabled).toBe(!DISABLED_BITNODES.has(leg.node));
    });
    // Leg names are unique: levels only rise, so (node, level) never repeats.
    expect(new Set(legs.map(({ leg }) => leg)).size).toBe(legs.length);
    expect(routeLegProfileId(legs[0]!)).toBe("leg-bn4.1");
    expect(SPEEDRUN_ROUTE_ID).toBe("all-sf3-bn4-first");
  });

  test("the 4.3 milestone is shorthand for 4.1, 4.2, 4.3", () => {
    expect(legs.slice(0, 3).map(({ leg }) => leg)).toEqual(["bn4.1", "bn4.2", "bn4.3"]);
    expect(legs.slice(0, 3).map(({ milestone }) => milestone)).toEqual(["4.3", "4.3", "4.3"]);
    // Only the very first completion is a fresh entrance; mid-milestone legs
    // re-enter their own node holding the partial Source-File just earned.
    expect(legs[0]).toMatchObject({ entranceSourceFiles: {}, entranceIntelligence: 0, enabled: true });
    expect(legs[1]).toMatchObject({ leg: "bn4.2", entranceSourceFiles: { "4": 1 } });
    expect(legs[2]).toMatchObject({ leg: "bn4.3", entranceSourceFiles: { "4": 2 } });
  });

  test("a later milestone decomposes only into the missing levels", () => {
    // 14.1 earlier in the route means the 14.3 milestone yields 14.2 and 14.3
    // only — never a repeat of 14.1.
    expect(legs.filter(({ node }) => node === 14).map(({ leg }) => leg))
      .toEqual(["bn14.1", "bn14.2", "bn14.3"]);
    expect(legs[14]).toMatchObject({ leg: "bn14.2", milestone: "14.3", entranceSourceFiles: expect.objectContaining({ "14": 1, "2": 3 }) });
    expect(legs[15]).toMatchObject({ leg: "bn14.3", entranceSourceFiles: expect.objectContaining({ "14": 2 }) });
  });

  test("BN1 is entered holding only the earned SF4.3 — nothing injected", () => {
    expect(legs[3]).toMatchObject({ leg: "bn1.1", entranceSourceFiles: { "4": 3 } });
    expect(legs[4]).toMatchObject({ leg: "bn1.2", entranceSourceFiles: { "4": 3, "1": 1 } });
    expect(legs[3]!.entranceIntelligence).toBe(0);
  });

  test("the 5.1 leg enters with every prior completion and still no intelligence", () => {
    expect(legs[10]).toMatchObject({
      leg: "bn5.1",
      entranceSourceFiles: { "4": 3, "1": 3, "15": 3, "14": 1 },
      entranceIntelligence: 0,
      intelligenceSource: "estimated",
    });
  });

  test("estimated intelligence grows by 10 per completion past 5.1", () => {
    // Installs zero intelligence without owned SF5, so it cannot predate 5.1.
    expect(legs[11]).toMatchObject({ leg: "bn2.1", entranceIntelligence: 10, enabled: false });
    expect(legs[11]!.entranceSourceFiles["5"]).toBe(1);
    expect(legs[13]).toMatchObject({ leg: "bn2.3", entranceIntelligence: 30 });
    expect(legs[15]).toMatchObject({ leg: "bn14.3", entranceIntelligence: 50 });
  });

  test("the final leg holds every Source-File, its own node at level 2", () => {
    const last = legs[legs.length - 1]!;
    expect(last.leg).toBe("bn3.3");
    expect(last.entranceIntelligence).toBe(340);
    expect(last.entranceSourceFiles["3"]).toBe(2);
    const nodes = new Set(BITNODE_SPEEDRUN_PLAN.map(({ node }) => node));
    nodes.delete(3);
    for (const node of nodes) {
      expect(last.entranceSourceFiles[String(node)]).toBe(3);
    }
  });

  test("spec/strategy/route-legs.md carries the current derived table", async () => {
    const { renderRouteLegsTable } = await import("../tools/route-legs.ts");
    const document = await Bun.file(new URL("../spec/strategy/route-legs.md", import.meta.url)).text();
    const spliced = document.match(/<!-- route-legs:begin -->\r?\n([\s\S]*?)\r?\n<!-- route-legs:end -->/);
    expect(spliced?.[1]?.replace(/\r\n/g, "\n") ?? "MISSING MARKER BLOCK — run bun tools/route-legs.ts --write")
      .toBe(renderRouteLegsTable());
  });

  test("a measured previous-leg exit beats the estimate and says so", () => {
    const chained = deriveRouteLegs(BITNODE_SPEEDRUN_PLAN, { "bn4.1": 7, "bn2.1": 42 });
    expect(chained[1]).toMatchObject({ leg: "bn4.2", entranceIntelligence: 7, intelligenceSource: "measured" });
    expect(chained[12]).toMatchObject({ leg: "bn2.2", entranceIntelligence: 42, intelligenceSource: "measured" });
    // Legs whose predecessor has no recorded exit keep the estimate.
    expect(chained[2]).toMatchObject({ intelligenceSource: "estimated" });
    expect(chained[11]).toMatchObject({ entranceIntelligence: 10, intelligenceSource: "estimated" });
  });
});
