'use client'

import {
  ArrowUpDown,
  Columns3,
  Combine,
  CopyX,
  Database,
  Filter,
  GitMerge,
  PackageCheck,
  PencilLine,
  Scissors,
  Sigma,
  Sparkles,
  SquareFunction,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { GraphNodeData, NodeTypeName } from '@/lib/foundry-types'

export interface NodeMeta {
  label: string
  icon: ComponentType<{ className?: string }>
  /** text color class for icon/accent */
  accent: string
  /** border/strip color class */
  strip: string
  hint: string
}

export const NODE_META: Record<NodeTypeName, NodeMeta> = {
  source: {
    label: 'Source',
    icon: Database,
    accent: 'text-emerald-600 dark:text-emerald-400',
    strip: 'bg-emerald-400',
    hint: 'Read rows from a catalog dataset as pipeline input.',
  },
  filter: {
    label: 'Filter',
    icon: Filter,
    accent: 'text-amber-600 dark:text-amber-400',
    strip: 'bg-amber-400',
    hint: 'Keep only rows matching a condition.',
  },
  derive: {
    label: 'Derive',
    icon: Sparkles,
    accent: 'text-fuchsia-400',
    strip: 'bg-fuchsia-400',
    hint: 'Compute a new column per row with a JS expression.',
  },
  select: {
    label: 'Select',
    icon: Columns3,
    accent: 'text-zinc-300',
    strip: 'bg-zinc-400',
    hint: 'Keep only the listed columns, in order.',
  },
  rename: {
    label: 'Rename',
    icon: PencilLine,
    accent: 'text-zinc-300',
    strip: 'bg-zinc-400',
    hint: 'Rename columns via old → new pairs.',
  },
  join: {
    label: 'Join',
    icon: GitMerge,
    accent: 'text-teal-600 dark:text-teal-400',
    strip: 'bg-teal-400',
    hint: 'Merge two inputs on a key (in-0 = left).',
  },
  aggregate: {
    label: 'Aggregate',
    icon: Sigma,
    accent: 'text-orange-600 dark:text-orange-400',
    strip: 'bg-orange-400',
    hint: 'Group rows and compute sum / avg / min / max / count.',
  },
  sort: {
    label: 'Sort',
    icon: ArrowUpDown,
    accent: 'text-zinc-300',
    strip: 'bg-zinc-400',
    hint: 'Order rows by one or more columns.',
  },
  dedupe: {
    label: 'Dedupe',
    icon: CopyX,
    accent: 'text-zinc-300',
    strip: 'bg-zinc-400',
    hint: 'Drop duplicate rows, optionally keyed by columns.',
  },
  union: {
    label: 'Union',
    icon: Combine,
    accent: 'text-teal-600 dark:text-teal-400',
    strip: 'bg-teal-400',
    hint: 'Stack two inputs into one row set.',
  },
  limit: {
    label: 'Limit',
    icon: Scissors,
    accent: 'text-zinc-300',
    strip: 'bg-zinc-400',
    hint: 'Keep the first N rows.',
  },
  output: {
    label: 'Output',
    icon: PackageCheck,
    accent: 'text-rose-600 dark:text-rose-400',
    strip: 'bg-rose-400',
    hint: 'Publish the result as a new dataset version.',
  },
}

export const NODE_TYPES: NodeTypeName[] = [
  'source',
  'filter',
  'derive',
  'select',
  'rename',
  'join',
  'aggregate',
  'sort',
  'dedupe',
  'union',
  'limit',
  'output',
]

export function defaultNodeData(type: NodeTypeName): GraphNodeData {
  switch (type) {
    case 'source':
      return { datasetId: '' }
    case 'filter':
      return { column: '', operator: 'eq', value: '' }
    case 'derive':
      return { newColumn: '', expression: '' }
    case 'select':
      return { columns: [] }
    case 'rename':
      return { mapping: {} }
    case 'join':
      return { how: 'inner', leftKey: '', rightKey: '' }
    case 'aggregate':
      return { groupBy: [], ops: [] }
    case 'sort':
      return { by: [] }
    case 'dedupe':
      return { keys: [] }
    case 'union':
      return {}
    case 'limit':
      return { n: 10 }
    case 'output':
      return { name: 'Output dataset' }
  }
}

const OP_GLYPH: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: '∋',
}

/** One-line human summary of a node's configuration. */
export function summarizeNode(
  type: string,
  data: GraphNodeData,
  datasetsById: Map<string, { name: string }>,
): string {
  const trunc = (s: string, n = 26) => (s.length > n ? `${s.slice(0, n)}…` : s)
  switch (type) {
    case 'source': {
      const ds = data.datasetId ? datasetsById.get(data.datasetId) : undefined
      return ds ? ds.name : '⚠ select a dataset'
    }
    case 'filter':
      return data.column
        ? `${data.column} ${OP_GLYPH[data.operator ?? 'eq'] ?? '='} ${trunc(String(data.value ?? ''))}`
        : '⚠ column required'
    case 'derive':
      return `${data.newColumn || '⚠ name'} = ${trunc(data.expression || '⚠ expression')}`
    case 'select':
      return data.columns && data.columns.length > 0
        ? data.columns.map((c) => trunc(c, 14)).join(', ')
        : '⚠ no columns'
    case 'rename': {
      const entries = Object.entries(data.mapping ?? {})
      if (entries.length === 0) return '⚠ no pairs'
      return entries.slice(0, 2).map(([o, n]) => `${o}→${n}`).join(', ') +
        (entries.length > 2 ? ` +${entries.length - 2}` : '')
    }
    case 'join':
      return `${data.how ?? 'inner'} · ${data.leftKey || '?'} = ${data.rightKey || '?'}`
    case 'aggregate': {
      const group = (data.groupBy ?? []).join(', ') || '—'
      const ops = (data.ops ?? [])
        .map((o) => `${o.op}(${o.column || '*'})${o.alias ? `→${o.alias}` : ''}`)
        .join(', ') || '—'
      return `by ${trunc(group, 16)} · ${trunc(ops, 20)}`
    }
    case 'sort':
      return (data.by ?? []).length > 0
        ? data.by!.map((b) => `${b.column} ${b.dir}`).join(', ')
        : '⚠ no keys'
    case 'dedupe':
      return data.keys && data.keys.length > 0 ? data.keys.join(', ') : '(all columns)'
    case 'union':
      return '2 inputs → rows combined'
    case 'limit':
      return `first ${data.n ?? '…'}`
    case 'output':
      return data.name || '⚠ name required'
    default:
      return ''
  }
}
