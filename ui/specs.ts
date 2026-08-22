import type { FeatureId } from "../shared/features/ids.ts";

/** One file per feature, under this directory. The spec drawer serves a whole
 * file rather than a section of a catalogue: `spec/strategy/features/<id>.md`
 * is the canonical description of one feature, so there is nothing to extract.
 * See spec/strategy/features/README.md for the split. */
export const FEATURE_SPEC_DIR = "spec/strategy/features";

/** Repository-relative path of one feature's specification. The caller supplies
 * a FeatureId, never a filesystem path. */
export function featureSpecFile(featureId: FeatureId): string {
  return `${FEATURE_SPEC_DIR}/${featureId}.md`;
}
