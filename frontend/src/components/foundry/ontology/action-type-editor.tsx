'use client'

import { usePermissions } from '@/lib/use-permissions'

// R14.6 — ontology action-type editor. Create or edit an action type,
// including the optional "Write-back" section: target dataset + write mode
// (append / upsert by key) + key property. Used from the /ontology page.
//
// UX notes (action-flow rework):
//  - parameter fields carry visible labels and column suggestions come from
//    the EFFECTIVE target dataset (write-back target, else the object type's
//    backing dataset), so mapsTo is never typed blind;
//  - "suggest values" fills allowed values (oneOf) from distinct column values
//    already present in that dataset, so run dialogs get real options;
//  - empty allowed-value lists are omitted on save (an empty array used to be
//    persisted and rendered as a dropdown with zero options).

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Database, KeyRound, Loader2, Plus, Sparkles, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { apiJson, apiSend } from '@/lib/foundry-api'
import type { DatasetDetailResponse, DatasetsListResponse } from '@/lib/foundry-types'

// ─── Local contract shapes (foundry-types.ts is frozen) ─────────────

export interface ActionParamDefLite {
  apiName: string
  displayName?: string
  dataType: 'string' | 'number' | 'boolean'
  required?: boolean
  mapsTo: string
  isPk?: boolean
  oneOf?: string[]
}

export interface OntologyActionFull {
  id: string
  apiName: string
  displayName: string
  description: string | null
  operation: 'create' | 'update' | 'delete'
  enabled: boolean
  objectTypeId: string
  objectType: {
    id: string
    apiName: string
    displayName: string
    primaryKey: string | null
    icon: string | null
    color: string | null
    sourceDatasetId: string | null
  }
  parameters: ActionParamDefLite[]
  writeback: {
    targetDatasetId: string
    targetDatasetName: string | null
    writeMode: 'append' | 'upsert'
    keyProperty: string | null
  } | null
  createdAt?: string
  updatedAt?: string
}

interface ActionCreatedResponse {
  action: OntologyActionFull
}

/** Rows endpoint returns raw row records (masked per role). */
interface DatasetRowsResponse {
  rows: Record<string, unknown>[]
  total: number
}

export interface EditorObjectType {
  id: string
  apiName: string
  displayName: string
  primaryKey?: string | null
  sourceDatasetId?: string | null
}

interface ParamDraft {
  uid: number
  apiName: string
  displayName: string
  dataType: 'string' | 'number' | 'boolean'
  mapsTo: string
  required: boolean
  isPk: boolean
  oneOf: string
}

let uidSeq = 1
function nextUid(): number {
  return uidSeq++
}

function draftFromParam(p: ActionParamDefLite): ParamDraft {
  return {
    uid: nextUid(),
    apiName: p.apiName,
    displayName: p.displayName ?? p.apiName,
    dataType: p.dataType,
    mapsTo: p.mapsTo,
    required: !!p.required,
    isPk: !!p.isPk,
    oneOf: (p.oneOf ?? []).join(', '),
  }
}

function parseOneOf(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

interface ActionTypeEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null → create mode. */
  action: OntologyActionFull | null
  objectTypes: EditorObjectType[]
}

