import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiSend, toastApiError } from '@/lib/foundry-api'
import type { DatasetSummary, TransformSummary } from '@/lib/foundry-types'
import { workbookTableNames } from '@/lib/workbook-sql'

export function WorkbookInputsDialog({ transform, datasets, onClose }: {
  transform: TransformSummary
  datasets: DatasetSummary[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [inputs, setInputs] = useState(transform.inputs.map((input) => input.datasetId))
  const names = workbookTableNames(inputs.map((id) => datasets.find((ds) => ds.id === id)?.name ?? ''))
  const save = useMutation({
    mutationFn: () => apiSend(`/api/transforms/${transform.id}`, 'PATCH', { inputs }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transform', transform.id] })
      queryClient.invalidateQueries({ queryKey: ['transforms'] })
      queryClient.invalidateQueries({ queryKey: ['transform-input-schema', transform.id] })
      toast.success('Workbook inputs updated')
      onClose()
    },
    onError: (error) => toastApiError(error, 'Could not update inputs'),
  })
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workbook inputs</DialogTitle>
          <DialogDescription>Select datasets in the order your code reads them. Changing inputs preserves your code; update table references if needed.</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {datasets.map((dataset) => {
            const index = inputs.indexOf(dataset.id)
            return (
              <label key={dataset.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                <Checkbox checked={index >= 0} aria-label={`Use ${dataset.name} as input`} onCheckedChange={(checked) => setInputs((previous) => checked === true ? [...previous, dataset.id] : previous.filter((id) => id !== dataset.id))} />
                <span className="min-w-0 flex-1 truncate">{dataset.name}</span>
                {index >= 0 && <code className="text-xs text-muted-foreground">{index + 1}{transform.language === 'sql' ? ` · ${names[index]}` : ''}</code>}
              </label>
            )
          })}
          {inputs.filter((id) => !datasets.some((ds) => ds.id === id)).map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <Checkbox checked aria-label="Remove unavailable input" onCheckedChange={() => setInputs((previous) => previous.filter((value) => value !== id))} />
              Unavailable dataset — uncheck to remove
            </label>
          ))}
          {datasets.length === 0 && <p className="text-sm text-muted-foreground">No datasets available. You can keep a workbook without inputs.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>Save inputs</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
