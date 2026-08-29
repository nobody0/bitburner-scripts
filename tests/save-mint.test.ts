import { describe, expect, test } from "bun:test";
import { decodeSaveJson } from "../shared/save/decode.ts";
import { encodeSaveJson, MINTED_SAVE_VERSION } from "../shared/save/encode.ts";
import { saveToSeed } from "../shared/save/to-sim.ts";
import { deriveRouteLegs } from "../shared/strategy/progression/route-legs.ts";
import { routeLegEntranceSnapshot } from "../sim/save-mint.ts";
import { readIndex, readSnapshot } from "../tools/save-io.ts";

/** Minting is the inverse of seeding: a leg's entrance is DERIVED, so the
 * checkpoint that starts it has to be written rather than captured. These
 * cases hold the two halves against each other — anything the encoder drops
 * or misnames shows up as a seed that no longer matches its leg. */

const legs = deriveRouteLegs();
const leg = (name: string) => legs.find((entry) => entry.leg === name)!;

describe("minting a route leg's entrance", () => {
  test("the encoder is the decoder's inverse", () => {
    // Three shapes that exercise every branch the route can produce: a fresh
    // node, a mid-milestone re-entry carrying its own partial Source-File,
    // and a leg carrying chained intelligence.
    for (const name of ["bn4.1", "bn4.2", "bn5.2"]) {
      const snapshot = routeLegEntranceSnapshot(leg(name));
      const round = decodeSaveJson(encodeSaveJson(snapshot));
      expect(round).toEqual(snapshot);
    }
  });

  test("a fresh BN4 entrance grants nothing and needs no injected SF4", () => {
    const snapshot = routeLegEntranceSnapshot(leg("bn4.1"));
    const seed = saveToSeed(decodeSaveJson(encodeSaveJson(snapshot)));
    expect(seed.bitnode).toBe(4);
    expect(seed.sourceFiles).toEqual({});
    // The own-node level the run is playing toward: a cold start is 0, and
    // Singularity works anyway because the player is INSIDE BN4.
    expect(seed.sourceFileLevel).toBe(0);
    expect(seed.playerState.money).toBe(1_000);
    expect(seed.person.skills.intelligence).toBe(0);
    expect(seed.homeRam).toBe(8);
  });

  test("a mid-milestone leg re-enters its own node at the level it earned", () => {
    // `4.3` is shorthand for three completions; this is the second of them,
    // so the entrance owns SF4.1 and the node's own multipliers escalate.
    const snapshot = routeLegEntranceSnapshot(leg("bn4.2"));
    const seed = saveToSeed(decodeSaveJson(encodeSaveJson(snapshot)));
    expect(seed.bitnode).toBe(4);
    expect(seed.sourceFiles).toEqual({ "4": 1 });
    expect(seed.sourceFileLevel).toBe(1);
  });

  test("chained intelligence survives the round trip as a reachable state", () => {
    const entrance = leg("bn5.2");
    expect(entrance.entranceIntelligence).toBeGreaterThan(0);
    const seed = saveToSeed(decodeSaveJson(encodeSaveJson(routeLegEntranceSnapshot(entrance))));
    expect(seed.person.skills.intelligence).toBe(entrance.entranceIntelligence);
    // Skill and experience must describe the SAME state, and the persistent
    // pool is what survives an install — an entrance whose exp disagreed
    // would lose its intelligence at the leg's first prestige.
    expect(seed.person.exp.intelligence).toBeGreaterThan(0);
    expect(seed.playerState.persistentIntelligenceExp).toBe(seed.person.exp.intelligence);
    // Intelligence only persists with owned SF5, which the route guarantees
    // by the time it hands any leg a non-zero entrance.
    expect(seed.sourceFiles["5"]).toBeGreaterThan(0);
  });

  test("the network is the fixed vanilla fixture, with darkweb present", () => {
    const snapshot = routeLegEntranceSnapshot(leg("bn1.1"));
    const seed = saveToSeed(decodeSaveJson(encodeSaveJson(snapshot)));
    // darkweb must exist even with no TOR, or connectTor reports an
    // unmodeled subsystem and invalidates the whole run.
    expect(snapshot.servers.has("darkweb")).toBe(true);
    expect(seed.hasTor).toBe(false);
    expect(snapshot.servers.get("n00dles")).toBeDefined();
    expect(snapshot.version).toBe(MINTED_SAVE_VERSION);
  });

  test("BN8 mints the node's trading bankroll, other nodes a prestige purse", () => {
    // The node grants it because the market is BN8's only income.
    expect(routeLegEntranceSnapshot(leg("bn8.1")).player.money).toBe(250e6);
    expect(routeLegEntranceSnapshot(leg("bn15.1")).player.money).toBe(1_000);
  });

  test("the registered fresh checkpoint is the route's own first entrance", () => {
    // `saves/leg-bn4.1-start.json.gz` is committed, so the route has a real
    // starting checkpoint rather than only a derivable one. It must keep
    // matching what the derivation says leg 0 is, or the chain starts from a
    // state the route never describes.
    const entry = readIndex().saves.find((save) => save.id === "leg-bn4.1-start");
    expect(entry).toBeDefined();
    expect(entry!.minted).toBe(true);
    expect(entry!.bitNode).toBe(4);
    const seed = saveToSeed(readSnapshot(entry!.file));
    const derived = saveToSeed(decodeSaveJson(encodeSaveJson(routeLegEntranceSnapshot(leg("bn4.1")))));
    expect(seed.bitnode).toBe(derived.bitnode);
    expect(seed.sourceFiles).toEqual(derived.sourceFiles);
    expect(seed.playerState.money).toBe(derived.playerState.money);
    expect(seed.homeRam).toBe(derived.homeRam);
  });

  test("minting the same leg twice produces the same bytes", () => {
    // The registry keys lineage on a checkpoint's SHA-256, so re-minting a
    // leg must reproduce it exactly — otherwise every downstream result would
    // appear to descend from a different entrance after any re-mint.
    const once = encodeSaveJson(routeLegEntranceSnapshot(leg("bn15.2")));
    const twice = encodeSaveJson(routeLegEntranceSnapshot(leg("bn15.2")));
    expect(once).toBe(twice);
  });

  test("node economics come from the leg's own node, not whichever ran last", () => {
    // serverFromSpec reads module-global multipliers, so minting must set
    // them first. Minting BN15 (ServerMaxMoney 0.01) after BN1 and getting
    // BN1 money back would be silent and invisible in the blob.
    const bn1 = routeLegEntranceSnapshot(leg("bn1.1")).servers.get("n00dles")!;
    const bn15 = routeLegEntranceSnapshot(leg("bn15.1")).servers.get("n00dles")!;
    expect(bn15.moneyMax).not.toBe(bn1.moneyMax);
  });
});
