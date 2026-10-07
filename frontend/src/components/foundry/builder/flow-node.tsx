'use client'

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { GraphNodeData } from '@/lib/foundry-types'
import { NODE_META, summarizeNode } from './node-meta'
import { useDatasetsById } from './builder-context'

export type AppNode = Node<GraphNodeData, string>

export function FlowNode({ data, type, selected }: NodeProps<AppNode>) {
  const nodeType = (type ?? 'select') as keyof typeof NODE_META
  const meta = NODE_META[nodeType] ?? NODE_META.select
  const datasetsById = useDatasetsById()
  const summary = summarizeNode(nodeType, data, datasetsById)

  const isSource = nodeType === 'source'
  const isOutput = nodeType === 'output'
  const isDualInput = nodeType === 'join' || nodeType === 'union'
  const Icon = meta.icon

  return (
    <div
      className={cn(
        'w-56 rounded-md border bg-card shadow-sm transition-colors',
        selected ? 'border-foreground' : 'border-border hover:border-foreground/40',
      )}
      role="group"
      aria-label={`${meta.label} node`}
    >
      {/* handles */}
      {!isSource && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          style={{ top: isDualInput ? '30%' : '50%' }}
          aria-label={`${meta.label} input`}
        />
      )}
      {isDualInput && (
        <Handle
          type="target"
          position={Position.Left}
          id="in-1"
          style={{ top: '70%' }}
          aria-label={`${meta.label} second input`}
        />
      )}
      {!isOutput && (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          aria-label={`${meta.label} output`}
        />
      )}

      <div className="flex items-start gap-2 px-2.5 py-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {meta.label}
          </p>
          <p
            className={cn(
              'truncate font-mono text-[11px] leading-4',
              nodeType === 'source' || nodeType === 'output' ? 'text-foreground' : 'text-muted-foreground',
            )}
            title={summary}
          >
            {summary}
          </p>
        </div>
      </div>
    </div>
  )
}
