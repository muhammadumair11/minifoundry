'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, ChevronsUpDown, Loader2, Zap } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiJson } from '@/lib/foundry-api'
import type {
  ActionDetail,
  ActionParam,
  ApplyActionResponse,
  ObjectsListResponse,
  ObjectsTypeMeta,
} from '@/lib/foundry-types'
import { cn } from '@/lib/utils'
import { getObjectColorClasses, getOperationClasses, OntologyIcon } from './icon-map'

/** R14.6 additive: write-back info returned by the apply endpoint. */
interface ApplyResponseWithWriteback extends ApplyActionResponse {
  writeback?: {
    datasetId: string
    datasetName: string
    mode: 'append' | 'upsert'
    outcome: 'appended' | 'merged'
  } | null
}

/**
 * Additive fields the ontology serializer already returns for actions
 * (foundry-types.ts stays frozen): write-back config + backing dataset id.
 */
interface ActionDialogDetail extends ActionDetail {
  objectType: ObjectsTypeMeta & { sourceDatasetId?: string | null }
  writeback?: {
    targetDatasetId: string
    targetDatasetName: string | null
    writeMode: 'append' | 'upsert'
    keyProperty: string | null
  } | null
}

interface ActionDialogProps {
  action: ActionDialogDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-fill the isPk parameter (e.g. selected object's pk). */
  prefillPk?: string | null
}

const SUBMIT_LABEL: Record<string, string> = {
  create: 'Create object',
  update: 'Apply update',
  delete: 'Delete object',
}

type Values = Record<string, string>
type Errors = Record<string, string>

/** Non-empty oneOf options only — an empty array must never render a Select. */
function oneOfOptions(p: ActionParam): string[] {
  return (p.oneOf ?? []).map((o) => String(o)).filter((o) => o.trim() !== '')
}

/** Initial param values: only the object key is prefilled (from context). */
function initialValues(action: ActionDialogDetail, prefillPk: string | null | undefined): Values {
  const next: Values = {}
  for (const p of action.parameters) {
    next[p.apiName] = p.isPk ? (prefillPk ?? '') : ''
  }
  return next
}

/**
 * Action write-back dialog. The parameter form is keyed by
 * action|prefillPk|open so every open starts from a fresh form state.
 */
export function ActionDialog({ action, open, onOpenChange, prefillPk }: ActionDialogProps) {
  const color = getObjectColorClasses(action.objectType.color)
  const close = () => onOpenChange(false)
  const writeback = action.writeback ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-md border ${color.border} ${color.bg}`}
            >
              <OntologyIcon name={action.objectType.icon} className={`h-4 w-4 ${color.text}`} />
            </span>
            {action.displayName}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {action.description ??
              'Write-back action — applies onto the backing dataset as a new version.'}
          </DialogDescription>
          <p className="font-mono text-[11px] text-muted-foreground/80">
            {action.operation} · target{' '}
            <span className="text-muted-foreground">{action.objectType.displayName}</span> · pk{' '}
            <span className="text-muted-foreground">{action.objectType.primaryKey}</span>
          </p>
          <p className="font-mono text-[11px] text-muted-foreground/80">
            {writeback ? (
              <>
                write-back {writeback.writeMode} →{' '}
                <span className="text-muted-foreground">
                  {writeback.targetDatasetName ?? 'target dataset'}
                </span>
                {writeback.keyProperty ? (
                  <>
                    {' '}
                    · key <span className="text-muted-foreground">{writeback.keyProperty}</span>
                  </>
                ) : null}
              </>
            ) : (
              <>write-back none — edits the backing dataset as a new version</>
            )}
          </p>
          {!action.enabled && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
              This action is disabled — submissions are rejected until it is enabled again.
            </p>
          )}
        </DialogHeader>

        <ActionParamForm
          key={`${open ? 'open' : 'closed'}|${action.apiName}|${prefillPk ?? ''}`}
          action={action}
          prefillPk={prefillPk ?? null}
          onClose={close}
        />
      </DialogContent>
    </Dialog>
  )
}

// ─── Searchable value picker (object keys + suggested column values) ──

interface ComboOption {
  value: string
  /** Secondary muted text (e.g. object title). */
  muted?: string
}

function ValueCombobox({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  invalid,
}: {
  id: string
  value: string
  onValueChange: (next: string) => void
  options: ComboOption[]
  placeholder: string
  searchPlaceholder: string
  emptyText: string
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const trimmedSearch = search.trim()
  const exactMatch = options.some((o) => o.value === trimmedSearch) || trimmedSearch === value
  const selected = options.find((o) => o.value === value)

  const pick = (next: string) => {
    onValueChange(next)
    setSearch('')
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={!!invalid}
          className={cn(
            'h-9 w-full justify-between font-mono text-sm font-normal',
            !value && 'text-muted-foreground',
            invalid && 'border-rose-500/60',
          )}
        >
          <span className="truncate">
            {value || placeholder}
            {value && selected?.muted ? (
              <span className="ml-2 font-sans text-[11px] text-muted-foreground">
                {selected.muted}
              </span>
            ) : null}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
      >
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
            className="h-8 text-xs"
          />
          <CommandList className="max-h-56">
            <CommandEmpty className="py-3 text-center text-[11px] text-muted-foreground">
              {trimmedSearch && !exactMatch ? (
                <button
                  type="button"
                  className="w-full px-2 py-1 font-mono text-xs text-foreground hover:bg-accent"
                  onClick={() => pick(trimmedSearch)}
                >
                  Use “{trimmedSearch}”
                </button>
              ) : (
                emptyText
              )}
            </CommandEmpty>
            <CommandGroup>
              {trimmedSearch && !exactMatch && (
                <CommandItem
                  value={`__free__ ${trimmedSearch}`}
                  keywords={[trimmedSearch]}
                  onSelect={() => pick(trimmedSearch)}
                  className="font-mono text-xs"
                >
                  Use “{trimmedSearch}” (new value)
                </CommandItem>
              )}
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  keywords={opt.muted ? [opt.value, opt.muted] : [opt.value]}
                  onSelect={() => pick(opt.value)}
                  className="font-mono text-xs"
                >
                  <Check
                    className={cn('mr-2 h-3.5 w-3.5', value === opt.value ? 'opacity-100' : 'opacity-0')}
                    aria-hidden
                  />
                  <span className="truncate">{opt.value}</span>
                  {opt.muted && (
                    <span className="ml-2 truncate font-sans text-[11px] text-muted-foreground">
                      {opt.muted}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ActionParamForm({
  action,
  prefillPk,
  onClose,
}: {
  action: ActionDialogDetail
  prefillPk: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Values>(() => initialValues(action, prefillPk))
  const [errors, setErrors] = useState<Errors>({})
  const [confirmOpen, setConfirmOpen] = useState(false)

  const isDanger = action.operation === 'delete'
  const operation = getOperationClasses(action.operation)
  const pkParam = action.parameters.find((p) => p.isPk)

  // Current object rows: pk suggestions for the key picker AND distinct column
  // values so free-form params (e.g. status) always offer real values.
  const objectRowsQuery = useQuery<ObjectsListResponse>({
    queryKey: ['objects', action.objectType.apiName, '', 1, 200],
    queryFn: () =>
      apiJson<ObjectsListResponse>(
        `/api/objects?type=${encodeURIComponent(action.objectType.apiName)}&page=1&pageSize=200`,
      ),
  })
  const pkOptions = useMemo<ComboOption[]>(
    () => (objectRowsQuery.data?.rows ?? []).map((r) => ({ value: r.pk, muted: r._title })),
    [objectRowsQuery.data],
  )
  const columnValues = useMemo(() => {
    const map = new Map<string, ComboOption[]>()
    for (const row of objectRowsQuery.data?.rows ?? []) {
      for (const [column, raw] of Object.entries(row.values ?? {})) {
        if (raw === null || raw === undefined || raw === '') continue
        const text = typeof raw === 'string' ? raw : String(raw)
        const list = map.get(column)
        if (!list) map.set(column, [{ value: text }])
        else if (!list.some((o) => o.value === text) && list.length < 50) list.push({ value: text })
      }
    }
    return map
  }, [objectRowsQuery.data])

  const applyMutation = useMutation({
    mutationFn: async () => {
      const params: Record<string, string | number> = {}
      for (const p of action.parameters) {
        const raw = (values[p.apiName] ?? '').trim()
        if (raw === '') continue
        params[p.apiName] = p.dataType === 'number' ? Number(raw) : raw
      }
      return apiJson<ApplyResponseWithWriteback>(`/api/actions/${action.apiName}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      })
    },
    onSuccess: (res) => {
      if (res.writeback) {
        toast.success(`Saved → ${res.writeback.datasetName} v${res.versionNumber}`, {
          description: `${action.displayName} · ${res.writeback.mode === 'upsert' ? (res.writeback.outcome === 'merged' ? 'upserted existing row' : 'inserted by upsert') : 'appended row'} · ${res.rowCount.toLocaleString()} rows in target`,
        })
      } else {
        toast.success(`Action applied — new dataset version v${res.versionNumber} published`, {
          description: `${action.displayName} · object ${res.objectPk ?? '—'} · ${res.rowCount.toLocaleString()} rows`,
        })
      }
      void queryClient.invalidateQueries({ queryKey: ['objects'] })
      void queryClient.invalidateQueries({ queryKey: ['object'] })
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['datasets'] })
      void queryClient.invalidateQueries({ queryKey: ['action-logs'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      onClose()
    },
    onError: (err: Error) => toast.error('Action failed', { description: err.message }),
  })

  const setField = (apiName: string, value: string) => {
    setValues((prev) => ({ ...prev, [apiName]: value }))
    setErrors((prev) => {
      if (!prev[apiName]) return prev
      const next = { ...prev }
      delete next[apiName]
      return next
    })
  }

  const validate = (): boolean => {
    const next: Errors = {}
    for (const p of action.parameters) {
      const raw = (values[p.apiName] ?? '').trim()
      if (p.required && raw === '') {
        next[p.apiName] = 'Required'
        continue
      }
      if (raw !== '' && p.dataType === 'number' && Number.isNaN(Number(raw))) {
        next[p.apiName] = 'Must be a number'
      }
      const allowed = oneOfOptions(p)
      if (raw !== '' && allowed.length > 0 && !allowed.includes(raw)) {
        next[p.apiName] = `Must be one of: ${allowed.join(', ')}`
      }
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSubmit = () => {
    if (!validate() || applyMutation.isPending || !action.enabled) return
    if (isDanger) {
      setConfirmOpen(true)
      return
    }
    applyMutation.mutate()
  }

  const renderParam = (p: ActionParam) => {
    const value = values[p.apiName] ?? ''
    const error = errors[p.apiName]
    const inputId = `action-param-${action.apiName}-${p.apiName}`
    const inputClass = 'w-full font-mono text-sm'
    const allowed = oneOfOptions(p)
    const suggested = p.mapsTo ? (columnValues.get(p.mapsTo) ?? []) : []
    return (
      <div key={p.apiName} className="space-y-1.5">
        <label
          htmlFor={inputId}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
        >
          {p.displayName}
          {p.required && (
            <span className="text-rose-600 dark:text-rose-400" aria-hidden>
              *
            </span>
          )}
          <span className="font-mono text-[10px] font-normal text-muted-foreground/80">
            {p.dataType}
          </span>
          {p.isPk && (
            <span className="rounded border border-border bg-muted/60 px-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
              key
            </span>
          )}
        </label>
        {allowed.length > 0 ? (
          <Select value={value || undefined} onValueChange={(v) => setField(p.apiName, v)}>
            <SelectTrigger id={inputId} className="w-full text-sm">
              <SelectValue placeholder={p.required ? 'Select a value' : '— none —'} />
            </SelectTrigger>
            <SelectContent>
              {allowed.map((opt) => (
                <SelectItem key={opt} value={opt} className="font-mono text-sm">
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : p.dataType === 'boolean' ? (
          <Select value={value || undefined} onValueChange={(v) => setField(p.apiName, v)}>
            <SelectTrigger id={inputId} className="w-full text-sm">
              <SelectValue placeholder={p.required ? 'Select true/false' : '— none —'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true" className="font-mono text-sm">
                true
              </SelectItem>
              <SelectItem value="false" className="font-mono text-sm">
                false
              </SelectItem>
            </SelectContent>
          </Select>
        ) : p.isPk ? (
          <ValueCombobox
            id={inputId}
            value={value}
            onValueChange={(v) => setField(p.apiName, v)}
            options={pkOptions}
            placeholder={
              objectRowsQuery.isLoading
                ? 'Loading keys…'
                : `Pick or type ${action.objectType.primaryKey ?? 'a key'}`
            }
            searchPlaceholder="Search keys or titles…"
            emptyText="No objects yet — type a key and choose “Use …”"
            invalid={!!error}
          />
        ) : suggested.length > 0 ? (
          <ValueCombobox
            id={inputId}
            value={value}
            onValueChange={(v) => setField(p.apiName, v)}
            options={suggested}
            placeholder={`Pick or type ${p.mapsTo}`}
            searchPlaceholder={`Search ${p.mapsTo} values…`}
            emptyText="No matching values — type your own and choose “Use …”"
            invalid={!!error}
          />
        ) : (
          <Input
            id={inputId}
            type={p.dataType === 'number' ? 'number' : 'text'}
            step="any"
            value={value}
            onChange={(e) => setField(p.apiName, e.target.value)}
            placeholder={p.mapsTo ? `value for column ${p.mapsTo}` : undefined}
            aria-invalid={!!error}
            className={`${inputClass} ${error ? 'border-rose-500/60' : ''}`}
          />
        )}
        {p.mapsTo && (
          <p className="font-mono text-[10px] text-muted-foreground/80">
            writes to column <span className="text-muted-foreground">{p.mapsTo}</span>
            {p.isPk ? ' (object key)' : ''}
            {!p.isPk && suggested.length > 0 && allowed.length === 0
              ? ` · ${suggested.length} values in use`
              : ''}
          </p>
        )}
        {error && <p className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        handleSubmit()
      }}
      className="space-y-4"
    >
      <div className="foundry-scroll max-h-72 space-y-4 overflow-y-auto pr-1">
        {action.parameters.map(renderParam)}
        {action.parameters.length === 0 && (
          <p className="text-sm text-muted-foreground">This action takes no parameters.</p>
        )}
      </div>

      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
        >
          Cancel
        </Button>
        {isDanger ? (
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <Button
              type="submit"
              size="sm"
              disabled={applyMutation.isPending || !action.enabled}
              className={operation.button}
            >
              {applyMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Zap className="h-4 w-4" aria-hidden />
              )}
              {SUBMIT_LABEL[action.operation] ?? 'Apply'}
            </Button>
            <AlertDialogContent className="bg-card sm:max-w-sm">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-foreground">Confirm delete?</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground">
                  {action.displayName} permanently removes a row from{' '}
                  <span className="font-medium text-foreground">{action.objectType.displayName}</span>{' '}
                  and publishes a new dataset version. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="text-muted-foreground hover:text-foreground">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault()
                    setConfirmOpen(false)
                    applyMutation.mutate()
                  }}
                  disabled={applyMutation.isPending}
                  className="bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400"
                >
                  {applyMutation.isPending ? 'Deleting…' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={applyMutation.isPending || !action.enabled}
            className={operation.button}
          >
            {applyMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Zap className="h-4 w-4" aria-hidden />
            )}
            {SUBMIT_LABEL[action.operation] ?? 'Apply'}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}
