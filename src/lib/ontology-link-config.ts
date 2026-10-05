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
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
  fkProperty: z.string().min(1).nullish(),
  fkSide: z.enum(['from', 'to']).nullish(),
  linkDatasetId: z.string().min(1).nullish(),
  fromKeyColumn: z.string().min(1).nullish(),
  toKeyColumn: z.string().min(1).nullish(),
})

export type LinkConfig = z.infer<typeof linkConfigSchema>

export function effectiveFkSide(input: LinkConfig): 'from' | 'to' {
  return input.fkSide ?? (input.cardinality === 'one-to-many' ? 'to' : 'from')
}

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
  } else {
    if (!input.fkProperty) return 'Select a foreign key column'
    if (input.cardinality === 'one-to-many' && effectiveFkSide(input) !== 'to') {
      return 'One to many requires a foreign key on the target type'
    }
    if (input.cardinality === 'many-to-one' && effectiveFkSide(input) !== 'from') {
      return 'Many to one requires a foreign key on the source type'
    }
  }

  const datasets = await db.dataset.findMany({ where: { id: { in: datasetIds } }, select: { id: true } })
  const schemas = new Map(await Promise.all(datasets.map(async (dataset) => {
    const consumer = await resolveConsumerVersion(dataset.id)
    const version = consumer?.versionNumber == null ? null : await getDatasetVersion(dataset.id, consumer.versionNumber)
    return [dataset.id, version ? parseSchema(version) : []] as const
  })))
  const columnType = (datasetId: string, column: string) => schemas.get(datasetId)?.find((entry) => entry.name === column)?.type
  const has = (datasetId: string, column: string) => columnType(datasetId, column) !== undefined
  if (!has(from.sourceDatasetId, from.primaryKey)) return `${from.displayName} primary key is missing from its consumer-visible dataset schema`
  if (!has(to.sourceDatasetId, to.primaryKey)) return `${to.displayName} primary key is missing from its consumer-visible dataset schema`

  if (input.cardinality !== 'many-to-many') {
    const holder = effectiveFkSide(input) === 'from' ? from : to
    const referenced = effectiveFkSide(input) === 'from' ? to : from
    if (!has(holder.sourceDatasetId!, input.fkProperty!)) {
      return `Column '${input.fkProperty}' is missing from ${holder.displayName}'s consumer-visible dataset schema`
    }
    if (columnType(holder.sourceDatasetId!, input.fkProperty!) !== columnType(referenced.sourceDatasetId!, referenced.primaryKey!)) {
      return `${holder.displayName}.${input.fkProperty} and ${referenced.displayName}.${referenced.primaryKey} must have the same data type`
    }
  } else {
    if (!schemas.has(input.linkDatasetId!)) return 'Relationship dataset not found'
    if (!has(input.linkDatasetId!, input.fromKeyColumn!)) return `Relationship column '${input.fromKeyColumn}' does not exist`
    if (!has(input.linkDatasetId!, input.toKeyColumn!)) return `Relationship column '${input.toKeyColumn}' does not exist`
    if (columnType(input.linkDatasetId!, input.fromKeyColumn!) !== columnType(from.sourceDatasetId, from.primaryKey)) {
      return `Relationship column '${input.fromKeyColumn}' must match ${from.displayName}'s primary key type`
    }
    if (columnType(input.linkDatasetId!, input.toKeyColumn!) !== columnType(to.sourceDatasetId, to.primaryKey)) {
      return `Relationship column '${input.toKeyColumn}' must match ${to.displayName}'s primary key type`
    }
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
    fkProperty: input.cardinality === 'many-to-many' ? null : input.fkProperty!,
    fkSide: input.cardinality === 'many-to-many' ? null : effectiveFkSide(input),
    linkDatasetId: input.cardinality === 'many-to-many' ? input.linkDatasetId! : null,
    fromKeyColumn: input.cardinality === 'many-to-many' ? input.fromKeyColumn! : null,
    toKeyColumn: input.cardinality === 'many-to-many' ? input.toKeyColumn! : null,
  }
}
