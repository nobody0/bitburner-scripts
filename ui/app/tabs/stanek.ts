import { rotate } from "../../../shared/strategy/stanek/pack.ts";
import { NONE, card, dot, hint, note, outcome, table, tiles, waiting, waitingPanel } from "../lib/dom.ts";
import { esc, fmtNum } from "../lib/format.ts";
import { html } from "../lib/html.ts";
import type { ProjectedState } from "../project.ts";
import type { StanekPlan, StanekState } from "../../../shared/telemetry/topics/stanek.ts";
import type { Tab } from "./index.ts";

/** Stanek's Gift: the grid is the whole problem, so it is drawn literally.
 * Each placed fragment gets a colour bucket so the packing is legible.
 *
 * Two grids, because the feature has two halves and they live in different
 * worlds. "in the gift" is observed occupancy; "best packing" is the packer's
 * candidate layout of the whole fragment CATALOGUE on an EMPTY grid, which
 * nothing in `game/` can execute (there is no place/clear path at all). Drawn
 * side by side and labelled, the second is a target to compare the first
 * against; labelled "placements" next to an observed count, as it was, it read
 * as a queue the driver was working through. */

/** One grid from an "x,y" -> fragment id map. Both grids use the same
 * `id % 6` bucket, so a fragment keeps its colour across the two and the
 * comparison can be made by eye. */
function gridOf(s: StanekState, occupied: Record<string, number>): string {
  const cells: string[] = [];
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const id = occupied[`${x},${y}`];
      cells.push(
        id === undefined
          ? `<span class="cell empty"></span>`
          : `<span class="cell f${id % 6}" title="${esc(`fragment ${id}`)}"></span>`,
      );
    }
  }
  return `<div class="gift" style="grid-template-columns:repeat(${s.width},1fr)">${cells.join("")}</div>`;
}

/** The candidate packing as occupied cells, or undefined when it cannot be
 * drawn honestly. `availableTypes` and `shape` are both optional (older
 * records) and the driver skips a shapeless definition rather than guessing a
 * footprint, so ONE unresolvable placement means no grid: drawing the
 * resolvable rest would present a partial layout as the packing. */
function packedCells(s: StanekState, plan: StanekPlan): Record<string, number> | undefined {
  if (plan.placements.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const placement of plan.placements) {
    const shape = s.availableTypes?.find((entry) => entry.id === placement.id)?.shape;
    if (!shape) return undefined;
    // The packer stores the rotation, not the rotated cells; same convention as
    // the probe applies to an active fragment.
    for (const cell of rotate(shape, placement.rotation)) {
      out[`${placement.x + cell.x},${placement.y + cell.y}`] = placement.id;
    }
  }
  return out;
}

function pane(label: string, body: string): string {
  return `<div><div class="giftlab">${esc(label)}</div>${body}</div>`;
}

