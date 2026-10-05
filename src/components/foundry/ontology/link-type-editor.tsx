'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiJson } from '@/lib/foundry-api'
import type { DatasetDetailResponse, DatasetsListResponse, LinkCardinality, OntologyObjectType, OutgoingLinkSummary } from '@/lib/foundry-types'

export interface EditingLink {
  from: OntologyObjectType
  link: OutgoingLinkSummary
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function LinkTypeEditor({ open, onOpenChange, types, editing }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  types: OntologyObjectType[]
  editing: EditingLink | null
}) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(editing?.link.displayName ?? '')
  const [apiName, setApiName] = useState(editing?.link.apiName ?? '')
  const [apiNameTouched, setApiNameTouched] = useState(!!editing)
  const [fromTypeId, setFromTypeId] = useState(editing?.from.id ?? '')
  const [toTypeId, setToTypeId] = useState(editing?.link.toTypeId ?? '')
  const [cardinality, setCardinality] = useState<LinkCardinality>(editing?.link.cardinality ?? 'one-to-many')
  const [fkProperty, setFkProperty] = useState(editing?.link.fkProperty ?? '')
  const [linkDatasetId, setLinkDatasetId] = useState(editing?.link.linkDatasetId ?? '')
  const [fromKeyColumn, setFromKeyColumn] = useState(editing?.link.fromKeyColumn ?? '')
  const [toKeyColumn, setToKeyColumn] = useState(editing?.link.toKeyColumn ?? '')

  const from = types.find((type) => type.id === fromTypeId)
  const to = types.find((type) => type.id === toTypeId)
  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'], queryFn: () => apiJson('/api/datasets'), enabled: open,
  })
  const datasets = useMemo(() => datasetsQuery.data?.datasets ?? [], [datasetsQuery.data])
  const detailQuery = useQuery<DatasetDetailResponse>({
    queryKey: ['dataset', linkDatasetId],
    queryFn: () => apiJson(`/api/datasets/${linkDatasetId}`),
    enabled: open && cardinality === 'many-to-many' && !!linkDatasetId,
  })
  const columns = detailQuery.data?.current.schema ?? []

  const mutation = useMutation({
    mutationFn: () => apiJson<{ link: { id: string } }>(
      editing ? `/api/ontology/links/${editing.link.id}` : '/api/ontology/links',
      { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim(), apiName: apiName.trim(),
          fromTypeId, toTypeId, cardinality, fkProperty: cardinality === 'one-to-many' ? fkProperty : null,
          linkDatasetId: cardinality === 'many-to-many' ? linkDatasetId : null,
          fromKeyColumn: cardinality === 'many-to-many' ? fromKeyColumn : null,
          toKeyColumn: cardinality === 'many-to-many' ? toKeyColumn : null }) },
    ),
    onSuccess: () => {
      toast.success(editing ? 'Link updated' : 'Link created')
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['object'] })
      onOpenChange(false)
    },
    onError: (error: Error) => toast.error('Could not save link', { description: error.message }),
  })

  const canSave = !!displayName.trim() && /^[a-z][a-z0-9_-]{1,63}$/.test(apiName.trim()) &&
    !!from?.sourceDatasetId && !!from.primaryKey && !!to?.sourceDatasetId && !!to.primaryKey &&
    (cardinality === 'one-to-many' ? !!fkProperty : !!linkDatasetId && !!fromKeyColumn && !!toKeyColumn && fromKeyColumn !== toKeyColumn) &&
    !mutation.isPending

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="bg-card sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{editing ? 'Edit link' : 'New link'}</DialogTitle>
        <DialogDescription>Connect object types through a foreign key or a relationship dataset. Links appear on object details in both directions.</DialogDescription>
      </DialogHeader>
      <div className="foundry-scroll max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="link-name">Display name</Label>
            <Input id="link-name" value={displayName} onChange={(event) => {
              setDisplayName(event.target.value)
              if (!apiNameTouched) setApiName(slugify(event.target.value))
            }} placeholder="Customer orders" /></div>
          <div className="space-y-1.5"><Label htmlFor="link-api">API name</Label>
            <Input id="link-api" className="font-mono" value={apiName} onChange={(event) => {
              setApiNameTouched(true); setApiName(event.target.value)
            }} placeholder="customer-orders" /></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="link-from">From object type</Label>
            <Select value={fromTypeId || undefined} onValueChange={setFromTypeId}>
              <SelectTrigger id="link-from" className="w-full"><SelectValue placeholder="Select source" /></SelectTrigger>
              <SelectContent>{types.map((type) => <SelectItem key={type.id} value={type.id}>{type.displayName}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label htmlFor="link-to">To object type</Label>
            <Select value={toTypeId || undefined} onValueChange={(value) => { setToTypeId(value); setFkProperty('') }}>
              <SelectTrigger id="link-to" className="w-full"><SelectValue placeholder="Select target" /></SelectTrigger>
              <SelectContent>{types.map((type) => <SelectItem key={type.id} value={type.id}>{type.displayName}</SelectItem>)}</SelectContent>
            </Select></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="link-cardinality">Relationship</Label>
          <Select value={cardinality} onValueChange={(value) => setCardinality(value as LinkCardinality)}>
            <SelectTrigger id="link-cardinality" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="one-to-many">One to many · foreign key on target</SelectItem>
              <SelectItem value="many-to-many">Many to many · relationship dataset</SelectItem></SelectContent>
          </Select></div>
        {cardinality === 'one-to-many' ? <div className="space-y-1.5">
          <Label htmlFor="link-fk">Foreign key on {to?.displayName ?? 'target type'}</Label>
          <Select value={fkProperty || undefined} onValueChange={setFkProperty}>
            <SelectTrigger id="link-fk" className="w-full"><SelectValue placeholder="Select column" /></SelectTrigger>
            <SelectContent>{to?.properties.map((property) => <SelectItem key={property.apiName} value={property.apiName}>{property.displayName} · {property.apiName}</SelectItem>)}</SelectContent>
          </Select>
          {from?.primaryKey && <p className="text-xs text-muted-foreground">This column must contain {from.displayName} values from <code>{from.primaryKey}</code>.</p>}
        </div> : <>
          <div className="space-y-1.5"><Label htmlFor="link-dataset">Relationship dataset</Label>
            <Select value={linkDatasetId || undefined} onValueChange={(value) => {
              setLinkDatasetId(value); setFromKeyColumn(''); setToKeyColumn('')
            }}>
              <SelectTrigger id="link-dataset" className="w-full"><SelectValue placeholder="Select dataset" /></SelectTrigger>
              <SelectContent>{datasets.filter((dataset) => dataset.currentVersion).map((dataset) =>
                <SelectItem key={dataset.id} value={dataset.id}>{dataset.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="link-from-column">{from?.displayName ?? 'Source'} key column</Label>
              <Select value={fromKeyColumn || undefined} onValueChange={setFromKeyColumn}>
                <SelectTrigger id="link-from-column" className="w-full"><SelectValue placeholder="Select column" /></SelectTrigger>
                <SelectContent>{columns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1.5"><Label htmlFor="link-to-column">{to?.displayName ?? 'Target'} key column</Label>
              <Select value={toKeyColumn || undefined} onValueChange={setToKeyColumn}>
                <SelectTrigger id="link-to-column" className="w-full"><SelectValue placeholder="Select column" /></SelectTrigger>
                <SelectContent>{columns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}</SelectContent>
              </Select></div>
          </div>
          <p className="text-xs text-muted-foreground">The selected columns must contain the two object types&apos; primary key values.</p>
        </>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={!canSave} onClick={() => mutation.mutate()}>{mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{editing ? 'Save link' : 'Create link'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
