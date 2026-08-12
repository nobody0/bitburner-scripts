import type { ArtifactIdentity } from "./run-identity.ts";
import type { HelloBody } from "./telemetry/schema.ts";

export interface ArtifactMetadata {
  version: 1;
  /** Path relative to runs/. */
  file: string;
  identity?: ArtifactIdentity;
  hello: HelloBody;
  emitters: string[];
  records: number;
  firstT: number | null;
  lastT: number | null;
  createdAt: number;
  updatedAt: number;
  live: boolean;
  pinned: boolean;
  size: number;
  /** Legacy files cannot be safely attached to a save lineage. */
  legacy?: boolean;
}

export interface RunCatalogEntry extends ArtifactMetadata {
  durationMs: number;
}
