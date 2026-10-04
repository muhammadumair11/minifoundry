'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BookOpen,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Compass,
  Eye,
  FolderKanban,
  GitBranch,
  GitFork,
  Home,
  LayoutDashboard,
  Maximize2,
  Minimize2,
  KeyRound,
  LogIn,
  LogOut,
  Menu,
  Network,
  PencilLine,
  Plug,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareCode,
  Terminal,
  UserCog,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type { ApiStats, FoundryRole, SessionResponse, SessionUserInfo } from '@/lib/foundry-types'
import { RoleBadge } from '@/components/foundry/governance/role-badge'
import { useFocusMode } from '@/components/foundry/focus-mode'
import { GlobalSearch } from '@/components/foundry/global-search' // R14-e ⌘K search
import { NotificationBell } from '@/components/foundry/notification-bell' // R14-e bell
import { SiteFooter } from '@/components/foundry/site-footer'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/* ------------------------------------------------------------------ */
/* Navigation model — grouped like Palantir Foundry's left rail.       */
/* The old single-row header crammed 12 items into one line; the       */
/* sidebar lets every page keep its label at every width and frees     */
/* the top bar for identity controls only.                             */
/* ------------------------------------------------------------------ */

type NavItem = { href: string; label: string; icon: LucideIcon }
type NavGroup = { label: string | null; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { href: '/', label: 'Home', icon: Home },
      { href: '/learn', label: 'Learn', icon: BookOpen },
    ],
  },
  {
    label: 'Data',
    items: [
      { href: '/projects', label: 'Projects', icon: FolderKanban },
      { href: '/connectors', label: 'Connectors', icon: Plug },
      { href: '/datasets', label: 'Datasets', icon: Boxes },
      { href: '/transforms', label: 'Transforms', icon: SquareCode },
    ],
  },
  {
    label: 'Build',
    items: [
      { href: '/pipelines', label: 'Pipelines', icon: GitBranch },
      { href: '/orchestration', label: 'Orchestration', icon: CalendarClock },
      { href: '/dashboards', label: 'Dashboards', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Ontology',
    items: [
      { href: '/ontology', label: 'Ontology', icon: Network },
      { href: '/objects', label: 'Objects', icon: Compass },
      { href: '/lineage', label: 'Lineage', icon: GitFork },
    ],
  },
  {
    label: 'Govern',
    items: [
      { href: '/governance', label: 'Governance', icon: ShieldCheck },
      { href: '/api-tokens', label: 'API tokens', icon: KeyRound },
      { href: '/api-docs', label: 'API docs', icon: Terminal },
    ],
  },
  {
    label: 'Platform',
    items: [{ href: '/settings', label: 'Settings', icon: SettingsIcon }],
  },
]

const FLAT_NAV = NAV_GROUPS.flatMap((g) => g.items)

// Role visual language: admin emerald / editor amber / viewer zinc —
// light-legible shades (600) with the original 400s restored in dark mode.
const ROLE_META: Record<FoundryRole, { label: string; dot: string; text: string; icon: LucideIcon }> = {
  admin: { label: 'Admin', dot: 'bg-emerald-600 dark:bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400', icon: ShieldCheck },
  editor: { label: 'Editor', dot: 'bg-amber-600 dark:bg-amber-400', text: 'text-amber-600 dark:text-amber-400', icon: PencilLine },
  viewer: { label: 'Viewer', dot: 'bg-zinc-500 dark:bg-zinc-400', text: 'text-zinc-500 dark:text-zinc-400', icon: Eye },
}

const ROLES: FoundryRole[] = ['viewer', 'editor', 'admin']

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                          */
/* ------------------------------------------------------------------ */

function LogoMark() {
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-emerald-500 font-mono text-sm font-bold text-zinc-950"
      aria-hidden
    >
      ▚
    </span>
  )
}

function HeaderLogo({ badge = false }: { badge?: boolean }) {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="MiniFoundry home">
      <LogoMark />
      <span className="text-sm font-semibold tracking-tight text-foreground">MiniFoundry</span>
      {badge && (
        <span className="hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-widest text-muted-foreground xl:inline">
          FOUNDRY CLONE
        </span>
      )}
    </Link>
  )
}

/* ------------------------------------------------------------------ */
/* Sidebar nav pieces                                                   */
/* ------------------------------------------------------------------ */

