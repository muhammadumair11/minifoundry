'use client'

// Notification center bell — Task 14-e.
//
// Top-bar bell with an unread badge; popover lists the latest 50 visible
// notifications (broadcast + addressed). Polls every 30s. Clicking a row
// marks it read and deep-links to the resource; "Mark all read" stamps every
// visible row. Type icons are semantic (rose = failure, amber = quality,
// emerald = approvals, teal = pipeline triggers, zinc = system).

import { useState } from 'react'
import { useRouter } from '@/lib/next-navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  BellOff,
  CheckCheck,
  Info,
  ShieldAlert,
  UserCheck,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { apiJson, apiSend } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import { cn } from '@/lib/utils'
import type { NotificationInfo, NotificationListResponse } from '@/lib/foundry-types'

const TYPE_ICON: Record<string, { icon: LucideIcon; className: string }> = {
  run_failed: { icon: XCircle, className: 'text-rose-600 dark:text-rose-400' },
  quality_failed: { icon: ShieldAlert, className: 'text-amber-600 dark:text-amber-400' },
  approval_requested: { icon: UserCheck, className: 'text-emerald-600 dark:text-emerald-400' },
  pipeline_triggered: { icon: Zap, className: 'text-teal-600 dark:text-teal-400' },
  system: { icon: Info, className: 'text-zinc-600 dark:text-zinc-400' },
}

function typeIcon(type: string) {
  return TYPE_ICON[type] ?? TYPE_ICON.system
}

export function NotificationBell() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data } = useQuery<NotificationListResponse>({
    queryKey: ['notifications'],
    queryFn: () => apiJson<NotificationListResponse>('/api/notifications'),
    refetchInterval: 30_000,
  })
  const notifications = data?.notifications ?? []
  const unreadCount = data?.unreadCount ?? 0

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] })

  const markRead = useMutation({
    mutationFn: (id: string) => apiSend<{ id: string }>(`/api/notifications/${id}/read`, 'POST'),
    onSettled: invalidate,
  })

  const markAllRead = useMutation({
    mutationFn: () => apiSend<{ updated: number }>('/api/notifications/read-all', 'POST'),
    onSettled: invalidate,
  })

  const openNotification = (n: NotificationInfo) => {
    if (!n.readAt) markRead.mutate(n.id)
    setOpen(false)
    if (n.href) router.push(n.href)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unreadCount > 0 && (
            <span
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold leading-none text-white dark:bg-rose-500"
              aria-hidden
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[calc(100vw-2rem)] max-w-sm p-0 sm:w-96"
      >
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          <span className="text-[13px] font-medium">Notifications</span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden />
              Mark all read
            </Button>
          )}
        </div>
        <Separator className="bg-border" />
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
            <BellOff className="h-5 w-5" aria-hidden />
            <p className="text-[13px]">You&apos;re all caught up</p>
          </div>
        ) : (
          <ul className="foundry-scroll max-h-96 overflow-y-auto">
            {notifications.map((n) => {
              const { icon: Icon, className } = typeIcon(n.type)
              const unread = !n.readAt
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => openNotification(n)}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/60',
                      unread ? 'bg-accent/50' : 'bg-transparent',
                    )}
                  >
                    <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', className)} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            'truncate text-[13px]',
                            unread ? 'font-medium text-foreground' : 'text-foreground/80',
                          )}
                        >
                          {n.title}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatRelative(n.createdAt)}
                        </span>
                      </span>
                      {n.body && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {n.body}
                        </span>
                      )}
                    </span>
                    {unread && (
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-600 dark:bg-rose-400"
                        aria-label="Unread"
                      />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
