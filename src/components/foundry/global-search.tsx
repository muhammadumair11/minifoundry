'use client'

// Global search (⌘K / Ctrl+K) — Task 14-e.
//
// A compact trigger in the top bar + a shadcn/cmkd command palette that
// queries GET /api/search (debounced 250ms, min 2 chars) and groups results
// by resource type. Enter / click navigates to the resource's href. The ⌘K
// listener lives HERE (not in app-shell) so the shell stays untouched.

import { useEffect, useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Boxes,
  Compass,
  GitBranch,
  LayoutDashboard,
  Loader2,
  Network,
  Plug,
  Search,
  SquareCode,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { apiJson } from '@/lib/foundry-api'
import type { SearchResponse, SearchResultItem } from '@/lib/foundry-types'

const GROUP_ORDER: Array<SearchResultItem['type']> = [
  'dataset',
  'pipeline',
  'transform',
  'objectType',
  'object',
  'dashboard',
  'connector',
]

const GROUP_META: Record<SearchResultItem['type'], { label: string; icon: LucideIcon }> = {
  dataset: { label: 'Datasets', icon: Boxes },
  pipeline: { label: 'Pipelines', icon: GitBranch },
  transform: { label: 'Transforms', icon: SquareCode },
  objectType: { label: 'Object types', icon: Network },
  object: { label: 'Objects', icon: Compass },
  dashboard: { label: 'Dashboards', icon: LayoutDashboard },
  connector: { label: 'Connectors', icon: Plug },
}

export function GlobalSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  // Remounts the cmdk tree per dialog session so its internal selection state
  // never goes stale across opens (fresh open always highlights the first hit).
  const [openSeq, setOpenSeq] = useState(0)

  // Search works from ordinary inputs; editors and textareas keep their own shortcuts.
  useHotkeys('ctrl+k,meta+k', (event) => {
    if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) {
      if (!open) return
    }
    event.preventDefault()
    setOpen((value) => !value)
    setOpenSeq((value) => value + 1)
  }, { enableOnFormTags: ['INPUT'] }, [open])

  // 250ms debounce; the query resets when the palette closes (both the program
  //matic run() path and Radix's ESC/backdrop close go through handleOpenChange).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  const handleOpenChange = (v: boolean) => {
    setOpen(v)
    if (v) setOpenSeq((n) => n + 1)
    else setQuery('')
  }

  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ['global-search', debounced],
    queryFn: () => apiJson<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 5_000,
  })

  // Server already ranked + capped results; cmdk filtering would only fight
  // it (matches on descriptions etc.), so items are passed through as-is.
  const groups = useMemo(() => {
    const results = data?.results ?? []
    return GROUP_ORDER.map((type) => ({
      type,
      items: results.filter((r) => r.type === type),
    })).filter((g) => g.items.length > 0)
  }, [data])

  const run = (item: SearchResultItem) => {
    setOpen(false)
    setQuery('')
    router.push(item.href)
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        keyHint="Ctrl / ⌘ K"
        aria-keyshortcuts="Control+K Meta+K"
        className="h-8 w-8 gap-2 px-0 text-muted-foreground md:w-auto md:px-3"
        onClick={() => setOpen(true)}
        aria-label="Search (Ctrl+K / Cmd+K)"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        <span className="hidden md:inline">Search</span>
        <Kbd className="hidden lg:inline-flex">
          Ctrl / ⌘ K
        </Kbd>
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search MiniFoundry</DialogTitle>
          <DialogDescription>
            Find datasets, pipelines, transforms, objects, dashboards and connectors.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
          <Command key={openSeq} shouldFilter={false} className="bg-popover text-popover-foreground">
            <div className="relative">
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder="Search datasets, pipelines, objects…"
                className="h-11"
                spellCheck={false}
              />
              {isFetching && debounced.length >= 2 && (
                <Loader2
                  className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
                  aria-label="Searching"
                />
              )}
            </div>
            <CommandList className="max-h-[min(24rem,60dvh)]">
              {debounced.length < 2 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Type at least 2 characters — results come from datasets, pipelines, transforms,
                  objects, dashboards and connectors.
                </p>
              ) : (
                <>
                  {groups.length === 0 && !isFetching && (
                    <CommandEmpty>No results for “{query.trim()}”</CommandEmpty>
                  )}
                  {groups.map((group, gi) => {
                    const meta = GROUP_META[group.type]
                    const Icon = meta.icon
                    return (
                      <div key={group.type}>
                        {gi > 0 && <CommandSeparator className="bg-border" />}
                        <CommandGroup heading={meta.label}>
                          {group.items.map((item) => (
                            <CommandItem
                              key={`${item.type}-${item.id}`}
                              value={`${item.type}-${item.id}`}
                              onSelect={() => run(item)}
                              className="gap-2.5"
                            >
                              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                              <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                              {item.subtitle && (
                                <span className="hidden min-w-0 max-w-[45%] truncate text-xs text-muted-foreground sm:inline">
                                  {item.subtitle}
                                </span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </div>
                    )
                  })}
                </>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
