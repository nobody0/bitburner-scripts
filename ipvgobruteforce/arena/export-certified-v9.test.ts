import { describe, expect, test } from "bun:test";
import {
  derivePolicyIndex,
  modelInputKey,
  parseCertificate,
  parseCertifiedAction,
  unpackCertificateBoard,
} from "./export-certified-v9.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("certified V9 export primitives", () => {
  test("decodes certificate actions", () => {
    expect(parseCertifiedAction("0,0")).toBe(0);
    expect(parseCertifiedAction("4,4@slot1")).toBe(24);
    expect(parseCertifiedAction("pass")).toBe(25);
    expect(parseCertifiedAction("align")).toBe("align");
    expect(parseCertifiedAction("terminal")).toBe("terminal");
  });

  test("unpacks certificate boards in x-major order", () => {
    const board = unpackCertificateBoard("0x3000000000001");
    expect(board.rows[0]![0]).toBe("X");
    expect(board.rows[4]![4]).toBe("#");
  });

  test("keys model-visible inputs and includes elapsed and behavior", () => {
    const first = modelInputKey("state", [0, 0.5], 1).toString("hex");
    expect(modelInputKey("state", [0, 0.5], 1).toString("hex")).toBe(first);
    expect(modelInputKey("state", [0, 0.5], 2).toString("hex")).not.toBe(first);
    expect(modelInputKey("state", [0, 0.6], 1).toString("hex")).not.toBe(first);
  });

  test("preserves the absolute playtime epoch in opponent behavior seeds", () => {
    const certificate = [
      "# ipvgo-seeded-certificate-v6",
      "# start_phase\t149999",
      "# runtime_uncertainty_ticks\t1",
      "# ai_seed_slip_ticks\t0",
      "# playtime_epoch\t2697",
      "# alignment_boards\t0",
      "# max_rounds\t40",
      "state_id\tphase\tround\talign_credit\tboard\tpasses\thistory\taction\taction_class\tsuccessors",
      "1\t149999\t1\t0\t.........................\t0\t\t0,0@slot1\texact-single\t2",
    ].join("\n") + "\n";
    const actor = parseCertificate(certificate, "fixture.tsv", "Netburners").candidates[0]!;
    expect(actor.opponentSeed).toBe(2698 * 30_000_000);
  });

  test("derives a deterministic policy index from certificate roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "certified-v9-index-"));
    try {
      await mkdir(join(directory, "policies"));
      const certificate = [
        "# ipvgo-seeded-certificate-v6",
        "# start_phase\t42",
        "# runtime_uncertainty_ticks\t1",
        "# ai_seed_slip_ticks\t0",
        "# playtime_epoch\t2697",
        "# alignment_boards\t0",
        "# max_rounds\t40",
        "state_id\tphase\tround\talign_credit\tboard\tpasses\thistory\taction\taction_class\tsuccessors",
        "0\t42\t0\t0\t.........................\t0\t\talign\texact-single\t1",
      ].join("\n") + "\n";
      await writeFile(join(directory, "policies", "42.tsv"), certificate);
      const derived = await derivePolicyIndex(directory, "Netburners");
      expect(derived.rows).toEqual([{
        opponent: "Netburners", phase: 42,
        startBoard: ".........................", policy: "42.tsv",
      }]);
      expect(derived.text).toContain("Netburners\t42\t.........................\t42.tsv");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
