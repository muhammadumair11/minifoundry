'use client'

// AppFilterDialog — define one global app filter: scope (an object type or
// '*'), property, operator and control kind. Select-kind filters store their
// option list on the definition; "Load values" samples distinct values from
// the governed objects API so option lists need no typing.

import { useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import type { AppFilterDef, AppFilterOp, ObjectsListResponse, OntologyObjectType } from '@/lib/foundry-types'

const STAR = '*'
const OPS: { value: AppFilterOp; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'greater or equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'less or equal' },
]

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `f-${Date.now()}`

interface AppFilterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  objectTypes: OntologyObjectType[]
  onSave: (def: AppFilterDef) => void
}

export function AppFilterDialog({ open, onOpenChange, objectTypes, onSave }: AppFilterDialogProps) {
  const [scope, setScope] = useState<string>(objectTypes[0]?.apiName ?? STAR)
  const [property, setProperty] = useState('')
  const [op, setOp] = useState<AppFilterOp>('eq')
  const [kind, setKind] = useState<'text' | 'number' | 'select'>('text')
  const [optionsText, setOptionsText] = useState('')
  const [label, setLabel] = useState('')
  const [loadingValues, setLoadingValues] = useState(false)

  useEffect(() => {
    if (!open) return
    setScope(objectTypes[0]?.apiName ?? STAR)
    setProperty('')
    setOp('eq')
    setKind('text')
    setOptionsText('')
    setLabel('')
  }, [open, objectTypes])

  const scopedType = objectTypes.find((t) => t.apiName === scope) ?? null
  const scopedProperty = scopedType?.properties.find((p) => p.apiName === property) ?? null

  // Keep kind sensible when the property changes.
  useEffect(() => {
    if (!scopedProperty) return
    if (scopedProperty.dataType === 'number') setKind('number')
    else setKind((k) => (k === 'number' ? 'text' : k))
  }, [scopedProperty])

  const options = useMemo(
    () =>
      optionsText
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    [optionsText],
  )

  const blocked = !property.trim() || (kind === 'select' && options.length === 0)

  const loadValues = async () => {
    if (!scopedType || !property) {
      toast.error('Pick an object type and property first')
      return
    }
    setLoadingValues(true)
    try {
      const res = await apiJson<ObjectsListResponse>(
        `/api/objects?type=${encodeURIComponent(scopedType.apiName)}&page=1&pageSize=200`,
      )
      const distinct = [...new Set(res.rows.map((r) => String(r.values[property] ?? '').trim()).filter(Boolean))]
        .sort()
        .slice(0, 30)
      if (distinct.length === 0) {
        toast.info('No distinct values found', { description: `${property} is empty across sampled objects.` })
      } else {
        setOptionsText(distinct.join(', '))
        setKind('select')
        toast.success(`Loaded ${distinct.length} distinct values`)
      }
    } catch (err) {
      toast.error('Could not load values', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setLoadingValues(false)
    }
  }

  const handleSave = () => {
    if (blocked) return
    onSave({
      id: newId(),
      objectTypeApiName: scope,
      property: property.trim(),
      op,
      kind,
      options: kind === 'select' ? options : [],
      label: label.trim() || null,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add global filter</DialogTitle>
          <DialogDescription className="text-xs">
            Filters drive every widget bound to the scope — maps, tables and stats refresh together.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="af-scope" className="text-xs">Applies to</Label>
              <Select
                value={scope}
                onValueChange={(v) => {
                  setScope(v)
                  setProperty('')
                }}
              >
                <SelectTrigger id="af-scope" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STAR}>Any object type</SelectItem>
                  {objectTypes.map((t) => (
                    <SelectItem key={t.apiName} value={t.apiName}>
                      {t.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="af-property" className="text-xs">Property</Label>
              {scopedType ? (
                <Select value={property || undefined} onValueChange={setProperty}>
                  <SelectTrigger id="af-property" className="h-9 text-xs">
                    <SelectValue placeholder="Pick a property…" />
                  </SelectTrigger>
                  <SelectContent>
                    {scopedType.properties.map((p) => (
                      <SelectItem key={p.apiName} value={p.apiName}>
                        {p.displayName || p.apiName}
                        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{p.dataType}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="af-property"
                  value={property}
                  onChange={(e) => setProperty(e.target.value)}
                  placeholder="property apiName"
                  className="h-9 font-mono text-xs"
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="af-op" className="text-xs">Operator</Label>
              <Select value={op} onValueChange={(v) => setOp(v as AppFilterOp)}>
                <SelectTrigger id="af-op" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{o.value}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="af-kind" className="text-xs">Control</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger id="af-kind" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="select">Dropdown</SelectItem>
                  <SelectItem value="text">Text input</SelectItem>
                  <SelectItem value="number">Number input</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {kind === 'select' && (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="af-options" className="text-xs">Options (comma-separated)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  onClick={() => void loadValues()}
                  disabled={loadingValues || !scopedType || !property}
                  title={scopedType ? 'Sample distinct values from the objects API' : 'Needs a concrete object type'}
                >
                  {loadingValues ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
                  Load values
                </Button>
              </div>
              <Input
                id="af-options"
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                placeholder="in_transit, delivered, delayed"
                className="h-9 font-mono text-xs"
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="af-label" className="text-xs">
              Label <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="af-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Shipment status"
              className="h-9 text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={blocked} onClick={handleSave}>
            Add filter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
