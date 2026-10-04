'use client'

// Phase 4 (collaboration) — dataset discussion tab.
// ANY role can read and post (collaboration is the point); the author or an
// admin can delete a comment. Comments may be pinned to a specific version
// ("what produced v4?") — the pin select defaults to the version being viewed.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Loader2, MessageSquare, Pin, Send, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type { SessionResponse } from '@/lib/foundry-types'

export interface DatasetCommentInfo {
  id: string
  datasetId: string
  versionNumber: number | null
  authorKey: string
  authorLabel: string
  authorRole: string
  body: string
  createdAt: string
}

const ROLE_STYLES: Record<string, string> = {
  admin: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  editor: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  viewer: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
  system: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-500',
}

function initialsOf(label: string): string {
  const clean = label.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  if (!clean) return '?'
  const parts = clean.split(' ')
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

interface Props {
  datasetId: string
  /** Version currently selected in the studio (used as default pin). */
  currentVersion: number
  /** All version numbers available for pinning (latest first). */
  versions: number[]
}

export default function DatasetDiscussion({ datasetId, currentVersion, versions }: Props) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  // null = follow the studio's selected version; 'none' = explicitly un-pinned
  // (Radix Select forbids empty-string item values); otherwise a pinned
  // version number string.
  const [pinOverride, setPinOverride] = useState<string | null>(null)
  const pinVersion = pinOverride ?? String(currentVersion)
  const PIN_NONE = 'none'

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 60_000,
  })

  const commentsQuery = useQuery({
    queryKey: ['dataset-comments', datasetId],
    queryFn: () => apiJson<{ comments: DatasetCommentInfo[] }>(`/api/datasets/${datasetId}/comments`),
    refetchInterval: 30_000,
  })

  const myKey = useMemo(() => {
    const s = sessionQuery.data
    const email = s?.session?.email ?? null
    return email ?? `sim:${s?.role ?? 'admin'}`
  }, [sessionQuery.data])
  const myRole = sessionQuery.data?.role ?? 'viewer'

  const postComment = useMutation({
    mutationFn: () =>
      apiSend(`/api/datasets/${datasetId}/comments`, 'POST', {
        body: draft.trim(),
        versionNumber: pinVersion === PIN_NONE ? null : Number(pinVersion),
      }),
    onSuccess: () => {
      setDraft('')
      toast.success('Comment posted')
      void queryClient.invalidateQueries({ queryKey: ['dataset-comments', datasetId] })
    },
    onError: (err) => toastApiError(err, 'Could not post comment'),
  })

  const deleteComment = useMutation({
    mutationFn: (commentId: string) =>
      apiSend(`/api/datasets/${datasetId}/comments?commentId=${commentId}`, 'DELETE'),
    onSuccess: () => {
      toast.success('Comment deleted')
      void queryClient.invalidateQueries({ queryKey: ['dataset-comments', datasetId] })
    },
    onError: (err) => toastApiError(err, 'Could not delete comment'),
  })

  const comments = commentsQuery.data?.comments ?? []
  const canPost = draft.trim().length > 0 && !postComment.isPending

  if (commentsQuery.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading discussion">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Composer */}
      <div className="rounded-lg border bg-card p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Discuss this dataset — ask what produced a version, flag a data quirk, leave review notes…"
          className="min-h-[64px] resize-y border-0 p-0 text-sm shadow-none focus-visible:ring-0"
          maxLength={2000}
          aria-label="Write a comment"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <div className="flex items-center gap-2">
            <Pin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <Select value={pinVersion} onValueChange={setPinOverride}>
              <SelectTrigger aria-label="Attach comment to a version" className="h-7 w-[150px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PIN_NONE} className="text-xs">
                  No specific version
                </SelectItem>
                {versions.map((v) => (
                  <SelectItem key={v} value={String(v)} className="text-xs">
                    on v{v}
                    {v === currentVersion && (
                      <span className="ml-1 text-[10px] text-emerald-600 dark:text-emerald-400">viewing</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn('text-[11px] tabular-nums', draft.length > 1800 ? 'text-amber-600' : 'text-muted-foreground')}>
              {draft.length}/2000
            </span>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={!canPost}
              onClick={() => postComment.mutate()}
            >
              {postComment.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Send className="mr-1 h-3 w-3" aria-hidden />
              )}
              Comment
            </Button>
          </div>
        </div>
      </div>

      {/* Thread */}
      {comments.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <MessageSquare className="h-6 w-6 text-muted-foreground/50" aria-hidden />
          <p className="text-sm font-medium">No comments yet</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Start the discussion — every role can comment. Version-pinned questions are great for review.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Dataset discussion thread">
          {comments.map((c) => {
            const mine = c.authorKey === myKey
            const canDelete = mine || myRole === 'admin'
            return (
              <li key={c.id} className="rounded-lg border bg-card p-3">
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold',
                      ROLE_STYLES[c.authorRole] ?? ROLE_STYLES.system,
                    )}
                  >
                    {initialsOf(c.authorLabel)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-xs font-semibold">{c.authorLabel}</span>
                      <Badge variant="outline" className={cn('px-1 py-0 text-[10px]', ROLE_STYLES[c.authorRole] ?? '')}>
                        {c.authorRole}
                      </Badge>
                      {c.versionNumber != null && (
                        <Badge variant="outline" className="px-1 py-0 font-mono text-[10px] text-muted-foreground">
                          on v{c.versionNumber}
                        </Badge>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {formatDistanceToNow(parseISO(c.createdAt), { addSuffix: true })}
                      </span>
                      {canDelete && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:text-rose-600"
                          disabled={deleteComment.isPending}
                          onClick={() => deleteComment.mutate(c.id)}
                          aria-label={`Delete comment by ${c.authorLabel}`}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed">{c.body}</p>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
