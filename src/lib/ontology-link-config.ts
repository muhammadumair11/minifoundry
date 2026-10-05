import { z } from 'zod'
import { db } from '@/lib/db'
import { parseSchema } from '@/lib/api-utils'
import { getDatasetVersion, resolveConsumerVersion } from '@/lib/dataset-service'

const slug = /^[a-z][a-z0-9_-]{1,63}$/

export const linkConfigSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  apiName: z.string().regex(slug, 'Use a lowercase slug starting with a letter'),
  fromTypeId: z.string().min(1),
  toTypeId: z.string().min(1),
  cardinality: z.enum(['one-to-many', 'many-to-many']),
  fkProperty: z.string().min(1).nullish(),
  linkDatasetId: z.string().min(1).nullish(),
  fromKeyColumn: z.string().min(1).nullish(),
  toKeyColumn: z.string().min(1).nullish(),
})

export type LinkConfig = z.infer<typeof linkConfigSchema>

/** Check mappings against current dataset schemas before a link can be saved. */
export async function validateLinkConfig(input: LinkConfig): Promise<string | null> {
  const [from, to] = await Promise.all([
    db.objectType.findUnique({ where: { id: input.fromTypeId } }),
    db.objectType.findUnique({ where: { id: input.toTypeId } }),
  ])
  if (!from || !to) return 'Select two existing object types'
  if (!from.sourceDatasetId || !from.primaryKey || !to.sourceDatasetId || !to.primaryKey) {
    return 'Both object types need a backing dataset and primary key'
  }

  const datasetIds = [from.sourceDatasetId, to.sourceDatasetId]
  if (input.cardinality === 'many-to-many') {
    if (!input.linkDatasetId || !input.fromKeyColumn || !input.toKeyColumn) {
      return 'Select a relationship dataset and both key columns'
    }
    if (input.fromKeyColumn === input.toKeyColumn) return 'Select two different relationship key columns'
    datasetIds.push(input.linkDatasetId)
  } else if (!input.fkProperty) {
    return 'Select the foreign key column on the target object type'
  }

  const datasets = await db.dataset.findMany({ where: { id: { in: datasetIds } }, select: { id: true } })
  const columns = new Map(await Promise.all(datasets.map(async (dataset) => {
    const consumer = await resolveConsumerVersion(dataset.id)
    const version = consumer?.versionNumber == null ? null : await getDatasetVersion(dataset.id, consumer.versionNumber)
    return [dataset.id, version ? parseSchema(version).map((column) => column.name) : []] as const
  })))
  const has = (datasetId: string, column: string) => columns.get(datasetId)?.includes(column) ?? false
  if (!has(from.sourceDatasetId, from.primaryKey)) return `${from.displayName} primary key is missing from its consumer-visible dataset schema`
  if (!has(to.sourceDatasetId, to.primaryKey)) return `${to.displayName} primary key is missing from its consumer-visible dataset schema`

  if (input.cardinality === 'one-to-many') {
    if (!has(to.sourceDatasetId, input.fkProperty!)) {
      return `Column '${input.fkProperty}' is missing from ${to.displayName}'s consumer-visible dataset schema`
    }
  } else {
    if (!columns.has(input.linkDatasetId!)) return 'Relationship dataset not found'
    if (!has(input.linkDatasetId!, input.fromKeyColumn!)) return `Relationship column '${input.fromKeyColumn}' does not exist`
    if (!has(input.linkDatasetId!, input.toKeyColumn!)) return `Relationship column '${input.toKeyColumn}' does not exist`
  }
  return null
}

export function normalizedLinkConfig(input: LinkConfig) {
  return {
    displayName: input.displayName,
    apiName: input.apiName,
    fromTypeId: input.fromTypeId,
    toTypeId: input.toTypeId,
    cardinality: input.cardinality,
    fkProperty: input.cardinality === 'one-to-many' ? input.fkProperty! : null,
    linkDatasetId: input.cardinality === 'many-to-many' ? input.linkDatasetId! : null,
    fromKeyColumn: input.cardinality === 'many-to-many' ? input.fromKeyColumn! : null,
    toKeyColumn: input.cardinality === 'many-to-many' ? input.toKeyColumn! : null,
  }
}
