import type { ColumnDef, PipelineGraph } from '@/lib/foundry-types'

export type PipelineSchema = ColumnDef[] | null

export interface NodeSchema {
  inputs: PipelineSchema[]
  output: PipelineSchema
  missing: string[]
}

const unique = (columns: ColumnDef[]) => [...new Map(columns.map((column) => [column.name, column])).values()]

/** Infer columns without executing the graph. Null means an upstream schema is unavailable. */
export function inferPipelineSchemas(
  graph: PipelineGraph,
  sourceSchemas: Map<string, ColumnDef[]>,
): Map<string, NodeSchema> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const result = new Map<string, NodeSchema>()
  const visiting = new Set<string>()

  function visit(id: string): NodeSchema {
    const cached = result.get(id)
    if (cached) return cached
    const node = nodes.get(id)
    if (!node || visiting.has(id)) return { inputs: [], output: null, missing: [] }
    visiting.add(id)
    // The engine reads the upper handle before the lower handle; legacy edges retain order.
    const inputs = graph.edges.filter((edge) => edge.target === id)
      .sort((a, b) => Number(a.targetHandle === 'in-1') - Number(b.targetHandle === 'in-1'))
      .map((edge) => visit(edge.source).output)
    const first = inputs[0] ?? null
    const missing: string[] = []
    const check = (name: string | undefined, schema = first) => {
      if (name && schema && !schema.some((column) => column.name === name)) missing.push(name)
    }
    let output: PipelineSchema = first
    const data = node.data
    switch (node.type) {
      case 'source':
        output = sourceSchemas.get(data.datasetId ?? '') ?? null
        break
      case 'filter':
        check(data.column)
        break
      case 'derive':
        if (first && data.newColumn) output = unique([...first, { name: data.newColumn, type: 'string' }])
        break
      case 'select':
        for (const name of data.columns ?? []) check(name)
        if (first) output = (data.columns ?? []).flatMap((name) => first.filter((column) => column.name === name))
        break
      case 'rename':
        for (const name of Object.keys(data.mapping ?? {})) check(name)
        if (first) output = unique(first.map((column) => ({ ...column, name: data.mapping?.[column.name] || column.name })))
        break
      case 'join': {
        check(data.leftKey, inputs[0])
        check(data.rightKey, inputs[1])
        if (inputs[0] && inputs[1]) {
          const left = inputs[0]
          const right = inputs[1]
          output = unique([...left, ...right.map((column) => ({
            ...column,
            name: left.some((item) => item.name === column.name) ? `right_${column.name}` : column.name,
          }))])
        } else output = null
        break
      }
      case 'aggregate':
        for (const name of data.groupBy ?? []) check(name)
        for (const spec of data.ops ?? []) check(spec.column)
        if (first) output = unique([
          ...(data.groupBy ?? []).flatMap((name) => first.filter((column) => column.name === name)),
          ...(data.ops ?? []).map((spec) => ({
            name: spec.alias || (spec.op === 'count' ? 'count' : `${spec.op}_${spec.column}`),
            type: 'number' as const,
          })),
        ])
        break
      case 'sort':
        for (const spec of data.by ?? []) check(spec.column)
        break
      case 'dedupe':
        for (const name of data.keys ?? []) check(name)
        break
      case 'union':
        output = inputs[0] && inputs[1] ? unique([...inputs[0], ...inputs[1]]) : null
        break
    }
    const value = { inputs, output, missing: [...new Set(missing)] }
    result.set(id, value)
    visiting.delete(id)
    return value
  }

  for (const node of graph.nodes) visit(node.id)
  return result
}
