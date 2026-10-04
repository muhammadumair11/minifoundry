'use client'

import { useEffect, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/foundry/code-editor'
import type {
  AggregateOp,
  AggregateOpSpec,
  DatasetSummary,
  GraphNodeData,
  NodeTypeName,
  SortSpec,
} from '@/lib/foundry-types'
import type { AppNode } from './flow-node'
import { NODE_META } from './node-meta'

const inputCls = 'h-8 font-mono text-xs'

function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  htmlFor?: string
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={htmlFor} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[10px] leading-4 text-muted-foreground/80">{hint}</p>}
    </div>
  )
}

function CommaListInput({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  id?: string
}) {
  const joined = value.join(', ')
  const [text, setText] = useState(joined)
  useEffect(() => {
    setText(joined)
  }, [joined])
  return (
    <Input
      id={id}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }}
      className={inputCls}
    />
  )
}

export function ConfigPanel({
  node,
  datasets,
  onPatchData,
  onDelete,
  nodeCount,
  edgeCount,
}: {
  node: AppNode | null
  datasets: DatasetSummary[]
  onPatchData: (id: string, patch: Partial<GraphNodeData>) => void
  onDelete: (id: string) => void
  nodeCount: number
  edgeCount: number
}) {
  if (!node) {
    return (
      <div className="foundry-scroll flex h-full flex-col gap-3 overflow-y-auto p-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Configuration
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {nodeCount} nodes · {edgeCount} edges
        </p>
        <div className="rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-5 text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">How to build a pipeline</p>
          <ol className="list-inside list-decimal space-y-1">
            <li>
              Add a <span className="font-mono text-foreground">source</span> node and pick a
              dataset.
            </li>
            <li>Chain transform nodes — they execute top to bottom.</li>
            <li>
              Finish with exactly one <span className="font-mono text-foreground">output</span> node
              that names the result dataset.
            </li>
            <li>Hit Save, then Run. Each run writes a new dataset version.</li>
          </ol>
          <p className="mt-2 text-muted-foreground/80">
            Select a node on the canvas to edit its configuration. Press Backspace/Delete to remove
            the selected node.
          </p>
        </div>
      </div>
    )
  }

  const meta = NODE_META[(node.type as NodeTypeName) ?? 'select'] ?? NODE_META.select
  const d = node.data
  const patch = (p: Partial<GraphNodeData>) => onPatchData(node.id, p)

  return (
    <div className="foundry-scroll flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          <meta.icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {meta.label} node
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(node.id)}
          className="h-7 gap-1 px-2 text-[11px] text-rose-600 hover:bg-rose-500/10 hover:text-rose-500 dark:text-rose-400 dark:hover:text-rose-300"
          aria-label="Delete selected node"
        >
          <Trash2 className="h-3 w-3" aria-hidden />
          Delete
        </Button>
      </div>

      {/* ── source ── */}
      {node.type === 'source' && (
        <>
          <Field
            label="Input dataset"
            hint="Rows are read from the dataset's latest version at run time."
            htmlFor="cfg-dataset"
          >
            <Select
              value={typeof d.datasetId === 'string' ? d.datasetId : ''}
              onValueChange={(v) => patch({ datasetId: v })}
            >
              <SelectTrigger id="cfg-dataset" className="h-8 text-xs">
                <SelectValue placeholder="Choose dataset…" />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id} className="text-xs">
                    {ds.name}
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                      v{ds.currentVersion?.versionNumber ?? '?'} · {ds.currentVersion?.rowCount ?? 0} rows
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      )}

      {/* ── filter ── */}
      {node.type === 'filter' && (
        <>
          <Field label="Column" htmlFor="cfg-filter-col" hint="Column to compare on.">
            <Input
              id="cfg-filter-col"
              value={d.column ?? ''}
              onChange={(e) => patch({ column: e.target.value })}
              placeholder="status"
              className={inputCls}
            />
          </Field>
          <Field label="Operator" hint="contains is case-insensitive.">
            <Select
              value={d.operator ?? 'eq'}
              onValueChange={(v) => patch({ operator: v as GraphNodeData['operator'] })}
            >
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  [
                    ['eq', '= equals'],
                    ['neq', '≠ not equals'],
                    ['gt', '> greater'],
                    ['gte', '≥ greater or equal'],
                    ['lt', '< less'],
                    ['lte', '≤ less or equal'],
                    ['contains', '∋ contains'],
                  ] as const
                ).map(([op, label]) => (
                  <SelectItem key={op} value={op} className="font-mono text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Value" htmlFor="cfg-filter-val" hint="Numbers compare numerically; otherwise string compare.">
            <Input
              id="cfg-filter-val"
              value={d.value ?? ''}
              onChange={(e) => patch({ value: e.target.value })}
              placeholder="delivered"
              className={inputCls}
            />
          </Field>
        </>
      )}

      {/* ── derive ── */}
      {node.type === 'derive' && (
        <>
          <Field label="New column" htmlFor="cfg-derive-col" hint="Name of the computed column.">
            <Input
              id="cfg-derive-col"
              value={d.newColumn ?? ''}
              onChange={(e) => patch({ newColumn: e.target.value })}
              placeholder="totalValue"
              className={inputCls}
            />
          </Field>
          <Field
            label="Expression"
            hint="JavaScript using `row`. Failing rows evaluate to null."
          >
            <CodeEditor
              value={d.expression ?? ''}
              onChange={(expression) => patch({ expression })}
              language="javascript"
              variant="compact"
              fontSize={12}
              placeholder="row.quantity * row.unitPrice"
              ariaLabel="Derive expression — JavaScript using row"
              className="h-[96px] shrink-0 rounded-md border border-border"
            />
          </Field>
        </>
      )}

      {/* ── select ── */}
      {node.type === 'select' && (
        <Field
          label="Columns to keep"
          htmlFor="cfg-select-cols"
          hint="Comma-separated, order preserved."
        >
          <CommaListInput
            id="cfg-select-cols"
            value={d.columns ?? []}
            onChange={(columns) => patch({ columns })}
            placeholder="id, sku, quantity"
          />
        </Field>
      )}

      {/* ── rename ── */}
      {node.type === 'rename' && (
        <div className="grid gap-2">
          <p className="text-[11px] font-medium text-muted-foreground">Column mappings (old → new)</p>
          {Object.entries(d.mapping ?? {}).map(([oldName, newName], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={oldName}
                aria-label="Old column name"
                onChange={(e) => {
                  const entries = Object.entries(d.mapping ?? {}).map(([k, v], j) =>
                    j === i ? [e.target.value, v] : [k, v],
                  )
                  patch({ mapping: Object.fromEntries(entries) })
                }}
                className={cn(inputCls, 'w-[42%]')}
                placeholder="old"
              />
              <span className="shrink-0 text-muted-foreground" aria-hidden>
                →
              </span>
              <Input
                value={newName}
                aria-label="New column name"
                onChange={(e) => patch({ mapping: { ...(d.mapping ?? {}), [oldName]: e.target.value } })}
                className={inputCls}
                placeholder="new"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                aria-label={`Remove mapping ${oldName}`}
                onClick={() => {
                  const next = { ...(d.mapping ?? {}) }
                  delete next[oldName]
                  patch({ mapping: next })
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              const key = `col${Object.keys(d.mapping ?? {}).length + 1}`
              patch({ mapping: { ...(d.mapping ?? {}), [key]: '' } })
            }}
          >
            + Add pair
          </Button>
        </div>
      )}

      {/* ── join ── */}
      {node.type === 'join' && (
        <>
          <Field label="Join type" hint="left keeps unmatched left rows with nulls.">
            <Select
              value={d.how ?? 'inner'}
              onValueChange={(v) => patch({ how: v as 'inner' | 'left' })}
            >
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inner" className="font-mono text-xs">
                  inner
                </SelectItem>
                <SelectItem value="left" className="font-mono text-xs">
                  left
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Left key" htmlFor="cfg-join-left" hint="Column on in-0 (upper handle).">
            <Input
              id="cfg-join-left"
              value={d.leftKey ?? ''}
              onChange={(e) => patch({ leftKey: e.target.value })}
              placeholder="supplierId"
              className={inputCls}
            />
          </Field>
          <Field label="Right key" htmlFor="cfg-join-right" hint="Column on in-1 (lower handle).">
            <Input
              id="cfg-join-right"
              value={d.rightKey ?? ''}
              onChange={(e) => patch({ rightKey: e.target.value })}
              placeholder="id"
              className={inputCls}
            />
          </Field>
        </>
      )}

      {/* ── aggregate ── */}
      {node.type === 'aggregate' && (
        <>
          <Field label="Group by" htmlFor="cfg-agg-group" hint="Comma-separated keys. Empty = single global row.">
            <CommaListInput
              id="cfg-agg-group"
              value={d.groupBy ?? []}
              onChange={(groupBy) => patch({ groupBy })}
              placeholder="warehouseId, category"
            />
          </Field>
          <div className="grid gap-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">Aggregations</p>
            {(d.ops ?? []).map((spec: AggregateOpSpec, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/40 p-2">
                <div className="flex items-center gap-1.5">
                  <Select
                    value={spec.op}
                    onValueChange={(v) => {
                      const ops = [...(d.ops ?? [])]
                      ops[i] = { ...ops[i], op: v as AggregateOp }
                      patch({ ops })
                    }}
                  >
                    <SelectTrigger className="h-7 flex-1 font-mono text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['sum', 'avg', 'min', 'max', 'count'] as const).map((op) => (
                        <SelectItem key={op} value={op} className="font-mono text-xs">
                          {op}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                    aria-label={`Remove aggregation ${i + 1}`}
                    onClick={() => patch({ ops: (d.ops ?? []).filter((_, j) => j !== i) })}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <Input
                    value={spec.column ?? ''}
                    aria-label={`Aggregation ${i + 1} column`}
                    onChange={(e) => {
                      const ops = [...(d.ops ?? [])]
                      ops[i] = { ...ops[i], column: e.target.value }
                      patch({ ops })
                    }}
                    placeholder="column"
                    className={cn(inputCls, 'h-7')}
                  />
                  <Input
                    value={spec.alias ?? ''}
                    aria-label={`Aggregation ${i + 1} alias`}
                    onChange={(e) => {
                      const ops = [...(d.ops ?? [])]
                      ops[i] = { ...ops[i], alias: e.target.value }
                      patch({ ops })
                    }}
                    placeholder="alias"
                    className={cn(inputCls, 'h-7')}
                  />
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => patch({ ops: [...(d.ops ?? []), { op: 'sum', column: '', alias: '' }] })}
            >
              + Add aggregation
            </Button>
          </div>
        </>
      )}

      {/* ── sort ── */}
      {node.type === 'sort' && (
        <div className="grid gap-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">Sort keys (applied in order)</p>
          {(d.by ?? []).map((spec: SortSpec, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={spec.column}
                aria-label={`Sort column ${i + 1}`}
                onChange={(e) => {
                  const by = [...(d.by ?? [])]
                  by[i] = { ...by[i], column: e.target.value }
                  patch({ by })
                }}
                placeholder="column"
                className={cn(inputCls, 'flex-1')}
              />
              <Select
                value={spec.dir}
                onValueChange={(v) => {
                  const by = [...(d.by ?? [])]
                  by[i] = { ...by[i], dir: v as 'asc' | 'desc' }
                  patch({ by })
                }}
              >
                <SelectTrigger className="h-8 w-20 shrink-0 font-mono text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc" className="font-mono text-xs">
                    asc
                  </SelectItem>
                  <SelectItem value="desc" className="font-mono text-xs">
                    desc
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                aria-label={`Remove sort key ${i + 1}`}
                onClick={() => patch({ by: (d.by ?? []).filter((_, j) => j !== i) })}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => patch({ by: [...(d.by ?? []), { column: '', dir: 'asc' }] })}
          >
            + Add sort key
          </Button>
        </div>
      )}

      {/* ── dedupe ── */}
      {node.type === 'dedupe' && (
        <Field
          label="Key columns"
          htmlFor="cfg-dedupe-keys"
          hint="Optional. Empty = dedupe on the full row."
        >
          <CommaListInput
            id="cfg-dedupe-keys"
            value={d.keys ?? []}
            onChange={(keys) => patch({ keys })}
            placeholder="sku, warehouseId"
          />
        </Field>
      )}

      {/* ── union ── */}
      {node.type === 'union' && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-5 text-muted-foreground">
          Connect two inputs (in-0, in-1). Rows are stacked and aligned by column name; missing
          columns become <span className="font-mono">null</span>. No configuration needed.
        </p>
      )}

      {/* ── limit ── */}
      {node.type === 'limit' && (
        <Field label="N rows" htmlFor="cfg-limit-n" hint="Keep the first N rows.">
          <Input
            id="cfg-limit-n"
            type="number"
            min={0}
            value={d.n ?? ''}
            onChange={(e) =>
              patch({ n: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })
            }
            className={inputCls}
          />
        </Field>
      )}

      {/* ── output ── */}
      {node.type === 'output' && (
        <Field
          label="Output dataset name"
          htmlFor="cfg-output-name"
          hint="A new version of this dataset is published on every run."
        >
          <Input
            id="cfg-output-name"
            value={d.name ?? ''}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Active Shipments"
            className={inputCls}
          />
        </Field>
      )}
    </div>
  )
}
