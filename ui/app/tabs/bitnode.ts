import {
  BITNODES,
  MULTIPLIER_GROUPS,
  changedMultipliers,
  type ChangedMultiplier,
  type MultiplierGroup,
} from "../../../shared/features/bitnode.ts";
import { featureForBitNode } from "../../../shared/features/registry.ts";
import { card, definitions, filters, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** BitNode tab: where we are, what we have finished, and exactly what this
 * node changes. Source-file level doubles as the completion count — SF n at
 * level 3 means BitNode n was destroyed three times. */

const GROUP_LABELS: Record<MultiplierGroup, string> = {
  hacking: "Hacking",
  infra: "Infrastructure",
  skills: "Skills",
  career: "Career",
  factions: "Factions",
  side: "Side income",
  hacknet: "Hacknet",
  stock: "Stocks",
  gang: "Gang",
  corp: "Corporation",
  bladeburner: "Bladeburner",
  stanek: "Stanek",
  go: "Go",
  darknet: "Darknet",
  endgame: "Endgame",
};

/** Strip the noise words every field name repeats. `HackingLevelMultiplier`
 * inside a card titled "BitNode multipliers" spends 10 of its 23 characters
 * saying nothing. */
function shortField(field: string): string {
  return field.replace(/Multiplier$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** One multiplier as `name  value  ±%`.
 *
 * The BN1 default is not a column: it is 1.0 for every field but two, so a
 * whole column of "1.000" was a third of the table's width. The percentage
 * carries the same information and reads as a magnitude — 0.700 is "70% of
 * BN1", 1.428 is "143%" — while the colour says whether that helps. */
function multiplierEntry(entry: ChangedMultiplier): string {
  const cls = entry.harder ? "bad" : "good";
  // StaneksGiftExtraSize is the one field with a base of 0, where a ratio is
  // undefined; it is a count of grid squares, so it is shown as a delta.
  const delta =
    entry.base === 0
      ? `${entry.value > 0 ? "+" : ""}${fmtNum(entry.value, 0)}`
      : `${((entry.value / entry.base) * 100).toFixed(0)}%`;
  return (
    `<div class="mult" title="${esc(`${entry.field}: ${entry.value} (BN1 default ${entry.base})`)}">` +
    `<span class="nm">${esc(shortField(entry.field))}</span>` +
    `<span class="vl">${fmtNum(entry.value, entry.value < 10 ? 2 : 0)}</span>` +
    `<span class="dl ${cls}">${esc(delta)}</span>` +
    `</div>`
  );
}

function multiplierGrid(changed: ChangedMultiplier[]): string {
  const mode = view("bitnode.mults", "all");
  const shown = mode === "harder" ? changed.filter((c) => c.harder) : mode === "easier" ? changed.filter((c) => !c.harder) : changed;
  if (shown.length === 0) return note("nothing in this view");

  const byGroup = new Map<MultiplierGroup, ChangedMultiplier[]>();
  for (const entry of shown) {
    const list = byGroup.get(entry.group);
    if (list) list.push(entry);
    else byGroup.set(entry.group, [entry]);
  }
  return MULTIPLIER_GROUPS.filter((group) => byGroup.has(group))
    .map(
      (group) =>
        `<div class="multgroup"><h3>${esc(GROUP_LABELS[group])}</h3>` +
        `<div class="mults">${byGroup.get(group)!.map(multiplierEntry).join("")}</div></div>`,
    )
    .join("");
}

export const bitnodeTab: Tab = {
  id: "progression",
  render(state: ProjectedState) {
    const p = state.topics.progression;
    if (!p) return note("waiting for the gate probe (ns.getResetInfo, ~1 GB, every sweep)");

    const current = BITNODES.find((b) => b.n === p.bitNode);
    const grid =
      `<div class="nodegrid">` +
      BITNODES.map((node) => {
        const level = p.sourceFiles[String(node.n)] ?? 0;
        const isCurrent = node.n === p.bitNode;
        const cls = isCurrent ? "current" : level > 0 ? "done" : "todo";
        const feature = featureForBitNode(node.n);
        return (
          `<div class="node ${cls}" title="${esc(`${node.name} — ${node.tagline}${feature ? `\n${feature.problem}` : ""}`)}">` +
          `<div class="n">BN${node.n}${level > 0 ? `<span class="lvl">${level}</span>` : ""}</div>` +
          `<div class="nm">${esc(node.name)}</div>` +
          `<div class="ft">${esc(feature?.label ?? "—")}</div>` +
          `</div>`
        );
      }).join("") +
      `</div>`;

    const completed = Object.entries(p.sourceFiles).filter(([, level]) => level > 0);
    const summary = tiles([
      { label: "current BitNode", value: current ? `BN${p.bitNode} ${current.name}` : `BN${p.bitNode}` },
      { label: "source files", value: String(completed.length), sub: `${BITNODES.length} nodes exist` },
      { label: "augmentations installed", value: String(p.augCount) },
      { label: "since aug reset", value: p.lastAugReset ? fmtTime(Date.now() - p.lastAugReset) : "–" },
      { label: "since node reset", value: p.lastNodeReset ? fmtTime(Date.now() - p.lastNodeReset) : "–" },
    ]);

    const changed = changedMultipliers(p.multipliers);
    const harder = changed.filter((m) => m.harder).length;
    const multipliers = p.multipliers
      ? changed.length > 0
        ? multiplierGrid(changed)
        : note("this BitNode uses every default multiplier")
      : note("requires SF5 or BN5 — ns.getBitNodeMultipliers is unavailable otherwise");
    const multiplierFilters =
      p.multipliers && changed.length > 0
        ? filters(
            "bitnode.mults",
            [
              { value: "all", label: "all", badge: String(changed.length) },
              { value: "harder", label: "harder", badge: String(harder) },
              { value: "easier", label: "easier", badge: String(changed.length - harder) },
            ],
            "all",
          )
        : "";

    const options = p.bitNodeOptions;
    const flags = options
      ? definitions(
          (
            [
              ["restrict home upgrades", options.restrictHomePCUpgrade],
              ["gang disabled", options.disableGang],
              ["corporation disabled", options.disableCorporation],
              ["bladeburner disabled", options.disableBladeburner],
              ["hacknet server disabled", options.disableHacknetServer],
              ["sleeve exp/augs disabled", options.disableSleeveExpAndAugmentation],
            ] as [string, boolean | undefined][]
          )
            .filter(([, on]) => on)
            .map(([label]) => [label, "on"] as [string, string])
            .concat(
              options.intelligenceOverride !== undefined
                ? [["intelligence override", String(options.intelligenceOverride)]]
                : [],
            ),
        )
      : "";
    const optionsBody =
      options && (flags.includes("<dt>") || Object.keys(options.sourceFileOverrides).length > 0)
        ? flags +
          (Object.keys(options.sourceFileOverrides).length > 0
            ? table(
                ["SF", "forced level"],
                Object.entries(options.sourceFileOverrides).map(([sf, level]) => [`SF${esc(sf)}`, String(level)]),
              )
            : "")
        : note("default BitNode options");

    return (
      `<div class="col wide">` +
      card("Progression", summary + grid) +
      card("BitNode multipliers", multipliers, multiplierFilters) +
      `</div>` +
      `<div class="col">` +
      card(
        "Source files",
        completed.length
          ? table(
              ["source file", "level", "theme"],
              completed
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([sf, level]) => [
                  `SF${esc(sf)}`,
                  String(level),
                  esc(featureForBitNode(Number(sf))?.label ?? "—"),
                ]),
            )
          : note("no source files yet"),
      ) +
      card("BitNode options", optionsBody) +
      `</div>`
    );
  },
};
