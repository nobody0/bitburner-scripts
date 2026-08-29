/** Print the speedrun route's per-leg overview table, or splice it into
 * spec/strategy/route-legs.md with --write. The table is derived — route
 * order from BITNODE_SPEEDRUN_PLAN, entrances from deriveRouteLegs, bench
 * coverage from sim PROFILES, measured exits from the chain ledger — so the
 * doc can never drift from the code; tests/route-legs.test.ts fails when the
 * spliced copy is stale. */

import { readFileSync, writeFileSync } from "node:fs";
import { deriveRouteLegs, routeLegProfileId } from "../shared/strategy/progression/route-legs.ts";
import { PROFILES } from "../sim/profiles.ts";
import ROUTE_LEG_LEDGER from "../sim/tests/baselines/route-legs.json" with { type: "json" };

const SPEC_FILE = new URL("../spec/strategy/route-legs.md", import.meta.url).pathname;
const BEGIN = "<!-- route-legs:begin -->";
const END = "<!-- route-legs:end -->";

export function renderRouteLegsTable(): string {
  const ledgerLegs = ROUTE_LEG_LEDGER.legs as Record<string, { exit?: { intelligenceAtGoal?: number } }>;
  const measured = Object.fromEntries(
    Object.entries(ledgerLegs).flatMap(([leg, entry]) =>
      entry.exit?.intelligenceAtGoal !== undefined ? [[leg, entry.exit.intelligenceAtGoal] as const] : []
    ),
  );
  const profileIds = new Set(PROFILES.map((profile) => profile.id));
  const lines = [
    "| # | leg | milestone | entrance Source-Files | int (source) | enabled | bench profile | measured exit int |",
    "|---:|---|---|---|---|---|---|---|",
  ];
  for (const leg of deriveRouteLegs(undefined, measured)) {
    const sfs = Object.entries(leg.entranceSourceFiles)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([sf, level]) => `${sf}.${level}`)
      .join(", ") || "—";
    const profileId = routeLegProfileId(leg);
    const exit = measured[leg.leg];
    lines.push(
      `| ${leg.index} | \`${leg.leg}\` | ${leg.milestone} | ${sfs} ` +
      `| ${leg.entranceIntelligence} (${leg.intelligenceSource}) | ${leg.enabled ? "yes" : "no"} ` +
      `| ${profileIds.has(profileId) ? `\`${profileId}\`` : "—"} | ${exit !== undefined ? exit : "—"} |`,
    );
  }
  return lines.join("\n");
}

export function spliceRouteLegsTable(document: string): string {
  const begin = document.indexOf(BEGIN);
  const end = document.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${SPEC_FILE} is missing the ${BEGIN} / ${END} markers`);
  }
  return `${document.slice(0, begin + BEGIN.length)}\n${renderRouteLegsTable()}\n${document.slice(end)}`;
}

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    const document = readFileSync(SPEC_FILE, "utf8");
    writeFileSync(SPEC_FILE, spliceRouteLegsTable(document));
    console.log(`updated ${SPEC_FILE}`);
  } else {
    console.log(renderRouteLegsTable());
  }
}