export const stanekTab: Tab = {
  id: "stanek",
  render(state: ProjectedState) {
    const s = state.topics.stanek;
    if (!s) return waitingPanel("Stanek", "the Stanek probe");
    const plan = s.plan;

    const summary = tiles([
      { label: "grid", value: `${s.width} x ${s.height}` },
      { label: "fragments placed", value: String(s.fragments.length) },
      { label: "cells used", value: `${Object.keys(s.occupied).length} / ${s.width * s.height}` },
    ]);

    const packed = plan ? packedCells(s, plan) : undefined;
    const grids = s.width
      ? `<div class="gifts">` +
        pane("in the gift", gridOf(s, s.occupied)) +
        (plan ? pane("best packing", packed ? gridOf(s, packed) : note("no fragment shapes on this record")) : "") +
        `</div>`
      : note("no gift grid");

    const fragments = table(
      [
        "id",
        "type",
        "at",
        "rot",
        "power",
        // Charge is two numbers priced very differently, and the panel used to
        // print only the cheaper one. The count enters the effect at the power
        // 0.07 — nearly flat, so grinding it is close to worthless — while the
        // peak charge is the logarithmic term that dominates it, and
        // `charged effect` is the only figure on this tab that says what the
        // charging has actually bought (`power` and `effect` are static per
        // fragment).
        "charge count",
        "peak charge",
        hint("charged effect", "raw modifier: 1 on every booster, and inverted-sense on the cost fragments — 1.25 means costs x 0.8"),
        "effect",
      ],
      s.fragments.map((f) => [
        `<span class="swatch f${f.id % 6}"></span>${f.id}`,
        // A booster is in the gift and can never be in the charge queue: the
        // API rejects chargeFragment on it, so the driver filters it out of
        // `chargeOrder`. This dot is what reconciles the "fragments placed"
        // tile (observed, boosters included) with "charge queue" — NOT with
        // "candidate packing", which is short for the unrelated reason that it
        // is a hypothetical layout. `=== false` because the field is optional:
        // an older record omits it, and "cannot be charged" would then be a
        // claim made from an absent field.
        f.chargeable === false ? html`${dot("off", "boosters cannot be charged through the API")}${f.type}` : esc(f.type),
        `${f.x},${f.y}`,
        String(f.rotation),
        fmtNum(f.power, 2),
        fmtNum(f.numCharge, 0),
        // Kept behind fmtNum: an older record carries neither number, and
        // arithmetic on `undefined` would print a missing reading as 0.
        fmtNum(f.highestCharge, 0),
        fmtNum(f.chargedEffect, 3),
        esc(f.effect),
      ]),
      "nothing placed",
    );

    const available = s.availableTypes?.length
      ? table(
          ["id", "type", "power", "limit"],
          s.availableTypes.map((f) => [String(f.id), esc(f.type), fmtNum(f.power, 2), String(f.limit)]),
        )
      : "";

    const decision = plan
      ? tiles([
          {
            // "exact" on its own asserted provable optimality of a layout that
            // is never applied, which is the most misleading number here.
            label: hint("packing", "the search's verdict on the candidate packing below — not on what is in the gift"),
            value: plan.approximated ? "capped" : "exact",
          },
          {
            label: hint("objective value", "total weight of the candidate packing; comparable between packings, not an effect the run has realised"),
            value: fmtNum(plan.value, 3),
          },
          {
            label: hint("candidate packing", "best layout of the FULL fragment catalogue on an EMPTY grid — a target to compare the gift against, not a queue: nothing in game/ places or clears a fragment"),
            value: String(plan.placements.length),
          },
          {
            label: hint("charge queue", "the observed fragments the API accepts a charge for; boosters are excluded, so this is shorter than fragments placed"),
            value: String(plan.chargeOrder.length),
          },
        ]) +
        table(
          [
            hint("order", "the driver orders by power alone — how charged a fragment already is does not move it"),
            "fragment",
            "packs at",
            "rotation",
            "observed charges",
            "peak charge",
          ],
          plan.chargeOrder.map((id, index) => {
            const placement = plan.placements.find((entry) => entry.id === id);
            const observed = s.fragments.find((entry) => entry.id === id);
            return [
              String(index + 1),
              String(id),
              // "packs at" and NONE, not "planned at" and "observed only":
              // every row here is observed by construction (`chargeOrder` is
              // built from the observed fragments), so "observed only" implied
              // the other rows were planned into place. The coordinate is the
              // candidate packing's, computed against an empty grid — where the
              // packer would put the fragment, not an intention to move it.
              placement ? `${placement.x},${placement.y}` : NONE,
              placement ? String(placement.rotation) : NONE,
              observed ? fmtNum(observed.numCharge, 0) : NONE,
              observed ? fmtNum(observed.highestCharge, 0) : NONE,
            ];
          }),
          { empty: "no chargeable fragments selected", left: [2] },
        ) +
        (plan.lastResult ? outcome(plan.lastResult) : "")
      : waiting("the first packing decision");

    return (
      `<div class="col wide">` +
      card("Placed fragments", fragments) +
      (available ? card("Fragment catalogue", available) : "") +
      `</div>` +
      `<div class="col">` +
      card("Gift", summary + grids) +
      card("Decision", decision) +
      `</div>`
    );
  },
};
