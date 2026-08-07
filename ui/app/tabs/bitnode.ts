import { BITNODES, changedMultipliers } from "../../../shared/features/bitnode.ts";
import { featureForBitNode } from "../../../shared/features/registry.ts";
import { card, definitions, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtNum, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** BitNode tab: where we are, what we have finished, and exactly what this
 * node changes. Source-file level doubles as the completion count — SF n at
 * level 3 means BitNode n was destroyed three times. */

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
    const multipliers = p.multipliers
      ? changed.length > 0
        ? table(
            ["multiplier", "value", "BN1 default"],
            changed.map((m) => [esc(m.field), fmtNum(m.value, 3), fmtNum(m.base, 3)]),
          )
        : note("this BitNode uses every default multiplier")
      : note("requires SF5 or BN5 — ns.getBitNodeMultipliers is unavailable otherwise");

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
      card("BitNode multipliers", multipliers) +
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
