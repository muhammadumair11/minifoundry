'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'
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
  CreateObjectTypeResponse,
  DatasetDetailResponse,
  DatasetsListResponse,
} from '@/lib/foundry-types'
import {
  getObjectColorClasses,
  ONTOLOGY_COLOR_CHOICES,
  ONTOLOGY_ICON_CHOICES,
  OntologyIcon,
} from './icon-map'

/** Lowercase kebab-slug for apiName suggestions. */
function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Radix Select forbids empty item values — sentinel for "default to primary key".
const TITLE_DEFAULT = '__pk__'

export function NewObjectTypeDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [apiName, setApiName] = useState('')
  const [apiNameTouched, setApiNameTouched] = useState(false)
  const [datasetId, setDatasetId] = useState('')
  const [primaryKey, setPrimaryKey] = useState('')
  const [titleProperty, setTitleProperty] = useState(TITLE_DEFAULT)
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState<string>('box')
  const [color, setColor] = useState<string>('emerald')

  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: () => apiJson<DatasetsListResponse>('/api/datasets'),
    enabled: open,
  })
  const datasets = useMemo(() => datasetsQuery.data?.datasets ?? [], [datasetsQuery.data])

  // Load the chosen dataset's current schema for pk/title options.
  const detailQuery = useQuery<DatasetDetailResponse>({
    queryKey: ['dataset', datasetId],
    queryFn: () => apiJson<DatasetDetailResponse>(`/api/datasets/${datasetId}`),
    enabled: open && datasetId !== '',
  })
  const schemaColumns = detailQuery.data?.current.schema ?? []

  const resetForm = () => {
    setDisplayName('')
    setApiName('')
    setApiNameTouched(false)
    setDatasetId('')
    setPrimaryKey('')
    setTitleProperty(TITLE_DEFAULT)
    setDescription('')
    setIcon('box')
    setColor('emerald')
  }

  const handleDisplayName = (value: string) => {
    setDisplayName(value)
    if (!apiNameTouched) setApiName(slugify(value))
  }

  const createMutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiJson<CreateObjectTypeResponse>('/api/ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (res) => {
      toast.success('Object type created', {
        description: `${res.objectType.displayName} (${res.objectType.properties.length} properties) now lives in the ontology.`,
      })
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      resetForm()
      setOpen(false)
    },
    onError: (err: Error) =>
      toast.error('Could not create object type', { description: err.message }),
  })

  const canSubmit =
    displayName.trim() !== '' &&
    apiName.trim() !== '' &&
    datasetId !== '' &&
    primaryKey !== '' &&
    createMutation.isPending === false

  const handleSubmit = () => {
    if (!canSubmit) return
    createMutation.mutate({
      displayName: displayName.trim(),
      apiName: slugify(apiName.trim()),
      sourceDatasetId: datasetId,
      primaryKey,
      titleProperty: titleProperty === TITLE_DEFAULT ? primaryKey : titleProperty,
      description: description.trim(),
      icon,
      color,
    })
  }

  const previewColor = getObjectColorClasses(color)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetForm()
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          aria-label="New object type"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New object type
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-foreground">New object type</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Map a dataset into a business concept — properties derive from its latest schema.
          </DialogDescription>
        </DialogHeader>

        <div className="foundry-scroll max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="ot-display-name" className="text-xs font-medium text-muted-foreground">
              Display name
            </Label>
            <Input
              id="ot-display-name"
              value={displayName}
              onChange={(e) => handleDisplayName(e.target.value)}
              placeholder="e.g. Purchase Order"
              className="text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ot-api-name" className="text-xs font-medium text-muted-foreground">
              API name <span className="text-muted-foreground/80">(mono slug)</span>
            </Label>
            <Input
              id="ot-api-name"
              value={apiName}
              onChange={(e) => {
                setApiNameTouched(true)
                setApiName(e.target.value)
              }}
              placeholder="purchase-order"
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ot-dataset" className="text-xs font-medium text-muted-foreground">
              Source dataset
            </Label>
            <Select
              value={datasetId || undefined}
              onValueChange={(v) => {
                setDatasetId(v)
                setPrimaryKey('')
                setTitleProperty(TITLE_DEFAULT)
              }}
            >
              <SelectTrigger id="ot-dataset" className="w-full text-sm">
                <SelectValue placeholder="Select a dataset" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {datasets.map((d) => (
                  <SelectItem key={d.id} value={d.id} className="text-sm">
                    {d.name}
                    {d.currentVersion && (
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        {d.currentVersion.rowCount} rows
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {datasets.length === 0 && !datasetsQuery.isLoading && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                No datasets yet — ingest one via Connectors first.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ot-pk" className="text-xs font-medium text-muted-foreground">
                Primary key
              </Label>
              <Select
                value={primaryKey || undefined}
                onValueChange={(v) => {
                  setPrimaryKey(v)
                  setTitleProperty(TITLE_DEFAULT)
                }}
                disabled={datasetId === ''}
              >
                <SelectTrigger id="ot-pk" className="w-full text-sm">
                  <SelectValue placeholder={datasetId === '' ? 'Pick a dataset first' : 'Select column'} />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {schemaColumns.map((c) => (
                    <SelectItem key={c.name} value={c.name} className="font-mono text-sm">
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ot-title" className="text-xs font-medium text-muted-foreground">
                Title property
              </Label>
              <Select value={titleProperty} onValueChange={setTitleProperty} disabled={datasetId === ''}>
                <SelectTrigger id="ot-title" className="w-full text-sm">
                  <SelectValue placeholder={datasetId === '' ? 'Pick a dataset first' : 'Select column'} />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectItem value={TITLE_DEFAULT} className="text-sm">
                    — primary key —
                  </SelectItem>
                  {schemaColumns.map((c) => (
                    <SelectItem key={c.name} value={c.name} className="font-mono text-sm">
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ot-description" className="text-xs font-medium text-muted-foreground">
              Description <span className="text-muted-foreground/80">(optional)</span>
            </Label>
            <Input
              id="ot-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this concept mean?"
              className="text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ot-icon" className="text-xs font-medium text-muted-foreground">
                Icon
              </Label>
              <Select value={icon} onValueChange={setIcon}>
                <SelectTrigger id="ot-icon" className="w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ONTOLOGY_ICON_CHOICES.map((name) => (
                    <SelectItem key={name} value={name} className="text-sm">
                      <span className="flex items-center gap-2">
                        <OntologyIcon name={name} className="h-3.5 w-3.5" />
                        {name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ot-color" className="text-xs font-medium text-muted-foreground">
                Color
              </Label>
              <Select value={color} onValueChange={setColor}>
                <SelectTrigger id="ot-color" className="w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ONTOLOGY_COLOR_CHOICES.map((name) => {
                    const c = getObjectColorClasses(name)
                    return (
                      <SelectItem key={name} value={name} className="text-sm">
                        <span className="flex items-center gap-2">
                          <span className={`h-2.5 w-2.5 rounded-full ${c.dot}`} aria-hidden />
                          {name}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Live preview */}
          <div className="flex items-center gap-2.5 rounded-md border border-border bg-muted/40 p-3">
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-lg border ${previewColor.border} ${previewColor.bg}`}
            >
              <OntologyIcon name={icon} className={`h-5 w-5 ${previewColor.text}`} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {displayName.trim() || 'Preview'}
              </p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {slugify(apiName) || 'api-name'}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Creating…
              </>
            ) : (
              'Create object type'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
