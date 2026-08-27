import { describe, expect, test } from "bun:test";
import { planArmour, type ArmourCandidate, type ArmourContext } from "../shared/strategy/dnet/armour.ts";
import { msPerRestartOfHost, mutationBudget } from "../shared/strategy/dnet/rates.ts";
import { PROBER_ARMOURED_GB, PROBER_GB } from "../game/dnet/shared.ts";

/** Who pays the 2 GB, and why.
 *
 * Armour is the only thing that survives `restartServer`, and it is deliberately
 * NOT a default: the spread lane measures stranded capacity at a fraction of
 * what a blanket fleet reserve would cost. These pin the two arguments that
 * override that default and, just as importantly, the cases that must not. */

const ARMOUR_GB = PROBER_ARMOURED_GB - PROBER_GB;

const ctx = (over: Partial<ArmourContext> = {}): ArmourContext =>
  ({ stormImminent: false, armourGb: ARMOUR_GB, ...over });

const host = (over: Partial<ArmourCandidate> = {}): ArmourCandidate =>
  ({ hostname: "dnet-3-x11", usableGb: 12, proberStanding: true, ...over });

const armoured = (candidate: ArmourCandidate, context = ctx()): boolean =>
  planArmour([candidate], context).has(candidate.hostname);

describe("what armour costs is exactly one call", () => {
  test("the 2 GB is `spawn`, and nothing else", () => {
    expect(ARMOUR_GB).toBeCloseTo(2, 6);
  });
});

describe("the hosts that must never wear it", () => {
  test("a stasis-linked host is exempt from restart, so armour could never fire", () => {
    // The engine's guard is `openServer || isConnectedTo || hasStasisLink` and
    // `restartServer` returns early on it. Arming here is a reserve with no
    // event to spend itself on — and stasis hosts are the deepest and most
    // capacity-rich ones we hold, so it would be the most expensive mistake
    // available. Not even a storm or a backdoor overrides it: a linked host is
    // filtered out of the backdoored pool too.
    for (const context of [ctx(), ctx({ stormImminent: true })]) {
      expect(armoured(host({ stasisLinked: true }), context)).toBe(false);
      expect(armoured(host({ stasisLinked: true, backdoored: true }), context)).toBe(false);
    }
  });

  test("the lab candidate carries no prober, so it has nothing to armour", () => {
    expect(armoured(host({ omitProber: true }), ctx({ stormImminent: true }))).toBe(false);
  });

  test("a host with no prober standing is left to the plant that sizes it", () => {
    expect(armoured(host({ proberStanding: false }), ctx({ stormImminent: true }))).toBe(false);
    expect(armoured(host({ goneAt: 500 }), ctx({ stormImminent: true }))).toBe(false);
  });

  test("unknown RAM never reads as room", () => {
    // The same rule the spread planner keeps: an exec against unknown capacity
    // returns a silent 0, indistinguishable from a host that is simply full.
    expect(armoured(host({ usableGb: undefined }), ctx({ stormImminent: true }))).toBe(false);
  });

  test("armour is refused when the host cannot pay for it", () => {
    const storm = ctx({ stormImminent: true });
    expect(armoured(host({ usableGb: ARMOUR_GB - 0.01 }), storm)).toBe(false);
    expect(armoured(host({ usableGb: ARMOUR_GB }), storm)).toBe(true);
  });
});

describe("the two arguments for paying it", () => {
  test("an imminent storm arms everything that fits, and nothing before", () => {
    // The one case that is a CERTAINTY rather than a rate:
    // `restartAllDarknetServers` restarts every movable survivor at once, and
    // it is a storm we fire ourselves. A host with no standing case for armour
    // still gets it here — and loses it again the moment the storm is not near.
    const small = host({ usableGb: ARMOUR_GB, hostname: "tiny" });
    expect(armoured(small, ctx())).toBe(false);
    expect(armoured(small, ctx({ stormImminent: true }))).toBe(true);
  });

  test("a backdoored host is armed on its own restart branch, storm or no storm", () => {
    // Upstream draws one victim from the backdoored pool alone at 10% per tick
    // and RETURNS, so a lone backdoor is a flat ~9% per tick against a share of
    // the generic 20% draw spread over the whole population.
    expect(armoured(host({ backdoored: true }), ctx())).toBe(true);
    expect(armoured(host({ backdoored: false }), ctx())).toBe(false);
  });

  test("the arithmetic behind the backdoor rung: an order of magnitude hotter", () => {
    // This is the whole justification for arming a backdoored host permanently,
    // so it is pinned rather than asserted in a comment.
    const one = msPerRestartOfHost(true, 36, 15, 1);
    const eight = msPerRestartOfHost(true, 36, 15, 8);
    const ordinary = msPerRestartOfHost(false, 36, 15, 8);
    // One backdoor absorbs the whole targeted draw; eight share it.
    expect(one).toBeLessThan(eight);
    // And either way a backdoored host is restarted far sooner than a plain one.
    expect(eight).toBeLessThan(ordinary);
    expect(ordinary / one).toBeGreaterThan(10);
  });

  test("with no backdoors at all the targeted branch cannot fire", () => {
    // `backdoored` is an input to the whole budget: with an empty pool the two
    // backdoor branches early-return less often, so the net is calmer.
    expect(msPerRestartOfHost(true, 36, 15, 0)).toBe(msPerRestartOfHost(false, 36, 15, 0));
    expect(mutationBudget(0).restarted).toBeLessThan(mutationBudget(1).restarted);
  });

  test("there is no standing capacity rung, and that was measured", () => {
    // A rung weighing each host's capacity against its restart hazard was built
    // and benchmarked: over sixteen paired seeds it billed 264.70 GB-h against
    // storm-only armour's 4.80 and recovered nothing further, because the net
    // replants itself in the same virtual instant 96% of the time. It was
    // removed rather than left switched off, so an enormous idle host is worth
    // exactly as much armour as a small one: none.
    expect(armoured(host({ hostname: "huge", usableGb: 4_096 }), ctx())).toBe(false);
  });
});
