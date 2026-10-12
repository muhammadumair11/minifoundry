'use client'

// MiniFoundry governance — role badge visual language (Task 4-c).
// admin emerald · editor amber · viewer zinc · system zinc (no blue/indigo).
// Light-legible: -600 with dark: restore to the original -400.

import { cn } from '@/lib/utils'
import type { AuditActorRole, FoundryRole } from '@/lib/foundry-types'

export interface RoleClasses {
  /** Solid dot color. */
  dot: string
  /** Badge/text color pair (translucent bg + border). */
  badge: string
  /** Text-only color. */
  text: string
}

const ROLE_CLASSES: Record<AuditActorRole, RoleClasses> = {
  admin: {
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    badge:
      'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  editor: {
    dot: 'bg-amber-500 dark:bg-amber-400',
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
  },
  viewer: {
    dot: 'bg-zinc-400 dark:bg-zinc-500',
    badge: 'border-border bg-muted text-muted-foreground',
    text: 'text-muted-foreground',
  },
  system: {
    dot: 'bg-zinc-500 dark:bg-zinc-400',
    badge: 'border-border bg-muted text-muted-foreground',
    text: 'text-muted-foreground',
  },
}

/** Resolve role classes; unknown roles fall back to zinc. */
export function getRoleClasses(role: string | null | undefined): RoleClasses {
  if (role === 'admin' || role === 'editor' || role === 'viewer' || role === 'system') {
    return ROLE_CLASSES[role]
  }
  return ROLE_CLASSES.viewer
}

/** Uppercased short label for a role (used in badges). */
export function roleLabel(role: string | null | undefined): string {
  if (role === 'system') return 'system'
  return role ?? 'viewer'
}

export function RoleBadge({
  role,
  className,
}: {
  role: AuditActorRole | FoundryRole | string | null | undefined
  className?: string
}) {
  const classes = getRoleClasses(role)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0 font-mono text-[10px] leading-4',
        classes.badge,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', classes.dot)} aria-hidden />
      {roleLabel(role)}
    </span>
  )
}
