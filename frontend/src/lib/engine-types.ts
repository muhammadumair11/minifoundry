// Client-safe type definitions that used to live in the server modules
// `@/lib/dataset-service` and `@/lib/engine`. Shapes mirror the Rust
// `mf-types` crate and the API wire contract exactly.

// ── from dataset-service.ts ─────────────────────────────────────────────

export type Row = Record<string, unknown>
export type ColumnType = 'string' | 'number' | 'boolean'

export interface SchemaColumn {
  name: string
  type: ColumnType
}

// ── from engine.ts (run manifests — reproducible builds) ────────────────

export interface ManifestInput {
  datasetId: string
  datasetName: string
  /** Exact version this run read (null only when the dataset had no versions). */
  versionNumber: number | null
  rowCount: number
}

export interface ManifestOutput {
  datasetId: string
  datasetName: string
  versionNumber: number
  rowCount: number
}

export interface ManifestNode {
  nodeId: string
  type: string
  label?: string
  /** sha256 of inline code (derive nodes) — confirms the exact logic identity. */
  codeSha256?: string
}

export interface RunManifest {
  graphVersion: { versionNumber: number | null; nodeCount: number }
  inputs: ManifestInput[]
  outputs: ManifestOutput[]
  nodes: ManifestNode[]
}
