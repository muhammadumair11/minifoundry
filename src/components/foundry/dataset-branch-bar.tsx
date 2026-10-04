'use client'

// R14 dataset branch control: branch switcher (header), "New branch" dialog
// and a per-branch manage dialog (base→head, merged badge, merge, delete).
// NOTE: transforms & pipelines always write to main — branches only apply to
// manual dataset operations (branch switch + merge in this UI).

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { GitBranch, GitMerge, Loader2, Plus, Settings2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type {
  CreateBranchResponse,
  DatasetBranchInfo,
  DatasetBranchesResponse,
  MergeBranchResponse,
} from '@/lib/foundry-types'
import { cn } from '@/lib/utils'

export default function DatasetBranchBar({
  datasetId,
  branch,
  onBranchChange,
  canEdit,
}: {
  datasetId: string
  /** currently checked-out branch name ('main' or a branch name) */
  branch: string
  onBranchChange: (branch: string) => void
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [mergeTarget, setMergeTarget] = useState<DatasetBranchInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DatasetBranchInfo | null>(null)

  const branchesQuery = useQuery<DatasetBranchesResponse>({
    queryKey: ['dataset-branches', datasetId],
    queryFn: () => apiJson<DatasetBranchesResponse>(`/api/datasets/${datasetId}/branches`),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['dataset-branches', datasetId] })
    queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
    queryClient.invalidateQueries({ queryKey: ['dataset-rows', datasetId] })
  }

  const createMutation = useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      apiSend<CreateBranchResponse>(`/api/datasets/${datasetId}/branches`, 'POST', body),
    onSuccess: (created) => {
      toast.success(`Branch '${created.name}' created`, {
        description: `Based on main v${created.baseVersion}.`,
      })
      setCreateOpen(false)
      setNewName('')
      setNewDescription('')
      invalidate()
      onBranchChange(created.name)
    },
    onError: (err) => toastApiError(err, 'Could not create branch'),
  })

  const mergeMutation = useMutation({
    mutationFn: (branchId: string) =>
      apiSend<MergeBranchResponse>(`/api/datasets/${datasetId}/branches/${branchId}/merge`, 'POST'),
    onSuccess: (res) => {
      toast.success(`Merged into v${res.mergedVersion}`, {
        description: `${res.rowsMerged.toLocaleString()} rows from '${res.branchName}' copied to main.`,
      })
      setMergeTarget(null)
      setManageOpen(false)
      invalidate()
      onBranchChange('main')
    },
    onError: (err) => toastApiError(err, 'Merge failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: (branchId: string) =>
      apiSend(`/api/datasets/${datasetId}/branches/${branchId}`, 'DELETE'),
    onSuccess: (_res, branchId) => {
      const deleted = branchesQuery.data?.branches.find((b) => b.id === branchId)
      toast.success(`Branch '${deleted?.name ?? 'branch'}' deleted`, {
        description: 'Branch versions remain as dataset history.',
      })
      setDeleteTarget(null)
      invalidate()
      if (deleted && branch === deleted.name) onBranchChange('main')
    },
    onError: (err) => toastApiError(err, 'Could not delete branch'),
  })

  const branches = branchesQuery.data?.branches ?? []
  const mainHead = branchesQuery.data?.mainHead ?? 0

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Branch switcher */}
      <Select value={branch} onValueChange={onBranchChange}>
        <SelectTrigger
          aria-label="Switch dataset branch"
          title="Check out a branch — transforms & pipelines always write to main"
          className="h-6 w-auto gap-1 border-border bg-muted px-1.5 py-0 text-[10px] font-normal text-muted-foreground data-[size=default]:h-6"
        >
          <GitBranch className="h-3 w-3 text-muted-foreground" aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="main" className="font-mono text-xs">
            main · v{mainHead}
          </SelectItem>
          {branches.map((b) => (
            <SelectItem key={b.id} value={b.name} className="font-mono text-xs">
              {b.name} · v{b.headVersion}
              {b.mergedAt && <span className="ml-1 text-[10px] text-emerald-600 dark:text-emerald-400">merged</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* New branch (editor+) */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <GatedButton
          allowed={canEdit}
          reason="requires editor role"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-3 w-3" aria-hidden />
          New branch
        </GatedButton>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">New branch</DialogTitle>
            <DialogDescription className="text-xs">
              Branch from main v{mainHead}. Commits made on a branch stay isolated until you merge.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="branch-name" className="text-xs">
                Name
              </Label>
              <Input
                id="branch-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="experiment"
                className="h-8 font-mono text-xs"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="branch-description" className="text-xs">
                Description <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="branch-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Trying a new shaping…"
                className="h-8 text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={!newName.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate({ name: newName.trim(), description: newDescription.trim() || undefined })}
            >
              {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Create branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage branches */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setManageOpen(true)}
        >
          <Settings2 className="h-3 w-3" aria-hidden />
          Manage
        </Button>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Branches</DialogTitle>
            <DialogDescription className="text-xs">
              Merge copies the branch head into a new main version. Transforms & pipelines always write to main.
            </DialogDescription>
          </DialogHeader>
          {branchesQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : branches.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No branches yet — create one to experiment safely.
            </p>
          ) : (
            <ul className="foundry-scroll max-h-72 space-y-2 overflow-y-auto pr-1">
              {branches.map((b) => {
                const mergedNoNewCommits = b.mergedAt !== null && b.headVersion <= (b.mergedInto ?? 0)
                return (
                  <li key={b.id} className="rounded-md border border-border px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-medium text-foreground">{b.name}</span>
                      {b.mergedAt ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 px-1 text-[10px] text-emerald-600 dark:text-emerald-400"
                        >
                          merged → v{b.mergedInto}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-border bg-muted px-1 text-[10px] text-muted-foreground">
                          open
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        v{b.baseVersion} → v{b.headVersion}
                        {b.description ? ` · ${b.description}` : ''}
                      </span>
                      <span className="flex items-center gap-1">
                        <GatedButton
                          allowed={canEdit}
                          reason="requires editor role"
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 px-1.5 text-[10px]"
                          disabled={mergeMutation.isPending}
                          onClick={() => setMergeTarget(b)}
                        >
                          <GitMerge className="h-3 w-3" aria-hidden />
                          {mergedNoNewCommits ? 'Merged' : 'Merge'}
                        </GatedButton>
                        <GatedButton
                          allowed={canEdit}
                          reason="requires editor role"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete branch ${b.name}`}
                          disabled={b.mergedAt !== null}
                          title={b.mergedAt ? 'Merged branches cannot be deleted' : 'Delete unmerged branch'}
                          className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                          onClick={() => setDeleteTarget(b)}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </GatedButton>
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {/* Merge confirm */}
      <AlertDialog open={mergeTarget !== null} onOpenChange={(open) => !open && setMergeTarget(null)}>
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">
              Merge &apos;{mergeTarget?.name}&apos; into main?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              The branch head (v{mergeTarget?.headVersion}) becomes a new main version with the same rows.
              Branch history is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 text-xs"
              disabled={mergeMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (mergeTarget) mergeMutation.mutate(mergeTarget.id)
              }}
            >
              {mergeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <GitMerge className="h-3.5 w-3.5" aria-hidden />}
              Merge into main
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete branch &apos;{deleteTarget?.name}&apos;?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              Only the branch pointer is removed — version {deleteTarget && `v${deleteTarget.headVersion}`} and its
              rows stay as dataset history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn('h-8 bg-rose-600 text-xs text-white hover:bg-rose-600/90 dark:bg-rose-500 dark:hover:bg-rose-500/90')}
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
              }}
            >
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
              Delete branch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
