import type { FeatureId } from "../../../shared/features/ids.ts";
import type { ProjectedState } from "../project.ts";
import { bitnodeTab } from "./bitnode.ts";
import { bladeburnerTab } from "./bladeburner.ts";
import { careerTab } from "./career.ts";
import { corpTab } from "./corp.ts";
import { dnetTab } from "./dnet.ts";
import { factionsTab } from "./factions.ts";
import { gangTab } from "./gang.ts";
import { goTab } from "./go.ts";
import { hackingTab } from "./hacking.ts";
import { hacknetTab } from "./hacknet.ts";
import { overviewTab } from "./overview.ts";
import { sideTab } from "./side.ts";
import { sleevesTab } from "./sleeves.ts";
import { stanekTab } from "./stanek.ts";
import { stockTab } from "./stock.ts";

export type TabId = FeatureId | "overview";

export interface Tab {
  id: TabId;
  /** Returns the panel's markup. Called on every frame; keep it cheap. */
  render(state: ProjectedState): string;
  /** Imperative follow-up after the markup is in the DOM (canvas drawing,
   *  event listeners on freshly created nodes). */
  mount?(state: ProjectedState, el: HTMLElement): void;
}

/** Keyed by tab id. Order in the tab bar comes from FEATURES
 * (shared/features/registry.ts), with Overview pinned first — the registry is
 * the single source of truth for which features exist. */
export const TABS: Record<TabId, Tab> = {
  overview: overviewTab,
  progression: bitnodeTab,
  hacking: hackingTab,
  factions: factionsTab,
  career: careerTab,
  hacknet: hacknetTab,
  stock: stockTab,
  gang: gangTab,
  corp: corpTab,
  bladeburner: bladeburnerTab,
  sleeves: sleevesTab,
  go: goTab,
  stanek: stanekTab,
  dnet: dnetTab,
  side: sideTab,
};
