/** The feature axis. A *feature* is one optimization problem that can be
 * attacked in isolation: it owns its own telemetry topic(s), its own UI tab,
 * and (eventually) its own simulator model. Composing all of them under one
 * BitNode's multipliers is the whole-game problem.
 *
 * This module deliberately has no imports so every layer (shared topics,
 * game probes, ui tabs, sim models) can key off the same union without
 * dragging in the registry. */

export const FEATURE_IDS = [
  "progression",
  "hacking",
  "factions",
  "career",
  "hacknet",
  "stock",
  "gang",
  "corp",
  "bladeburner",
  "sleeves",
  "go",
  "stanek",
  "dnet",
  "side",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];
