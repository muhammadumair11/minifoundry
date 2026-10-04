'use client'

// M0 finish (Task 5-b) — /projects: workspaces that group datasets and
// pipelines. Card click filters the catalog (?project=<id>); rename/delete
// via per-card menu. Backend: /api/projects + /api/projects/[id] (5-a).

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { toast } from 'sonner'
import {
  Database,
  FolderKanban,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Workflow,
} from 'lucide-react'
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
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type {
  CreateProjectResponse,
  FoundryProject,
  FoundryRole,
  ProjectMutationResponse,
  ProjectsListResponse,
  SessionResponse,
} from '@/lib/foundry-types'

const canEditRole = (role: FoundryRole | undefined) => role === 'editor' || role === 'admin'

export default function ProjectsPage() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [renaming, setRenaming] = useState<FoundryProject | null>(null)
  const [deleting, setDeleting] = useState<FoundryProject | null>(null)

  const projectsQuery = useQuery<ProjectsListResponse>({
    queryKey: ['projects'],
    queryFn: () => apiJson<ProjectsListResponse>('/api/projects'),
  })

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = canEditRole(sessionQuery.data?.role)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiSend<{ ok: boolean }>(`/api/projects/${id}`, 'DELETE'),
    onSuccess: (_res, id) => {
      toast.success('Project deleted', {
        description: `${deleting?.name ?? 'Project'} — datasets and pipelines are kept, unassigned.`,
      })
      setDeleting(null)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      // Datasets/pipelines were detached (projectId → null) and stats changed.
      queryClient.invalidateQueries({ queryKey: ['datasets'] })
      queryClient.invalidateQueries({ queryKey: ['pipelines'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      void id
    },
    onError: (err) => toastApiError(err, 'Delete failed'),
  })

  const projects = projectsQuery.data?.projects ?? []

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">Projects</h1>
          {projects.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {projects.length} projects
            </span>
          )}
        </div>
        <GatedButton
          allowed={canEdit}
          reason="requires editor role"
          onClick={() => setCreateOpen(true)}
          className="shrink-0"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New project
        </GatedButton>
      </div>

      {projectsQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/50">
              <FolderKanban className="h-6 w-6 text-muted-foreground" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">No projects yet</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                Create a project to group datasets and pipelines — e.g. “Supply Chain Ops” — then
                assign resources from the catalog and pipeline builder.
              </p>
            </div>
            <GatedButton
              allowed={canEdit}
              reason="requires editor role"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Create your first project
            </GatedButton>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              canEdit={canEdit}
              onRename={() => setRenaming(p)}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </div>
      )}

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          // No detail page for projects — highlight the new card is enough;
          // catalog filter is one click away.
          void id
        }}
      />

      {renaming && (
        <RenameProjectDialog
          project={renaming}
          open={!!renaming}
          onOpenChange={(open) => {
            if (!open) setRenaming(null)
          }}
        />
      )}

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-foreground">
              Delete “{deleting?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              The project label is removed. Its {deleting?.datasetsCount ?? 0} datasets and{' '}
              {deleting?.pipelinesCount ?? 0} pipelines are kept, unassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-600/90 dark:bg-rose-500 dark:hover:bg-rose-500/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Project card ─────────────────────────────────────────────────────

function ProjectCard({
  project,
  canEdit,
  onRename,
  onDelete,
}: {
  project: FoundryProject
  canEdit: boolean
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <Card className="group relative transition-colors hover:border-foreground/25">
      {/* Stretched link: whole card navigates to the filtered catalog */}
      <Link
        href={`/datasets?project=${project.id}`}
        className="absolute inset-0 rounded-lg"
        aria-label={`Open ${project.name} in the data catalog`}
      />
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
              <FolderKanban className="h-4 w-4 text-muted-foreground" aria-hidden />
            </span>
            <h2 className="min-w-0 truncate text-sm font-medium text-foreground">
              {project.name}
            </h2>
          </div>
          <div className="relative z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label={`Actions for ${project.name}`}
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Project actions
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!canEdit}
                  onSelect={onRename}
                  className="gap-2 text-xs"
                >
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  Rename
                  {!canEdit && (
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground/80">
                      editor+
                    </span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canEdit}
                  onSelect={onDelete}
                  className="gap-2 text-xs focus:text-rose-600 dark:focus:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" aria-hidden />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {project.description ? (
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{project.description}</p>
        ) : (
          <p className="text-xs italic text-muted-foreground/80">No description</p>
        )}

        <div className="mt-auto space-y-2">
          <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Database className="h-3 w-3" aria-hidden />
              <span className="text-foreground">{project.datasetsCount}</span> datasets
            </span>
            <span className="flex items-center gap-1">
              <Workflow className="h-3 w-3" aria-hidden />
              <span className="text-foreground">{project.pipelinesCount}</span> pipelines
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-muted-foreground/80">
              created{' '}
              {formatDistanceToNow(parseISO(project.createdAt), { addSuffix: true })}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground transition-colors group-hover:text-foreground">
              view catalog →
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Create dialog ────────────────────────────────────────────────────

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const createMutation = useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      apiSend<CreateProjectResponse>('/api/projects', 'POST', body),
    onSuccess: (res) => {
      toast.success('Project created', { description: res.project.name })
      onOpenChange(false)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      onCreated(res.project.id)
    },
    onError: (err) => toastApiError(err, 'Could not create project'),
  })

  const submit = () => {
    if (!name.trim() || createMutation.isPending) return
    createMutation.mutate({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    })
  }

  // Fresh form each time the dialog opens.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName('')
      setDescription('')
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-foreground">
            <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
            New project
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            A workspace label that groups datasets and pipelines.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="project-name" className="text-xs text-muted-foreground">
              Name <span className="text-rose-600 dark:text-rose-400">*</span>
            </Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="e.g. Supply Chain Ops"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-desc" className="text-xs text-muted-foreground">
              Description
            </Label>
            <Input
              id="project-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What lives in this workspace?"
              className="h-8 text-sm"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={!name.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden />
            )}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Rename dialog ────────────────────────────────────────────────────

function RenameProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: FoundryProject
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')

  const renameMutation = useMutation({
    mutationFn: (body: { name?: string; description?: string }) =>
      apiSend<ProjectMutationResponse>(`/api/projects/${project.id}`, 'PATCH', body),
    onSuccess: (res) => {
      toast.success('Project updated', { description: res.project.name })
      onOpenChange(false)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['datasets'] })
      queryClient.invalidateQueries({ queryKey: ['pipelines'] })
    },
    onError: (err) => toastApiError(err, 'Rename failed'),
  })

  const submit = () => {
    if (renameMutation.isPending) return
    const nextName = name.trim()
    const nextDesc = description.trim()
    if (!nextName) return
    if (nextName === project.name && nextDesc === (project.description ?? '')) {
      onOpenChange(false)
      return
    }
    renameMutation.mutate({
      ...(nextName !== project.name ? { name: nextName } : {}),
      ...(nextDesc !== (project.description ?? '') ? { description: nextDesc } : {}),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base text-foreground">Rename project</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Datasets and pipelines keep their assignment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rename-project-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="rename-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rename-project-desc" className="text-xs text-muted-foreground">
              Description
            </Label>
            <Input
              id="rename-project-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={!name.trim() || renameMutation.isPending}
          >
            {renameMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            )}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
