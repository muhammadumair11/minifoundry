'use client'

import { useEffect, useState } from 'react'
import { Check, ChevronDown, Trash2, X } from 'lucide-react'
import { EditorButton as Button } from '@/components/foundry/editor-button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  ColumnDef,
  DatasetSummary,
  GraphNodeData,
  NodeTypeName,
  SortSpec,
} from '@/lib/foundry-types'
import type { NodeSchema } from '@/lib/pipeline-schema'
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

function ColumnPicker({
  id,
  value,
  columns,
  onChange,
  placeholder = 'Choose a column',
}: {
  id: string
  value: string
  columns: ColumnDef[] | null
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  if (!columns?.length) {
    return (
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={inputCls}
      />
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={id.replace(/^cfg-/, '').replace(/-/g, ' ')}
          className="h-8 min-w-0 flex-1 justify-between gap-1 px-2 font-mono text-xs font-normal"
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>{value || placeholder}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-52 p-0">
        <Command>
          <CommandInput placeholder="Search columns…" aria-label="Search columns" />
          <CommandList>
            <CommandEmpty>No matching columns.</CommandEmpty>
            <CommandGroup>
              {columns.map((column) => (
                <CommandItem
                  key={column.name}
                  value={column.name}
                  onSelect={() => { onChange(column.name); setOpen(false) }}
                  className="font-mono text-xs"
                >
                  <Check className={cn('h-3.5 w-3.5', value === column.name ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{column.name}</span>
                  <span className="text-[10px] text-muted-foreground">{column.type}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ColumnChecklist({
  id,
  value,
  columns,
  onChange,
  emptyHint,
}: {
  id: string
  value: string[]
  columns: ColumnDef[] | null
  onChange: (value: string[]) => void
  emptyHint: string
}) {
  const [search, setSearch] = useState('')
  if (!columns) {
    return <CommaListInput id={id} value={value} onChange={onChange} placeholder="Connect a source to choose columns" />
  }
  const visible = columns.filter((column) => column.name.toLowerCase().includes(search.toLowerCase()))
  return (
    <div className="grid gap-2">
      <Input
        id={id}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search columns"
        aria-label="Search columns"
        className={inputCls}
      />
      <div className="flex gap-2 text-[11px]">
        <button type="button" className="text-primary hover:underline" onClick={() => onChange(columns.map((column) => column.name))}>Select all</button>
        <button type="button" className="text-muted-foreground hover:underline" onClick={() => onChange([])}>Clear</button>
      </div>
      <div className="foundry-scroll max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {visible.map((column) => (
          <label key={column.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-accent">
            <input
              type="checkbox"
              checked={value.includes(column.name)}
              onChange={(event) => onChange(event.target.checked
                ? [...value, column.name]
                : value.filter((name) => name !== column.name))}
              className="accent-primary"
            />
            <span className="min-w-0 flex-1 truncate font-mono">{column.name}</span>
            <span className="text-[10px] text-muted-foreground">{column.type}</span>
          </label>
        ))}
        {visible.length === 0 && <p className="text-xs text-muted-foreground">No matching columns.</p>}
      </div>
      {value.length === 0 && <p className="text-[10px] text-muted-foreground">{emptyHint}</p>}
    </div>
  )
}

export function ConfigPanel({
  node,
  selectedEdge,
  onDeleteEdge,
  schema,
  datasets,
  onPatchData,
  onDelete,
  nodeCount,
  edgeCount,
}: {
  node: AppNode | null
  selectedEdge?: { id: string; source: string; target: string } | null
  onDeleteEdge?: (id: string) => void
  schema?: NodeSchema | null
  datasets: DatasetSummary[]
  onPatchData: (id: string, patch: Partial<GraphNodeData>) => void
  onDelete: (id: string) => void
  nodeCount: number
  edgeCount: number
}) {
  if (selectedEdge) {
    return (
      <div className="flex h-full flex-col gap-3 p-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Connection</p>
        <p className="break-all font-mono text-xs">{selectedEdge.source} → {selectedEdge.target}</p>
        <Button variant="outline" size="sm" className="gap-2 text-rose-600" onClick={() => onDeleteEdge?.(selectedEdge.id)}>
          <Trash2 className="h-3.5 w-3.5" /> Remove connection
        </Button>
        <p className="text-xs text-muted-foreground">The connected nodes remain in the pipeline.</p>
      </div>
    )
  }
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
            Select a node or connection to edit it. Press Backspace/Delete to remove the selection.
          </p>
        </div>
      </div>
    )
  }

  const meta = NODE_META[(node.type as NodeTypeName) ?? 'select'] ?? NODE_META.select
  const d = node.data
  const patch = (p: Partial<GraphNodeData>) => onPatchData(node.id, p)
  const inputColumns = schema?.inputs[0] ?? null

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

      {node.type !== 'source' && (
        <div className="rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
          <p className="font-medium text-foreground">Incoming columns</p>
          {schema?.inputs.some((columns) => columns !== null)
            ? schema.inputs.map((columns, index) => (
                <p key={index} className="mt-1 break-words font-mono">{schema.inputs.length > 1 ? `Input ${index + 1}: ` : ''}{columns?.map((column) => column.name).join(', ') || 'No columns'}</p>
              ))
            : <p className="mt-1">Connect a source to see its columns.</p>}
          {schema?.missing.length ? <p className="mt-2 text-rose-600">Missing: {schema.missing.join(', ')}</p> : null}
        </div>
      )}

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
            <ColumnPicker
              id="cfg-filter-col"
              value={d.column ?? ''}
              columns={inputColumns}
              onChange={(column) => patch({ column })}
              placeholder="status"
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
            {inputColumns?.find((column) => column.name === d.column)?.type === 'boolean' ? (
              <Select value={d.value ?? ''} onValueChange={(value) => patch({ value })}>
                <SelectTrigger id="cfg-filter-val" className={inputCls}><SelectValue placeholder="Choose true or false" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">true</SelectItem>
                  <SelectItem value="false">false</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="cfg-filter-val"
                type={inputColumns?.find((column) => column.name === d.column)?.type === 'number' ? 'number' : 'text'}
                value={d.value ?? ''}
                onChange={(e) => patch({ value: e.target.value })}
                placeholder="delivered"
                className={inputCls}
              />
            )}
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
          {inputColumns && inputColumns.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {inputColumns.slice(0, 12).map((column) => (
                <button
                  key={column.name}
                  type="button"
                  className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent"
                  onClick={() => patch({ expression: `${d.expression ?? ''}${d.expression ? ' ' : ''}row[${JSON.stringify(column.name)}]` })}
                >
                  + {column.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── select ── */}
      {node.type === 'select' && (
        <Field
          label="Columns to keep"
          htmlFor="cfg-select-cols"
          hint="Choose the columns to include. Selection order is preserved."
        >
          <ColumnChecklist
            id="cfg-select-cols"
            value={d.columns ?? []}
            columns={inputColumns}
            onChange={(columns) => patch({ columns })}
            emptyHint="Select at least one column."
          />
        </Field>
      )}

      {/* ── rename ── */}
      {node.type === 'rename' && (
        <div className="grid gap-2">
          <p className="text-[11px] font-medium text-muted-foreground">Column mappings (old → new)</p>
          {Object.entries(d.mapping ?? {}).map(([oldName, newName], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <ColumnPicker
                id={`cfg-rename-old-${i}`}
                value={oldName}
                columns={inputColumns}
                onChange={(value) => {
                  const entries = Object.entries(d.mapping ?? {}).map(([k, v], j) =>
                    j === i ? [value, v] : [k, v],
                  )
                  patch({ mapping: Object.fromEntries(entries) })
                }}
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
          <Field label="Left key" htmlFor="cfg-join-left" hint="Column on input 1 (upper handle).">
            <ColumnPicker
              id="cfg-join-left"
              value={d.leftKey ?? ''}
              columns={schema?.inputs[0] ?? null}
              onChange={(leftKey) => patch({ leftKey })}
              placeholder="supplierId"
            />
          </Field>
          <Field label="Right key" htmlFor="cfg-join-right" hint="Column on input 2 (lower handle).">
            <ColumnPicker
              id="cfg-join-right"
              value={d.rightKey ?? ''}
              columns={schema?.inputs[1] ?? null}
              onChange={(rightKey) => patch({ rightKey })}
              placeholder="id"
            />
          </Field>
        </>
      )}

      {/* ── aggregate ── */}
      {node.type === 'aggregate' && (
        <>
          <Field label="Group by" htmlFor="cfg-agg-group" hint="Empty = single global row.">
            <ColumnChecklist
              id="cfg-agg-group"
              value={d.groupBy ?? []}
              columns={inputColumns}
              onChange={(groupBy) => patch({ groupBy })}
              emptyHint="No grouping columns: one global row."
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
                  <ColumnPicker
                    id={`cfg-agg-col-${i}`}
                    value={spec.column ?? ''}
                    columns={inputColumns}
                    onChange={(column) => {
                      const ops = [...(d.ops ?? [])]
                      ops[i] = { ...ops[i], column }
                      patch({ ops })
                    }}
                    placeholder="column"
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
              <ColumnPicker
                id={`cfg-sort-col-${i}`}
                value={spec.column}
                columns={inputColumns}
                onChange={(column) => {
                  const by = [...(d.by ?? [])]
                  by[i] = { ...by[i], column }
                  patch({ by })
                }}
                placeholder="column"
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
          <ColumnChecklist
            id="cfg-dedupe-keys"
            value={d.keys ?? []}
            columns={inputColumns}
            onChange={(keys) => patch({ keys })}
            emptyHint="No keys: use the full row."
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
            step={1}
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
            list="cfg-output-datasets"
            value={d.name ?? ''}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Active Shipments"
            className={inputCls}
          />
          <datalist id="cfg-output-datasets">{datasets.map((dataset) => <option key={dataset.id} value={dataset.name} />)}</datalist>
        </Field>
      )}
    </div>
  )
}
