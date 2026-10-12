'use client'

// AppActionWidget + ActiveActionDialog — run Ontology write-back actions from
// inside an app. The dialog host fetches the full ActionDetail lazily and
// reuses the platform's ActionDialog (parameter form, delete confirmation,
// write-back toast, query invalidation). With useSelection, the pk parameter
// is pre-filled from whatever object is currently selected app-wide (map
// marker, table row, detail panel).

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MousePointerClick, TriangleAlert, Zap } from 'lucide-react'
import { ActionDialog } from '@/components/foundry/ontology/action-dialog'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiJson } from '@/lib/foundry-api'
import { getObjectColorClasses, getOperationClasses, OntologyIcon } from '@/components/foundry/ontology/icon-map'
import type { ActionResponse, AppActionWidget as AppActionWidgetConfig, AppObjectRef, OntologyObjectType } from '@/lib/foundry-types'

/** Fetch-on-open action dialog host (same pattern as the object explorer). */
export function ActiveActionDialog({
  actionApiName,
  prefillPk,
  onClose,
}: {
  actionApiName: string
  prefillPk: string | null
  onClose: () => void
}) {
  const actionQuery = useQuery<ActionResponse>({
    queryKey: ['action', actionApiName],
    queryFn: () => apiJson<ActionResponse>(`/api/actions/${encodeURIComponent(actionApiName)}`),
    enabled: actionApiName !== '',
  })

  useEffect(() => {
    if (actionQuery.isError) {
      toast.error('Could not load action', {
        description: actionQuery.error instanceof Error ? actionQuery.error.message : 'Unknown error.',
      })
      onClose()
    }
  }, [actionQuery.isError, actionQuery.error, onClose])

  if (!actionQuery.data) return null

  return (
    <ActionDialog
      action={actionQuery.data.action}
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      prefillPk={prefillPk}
    />
  )
}

interface AppActionWidgetProps {
  widget: AppActionWidgetConfig
  objectTypes: OntologyObjectType[]
  selection: AppObjectRef | null
  canEdit: boolean
}

export function AppActionWidget({ widget, objectTypes, selection, canEdit }: AppActionWidgetProps) {
  const [dialogOpen, setDialogOpen] = useState(false)

  // Resolve the action summary through the ontology (actions hang off types).
  const resolved = objectTypes
    .flatMap((t) => t.actions.map((action) => ({ action, objectType: t })))
    .find(({ action }) => action.apiName === widget.actionApiName)

  if (!resolved || !resolved.action.enabled) {
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center">
        <TriangleAlert className="h-4 w-4 text-amber-500" aria-hidden />
        <p className="px-3 text-[11px] text-muted-foreground">
          Action <span className="font-mono">{widget.actionApiName}</span> is{' '}
          {!resolved ? 'not in the Ontology' : 'disabled'}.
        </p>
      </div>
    )
  }

  const { action, objectType } = resolved
  const color = getObjectColorClasses(objectType.color)
  const operation = getOperationClasses(action.operation)
  const prefillPk =
    widget.useSelection && selection?.objectTypeApiName === objectType.apiName ? selection.pk : null

  return (
    <div className="flex h-24 flex-col items-stretch justify-center gap-2 rounded-md border border-border/60 bg-muted/20 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${color.border} ${color.bg}`}>
          <OntologyIcon name={objectType.icon} className={`h-3.5 w-3.5 ${color.text}`} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{action.displayName}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {action.operation} · {objectType.displayName}
            {widget.useSelection && (
              <span className={prefillPk ? 'text-indigo-600 dark:text-indigo-400' : ''}>
                {' '}· {prefillPk ? `target ${prefillPk}` : 'pick an object first'}
              </span>
            )}
          </p>
        </div>
      </div>
      <GatedButton
        allowed={canEdit}
        reason="requires editor role (current: viewer)"
        size="sm"
        variant="outline"
        className={`h-7 gap-1.5 text-xs ${operation.button}`}
        onClick={() => setDialogOpen(true)}
      >
        {widget.useSelection && !prefillPk ? (
          <MousePointerClick className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Zap className="h-3.5 w-3.5" aria-hidden />
        )}
        Run action
      </GatedButton>
      {dialogOpen && (
        <ActiveActionDialog
          actionApiName={action.apiName}
          prefillPk={prefillPk}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
