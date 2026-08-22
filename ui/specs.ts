import type { FeatureId } from "../shared/features/ids.ts";

export const FEATURE_SPEC_FILE = "spec/strategy/feature-catalog.md";

/** Extract one canonical feature section from the checked-in strategy
 * catalogue. The caller supplies a FeatureId, never a filesystem path. */
export function extractFeatureSpec(markdown: string, featureId: FeatureId): string | undefined {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const heading = `## \`${featureId}\``;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^## `[^`]+`(?:\s|$)/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start, end);
  while (section.at(-1)?.trim() === "") section.pop();
  if (section.at(-1)?.trim() === "---") section.pop();
  while (section.at(-1)?.trim() === "") section.pop();
  return section.join("\n") + "\n";
}
