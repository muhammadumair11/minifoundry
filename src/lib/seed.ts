// MiniFoundry — idempotent database seeder.
// Creates sample connectors, ingests the built-in sample packs into datasets,
// registers the demo pipeline ("Shipment Overview") without running it, and
// ensures the M9 demo users exist (real password auth).

import { db } from '@/lib/db'
import { SAMPLE_PACKS, DEMO_PIPELINE } from '@/lib/sample-data'
import { createDatasetFromRows, type Row } from '@/lib/dataset-service'
import { setQualityGate } from '@/lib/publication'
import { evaluateRules } from '@/lib/quality'
import { hashPassword } from '@/lib/auth-service'
import type { User } from '@prisma/client'

export interface SeedResult {
  seeded: boolean
  datasets: string[]
  /** M9: number of demo users ensured (upserted by email) during this call. */
  usersEnsured?: number
}

// ─── M9: demo users (real password auth) ─────────────────────────────

/** Shared password for all three demo users. */
export const DEMO_USER_PASSWORD = '<redacted>'

/** The seeded demo users, upserted by email (idempotent). */
export const DEMO_USERS = [
  { email: 'demo-admin@example.invalid', name: 'Ada Admin', role: 'admin' },
  { email: 'demo-editor@example.invalid', name: 'Eddie Editor', role: 'editor' },
  { email: 'demo-viewer@example.invalid', name: 'Vera Viewer', role: 'viewer' },
] as const

/**
 * Ensure the M9 demo users exist. Idempotent: upserts by email with an EMPTY
 * update branch — re-seeding NEVER clobbers a role change or deactivation made
 * via the API. Fresh-DB callers should run `bun scripts/seed-users-cli.ts`
 * (or POST /api/seed, which calls seedDatabase -> this). Returns the User rows.
 */
export async function ensureSeedUsers(): Promise<User[]> {
  const passwordHash = hashPassword(DEMO_USER_PASSWORD)
  const users: User[] = []
  for (const u of DEMO_USERS) {
    users.push(
      await db.user.upsert({
        where: { email: u.email },
        update: {},
        create: { email: u.email, name: u.name, role: u.role, passwordHash },
      }),
    )
  }
  return users
}

// ─── P2 discovery: one GATED dataset, out of the box ─────────────────
//
// "Supplier Risk Scores" ships with the publication gate ON, two
// error-severity quality rules, a clean published v1 and a FAILED draft v2
// (one row has risk_score 140). That makes the whole trust workflow
// discoverable without any setup: draft → blocked publish (with reasons) →
// approvals gate preview in the governance console.

const RISK_DATASET_NAME = 'Supplier Risk Scores'

const RISK_CLEAN_ROWS: Row[] = [
  { supplier: 'Northline Foods', region: 'EMEA', risk_score: 22, tier: 'A' },
  { supplier: 'Pacific Metals', region: 'APAC', risk_score: 58, tier: 'B' },
  { supplier: 'Andes Textiles', region: 'LATAM', risk_score: 41, tier: 'B' },
  { supplier: 'Gulf Plastics', region: 'EMEA', risk_score: 77, tier: 'C' },
  { supplier: 'Baltic Grain Co', region: 'EMEA', risk_score: 15, tier: 'A' },
]

/** v2: same shape, but Gulf Plastics reports 140 — outside [0,100]. */
const RISK_DIRTY_ROWS: Row[] = RISK_CLEAN_ROWS.map((r) =>
  r.supplier === 'Gulf Plastics' ? { ...r, risk_score: 140 } : r,
)

/**
 * Seed the governed demo dataset (idempotent by dataset name). v1 is
 * published + passes; the gate is enabled; v2 lands as a FAILED draft.
 */
