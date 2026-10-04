'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Zap } from 'lucide-react'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
} from '@/lib/foundry-types'
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

interface ActionDialogProps {
  action: ActionDetail
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

/** Initial param values: pk prefilled, first oneOf option selected. */
function initialValues(action: ActionDetail, prefillPk: string | null | undefined): Values {
  const next: Values = {}
  for (const p of action.parameters) {
    next[p.apiName] = p.isPk ? (prefillPk ?? '') : p.oneOf?.length ? p.oneOf[0] : ''
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

function ActionParamForm({
  action,
  prefillPk,
  onClose,
}: {
  action: ActionDetail
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

  // Object pks for isPk datalist suggestions.
  const pkOptionsQuery = useQuery<ObjectsListResponse>({
    queryKey: ['objects', action.objectType.apiName, '', 1, 200],
    queryFn: () =>
      apiJson<ObjectsListResponse>(
        `/api/objects?type=${encodeURIComponent(action.objectType.apiName)}&page=1&pageSize=200`,
      ),
    enabled: !!pkParam,
  })
  const pkOptions = useMemo(
    () => (pkOptionsQuery.data?.rows ?? []).map((r) => r.pk),
    [pkOptionsQuery.data],
  )

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
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSubmit = () => {
    if (!validate() || applyMutation.isPending) return
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
          <span className="font-mono text-[10px] font-normal text-muted-foreground/80">{p.dataType}</span>
        </label>
        {p.oneOf ? (
          <Select value={value || undefined} onValueChange={(v) => setField(p.apiName, v)}>
            <SelectTrigger id={inputId} className="w-full text-sm">
              <SelectValue placeholder={p.required ? 'Select a value' : '— none —'} />
            </SelectTrigger>
            <SelectContent>
              {p.oneOf.map((opt) => (
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
        ) : (
          <>
            <Input
              id={inputId}
              type={p.dataType === 'number' ? 'number' : 'text'}
              step="any"
              value={value}
              onChange={(e) => setField(p.apiName, e.target.value)}
              list={p.isPk ? `pk-options-${action.apiName}` : undefined}
              placeholder={
                p.isPk ? `e.g. ${pkOptions[0] ?? action.objectType.primaryKey}` : undefined
              }
              aria-invalid={!!error}
              className={`${inputClass} ${error ? 'border-rose-500/60' : ''}`}
            />
            {p.isPk && (
              <datalist id={`pk-options-${action.apiName}`}>
                {pkOptions.map((pk) => (
                  <option key={pk} value={pk} />
                ))}
              </datalist>
            )}
          </>
        )}
        {p.mapsTo && (
          <p className="font-mono text-[10px] text-muted-foreground/80">
            writes to column <span className="text-muted-foreground">{p.mapsTo}</span>
            {p.isPk ? ' (object key)' : ''}
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
              disabled={applyMutation.isPending}
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
            disabled={applyMutation.isPending}
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
