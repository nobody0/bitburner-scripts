import { NONE, table } from "./dom.ts";
import { esc, fmtMoney, fmtTime } from "./format.ts";
import type { ProjectedState } from "../project.ts";

/** The "Decision history" table, shared by every subsystem that competes at
 * the investment arbiter. One implementation so the columns, the arbiter
 * denied/funded wording and the row shape cannot drift between tabs. */

interface DecisionData {
  plan?: {
    buy?: { kind?: string };
    candidate?: { kind?: string };
    spend?: { name?: string };
    reserve?: { name?: string };
  };
  result?: { detail?: string };
  detail?: string;
  subsystem?: string;
  arbitration?: {
    grants?: { by: string; id: string; amount: number }[];
    denied?: { by: string; id?: string; reason: string }[];
  };
}

export interface DecisionHistoryOptions {
  /** Event names always included (e.g. "hash.decision"). investment.decision
   * and investment.result are included when their subsystem matches. */
  events?: string[];
  subsystem?: string;
  /** Which feature's denials are OURS in the arbitration payload. */
  by: string;
  /** Narrow OUR claims further by grant/denial id (e.g. "infrastructure:"). */
  idPrefix?: string;
  limit?: number;
}

/** Renders the shared history table, or "" when there is nothing to show. */
export function decisionHistory(state: ProjectedState, options: DecisionHistoryOptions): string {
  const always = new Set(options.events ?? []);
  const rows = state.events
    .filter((event) => {
      if (event.kind !== "event") return false;
      if (always.has(event.name)) return true;
      if (event.name !== "investment.decision" && event.name !== "investment.result") return false;
      return (event.data as DecisionData | undefined)?.subsystem === options.subsystem;
    })
    .slice(-(options.limit ?? 10))
    .reverse()
    .map((event) => {
      const data = event.data as DecisionData | undefined;
      const ours = (id: string | undefined) => !options.idPrefix || (id ?? "").startsWith(options.idPrefix);
      const denied = data?.arbitration?.denied?.find((entry) => entry.by === options.by && ours(entry.id));
      const winners = data?.arbitration?.grants?.filter((entry) => entry.by !== options.by || !ours(entry.id)) ?? [];
      const arbiter = denied
        ? `${denied.reason}${winners.length ? `; funded ${winners.map((entry) => `${entry.by}:${entry.id} ${fmtMoney(entry.amount)}`).join(", ")}` : ""}`
        : data?.arbitration
          ? "funded"
          : NONE;
      const selection =
        data?.result?.detail || data?.detail
          ? (data.result?.detail ?? data.detail ?? "")
          : (data?.plan?.spend?.name ??
            data?.plan?.reserve?.name ??
            data?.plan?.buy?.kind ??
            data?.plan?.candidate?.kind ??
            "hold");
      return [
        fmtTime(event.t - (state.t0 ?? event.t)),
        esc(event.kind === "event" ? event.name : ""),
        esc(selection),
        esc(arbiter),
      ];
    });
  if (rows.length === 0) return "";
  return table(["at", "transition", "selection / outcome", "arbiter"], rows, { left: [1, 2, 3] });
}
