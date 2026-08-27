import { describe, expect, test } from "bun:test";
import {
  invalidatedPersistedBackdoors,
  parsePersistedDnetState,
  serializePersistedDnetState,
  type PersistedBackdoorEntry,
} from "../game/lib/features/dnet.ts";
import type { VaultEntry } from "../shared/strategy/dnet/courier.ts";
import { emptyKnowledge } from "../shared/strategy/dnet/host.ts";

/** Home persists the vault it cracked to its own file so a save RELOAD skips
 * re-cracking. The one thing that must never go wrong is the generation guard:
 * a prestige mints a new net with new passwords, and loading a dead node's
 * credentials into a live one would spend calls proving them wrong. These pin
 * the pure round-trip and every way the guard must refuse. */

const GEN = "12:1787430908768";
const entries: VaultEntry[] = [
  { hostname: "darkweb-neighbour", password: "hunter2", identity: "ip-1", at: 1000 },
  { hostname: "stasis-host", password: "", identity: "ip-2", at: 2000 },
];
const backdoors: PersistedBackdoorEntry[] = [
  { hostname: "low-ram-a", installedAt: 3_000 },
  { hostname: "low-ram-b", installedAt: 4_000 },
];

describe("private darknet state persistence", () => {
  test("a same-generation round-trip restores credentials and backdoors", () => {
    expect(parsePersistedDnetState(serializePersistedDnetState(GEN, entries, backdoors), GEN))
      .toEqual({ vault: entries, backdoors });
  });

  test("a prestige restores nothing from the dead generation", () => {
    const raw = serializePersistedDnetState(GEN, entries, backdoors);
    expect(parsePersistedDnetState(raw, "13:1787430908768")).toEqual({ vault: [], backdoors: [] });
    expect(parsePersistedDnetState(raw, "12:9999999999999")).toEqual({ vault: [], backdoors: [] });
  });

  test("empty, corrupt, and generation-less files restore nothing", () => {
    const empty = { vault: [], backdoors: [] };
    expect(parsePersistedDnetState("", GEN)).toEqual(empty);
    expect(parsePersistedDnetState("{ not json", GEN)).toEqual(empty);
    expect(parsePersistedDnetState("null", GEN)).toEqual(empty);
    expect(parsePersistedDnetState(JSON.stringify({ vault: entries, backdoors }), GEN)).toEqual(empty);
  });

  test("malformed records are dropped while valid records survive", () => {
    const mixed = JSON.stringify({
      generation: GEN,
      vault: [
        entries[0],
        { hostname: "", password: "x", at: 1 },
        { hostname: "h", password: "x" },
        { password: "x", at: 1 },
        null,
        entries[1],
      ],
      backdoors: [
        backdoors[0],
        { hostname: "", installedAt: 1 },
        { hostname: "missing-time" },
        { hostname: "nan", installedAt: Number.NaN },
        null,
        backdoors[1],
      ],
    });
    expect(parsePersistedDnetState(mixed, GEN)).toEqual({ vault: entries, backdoors });
  });

});

describe("backdoor retirement", () => {

  test("gone, replaced, and forgotten hosts release restored slots", () => {
    const held = new Map(backdoors.map((entry) => [entry.hostname, entry.installedAt]));
    const knowledge = emptyKnowledge(GEN);
    knowledge.hosts.set("low-ram-a", {
      hostname: "low-ram-a",
      lastSeenAt: 5_000,
      goneAt: 5_000,
      seenAt: {},
      dirty: {},
    });
    knowledge.hosts.set("not-yet-seen", {
      hostname: "not-yet-seen",
      lastSeenAt: 1,
      seenAt: {},
      dirty: {},
    });
    expect(invalidatedPersistedBackdoors(
      held,
      knowledge,
      ["low-ram-b", "already-forgotten"],
    )).toEqual(["low-ram-a", "low-ram-b"]);
  });
});