export function ActionTypeEditor({ open, onOpenChange, action, objectTypes }: ActionTypeEditorProps) {
  const { canEdit } = usePermissions()
  if (!canEdit) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Zap className="h-4 w-4 text-muted-foreground" aria-hidden />
            {action ? `Edit action — ${action.displayName}` : 'New action type'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Actions are the write-back layer of the ontology: parameter forms that publish new
            dataset versions when submitted.
          </DialogDescription>
        </DialogHeader>
        <EditorForm action={action} objectTypes={objectTypes} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function EditorForm({
  action,
  objectTypes,
  onClose,
}: {
  action: OntologyActionFull | null
  objectTypes: EditorObjectType[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const isEdit = !!action

  const [displayName, setDisplayName] = useState(action?.displayName ?? '')
  const [apiName, setApiName] = useState(action?.apiName ?? '')
  const [apiTouched, setApiTouched] = useState(isEdit)
  const [description, setDescription] = useState(action?.description ?? '')
  const [objectTypeId, setObjectTypeId] = useState(action?.objectTypeId ?? objectTypes[0]?.id ?? '')
  const [operation, setOperation] = useState<'create' | 'update' | 'delete'>(action?.operation ?? 'create')
  const [enabled, setEnabled] = useState(action?.enabled ?? true)
  const [params, setParams] = useState<ParamDraft[]>(() => {
    const seed: ActionParamDefLite[] =
      action?.parameters ??
      [
        {
          apiName: '',
          displayName: '',
          dataType: 'string',
          mapsTo: '',
          required: true,
          isPk: false,
        },
      ]
    return seed.map(draftFromParam)
  })
  const [wbTarget, setWbTarget] = useState(action?.writeback?.targetDatasetId ?? '')
  const [wbMode, setWbMode] = useState<'append' | 'upsert'>(action?.writeback?.writeMode ?? 'append')
  const [wbKey, setWbKey] = useState(action?.writeback?.keyProperty ?? '')
  const [suggestingUid, setSuggestingUid] = useState<number | null>(null)

  const selectedType = useMemo(
    () => objectTypes.find((t) => t.id === objectTypeId) ?? null,
    [objectTypes, objectTypeId],
  )
  // Effective target of the write: the write-back dataset when configured,
  // otherwise the object type's backing dataset. Columns + value suggestions
  // always describe THIS dataset.
  const effectiveTargetId = wbTarget || selectedType?.sourceDatasetId || ''

  // Datasets catalog for the write-back target select.
  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: () => apiJson<DatasetsListResponse>('/api/datasets'),
  })
  const datasets = useMemo(() => datasetsQuery.data?.datasets ?? [], [datasetsQuery.data])

  // Schema columns of the effective target (mapsTo suggestions + validation).
  const targetSchemaQuery = useQuery<DatasetDetailResponse>({
    queryKey: ['dataset', effectiveTargetId],
    queryFn: () => apiJson<DatasetDetailResponse>(`/api/datasets/${encodeURIComponent(effectiveTargetId)}`),
    enabled: !!effectiveTargetId,
  })
  const targetSchema = targetSchemaQuery.data?.current?.schema
  const targetColumns = useMemo(() => (targetSchema ?? []).map((c) => c.name), [targetSchema])
  const effectiveTargetName =
    datasets.find((d) => d.id === effectiveTargetId)?.name ??
    (effectiveTargetId === selectedType?.sourceDatasetId ? 'backing dataset' : 'target dataset')

  const setParam = (uid: number, patch: Partial<ParamDraft>) => {
    setParams((prev) => prev.map((p) => (p.uid === uid ? { ...p, ...patch } : p)))
  }

  /** Fill a parameter's allowed values from distinct values already in the data. */
  const suggestValues = async (uid: number, column: string) => {
    if (!effectiveTargetId || !column || suggestingUid !== null) return
    setSuggestingUid(uid)
    try {
      const res = await apiJson<DatasetRowsResponse>(
        `/api/datasets/${encodeURIComponent(effectiveTargetId)}/rows?pageSize=200`,
      )
      const seen: string[] = []
      const set = new Set<string>()
      for (const row of res.rows ?? []) {
        const raw = row[column]
        if (raw === null || raw === undefined || raw === '') continue
        const text = typeof raw === 'string' ? raw : String(raw)
        if (set.has(text)) continue
        set.add(text)
        seen.push(text)
        if (seen.length >= 50) break
      }
      if (seen.length === 0) {
        toast.info(`No values found in column '${column}' yet`, {
          description: `Looked at the latest version of ${effectiveTargetName}.`,
        })
      } else {
        setParam(uid, { oneOf: seen.join(', ') })
        toast.success(`Suggested ${seen.length} allowed value${seen.length === 1 ? '' : 's'}`, {
          description: `Distinct values of '${column}' in ${effectiveTargetName} — edit the list before saving.`,
        })
      }
    } catch (err) {
      toast.error('Could not read dataset values', {
        description: err instanceof Error ? err.message : 'Unknown error.',
      })
    } finally {
      setSuggestingUid(null)
    }
  }

  /** Quick-add the object-key parameter pre-filled from the object type's pk. */
  const addKeyParam = () => {
    const pk = selectedType?.primaryKey
    if (!pk) return
    if (params.some((p) => p.isPk)) {
      toast.info('A parameter is already marked as the object key')
      return
    }
    const existing = params.find((p) => p.apiName.trim() === pk || p.mapsTo.trim() === pk)
    if (existing) {
      setParam(existing.uid, { isPk: true, required: true })
      toast.success(`Marked '${existing.apiName || pk}' as the object key`)
      return
    }
    setParams((prev) => [
      ...prev,
      {
        uid: nextUid(),
        apiName: pk,
        displayName: pk,
        dataType: 'string',
        mapsTo: pk,
        required: true,
        isPk: true,
        oneOf: '',
      },
    ])
  }

  const applyMutation = useMutation({
    mutationFn: async () => {
      const parameters = params
        .filter((p) => p.apiName.trim() !== '' || p.mapsTo.trim() !== '')
        .map((p) => {
          const oneOf = parseOneOf(p.oneOf)
          return {
            apiName: p.apiName.trim(),
            displayName: p.displayName.trim() || p.apiName.trim(),
            dataType: p.dataType,
            required: p.required,
            mapsTo: p.mapsTo.trim(),
            ...(p.isPk ? { isPk: true } : {}),
            // Omit empty lists — an empty oneOf must never be persisted.
            ...(oneOf.length > 0 ? { oneOf } : {}),
          }
        })
      const writeback = wbTarget
        ? {
            targetDatasetId: wbTarget,
            writeMode: wbMode,
            keyProperty: wbMode === 'upsert' ? wbKey : null,
          }
        : null
      if (isEdit) {
        return apiSend<ActionCreatedResponse>(`/api/ontology/actions/${encodeURIComponent(action!.id)}`, 'PATCH', {
          displayName: displayName.trim(),
          description: description.trim() || null,
          operation,
          enabled,
          parameters,
          writeback,
        })
      }
      return apiSend<ActionCreatedResponse>('/api/ontology/actions', 'POST', {
        displayName: displayName.trim(),
        apiName: (apiTouched ? apiName.trim() : slugify(displayName)) || undefined,
        description: description.trim() || null,
        objectTypeId,
        operation,
        enabled,
        parameters,
        writeback,
      })
    },
    onSuccess: (res) => {
      toast.success(isEdit ? 'Action updated' : 'Action created', {
        description: res.action?.writeback
          ? `${res.action.displayName} → writes back to ${res.action.writeback.targetDatasetName ?? 'dataset'} (${res.action.writeback.writeMode})`
          : `${res.action?.displayName ?? 'Action'} saved.`,
      })
      void queryClient.invalidateQueries({ queryKey: ['ontology-actions'] })
      void queryClient.invalidateQueries({ queryKey: ['actions'] })
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['action-logs'] })
      onClose()
    },
    onError: (err: Error) => toast.error(isEdit ? 'Could not update action' : 'Could not create action', { description: err.message }),
  })

  const submit = () => {
    if (applyMutation.isPending) return
    if (!displayName.trim()) {
      toast.error('Display name is required')
      return
    }
    const finalApi = isEdit ? action!.apiName : (apiTouched ? apiName.trim() : slugify(displayName))
    if (!isEdit && !finalApi) {
      toast.error('apiName could not be derived — provide one explicitly')
      return
    }
    const filled = params.filter((p) => p.apiName.trim() !== '' || p.mapsTo.trim() !== '')
    if (filled.some((p) => !p.apiName.trim() || !p.mapsTo.trim())) {
      toast.error('Every parameter needs an apiName and a target column (mapsTo)')
      return
    }
    const apiNames = new Set(filled.map((p) => p.apiName.trim()))
    if (apiNames.size !== filled.length) {
      toast.error('Parameter apiNames must be unique')
      return
    }
    if (filled.filter((p) => p.isPk).length > 1) {
      toast.error('At most one parameter can be the object key (isPk)')
      return
    }
    if (!wbTarget && (operation === 'update' || operation === 'delete') && !filled.some((p) => p.isPk)) {
      toast.error(`${operation} actions need one parameter marked isPk (or configure a write-back)`)
      return
    }
    if (wbTarget && wbMode === 'upsert' && !wbKey) {
      toast.error('Upsert write-back needs a key property')
      return
    }
    // Client-side column check against the effective target (the server only
    // validates write-back targets; this catches backing-dataset typos early).
    if (targetColumns.length > 0) {
      const bad = filled.find((p) => !targetColumns.includes(p.mapsTo.trim()))
      if (bad) {
        toast.error(`Parameter '${bad.apiName}' maps to '${bad.mapsTo}' which is not a column of ${effectiveTargetName}`, {
          description: `Columns: ${targetColumns.join(', ')}`,
        })
        return
      }
    }
    applyMutation.mutate()
  }

  const inputCls = 'h-8 text-xs'
  const pkColumn = selectedType?.primaryKey ?? null
  const hasPkParam = params.some((p) => p.isPk)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="foundry-scroll -mx-1 max-h-[60vh] space-y-4 overflow-y-auto px-1 py-1"
    >
      {/* Basics */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="action-display-name" className="text-xs text-muted-foreground">
            Display name
          </Label>
          <Input
            id="action-display-name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value)
              if (!apiTouched) setApiName(slugify(e.target.value))
            }}
            placeholder="e.g. Register Shipment"
            className={inputCls}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="action-api-name" className="text-xs text-muted-foreground">
            apiName <span className="text-muted-foreground/70">(slug)</span>
          </Label>
          <Input
            id="action-api-name"
            value={apiName}
            onChange={(e) => {
              setApiName(e.target.value)
              setApiTouched(true)
            }}
            disabled={isEdit}
            placeholder="auto from display name"
            className={cn(inputCls, 'font-mono')}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Object type</Label>
          <Select value={objectTypeId} onValueChange={setObjectTypeId} disabled={isEdit || objectTypes.length === 0}>
            <SelectTrigger className={cn('w-full', inputCls)}>
              <SelectValue placeholder="Select a type" />
            </SelectTrigger>
            <SelectContent>
              {objectTypes.map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-xs">
                  {t.displayName} <span className="font-mono text-[10px] text-muted-foreground">{t.apiName}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedType && (
            <p className="font-mono text-[10px] text-muted-foreground/80">
              pk {selectedType.primaryKey ?? '—'} · backing dataset{' '}
              {selectedType.sourceDatasetId ? 'linked' : '—'}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Operation</Label>
          <Select value={operation} onValueChange={(v) => setOperation(v as 'create' | 'update' | 'delete')}>
            <SelectTrigger className={cn('w-full', inputCls)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="create" className="text-xs">create</SelectItem>
              <SelectItem value="update" className="text-xs">update</SelectItem>
              <SelectItem value="delete" className="text-xs">delete</SelectItem>
            </SelectContent>
          </Select>
          {(operation === 'update' || operation === 'delete') && !hasPkParam && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400">
              needs a parameter marked “object key”
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="action-description" className="text-xs text-muted-foreground">
          Description <span className="text-muted-foreground/70">(optional)</span>
        </Label>
        <Textarea
          id="action-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="text-xs"
          placeholder="What does this action do?"
        />
      </div>

      <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
        <div>
          <p className="text-xs font-medium text-foreground">Enabled</p>
          <p className="text-[11px] text-muted-foreground">Disabled actions reject submissions.</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Toggle action enabled" />
      </div>

      {/* Parameters */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs font-medium text-foreground">Parameters</Label>
          <div className="flex items-center gap-1.5">
            {pkColumn && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={addKeyParam}
                disabled={hasPkParam}
                title={`Add a parameter pre-filled from the object key column '${pkColumn}'`}
              >
                <KeyRound className="h-3 w-3" aria-hidden />
                Key param
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() =>
                setParams((prev) => [
                  ...prev,
                  { uid: nextUid(), apiName: '', displayName: '', dataType: 'string', mapsTo: '', required: true, isPk: false, oneOf: '' },
                ])
              }
            >
              <Plus className="h-3 w-3" aria-hidden />
              Add parameter
            </Button>
          </div>
        </div>
        {targetColumns.length > 0 && (
          <p className="font-mono text-[10px] text-muted-foreground/80">
            columns of {effectiveTargetName}: {targetColumns.join(', ')}
          </p>
        )}
        {params.map((p, i) => {
          const looksLikePk =
            !p.isPk && !!pkColumn && p.mapsTo.trim() === pkColumn && !hasPkParam
          const unknownColumn =
            targetColumns.length > 0 && p.mapsTo.trim() !== '' && !targetColumns.includes(p.mapsTo.trim())
          return (
            <div key={p.uid} className="space-y-2 rounded-md border border-border p-2">
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-[1fr_1fr_88px_1fr_auto]">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                    apiName
                  </Label>
                  <Input
                    value={p.apiName}
                    onChange={(e) => setParam(p.uid, { apiName: e.target.value, displayName: p.displayName || e.target.value })}
                    placeholder="order_id"
                    aria-label={`Parameter ${i + 1} apiName`}
                    className={cn(inputCls, 'font-mono')}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                    Label
                  </Label>
                  <Input
                    value={p.displayName}
                    onChange={(e) => setParam(p.uid, { displayName: e.target.value })}
                    placeholder="Order Id"
                    aria-label={`Parameter ${i + 1} label`}
                    className={inputCls}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                    Type
                  </Label>
                  <Select value={p.dataType} onValueChange={(v) => setParam(p.uid, { dataType: v as ParamDraft['dataType'] })}>
                    <SelectTrigger className={cn('w-full', inputCls)} aria-label={`Parameter ${i + 1} data type`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="string" className="text-xs">string</SelectItem>
                      <SelectItem value="number" className="text-xs">number</SelectItem>
                      <SelectItem value="boolean" className="text-xs">boolean</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                    Column (mapsTo)
                  </Label>
                  <Input
                    value={p.mapsTo}
                    onChange={(e) => setParam(p.uid, { mapsTo: e.target.value })}
                    placeholder="order_id"
                    aria-label={`Parameter ${i + 1} target column`}
                    list={targetColumns.length > 0 ? 'target-columns' : undefined}
                    className={cn(inputCls, 'font-mono', unknownColumn && 'border-amber-500/60')}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                    onClick={() => setParams((prev) => prev.filter((q) => q.uid !== p.uid))}
                    aria-label={`Remove parameter ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
              {unknownColumn && (
                <p className="text-[10px] text-amber-700 dark:text-amber-400">
                  ‘{p.mapsTo.trim()}’ is not a column of {effectiveTargetName}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Checkbox checked={p.required} onCheckedChange={(v) => setParam(p.uid, { required: v === true })} />
                  required
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Checkbox
                    checked={p.isPk}
                    onCheckedChange={(v) =>
                      setParams((prev) => prev.map((q) => ({ ...q, isPk: q.uid === p.uid ? v === true : false })))
                    }
                  />
                  object key (isPk)
                </label>
                {looksLikePk && (
                  <button
                    type="button"
                    className="text-[11px] text-sky-700 underline underline-offset-2 dark:text-sky-400"
                    onClick={() =>
                      setParams((prev) => prev.map((q) => ({ ...q, isPk: q.uid === p.uid ? true : false })))
                    }
                  >
                    maps to the object key — mark as isPk
                  </button>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                  Allowed values <span className="normal-case text-muted-foreground/70">(comma separated, optional)</span>
                </Label>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={p.oneOf}
                    onChange={(e) => setParam(p.uid, { oneOf: e.target.value })}
                    placeholder="e.g. pending, completed, cancelled — leave empty for free text"
                    aria-label={`Parameter ${i + 1} allowed values`}
                    className={cn(inputCls, 'h-8 flex-1 text-[11px]')}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1 px-2 text-[11px]"
                    disabled={!p.mapsTo.trim() || !effectiveTargetId || suggestingUid !== null}
                    onClick={() => suggestValues(p.uid, p.mapsTo.trim())}
                    title={`Fill with distinct values of '${p.mapsTo || '…'}' from ${effectiveTargetName}`}
                  >
                    {suggestingUid === p.uid ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <Sparkles className="h-3 w-3" aria-hidden />
                    )}
                    Suggest
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground/80">
                  With allowed values the run form shows a dropdown; empty means free text with
                  suggestions from existing rows.
                </p>
              </div>
            </div>
          )
        })}
        {targetColumns.length > 0 && (
          <datalist id="target-columns">
            {targetColumns.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        )}
      </div>

      {/* Write-back section (R14.6) */}
      <div className="space-y-2.5 rounded-md border border-border bg-muted/30 p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Database className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Write-back <span className="font-normal text-muted-foreground">(optional — ontology → data loop)</span>
        </p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Target dataset</Label>
            <Select
              value={wbTarget || 'none'}
              onValueChange={(v) => {
                setWbTarget(v === 'none' ? '' : v)
                setWbKey('')
              }}
            >
              <SelectTrigger className={cn('w-full', inputCls)}>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">
                  None — operate on the backing dataset
                </SelectItem>
                {datasets.map((d) => (
                  <SelectItem key={d.id} value={d.id} className="text-xs">
                    {d.name}
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      v{d.currentVersion?.versionNumber ?? '—'}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {wbTarget && (
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Write mode</Label>
              <Select value={wbMode} onValueChange={(v) => setWbMode(v as 'append' | 'upsert')}>
                <SelectTrigger className={cn('w-full', inputCls)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="append" className="text-xs">Append row</SelectItem>
                  <SelectItem value="upsert" className="text-xs">Upsert by key</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {wbTarget && wbMode === 'upsert' && (
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Key property</Label>
              <Select value={wbKey || undefined} onValueChange={setWbKey}>
                <SelectTrigger className={cn('w-full', inputCls)}>
                  <SelectValue placeholder="Select a column" />
                </SelectTrigger>
                <SelectContent>
                  {targetColumns.map((c) => (
                    <SelectItem key={c} value={c} className="font-mono text-xs">
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {wbTarget ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Submitting this action writes a row built from the mapped parameters into{' '}
            <span className="font-medium text-foreground">
              {datasets.find((d) => d.id === wbTarget)?.name ?? 'the target dataset'}
            </span>{' '}
            and publishes a new version
            {wbMode === 'upsert' ? (
              <>
                {' '}
                — matched on <span className="font-mono text-foreground">{wbKey || '(key property)'}</span>.
              </>
            ) : (
              ' (append).'
            )}
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Without a target, the action performs its operation on the object type&apos;s backing
            dataset{selectedType?.sourceDatasetId ? ' (columns and suggestions above come from it)' : ''}.
          </p>
        )}
      </div>

      <DialogFooter className="gap-2 border-t border-border pt-3">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={applyMutation.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90">
          {applyMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Zap className="h-4 w-4" aria-hidden />
          )}
          {isEdit ? 'Save changes' : 'Create action'}
        </Button>
      </DialogFooter>
    </form>
  )
}
