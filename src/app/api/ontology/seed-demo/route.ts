// POST /api/ontology/seed-demo — idempotent demo ontology seeder.
// Creates the Shipment / Supplier / Warehouse object types (backed by the
// seeded Shipments / Suppliers / Warehouses datasets), two one-to-many link
// types and three write-back actions. Static segment NEXT TO [id] — App
// Router resolves static routes first (same pattern as schedules/due).

import { db } from '@/lib/db'
import { badRequest, jsonOk, parseSchema, serverError } from '@/lib/api-utils'
import { deriveProperties } from '@/lib/ontology-service'
import type { ActionParamDef } from '@/lib/ontology-service'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

interface DemoType {
  apiName: string
  displayName: string
  datasetName: string
  primaryKey: string
  titleProperty: string
  icon: string
  color: string
  description: string
}

const DEMO_TYPES: DemoType[] = [
  {
    apiName: 'shipment',
    displayName: 'Shipment',
    datasetName: 'Shipments',
    primaryKey: 'id',
    titleProperty: 'productName',
    icon: 'truck',
    color: 'emerald',
    description: 'Outbound shipment instances flowing from suppliers through warehouses.',
  },
  {
    apiName: 'supplier',
    displayName: 'Supplier',
    datasetName: 'Suppliers',
    primaryKey: 'id',
    titleProperty: 'name',
    icon: 'factory',
    color: 'teal',
    description: 'Supplier master records with ratings, lead times and on-time delivery.',
  },
  {
    apiName: 'warehouse',
    displayName: 'Warehouse',
    datasetName: 'Warehouses',
    primaryKey: 'id',
    titleProperty: 'name',
    icon: 'warehouse',
    color: 'amber',
    description: 'Fulfilment warehouses and their storage capacity.',
  },
]

interface DemoLink {
  apiName: string
  displayName: string
  fromApiName: string
  toApiName: string
  cardinality: 'one-to-many' | 'many-to-many'
  fkProperty: string
}

const DEMO_LINKS: DemoLink[] = [
  {
    apiName: 'shipments',
    displayName: 'Shipments',
    fromApiName: 'supplier',
    toApiName: 'shipment',
    cardinality: 'one-to-many',
    fkProperty: 'supplierId',
  },
  {
    apiName: 'shipments',
    displayName: 'Shipments',
    fromApiName: 'warehouse',
    toApiName: 'shipment',
    cardinality: 'one-to-many',
    fkProperty: 'warehouseId',
  },
]

interface DemoAction {
  apiName: string
  displayName: string
  description: string
  objectApiName: string
  operation: 'create' | 'update' | 'delete'
  parameters: ActionParamDef[]
}

