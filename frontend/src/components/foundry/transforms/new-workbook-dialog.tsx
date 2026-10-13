'use client'

import { usePermissions } from '@/lib/use-permissions'

// M4 Code Workbooks — "New workbook" dialog (Task 5-b).
// name, language select, multi-checkbox dataset inputs, auto-suggested
// output dataset name. POST /api/transforms → 201 { transform }.
// The form lives in a child rendered only while the dialog is open, so every
// open starts from a fresh form (no state-reset effects — see 3-c playbook).

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
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
import { apiSend, toastApiError } from '@/lib/foundry-api'
import type {
  DatasetSummary,
  TransformLanguage,
  TransformResponse,
} from '@/lib/foundry-types'
import { cn } from '@/lib/utils'
import { workbookSqlStarter } from '@/lib/workbook-sql'

const LANGUAGES: { value: TransformLanguage; label: string; hint: string }[] = [
  { value: 'sql', label: 'SQL', hint: 'SELECT over real tables named after datasets' },
  { value: 'javascript', label: 'JavaScript', hint: 'function(input) body — return an array of rows' },
  { value: 'python', label: 'Python', hint: 'define transform(input) — return a list of row dicts' },
]

export function NewWorkbookDialog({
  open,
  onOpenChange,
  datasets,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasets: DatasetSummary[]
  onCreated: (id: string) => void
}) {
  const { canEdit } = usePermissions()
  if (!canEdit) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-lg">
        {open && (
          <WorkbookForm datasets={datasets} onOpenChange={onOpenChange} onCreated={onCreated} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function WorkbookForm({
  datasets,
  onOpenChange,
  onCreated,
}: {
  datasets: DatasetSummary[]
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [language, setLanguage] = useState<TransformLanguage>('sql')
  const [inputIds, setInputIds] = useState<string[]>([])
  const [output, setOutput] = useState('')
  // Output name auto-follows `name` until the user edits it by hand.
  const [outputTouched, setOutputTouched] = useState(false)

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string
      language: TransformLanguage
      sourceCode: string
      inputs: string[]
      outputDatasetName: string
    }) => apiSend<TransformResponse>('/api/transforms', 'POST', body),
    onSuccess: (res) => {
      toast.success('Workbook created', { description: res.transform.name })
      queryClient.invalidateQueries({ queryKey: ['transforms'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      onOpenChange(false)
      onCreated(res.transform.id)
    },
    onError: (err) => toastApiError(err, 'Could not create workbook'),
  })

  const toggleInput = (id: string, checked: boolean) =>
    setInputIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)))

  const handleNameChange = (next: string) => {
    setName(next)
    if (!outputTouched) setOutput(next.trim() ? `${next.trim()} Output` : '')
  }

  const submit = () => {
    if (!name.trim() || !output.trim() || createMutation.isPending) return
    createMutation.mutate({
      name: name.trim(),
      language,
      // A runnable stub per language; the user edits it right away.
      sourceCode:
        language === 'sql'
          ? workbookSqlStarter(inputIds.map((id) => datasets.find((ds) => ds.id === id)?.name ?? ''))
          : language === 'python'
            ? `# ${name.trim()} — define transform(input); return a list of row dicts\n# input["rows"] = first input, input["datasets"]["Name"] = any input\ndef transform(input):\n    return input["rows"][:20]`
            : `// ${name.trim()} — runs as function(input){...}\n// input.rows = first input, input.datasets["Name"] = any input\nreturn input.rows.slice(0, 20)`,
      inputs: inputIds,
      outputDatasetName: output.trim(),
    })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base text-foreground">
          <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
          New code workbook
        </DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground">
          A workbook reads input datasets and publishes its output as a new dataset on every
          run.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wb-name" className="text-xs text-muted-foreground">
              Name <span className="text-rose-600 dark:text-rose-400">*</span>
            </Label>
            <Input
              id="wb-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Weekly Spend Report"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wb-language" className="text-xs text-muted-foreground">
              Language
            </Label>
            <Select
              value={language}
              onValueChange={(v) => setLanguage(v as TransformLanguage)}
            >
              <SelectTrigger
                id="wb-language"
                className="h-8 text-sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value} className="text-xs">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="font-mono text-[10px] leading-4 text-muted-foreground/80">
              {LANGUAGES.find((l) => l.value === language)?.hint}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            Input datasets{' '}
            <span className="font-mono text-muted-foreground/80">({inputIds.length} selected)</span>
          </Label>
          <div className="foundry-scroll max-h-44 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/40 p-2">
            {datasets.length === 0 ? (
              <p className="p-2 text-center text-xs text-muted-foreground">
                No datasets in the catalog yet — ingest data first.
              </p>
            ) : (
              datasets.map((ds) => (
                <label
                  key={ds.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-accent',
                    inputIds.includes(ds.id) && 'bg-accent/50',
                  )}
                >
                  <Checkbox
                    checked={inputIds.includes(ds.id)}
                    onCheckedChange={(checked) => toggleInput(ds.id, checked === true)}
                    aria-label={`Use ${ds.name} as input`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {ds.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {(ds.currentVersion?.rowCount ?? 0).toLocaleString()} rows
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wb-output" className="text-xs text-muted-foreground">
            Output dataset name <span className="text-rose-600 dark:text-rose-400">*</span>
          </Label>
          <Input
            id="wb-output"
            value={output}
            onChange={(e) => {
              setOutput(e.target.value)
              setOutputTouched(true)
            }}
            placeholder="Created / updated on every run"
            className="h-8 font-mono text-sm"
          />
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          data-dialog-submit
          size="sm"
          onClick={submit}
          disabled={!name.trim() || !output.trim() || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden />
          )}
          Create workbook
        </Button>
      </DialogFooter>
    </>
  )
}