async function seedGatedDataset(): Promise<string | null> {
  const already = await db.dataset.findFirst({ where: { name: RISK_DATASET_NAME }, select: { id: true } })
  if (already) return null

  const connector = await db.connector.create({
    data: {
      name: 'Sample: Supplier Risk',
      type: 'sample',
      config: JSON.stringify({
        sampleKey: 'supplier-risk',
        description: 'Vendor risk scoring export (governed — quality gate on)',
      }),
    },
  })
  const ingestion = await db.ingestion.create({
    data: { connectorId: connector.id, status: 'running' },
  })

  try {
    // v1 — clean, published (gate is still off for a brand-new dataset).
    const { dataset, version } = await createDatasetFromRows({
      name: RISK_DATASET_NAME,
      description: 'Vendor risk scores with the publication gate ON — v2 is a failing draft, so publishing it is blocked until quality passes.',
      connectorId: connector.id,
      tags: ['sample', 'supply-chain', 'governed'],
      createdBy: ingestion.id,
      rows: RISK_CLEAN_ROWS,
    })

    // Turn the gate ON: backfills publishedVersion to the clean v1 baseline.
    await setQualityGate(dataset.id, true)

    // Error-severity rules — the gate's teeth.
    await db.qualityRule.createMany({
      data: [
        {
          datasetId: dataset.id,
          name: 'Supplier name present',
          kind: 'not_null',
          column: 'supplier',
          severity: 'error',
        },
        {
          datasetId: dataset.id,
          name: 'Risk score within 0–100',
          kind: 'range',
          column: 'risk_score',
          configJson: JSON.stringify({ min: 0, max: 100 }),
          severity: 'error',
        },
      ],
    })

    // v2 — gate ON → lands as a DRAFT; the range rule fails on risk_score 140.
    const v2 = await createDatasetFromRows({
      name: RISK_DATASET_NAME,
      connectorId: connector.id,
      createdBy: ingestion.id,
      rows: RISK_DIRTY_ROWS,
    })

    // Deterministic states: v1 passes, v2 fails (also raises the one
    // 'quality_failed' bell notification that teaches the gate).
    await evaluateRules(dataset.id, version.versionNumber, 'manual')
    await evaluateRules(dataset.id, v2.version.versionNumber, 'auto')

    await db.ingestion.update({
      where: { id: ingestion.id },
      data: {
        datasetId: dataset.id,
        status: 'success',
        rowsIngested: v2.version.rowCount,
        message: `Seeded governed dataset '${RISK_DATASET_NAME}' (v1 published · v${v2.version.versionNumber} draft failed quality — gate blocks publishing)`,
        finishedAt: new Date(),
      },
    })
    return RISK_DATASET_NAME
  } catch (err) {
    await db.ingestion
      .update({
        where: { id: ingestion.id },
        data: {
          status: 'failed',
          message: `Failed to seed gated dataset: ${err instanceof Error ? err.message : String(err)}`,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined)
    throw err
  }
}

export async function seedDatabase(): Promise<SeedResult> {
  // M9: demo users are ensured on EVERY seed call — including already-seeded
  // databases (fresh DBs get them via this path too).
  const usersEnsured = (await ensureSeedUsers()).length

  const existing = await db.dataset.findFirst({ select: { id: true } })
  if (existing) {
    // Backfill: the governed demo dataset is idempotent by name, so
    // already-seeded workspaces gain it on their next seed call too.
    const gatedName = await seedGatedDataset()
    return { seeded: false, datasets: gatedName ? [gatedName] : [], usersEnsured }
  }

  const datasetNames: string[] = []
  const datasetIdsByName = new Map<string, string>()

  for (const [sampleKey, pack] of Object.entries(SAMPLE_PACKS)) {
    const connector = await db.connector.create({
      data: {
        name: `Sample: ${pack.name}`,
        type: 'sample',
        config: JSON.stringify({ sampleKey, description: pack.description }),
      },
    })

    const ingestion = await db.ingestion.create({
      data: { connectorId: connector.id, status: 'running' },
    })

    try {
      const { dataset, version } = await createDatasetFromRows({
        name: pack.name,
        description: pack.description,
        connectorId: connector.id,
        tags: ['sample', 'supply-chain'],
        createdBy: ingestion.id,
        rows: pack.rows as Row[],
      })
      await db.ingestion.update({
        where: { id: ingestion.id },
        data: {
          datasetId: dataset.id,
          status: 'success',
          rowsIngested: version.rowCount,
          message: `Seeded ${version.rowCount} rows into dataset '${pack.name}' (v${version.versionNumber}) from sample pack '${sampleKey}'`,
          finishedAt: new Date(),
        },
      })
      datasetNames.push(pack.name)
      datasetIdsByName.set(pack.name, dataset.id)
    } catch (err) {
      await db.ingestion.update({
        where: { id: ingestion.id },
        data: {
          status: 'failed',
          message: `Failed to ingest sample pack '${sampleKey}': ${err instanceof Error ? err.message : String(err)}`,
          finishedAt: new Date(),
        },
      })
      throw err
    }
  }

  // Demo pipeline — resolve the __SHIPMENTS__ placeholder into the real dataset id.
  const shipmentsDatasetId = datasetIdsByName.get('Shipments')
  if (!shipmentsDatasetId) {
    throw new Error('Seed error: Shipments dataset was not created')
  }
  const graph = {
    nodes: DEMO_PIPELINE.graph.nodes.map((n) =>
      n.type === 'source' && n.data.datasetId === '__SHIPMENTS__'
        ? { ...n, data: { ...n.data, datasetId: shipmentsDatasetId } }
        : n,
    ),
    edges: DEMO_PIPELINE.graph.edges,
  }

  await db.pipeline.create({
    data: {
      name: DEMO_PIPELINE.name,
      description: DEMO_PIPELINE.description,
      graphJson: JSON.stringify(graph),
    },
  })

  // P2 discovery: the governed dataset (gate ON, failing draft v2).
  const gatedName = await seedGatedDataset()
  if (gatedName) datasetNames.push(gatedName)

  return { seeded: true, datasets: datasetNames, usersEnsured }
}
