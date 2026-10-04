'use client'

// Governance console — section (a): role & capabilities matrix (Task 4-c).
// Static teaching data for the viewer < editor < admin model; the current-role
// badge shares the ['session'] cache with the header role switcher.

import { useQuery } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { apiJson } from '@/lib/foundry-api'
import type { FoundryRole, SessionResponse } from '@/lib/foundry-types'
import { getRoleClasses, RoleBadge } from '@/components/foundry/governance/role-badge'

type Capability = 'read' | 'mutate' | 'markings' | 'approve'

const CAPABILITY_COLUMNS: { key: Capability; label: string }[] = [
  { key: 'read', label: 'Read' },
  { key: 'mutate', label: 'Mutate' },
  { key: 'markings', label: 'Markings' },
  { key: 'approve', label: 'Approve' },
]

// viewer = read-only (+ masked values) · editor = + mutations & approval
// requests · admin = + markings CRUD and approval decisions.
const CAPABILITY_MATRIX: Record<FoundryRole, Record<Capability, boolean>> = {
  viewer: { read: true, mutate: false, markings: false, approve: false },
  editor: { read: true, mutate: true, markings: false, approve: false },
  admin: { read: true, mutate: true, markings: true, approve: true },
}

const ROWS: FoundryRole[] = ['viewer', 'editor', 'admin']

function CapabilityCell({ allowed }: { allowed: boolean }) {
  return allowed ? (
    <Check
      className="mx-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400"
      aria-label="allowed"
    />
  ) : (
    <X
      className="mx-auto h-3.5 w-3.5 text-rose-500/70 dark:text-rose-400/70"
      aria-label="not allowed"
    />
  )
}

export function RoleCapabilitiesCard() {
  const { data: session, isLoading } = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const currentRole = session?.role ?? null

  return (
    <Card>
      <CardHeader className="gap-1.5 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-foreground">
            Role &amp; Capabilities
          </CardTitle>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            acting as
            {isLoading ? (
              <Skeleton className="h-4 w-16" />
            ) : (
              <RoleBadge role={currentRole ?? 'admin'} />
            )}
          </div>
        </div>
        <CardDescription className="text-xs leading-relaxed text-muted-foreground">
          Roles are strictly ordered viewer &lt; editor &lt; admin. Markings gate column{' '}
          <span className="font-mono text-foreground">VALUES</span> by minimum role; masked cells show{' '}
          <span className="font-mono italic text-foreground">------</span> to everyone below the
          marking&rsquo;s minRole. Editors can <em>request</em> approvals; only admins decide.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-3">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="h-8 pl-1 pr-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Role
              </TableHead>
              {CAPABILITY_COLUMNS.map((c) => (
                <TableHead
                  key={c.key}
                  className="h-8 px-2 text-center text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map((role) => {
              const isCurrent = role === currentRole
              const classes = getRoleClasses(role)
              return (
                <TableRow
                  key={role}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={cn(
                    'border-border/70',
                    isCurrent && 'bg-muted/60 hover:bg-muted/60',
                  )}
                >
                  <TableCell className="py-1.5 pl-1 pr-2">
                    <span className="flex items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 rounded-full', classes.dot)} aria-hidden />
                      <span
                        className={cn(
                          'text-xs capitalize',
                          isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {role}
                      </span>
                      {isCurrent && (
                        <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 font-mono text-[9px] text-emerald-600 dark:text-emerald-400">
                          you
                        </span>
                      )}
                    </span>
                  </TableCell>
                  {CAPABILITY_COLUMNS.map((c) => (
                    <TableCell key={c.key} className="px-2 py-1.5 text-center">
                      <CapabilityCell allowed={CAPABILITY_MATRIX[role][c.key]} />
                    </TableCell>
                  ))}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <p className="mt-2.5 pl-1 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
          Markings gate column <span className="text-foreground">VALUES</span> by minimum role —
          masked cells show <span className="text-foreground">------</span>. Switch roles from the
          header to see masking live.
        </p>
      </CardContent>
    </Card>
  )
}
