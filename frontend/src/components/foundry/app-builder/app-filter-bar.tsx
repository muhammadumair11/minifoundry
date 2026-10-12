'use client'

// AppFilterBar — the app's global filters. Runtime: one control per filter
// definition driving every widget bound to that object type (or '*' when the
// property exists). Edit mode: remove buttons + "Add filter". Text inputs are
// debounced so typing does not fire a query per keystroke.

import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AppFilterDef, OntologyObjectType } from '@/lib/foundry-types'

const ALL = '__all__'

function DebouncedInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  id,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'number'
  id: string
}) {
  const [local, setLocal] = useState(value)
  // Sync from the outside value without an effect (React's "adjust state when
  // props change" render pattern) — e.g. when a filter is cleared externally.
  const [lastSynced, setLastSynced] = useState(value)
  if (value !== lastSynced) {
    setLastSynced(value)
    setLocal(value)
  }
  useEffect(() => {
    if (local === value) return
    const timer = setTimeout(() => onChange(local), 400)
    return () => clearTimeout(timer)
  }, [local])
  return (
    <Input
      id={id}
      type={type}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder={placeholder}
      className="h-7 w-28 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 sm:w-36"
    />
  )
}

interface AppFilterBarProps {
  defs: AppFilterDef[]
  values: Record<string, string>
  onChange: (id: string, value: string) => void
  editing: boolean
  objectTypes: OntologyObjectType[]
  onAddFilter: () => void
  onRemoveFilter: (id: string) => void
}

export function AppFilterBar({
  defs,
  values,
  onChange,
  editing,
  objectTypes,
  onAddFilter,
  onRemoveFilter,
}: AppFilterBarProps) {
  if (defs.length === 0 && !editing) return null

  const typeLabel = (apiName: string) =>
    apiName === '*'
      ? 'any object'
      : objectTypes.find((t) => t.apiName === apiName)?.displayName ?? apiName

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Filters</span>
      {defs.map((def) => {
        const value = values[def.id] ?? ''
        const label = def.label ?? `${typeLabel(def.objectTypeApiName)} · ${def.property}`
        const inputId = `app-filter-${def.id}`
        return (
          <div key={def.id} className="flex items-center gap-1">
            <label htmlFor={inputId} className="sr-only">
              {label}
            </label>
            {def.kind === 'select' ? (
              <Select value={value === '' ? ALL : value} onValueChange={(v) => onChange(def.id, v === ALL ? '' : v)}>
                <SelectTrigger id={inputId} className="h-8 w-auto min-w-32 max-w-52 gap-1 text-xs" title={label}>
                  <span className="truncate text-[10px] text-muted-foreground">{label}:</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  {def.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="flex items-center gap-1.5 rounded-md border border-input bg-background pl-2 pr-0.5 focus-within:ring-1 focus-within:ring-ring">
                <span className="max-w-28 truncate text-[10px] text-muted-foreground" title={label}>
                  {label}:
                </span>
                <DebouncedInput
                  id={inputId}
                  value={value}
                  onChange={(v) => onChange(def.id, v)}
                  type={def.kind === 'number' ? 'number' : 'text'}
                  placeholder={def.kind === 'number' ? 'number…' : 'text…'}
                />
              </span>
            )}
            {editing && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-rose-600"
                onClick={() => onRemoveFilter(def.id)}
                title={`Remove filter "${label}"`}
              >
                <X className="h-3 w-3" aria-hidden />
              </Button>
            )}
          </div>
        )
      })}
      {editing && (
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={onAddFilter}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add filter
        </Button>
      )}
    </div>
  )
}
