'use client'

// Task 14-d — "Add widget" dialog for the dashboard builder. Point-and-click:
// widget type (icons) → dataset → dynamic metric config (groupBy / agg /
// valueColumn / topN / sortDir / span) with an editable auto-suggested title.
// Column options come from the selected dataset's latest-version schema
// (GET /api/datasets/[id] — reuses the shared ['dataset', id] cache).

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  BarChart3,
  LineChart,
  PieChart,
  Plus,
  Sigma,
  Table2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiJson } from '@/lib/foundry-api'
import type {
  DashboardWidget,
  DashboardWidgetType,
  DatasetDetailResponse,
  DatasetSummary,
} from '@/lib/foundry-types'

const GROUP_TYPES: DashboardWidgetType[] = ['bar', 'line', 'pie', 'area']

const TYPE_OPTIONS: { value: DashboardWidgetType; label: string; icon: React.ReactNode }[] = [
  { value: 'bar', label: 'Bar', icon: <BarChart3 className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'line', label: 'Line', icon: <LineChart className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'pie', label: 'Pie', icon: <PieChart className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'area', label: 'Area', icon: <AreaChart className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'stat', label: 'Stat', icon: <Sigma className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'table', label: 'Table', icon: <Table2 className="h-3.5 w-3.5" aria-hidden /> },
]

const AGG_OPTIONS = ['count', 'sum', 'avg', 'min', 'max'] as const
const NUMERIC_AGGS = ['sum', 'avg', 'min', 'max']

