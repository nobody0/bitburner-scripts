import { describe, expect, test } from "bun:test";
import { AUGMENTATION_TABLE } from "../vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { AUGMENTATIONS, describeMults, multLabel } from "../../shared/features/augmentations.ts";
import { SOA_SET } from "../ns/singularity.ts";

/** `shared/features/augmentations.ts` is a hand-transcribed copy of the
 * vendored augmentation table: `ui/` needs it to answer "what does this give
 * me and where do I get it" for augmentations from factions we have not joined
 * — which the telemetry `offers` list can never contain — and `ui/` may not
 * import `sim/` (tests/boundaries.test.ts).
 *
 * After `bun run vendor` bumps the tag, a failure here is the EXPECTED signal
 * to regenerate the transcription. */

describe("augmentation transcription parity", () => {
  /** A NAME THAT MATCHES NOTHING IS SILENT. Every one of SOA_SET's nine entries
   * was written without the "SoA - " prefix the game ships, so the set matched
   * no augmentation at all: priceOf's SoA branch was unreachable and
   * queuedNonSoA counted the very augmentations it excludes. Nothing failed,
   * because a Set miss has no symptom — SoA augs were simply priced with the
   * generic formula and every queued one inflated the next NeuroFlux by 1.9x.
   * Source: src/Augmentation/Enums.ts:139-147, src/Augmentation/AugmentationHelpers.ts:140-153 */
  test("every SoA augmentation name resolves against the vendored table", () => {
    expect(SOA_SET.size).toBe(9);
    for (const name of SOA_SET) {
      expect(AUGMENTATION_TABLE[name], `${name} matches no augmentation`).toBeDefined();
    }
    // And the set is exactly the nine the game prices that way.
    const prefixed = Object.keys(AUGMENTATION_TABLE).filter((name) => name.startsWith("SoA - "));
    expect([...SOA_SET].sort()).toEqual(prefixed.sort());
  });

  test("the same augmentations exist on both sides", () => {
    expect(Object.keys(AUGMENTATIONS).sort()).toEqual(Object.keys(AUGMENTATION_TABLE).sort());
  });

  test("every price, requirement, faction list and multiplier matches", () => {
    for (const [name, vendored] of Object.entries(AUGMENTATION_TABLE)) {
      const mine = AUGMENTATIONS[name];
      expect(mine, `${name} missing from the transcription`).toBeDefined();
      expect(mine!.cost, `${name} cost`).toBe(vendored.baseCost);
      expect(mine!.rep, `${name} rep`).toBe(vendored.baseRepRequirement);
      expect([...mine!.factions], `${name} factions`).toEqual(vendored.factions);
      expect([...(mine!.prereqs ?? [])], `${name} prereqs`).toEqual(vendored.prereqs);
      expect(mine!.special ?? false, `${name} special`).toBe(vendored.isSpecial);
      expect(mine!.mults ?? {}, `${name} mults`).toEqual(vendored.mults);
      expect(mine!.startingMoney, `${name} startingMoney`).toBe(vendored.startingMoney);
      expect([...(mine!.programs ?? [])], `${name} programs`).toEqual(vendored.programs ?? []);
      expect(mine!.multsUnknown ?? false, `${name} multsUnknown`).toBe(vendored.multsUnknown ?? false);
    }
  });

  test("every multiplier field the game uses has a display label", () => {
    const fields = new Set<string>();
    for (const aug of Object.values(AUGMENTATION_TABLE)) for (const field of Object.keys(aug.mults)) fields.add(field);
    // A missing label falls back to the raw field name, which is how
    // "hacknet_node_purchase_cost" would end up in the panel.
    const unlabelled = [...fields].filter((f) => multLabel(f) === f && f.includes("_"));
    expect(unlabelled).toEqual([]);
  });
});

describe("describing what an augmentation gives", () => {
  test("biggest effect first, sign preserved", () => {
    const described = describeMults({ hacking: 1.1, hacking_money: 1.8, hacknet_node_core_cost: 0.85 }, 3);
    // A cost multiplier below 1.0 is a benefit; it is rendered as the negative
    // number it is, and ranked by how big the change is either way.
    expect(described.map((d) => d.text)).toEqual(["hack $ +80%", "hacknet core cost -15%", "hacking +10%"]);
  });
});