function NavLink({
  item,
  rail,
  onNavigate,
}: {
  item: NavItem
  rail: boolean
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const active = isActive(pathname, item.href)
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={rail ? item.label : undefined}
      className={cn(
        'group relative flex h-8 shrink-0 items-center rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        rail ? 'w-full justify-center px-0' : 'gap-2.5 px-2.5',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {active && !rail && (
        <span
          className="absolute inset-y-[7px] left-0 w-[2.5px] rounded-full bg-foreground/70"
          aria-hidden
        />
      )}
      <item.icon
        className={cn(
          'size-4 shrink-0 transition-colors',
          active
            ? 'text-foreground'
            : 'text-muted-foreground group-hover:text-foreground',
        )}
        aria-hidden
      />
      {!rail && <span className="truncate">{item.label}</span>}
    </Link>
  )

  // Icon-only rail gets a hover tooltip; full sidebar labels speak for themselves.
  if (!rail) return link
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={10}
        className="border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
      >
        {item.label}
      </TooltipContent>
    </Tooltip>
  )
}

function NavLists({ rail, onNavigate }: { rail: boolean; onNavigate?: () => void }) {
  return (
    <>
      {NAV_GROUPS.map((group, gi) => (
        <div
          key={group.label ?? 'general'}
          className={cn(gi > 0 && (rail ? 'mt-2 border-t border-border/60 pt-2' : 'mt-4'))}
        >
          {group.label && !rail && (
            <p className="px-2.5 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
              {group.label}
            </p>
          )}
          <div className={cn('flex flex-col', rail && 'gap-1')}>
            {group.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                rail={rail}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

/** Desktop sidebar — sticky full-height rail with collapsible width. */
function Sidebar({
  collapsed,
  onToggle,
  stats,
}: {
  collapsed: boolean
  onToggle: () => void
  stats: ApiStats | undefined
}) {
  const toggleButton = (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="size-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
    </Button>
  )

  return (
    <aside
      className={cn(
        'sticky top-0 z-30 hidden h-dvh shrink-0 select-none flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-in-out lg:flex',
        collapsed ? 'w-14' : 'w-60',
      )}
    >
      {/* Brand — collapses to the mark alone */}
      <div className={cn('flex h-14 shrink-0 items-center border-b border-border/70', collapsed ? 'justify-center px-2' : 'justify-between pl-3 pr-2')}>
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2"
          aria-label="MiniFoundry home"
          title="MiniFoundry home"
        >
          <LogoMark />
          {!collapsed && (
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">
              MiniFoundry
            </span>
          )}
        </Link>
        {!collapsed && toggleButton}
      </div>

      {/* Grouped nav */}
      <nav
        aria-label="Primary"
        className="foundry-scroll min-h-0 flex-1 overflow-y-auto px-2 py-3"
      >
        <NavLists rail={collapsed} />
      </nav>

      {/* Footer: collapse control + platform stats */}
      <div className="shrink-0 border-t border-border/70 p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 py-1">
            {toggleButton}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default font-mono text-[11px] text-muted-foreground" aria-hidden>
                  ◆
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                sideOffset={10}
                className="border-border bg-popover font-mono text-[11px] text-popover-foreground shadow-md"
              >
                {stats
                  ? `${stats.datasets} dataset${stats.datasets === 1 ? '' : 's'} · ${stats.pipelines} pipeline${stats.pipelines === 1 ? '' : 's'}`
                  : 'loading…'}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
              <span className="text-muted-foreground" aria-hidden>
                ◆
              </span>
              <span className="min-w-0 truncate">
                {stats ? (
                  <>
                    <span className="text-foreground">{stats.datasets}</span> dataset{stats.datasets === 1 ? '' : 's'} ·{' '}
                    <span className="text-foreground">{stats.pipelines}</span> pipeline{stats.pipelines === 1 ? '' : 's'}
                  </>
                ) : (
                  '· · ·'
                )}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between px-0.5">
              <span
                className="font-mono text-[9px] tracking-[0.18em] text-muted-foreground/80"
                aria-label="Foundry clone"
              >
                FOUNDRY CLONE
              </span>
              {toggleButton}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* Mobile drawer                                                        */
/* ------------------------------------------------------------------ */

function MobileNav({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="size-[18px]" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-72 border-border bg-sidebar p-0 sm:max-w-[85vw]"
      >
        <SheetTitle className="sr-only">MiniFoundry navigation</SheetTitle>
        <div className="flex h-14 shrink-0 items-center border-b border-border px-3">
          <HeaderLogo />
          {/* R14-e: bell also in the mobile drawer header for small screens */}
          <div className="ml-auto">
            <NotificationBell />
          </div>
        </div>
        <nav
          aria-label="Primary (mobile)"
          className="foundry-scroll max-h-[calc(100dvh-3.5rem)] overflow-y-auto p-2 pb-8"
        >
          <NavLists rail={false} onNavigate={() => onOpenChange(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ */
/* Identity controls (unchanged behavior, moved from site-header)       */
/* ------------------------------------------------------------------ */

/**
 * Anonymous demo mode — "Sign in" button + the legacy role simulator,
 * relabeled "Demo role" with a subtle DEMO badge (task 7-c).
 */
function DemoAuthControls({ session }: { session: SessionResponse | undefined }) {
  const queryClient = useQueryClient()
  const role = session?.role

  const roleMutation = useMutation({
    mutationFn: (next: FoundryRole) =>
      apiSend<{ role: FoundryRole }>('/api/session/role', 'POST', { role: next }),
    onSuccess: (res) => {
      toast.success(`Now acting as ${res.role}`)
      // Instant feedback, then refetch EVERYTHING so masked data re-renders.
      queryClient.setQueryData<SessionResponse>(['session'], (old) => ({
        role: res.role,
        session: old?.session ?? null,
      }))
      queryClient.invalidateQueries()
    },
    onError: (err) => toastApiError(err, 'Could not switch role'),
  })

  if (!role) {
    return <Skeleton className="h-7 w-[86px] rounded-md" aria-hidden />
  }

  const meta = ROLE_META[role]
  return (
    <>
      <Button
        asChild
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 rounded-md px-2 text-xs font-medium"
      >
        <Link href="/login" aria-label="Sign in">
          <LogIn className="size-3.5 shrink-0" aria-hidden />
          <span className="hidden 2xl:inline">Sign in</span>
        </Link>
      </Button>
      <span
        className="hidden rounded border border-dashed border-border px-1 py-0 font-mono text-[9px] leading-4 text-muted-foreground xl:inline"
        aria-label="Demo mode — simulator role"
      >
        DEMO
      </span>
      <Select
        value={role}
        onValueChange={(next) => {
          if (next !== role) roleMutation.mutate(next as FoundryRole)
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={`Demo role — acting as ${meta.label}, switch`}
          title="Demo role (simulator) — sign in to use a real identity"
          className="h-7 gap-1.5 rounded-md border-border bg-muted/60 px-1.5 text-xs font-medium text-foreground hover:bg-accent data-[size=sm]:h-7"
        >
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden />
          <span className={cn('hidden leading-none md:inline', meta.text)}>{meta.label}</span>
        </SelectTrigger>
        <SelectContent className="min-w-0">
          {ROLES.map((r) => {
            const m = ROLE_META[r]
            const Icon = m.icon
            return (
              <SelectItem
                key={r}
                value={r}
                className="gap-2 text-xs"
              >
                <Icon className={cn('size-3.5', m.text)} aria-hidden />
                {m.label}
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">{r}</span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    </>
  )
}

/**
 * Signed-in identity — avatar menu (task 7-c). Shows the real identity
 * (name/email/role badge), a "Switch role (admin)" impersonation submenu for
 * session admins, and Sign out (full cache invalidation so role-gated data
 * downgrades back to demo level).
 */
function UserMenu({ session }: { session: SessionResponse }) {
  const queryClient = useQueryClient()
  const user: SessionUserInfo | null = session.session ?? null
  // EFFECTIVE role (impersonation-aware); `user.role` stays the TRUE role.
  const effectiveRole = user?.effectiveRole ?? session.role
  const isAdminUser = user?.role === 'admin'
  const impersonating = Boolean(user?.impersonating)

  const logoutMutation = useMutation({
    mutationFn: () => apiSend<{ ok: true }>('/api/auth/logout', 'POST'),
    onSuccess: async () => {
      // Demo-safe default: drop the simulator cookie to viewer so the
      // anonymous session starts least-privileged (the bare no-cookie
      // machine default would be admin). Best effort — ignore failures.
      try {
        await apiSend('/api/session/role', 'POST', { role: 'viewer' })
      } catch {
        /* demo default only — the refetch below settles the UI either way */
      }
      toast.success('Signed out', {
        description: 'Demo mode — acting as viewer. Sign in to use a real identity.',
      })
      queryClient.invalidateQueries()
    },
    onError: (err) => toastApiError(err, 'Could not sign out'),
  })

  // Impersonation is REAL (session-carried): the server re-issues the session
  // token with the effective role, so refetching ['session'] brings the truth
  // back and every role-gated query re-resolves against the new role.
  const switchRoleMutation = useMutation({
    mutationFn: (next: FoundryRole) =>
      apiSend<{ role: FoundryRole }>('/api/session/role', 'POST', { role: next }),
    onSuccess: (res) => {
      toast.success(
        res.role === 'admin' ? 'Restored admin role' : `Acting as ${res.role}`,
        {
          description:
            res.role === 'admin'
              ? 'Full admin permissions are back.'
              : 'API permissions now follow this role until you switch back or sign out.',
        },
      )
      queryClient.invalidateQueries()
    },
    onError: (err) => toastApiError(err, 'Could not switch role'),
  })

  if (!user) return null
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-1 pr-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Account menu — ${user.name} (${effectiveRole}${impersonating ? ', impersonated' : ''})`}
        >
          <span
            className="flex size-6 items-center justify-center rounded-full bg-primary font-mono text-[9px] font-bold text-primary-foreground"
            aria-hidden
          >
            {initials}
          </span>
          <span className="hidden max-w-32 truncate text-xs font-medium text-foreground md:inline">
            {user.name}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-sm font-semibold text-foreground">{user.name}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">{user.email}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <RoleBadge role={effectiveRole} />
            {impersonating && (
              <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">
                impersonated — true role {user.role}
              </span>
            )}
          </span>
        </DropdownMenuLabel>
        {isAdminUser && impersonating && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => switchRoleMutation.mutate(user.role)}
              disabled={switchRoleMutation.isPending}
              className="gap-2 text-xs text-amber-600 focus:text-amber-600 dark:text-amber-400 dark:focus:text-amber-400"
            >
              <Undo2 className="size-3.5" aria-hidden />
              Restore {user.role} role
            </DropdownMenuItem>
          </>
        )}
        {isAdminUser && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2 text-xs">
                <UserCog className="size-3.5 text-muted-foreground" aria-hidden />
                Switch role (admin)
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {ROLES.map((r) => {
                  const m = ROLE_META[r]
                  const Icon = m.icon
                  const current = r === effectiveRole
                  return (
                    <DropdownMenuItem
                      key={r}
                      disabled={current || switchRoleMutation.isPending}
                      onClick={() => switchRoleMutation.mutate(r)}
                      className="gap-2 text-xs"
                    >
                      <Icon className={cn('size-3.5', m.text)} aria-hidden />
                      {m.label}
                      <span className="ml-1 font-mono text-[10px] text-muted-foreground">{r}</span>
                      {current && <Check className="ml-auto size-3.5 text-foreground" aria-hidden />}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending}
          className="gap-2 text-xs focus:text-rose-600 dark:focus:text-rose-400"
        >
          <LogOut className="size-3.5" aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ */
/* AppShell — sidebar + slim top bar + mobile drawer                    */
/* ------------------------------------------------------------------ */

const SIDEBAR_KEY = 'mf.sidebar.collapsed'

/**
 * Rail/expanded preference, persisted in localStorage. Backed by
 * useSyncExternalStore so the client picks up the stored value during
 * hydration (no effect, no flash) and cross-tab updates stay in sync.
 */
function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener('mf:sidebar', onStoreChange)
    window.addEventListener('storage', onStoreChange)
    return () => {
      window.removeEventListener('mf:sidebar', onStoreChange)
      window.removeEventListener('storage', onStoreChange)
    }
  }, [])
  const collapsed = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(SIDEBAR_KEY) === '1',
    () => false, // server snapshot: expanded
  )
  const setCollapsed = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
    } catch {
      /* private mode etc. — preference just won't persist */
    }
    window.dispatchEvent(new Event('mf:sidebar'))
  }, [])
  return [collapsed, setCollapsed]
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [focus, setFocus] = useFocusMode()

  // Esc exits focus mode — but never while the user is typing or a dialog/
  // popover is open (Radix owns Esc there).
  useHotkeys('esc', () => {
    // Let an open Radix surface handle Escape before focus mode does.
    if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]')) return
    setFocus(false)
  }, { enabled: focus }, [focus, setFocus])

  const { data: stats } = useQuery<ApiStats>({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch('/api/stats')
      if (!res.ok) throw new Error('Failed to load stats')
      return res.json()
    },
  })
  // Shared session cache (M9): { role, session: {email,name,role} | null }.
  const { data: session } = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })

  // Rail preference lives in useSidebarCollapsed (localStorage-backed).
  const toggleCollapsed = () => setCollapsed(!collapsed)

  // /login renders a focused, chrome-free shell (logo-only bar, no sidebar)
  // — the auth showpiece keeps the screen clean; the footer still sticks.
  if (pathname === '/login') {
    return (
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <header className="sticky top-0 z-40 h-14 shrink-0 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-full items-center px-3 xl:px-4">
            <HeaderLogo badge />
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        <SiteFooter />
      </div>
    )
  }

  const current = FLAT_NAV.find((item) => isActive(pathname, item.href))
  const signedIn = session?.session ?? null
  const isPipelineBuilder = /^\/pipelines\/[^/]+\/?$/.test(pathname)

  return (
    <div
      className={cn(
        'flex bg-background text-foreground',
        isPipelineBuilder ? 'h-dvh overflow-hidden' : 'min-h-dvh',
      )}
      style={
        {
          // Focus mode removes the chrome around viewport-sized workbenches.
          '--mf-chrome-h': focus ? '0px' : '3.5rem',
          '--mf-footer-h': focus ? '0px' : '42px',
        } as React.CSSProperties
      }
    >
      {!focus && <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} stats={stats} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {focus ? (
          <>
            {/* Focus mode: the chrome is gone. A single floating pill keeps
                orientation (section breadcrumb) + the way back — it takes no
                layout space, so the workbench owns 100% of the viewport. */}
            <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center">
              <div className="pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border bg-card/95 pl-3.5 pr-1.5 shadow-lg backdrop-blur">
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
                  aria-hidden
                >
                  {current?.label ?? 'Focus mode'}
                </span>
                <span className="h-3 w-px bg-border" aria-hidden />
                <button
                  type="button"
                  onClick={() => setFocus(false)}
                  data-key-hint="Esc"
                  aria-keyshortcuts="Escape"
                  aria-label="Exit focus mode (Esc)"
                  title="Exit focus mode (Esc)"
                  className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Slim top bar — identity controls only; navigation lives in the
                sidebar so the bar no longer crams 12 items onto one line */}
            <header className="sticky top-0 z-40 h-14 shrink-0 border-b border-border bg-background/95 backdrop-blur">
              <div className="flex h-full items-center gap-2 px-3 xl:px-4">
                <MobileNav open={mobileOpen} onOpenChange={setMobileOpen} />

                {/* Mobile brand (desktop brand lives in the sidebar) */}
                <Link
                  href="/"
                  className="flex shrink-0 items-center gap-2 lg:hidden"
                  aria-label="MiniFoundry home"
                >
                  <LogoMark />
                  <span className="text-sm font-semibold tracking-tight text-foreground">
                    MiniFoundry
                  </span>
                </Link>

                {/* Desktop breadcrumb of the active section — orientation aid
                    now that the nav is vertical */}
                {current && (
                  <p
                    className="hidden min-w-0 truncate font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground lg:inline"
                    aria-hidden
                  >
                    {current.label}
                  </p>
                )}

                {/* P0-QA: min-w-0 (not shrink-0) so the cluster can compress on
                    375px screens; focus-mode is desktop-only — it alone caused
                    a 21px horizontal overflow on mobile. */}
                <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
                  {/* R14-e: global search (⌘K) + notification bell — additive */}
                  <GlobalSearch />
                  <NotificationBell />
                  <button
                    type="button"
                    onClick={() => setFocus(true)}
                    data-key-hint="Enter"
                    aria-label="Focus mode — hide the sidebar and top bar (Esc exits)"
                    title="Focus mode (Esc exits)"
                    className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex"
                  >
                    <Maximize2 className="h-4 w-4" aria-hidden />
                  </button>
                  {signedIn ? (
                    <UserMenu session={session as SessionResponse} />
                  ) : (
                    <DemoAuthControls session={session} />
                  )}
                </div>
              </div>
            </header>
          </>
        )}

        {/* flex-col lets full-height pages (e.g. /login, builder, transform
            workbench) stretch via flex-1 so the footer sticks to the bottom */}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>

        {!focus && <SiteFooter />}
      </div>
    </div>
  )
}