/** 'warehouseId' → 'Warehouse', 'onTimePct' → 'On time pct' — title material. */
function prettyColumn(c: string): string {
  const base = c.replace(/Id$/i, '')
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function AddWidgetDialog({
  datasets,
  onAdd,
}: {
  datasets: DatasetSummary[]
  onAdd: (widget: DashboardWidget) => void
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<DashboardWidgetType>('bar')
  const [datasetId, setDatasetId] = useState('')
  const [groupBy, setGroupBy] = useState('')
  const [agg, setAgg] = useState<(typeof AGG_OPTIONS)[number]>('count')
  const [valueColumn, setValueColumn] = useState('')
  const [topN, setTopN] = useState('10')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [span, setSpan] = useState<'1' | '2'>('1')
  // Title is EFFECTIVELY derived: until the user edits it, the input shows the
  // auto-suggestion (no setState-in-effect needed — see render + handleAdd).
  const [title, setTitle] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)

  const isGroupType = GROUP_TYPES.includes(type)
  const needsValue = NUMERIC_AGGS.includes(agg)
  const dataset = datasets.find((d) => d.id === datasetId) ?? null

  // Schema of the selected dataset (latest version) — shared cache with the
  // dataset detail page.
  const schemaQuery = useQuery<DatasetDetailResponse>({
    queryKey: ['dataset', datasetId],
    queryFn: () => apiJson<DatasetDetailResponse>(`/api/datasets/${datasetId}`),
    enabled: open && datasetId !== '',
  })
  const columns = schemaQuery.data?.current?.schema ?? []
  const numberColumns = columns.filter((c) => c.type === 'number')

  // Sensible defaults: picking a dataset or type resets the dependent metric
  // config (adjust-during-event instead of setState-in-effect).
  const resetDependentConfig = () => {
    setGroupBy('')
    setValueColumn('')
    setAgg('count')
  }

  const pickType = (t: DashboardWidgetType) => {
    setType(t)
    resetDependentConfig()
  }

  const pickDataset = (id: string) => {
    setDatasetId(id)
    resetDependentConfig()
  }

  // Auto-suggest the title until the user edits it manually.
  const suggested = useMemo(() => {
    if (!dataset) return ''
    const dsName = dataset.name
    if (type === 'table') return `${dsName} rows`
    if (type === 'stat') {
      if (agg === 'count') return `Total ${dsName.toLowerCase().endsWith('s') ? dsName : `${dsName} rows`}`
      return `${agg === 'avg' ? 'Average' : agg === 'sum' ? 'Total' : agg} of ${valueColumn ? prettyColumn(valueColumn) : dsName}`
    }
    return groupBy ? `${dsName} by ${prettyColumn(groupBy)}` : ''
  }, [dataset, type, agg, valueColumn, groupBy])

  const effectiveTitle = titleEdited ? title.trim() : suggested

  const reset = () => {
    setType('bar')
    setDatasetId('')
    setGroupBy('')
    setAgg('count')
    setValueColumn('')
    setTopN('10')
    setSortDir('desc')
    setSpan('1')
    setTitle('')
    setTitleEdited(false)
  }

  const blocked =
    !datasetId ||
    (isGroupType && !groupBy) ||
    (needsValue && !valueColumn) ||
    schemaQuery.isLoading

  const handleAdd = () => {
    if (blocked) return
    const config: DashboardWidget['config'] = { agg }
    if (isGroupType && groupBy) config.groupBy = groupBy
    if (needsValue && valueColumn) config.valueColumn = valueColumn
    if (type === 'table' || isGroupType) {
      const n = Math.max(1, Math.min(100, Number.parseInt(topN, 10) || 10))
      config.topN = n
      if (isGroupType) config.sortDir = sortDir
    }
    const widget: DashboardWidget = {
      id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `w-${Date.now()}`,
      type,
      title: effectiveTitle || suggested || 'Untitled widget',
      datasetId,
      ...(dataset ? { datasetName: dataset.name } : {}),
      config,
      span: span === '2' ? 2 : 1,
    }
    onAdd(widget)
    setOpen(false)
    reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add widget
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Add widget</DialogTitle>
          <DialogDescription className="text-xs">
            Point-and-click aggregation over any dataset&apos;s latest version.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {/* Widget type */}
          <div className="grid gap-1.5">
            <Label className="text-xs">Type</Label>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Widget type">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={type === opt.value}
                  onClick={() => pickType(opt.value)}
                  className={`flex h-16 flex-col items-center justify-center gap-1 rounded-md border text-[11px] transition-colors ${
                    type === opt.value
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                  }`}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Dataset */}
          <div className="grid gap-1.5">
            <Label htmlFor="dw-dataset" className="text-xs">Dataset</Label>
            <Select value={datasetId} onValueChange={pickDataset}>
              <SelectTrigger id="dw-dataset" className="h-9 text-xs">
                <SelectValue placeholder="Pick a dataset…" />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                    {d.currentVersion ? (
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        {d.currentVersion.rowCount.toLocaleString('en-US')} rows
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Dynamic metric config */}
          {isGroupType && (
            <div className="grid gap-1.5">
              <Label htmlFor="dw-groupby" className="text-xs">Group by column</Label>
              <Select value={groupBy} onValueChange={setGroupBy}>
                <SelectTrigger id="dw-groupby" className="h-9 text-xs">
                  <SelectValue placeholder={columns.length ? 'Pick a column…' : 'Select a dataset first'} />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      <span className="font-mono text-[11px]">{c.name}</span>
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{c.type}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {type !== 'table' && (
            <div className="grid gap-1.5">
              <Label htmlFor="dw-agg" className="text-xs">Aggregate</Label>
              <Select value={agg} onValueChange={(v) => setAgg(v as (typeof AGG_OPTIONS)[number])}>
                <SelectTrigger id="dw-agg" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGG_OPTIONS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a === 'count' ? 'count (rows)' : a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {type !== 'table' && needsValue && (
            <div className="grid gap-1.5">
              <Label htmlFor="dw-valuecol" className="text-xs">Value column</Label>
              <Select value={valueColumn} onValueChange={setValueColumn}>
                <SelectTrigger id="dw-valuecol" className="h-9 text-xs">
                  <SelectValue placeholder={columns.length ? 'Pick a numeric column…' : 'Select a dataset first'} />
                </SelectTrigger>
                <SelectContent>
                  {(numberColumns.length ? numberColumns : columns).map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      <span className="font-mono text-[11px]">{c.name}</span>
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{c.type}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {(isGroupType || type === 'table') && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="dw-topn" className="text-xs">Max rows (topN)</Label>
                <Input
                  id="dw-topn"
                  type="number"
                  min={1}
                  max={100}
                  value={topN}
                  onChange={(e) => setTopN(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              {isGroupType && (
                <div className="grid gap-1.5">
                  <Label htmlFor="dw-sort" className="text-xs">Sort</Label>
                  <Select value={sortDir} onValueChange={(v) => setSortDir(v as 'desc' | 'asc')}>
                    <SelectTrigger id="dw-sort" className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">value ↓ (desc)</SelectItem>
                      <SelectItem value="asc">value ↑ (asc)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="dw-title" className="text-xs">Title</Label>
              <Input
                id="dw-title"
                value={effectiveTitle}
                onChange={(e) => {
                  setTitle(e.target.value)
                  setTitleEdited(true)
                }}
                placeholder={suggested || 'Widget title'}
                className="h-9 text-xs"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dw-span" className="text-xs">Span</Label>
              <Select value={span} onValueChange={(v) => setSpan(v as '1' | '2')}>
                <SelectTrigger id="dw-span" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 column</SelectItem>
                  <SelectItem value="2">2 columns (wide)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button data-dialog-submit size="sm" className="gap-1.5" disabled={blocked} onClick={handleAdd}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add widget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
