import { describe, expect, test } from "bun:test";
import { selectDisagreedGroups } from
  "../ipvgobruteforce/arena/export-certified-terminal-regret.ts";
import { selectGroups as selectResponseGroups } from
  "../ipvgobruteforce/arena/export-certified-response-features.ts";

describe("certified Small5 terminal regret selection", () => {
  test("treats raw v16 actor inputs as independent outcome-blind probe groups", () => {
    const rows: Record<string, any>[] = ["Netburners", "Illuminati"].flatMap((opponent) =>
      ["train", "heldout"].flatMap((split) => Array.from({ length: 3 }, (_, index) => ({
        split,
        outcomeThatMustNotMatter: index % 2,
        example: { state: `X${".".repeat(23)}${index}`, behavior: [index], elapsed: index },
        generation: { opponent },
      }))));
    const selected = selectResponseGroups(rows, 1);
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map((row) =>
      `${row.split}:${(row.generation as Record<string, unknown>).opponent}`)).size).toBe(4);
  });

  test("selects complete KataGo-disagreed groups per split and opponent without outcomes", () => {
    const rows: Record<string, any>[] = [];
    for (const split of ["train", "heldout"]) {
      for (const opponent of ["Netburners", "Slum Snakes"]) {
        for (let group = 0; group < 4; group++) {
          for (let member = 0; member < 2; member++) {
            rows.push({ split, outcomeThatMustNotMatter: group % 2,
              generation: { opponent, conditionalGroupSha256: `${opponent}:${group}`,
                kataGoAgrees: group !== 3 }, member });
          }
        }
      }
    }
    const selected = selectDisagreedGroups(rows, 1);
    expect(selected).toHaveLength(8);
    expect(selected.every((row) => row.generation.kataGoAgrees === false)).toBe(true);
    const complete = new Map<string, number>();
    for (const row of selected) {
      const key = `${row.split}:${row.generation.opponent}:${row.generation.conditionalGroupSha256}`;
      complete.set(key, (complete.get(key) ?? 0) + 1);
    }
    expect([...complete.values()]).toEqual([2, 2, 2, 2]);
  });
});