const DEMO_ACTIONS: DemoAction[] = [
  {
    apiName: 'update-shipment-status',
    displayName: 'Update Shipment Status',
    description: 'Set a shipment’s live status (in_transit, delivered, delayed, customs).',
    objectApiName: 'shipment',
    operation: 'update',
    parameters: [
      { apiName: 'shipmentId', displayName: 'Shipment Id', dataType: 'string', required: true, mapsTo: 'id', isPk: true },
      {
        apiName: 'newStatus',
        displayName: 'New Status',
        dataType: 'string',
        required: true,
        mapsTo: 'status',
        oneOf: ['in_transit', 'delivered', 'delayed', 'customs'],
      },
    ],
  },
  {
    apiName: 'register-supplier',
    displayName: 'Register Supplier',
    description: 'Append a new supplier row to the Suppliers dataset (id is generated).',
    objectApiName: 'supplier',
    operation: 'create',
    parameters: [
      { apiName: 'name', displayName: 'Name', dataType: 'string', required: true, mapsTo: 'name' },
      { apiName: 'country', displayName: 'Country', dataType: 'string', required: true, mapsTo: 'country' },
      { apiName: 'region', displayName: 'Region', dataType: 'string', required: true, mapsTo: 'region' },
      { apiName: 'rating', displayName: 'Rating', dataType: 'number', required: false, mapsTo: 'rating' },
      { apiName: 'leadTimeDays', displayName: 'Lead Time Days', dataType: 'number', required: false, mapsTo: 'leadTimeDays' },
      { apiName: 'onTimePct', displayName: 'On Time Pct', dataType: 'number', required: false, mapsTo: 'onTimePct' },
    ],
  },
  {
    apiName: 'remove-shipment',
    displayName: 'Remove Shipment',
    description: 'Delete a shipment row from the Shipments dataset.',
    objectApiName: 'shipment',
    operation: 'delete',
    parameters: [
      { apiName: 'shipmentId', displayName: 'Shipment Id', dataType: 'string', required: true, mapsTo: 'id', isPk: true },
    ],
  },
]

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    // ── resolve backing datasets (demo data must exist) ─────────────
    const datasetsByName = new Map<string, { id: string; name: string }>()
    for (const t of DEMO_TYPES) {
      if (datasetsByName.has(t.datasetName)) continue
      const dataset = await db.dataset.findFirst({
        where: { name: t.datasetName },
        select: { id: true, name: true },
      })
      if (!dataset) {
        return badRequest(
          `Backing dataset '${t.datasetName}' not found — seed demo data first (POST /api/seed)`,
        )
      }
      datasetsByName.set(t.datasetName, dataset)
    }

    const created: string[] = []

    // ── object types (+ derived properties) ─────────────────────────
    for (const def of DEMO_TYPES) {
      const existing = await db.objectType.findUnique({
        where: { apiName: def.apiName },
        select: { id: true },
      })
      if (existing) continue

      const dataset = datasetsByName.get(def.datasetName)!
      const version = await db.datasetVersion.findFirst({
        where: { datasetId: dataset.id },
        orderBy: { versionNumber: 'desc' },
      })
      if (!version) {
        return badRequest(`Dataset '${dataset.name}' has no versions to derive properties from`)
      }
      const schema = parseSchema(version)
      if (!schema.some((c) => c.name === def.primaryKey)) {
        return badRequest(
          `Primary key '${def.primaryKey}' not found in dataset '${dataset.name}' schema`,
        )
      }
      if (!schema.some((c) => c.name === def.titleProperty)) {
        return badRequest(
          `titleProperty '${def.titleProperty}' not found in dataset '${dataset.name}' schema`,
        )
      }

      await db.objectType.create({
        data: {
          apiName: def.apiName,
          displayName: def.displayName,
          description: def.description,
          sourceDatasetId: dataset.id,
          primaryKey: def.primaryKey,
          icon: def.icon,
          color: def.color,
          properties: { create: deriveProperties(schema, def.primaryKey, def.titleProperty) },
        },
      })
      created.push(def.apiName)
    }

    // resolve type ids (all ensured above)
    const typeIds = new Map<string, string>()
    for (const def of DEMO_TYPES) {
      const t = await db.objectType.findUnique({
        where: { apiName: def.apiName },
        select: { id: true },
      })
      if (t) typeIds.set(def.apiName, t.id)
    }

    // ── link types ──────────────────────────────────────────────────
    for (const link of DEMO_LINKS) {
      const fromTypeId = typeIds.get(link.fromApiName)
      const toTypeId = typeIds.get(link.toApiName)
      if (!fromTypeId || !toTypeId) continue
      const existing = await db.linkType.findUnique({
        where: { fromTypeId_apiName: { fromTypeId, apiName: link.apiName } },
        select: { id: true },
      })
      if (existing) continue
      await db.linkType.create({
        data: {
          apiName: link.apiName,
          displayName: link.displayName,
          fromTypeId,
          toTypeId,
          cardinality: link.cardinality,
          fkProperty: link.fkProperty,
        },
      })
    }

    // ── action types ────────────────────────────────────────────────
    for (const action of DEMO_ACTIONS) {
      const existing = await db.actionType.findUnique({
        where: { apiName: action.apiName },
        select: { id: true },
      })
      if (existing) continue
      const objectTypeId = typeIds.get(action.objectApiName)
      if (!objectTypeId) continue
      await db.actionType.create({
        data: {
          apiName: action.apiName,
          displayName: action.displayName,
          description: action.description,
          objectTypeId,
          operation: action.operation,
          parametersJson: JSON.stringify(action.parameters),
          enabled: true,
        },
      })
    }

    // Governance audit — only when something was actually created (idempotent
    // no-op re-runs stay silent).
    if (created.length > 0) {
      audit({
        req,
        action: 'ontology.create',
        resourceType: 'ontology',
        resourceName: 'demo ontology',
        detail: `seeded object types: ${created.join(', ')}`,
      })
    }

    return jsonOk({ seeded: created.length > 0, created })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to seed demo ontology')
  }
}
