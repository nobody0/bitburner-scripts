// Vendored from bitburner-src v3.0.1:src/Go/boardAnalysis/goAI.ts (getKomi only, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import type { BoardState } from "../Types";
import { opponentDetails } from "../Constants";

export function getKomi(state: BoardState): number {
  if (state.komiOverride !== null) {
    return state.komiOverride;
  }
  return opponentDetails[state.ai].komi;
}
