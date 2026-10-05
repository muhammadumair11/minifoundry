// GET /api/applications — list apps with widget counts (any role may view).
// POST /api/applications — create an app (editor+). body: { name?, description?,
//   template?: 'blank' | 'supply-chain' }. The supply-chain template wires a
//   map (warehouses + suppliers), shipment stat/table and the demo action into
//   a ready-to-run operational app — referencing Ontology apiNames, so it
//   resolves live against whatever the workspace has seeded.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, parseJsonSafe, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor, requireRole } from '@/lib/governance'
import { appConfigSchema, DEFAULT_APP_PAGES, referencedObjectTypes, serializeApplication } from './shared'
import type { AppConfig, ApplicationTemplate } from '@/lib/foundry-types'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const postSchema = z.object({
  name: z.string().min(1, 'name is required').max(200).optional(),
  description: z.string().max(2000).nullish(),
  template: z.enum(['blank', 'supply-chain']).default('blank'),
})

/** Ready-made "Supply chain operations" app definition (Workshop-style). */
const SUPPLY_CHAIN_CONFIG: AppConfig = {
  pages: [
    { id: 'overview', title: 'Overview', sections: [{ id: 'network', title: 'Network at a glance' }] },
    { id: 'shipments', title: 'Shipments', sections: [{ id: 'workflow', title: 'Shipment workflow' }] },
  ],
  widgets: [
    {
      id: 'map-network',
      type: 'map',
      title: 'Global network',
      span: 2,
      pageId: 'overview',
      sectionId: 'network',
      mapMode: 'markers',
      layers: [
        {
          id: 'layer-warehouse',
          objectTypeApiName: 'warehouse',
          visible: true,
          fallbackProperty: 'city',
          sizeBy: 'capacity',
        },
        {
          id: 'layer-supplier',
          objectTypeApiName: 'supplier',
          visible: true,
          fallbackProperty: 'country',
          colorBy: 'region',
          sizeBy: 'rating',
        },
      ],
    },
    {
      id: 'stat-shipments',
      type: 'stat',
      title: 'Shipments in scope',
      span: 1,
      pageId: 'overview',
      sectionId: 'network',
      objectTypeApiName: 'shipment',
      agg: 'count',
    },
    {
      id: 'table-shipments',
      type: 'objectTable',
      title: 'Shipments',
      span: 2,
      pageId: 'shipments',
      sectionId: 'workflow',
      objectTypeApiName: 'shipment',
      columns: ['status', 'productName', 'supplierId', 'warehouseId', 'quantity', 'shipDate', 'etaDays'],
    },
    {
      id: 'chart-shipment-status',
      type: 'chart',
      title: 'Shipments by status',
      span: 2,
      pageId: 'shipments',
      sectionId: 'workflow',
      objectTypeApiName: 'shipment',
      chartType: 'bar',
      groupBy: 'status',
      agg: 'count',
      topN: 10,
    },
    {
      id: 'action-update-status',
      type: 'actionButton',
      title: 'Update shipment status',
      span: 1,
      pageId: 'shipments',
      sectionId: 'workflow',
      actionApiName: 'update-shipment-status',
      useSelection: true,
    },
  ],
  filters: [
    {
      id: 'filter-shipment-status',
      objectTypeApiName: 'shipment',
      property: 'status',
      op: 'eq',
      kind: 'select',
      options: ['in_transit', 'delivered', 'delayed', 'customs'],
      label: 'Shipment status',
    },
    {
      id: 'filter-supplier-region',
      objectTypeApiName: 'supplier',
      property: 'region',
      op: 'eq',
      kind: 'select',
      options: ['EMEA', 'APAC', 'NA', 'LATAM'],
      label: 'Supplier region',
    },
  ],
}

const TEMPLATE_DEFAULTS: Record<ApplicationTemplate, { name: string; description: string; config: AppConfig }> = {
  blank: { name: 'Untitled application', description: '', config: { pages: DEFAULT_APP_PAGES, widgets: [], filters: [] } },
  'supply-chain': {
    name: 'Supply chain operations',
    description:
      'Operational map of warehouses and suppliers with live shipment flow — filter, inspect and update shipment status without leaving the app.',
    config: SUPPLY_CHAIN_CONFIG,
  },
}

export async function GET() {
  try {
    const applications = await db.application.findMany({
      orderBy: { updatedAt: 'desc' },
    })
    return jsonOk({
      applications: applications.map((a) => {
        const config = parseJsonSafe<AppConfig>(a.configJson, { pages: DEFAULT_APP_PAGES, widgets: [], filters: [] })
        const parsed = appConfigSchema.safeParse(config)
        const safe = parsed.success ? parsed.data : { pages: DEFAULT_APP_PAGES, widgets: [], filters: [] }
        return {
          id: a.id,
          name: a.name,
          description: a.description,
          widgetCount: safe.widgets.length,
          objectTypeApiNames: referencedObjectTypes(safe),
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        }
      }),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load applications')
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const template = TEMPLATE_DEFAULTS[parsed.data.template]
    const application = await db.application.create({
      data: {
        name: parsed.data.name?.trim() || template.name,
        description: parsed.data.description ?? (template.description || null),
        configJson: JSON.stringify(template.config),
        createdBy: getActor(req).email,
      },
    })

    audit({
      req,
      action: 'application.create',
      resourceType: 'application',
      resourceId: application.id,
      resourceName: application.name,
      detail: `template=${parsed.data.template}`,
    })

    return jsonOk({ application: serializeApplication(application) }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create application')
  }
}
