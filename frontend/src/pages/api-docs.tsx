'use client'

// M10 Platform API (Task 6-c) — /api-docs: the API Explorer showpiece.
// Two-pane layout (endpoint list + detail) with a Try-it console: pick or
// paste a token, send a real GET against /api/foundry/v1/*, inspect status,
// rate-limit headers and a syntax-highlighted JSON body. Endpoint reference
// matches the 6-b backend contract exactly (see agent-ctx/6-b).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from '@/components/link'
import { usePermissions } from '@/lib/use-permissions'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BookOpenText,
  Check,
  Copy,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  Send,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiJson } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type { OntologyListResponse } from '@/lib/foundry-types'
import { cn } from '@/lib/utils'
import {
  SAVED_TOKENS_KEY,
  clearSavedTokens,
  loadSavedTokens,
  type SavedApiToken,
} from '@/components/foundry/api/saved-tokens'

// ── Endpoint reference (hardcoded, matches the backend contract) ────

type EndpointGroup = 'Metadata' | 'Datasets' | 'Ontology' | 'Pipelines'

interface EndpointParam {
  name: string
  where: 'path' | 'query'
  type: 'string' | 'integer'
  description: string
  /** Smart prefill source for {placeholder} inputs. */
  suggest?: 'datasetId' | 'pipelineId' | 'objectType' | 'objectPk'
}

interface EndpointDef {
  id: string
  group: EndpointGroup
  pathTemplate: string
  description: string
  /** Governance callout shown under the description where relevant. */
  governance?: string
  params: EndpointParam[]
}

const BASE_PATH = '/api/foundry/v1'
const ORIGIN = 'http://localhost:3000'

const ENDPOINTS: EndpointDef[] = [
  {
    id: 'whoami',
    group: 'Metadata',
    pathTemplate: '/whoami',
    description:
      'Identify the token making the call — name, prefix, usage counters — plus the API version and rate-limit policy.',
    governance: 'Every authenticated response carries X-RateLimit-Limit / Remaining / Reset headers.',
    params: [],
  },
  {
    id: 'datasets',
    group: 'Datasets',
    pathTemplate: '/datasets',
    description:
      'List every dataset in the catalog with tags and its latest version (number, rowCount, createdAt), paginated.',
    params: [
      { name: 'page', where: 'query', type: 'integer', description: '1-based page number (default 1).' },
      {
        name: 'pageSize',
        where: 'query',
        type: 'integer',
        description: 'Rows per page (default 50, clamped 1–200).',
      },
    ],
  },
  {
    id: 'dataset-detail',
    group: 'Datasets',
    pathTemplate: '/datasets/{id}',
    description:
      'One dataset: metadata, retention policy (keepLastN) and the selected version with its schema — columns carry their marking name (markedWith).',
    governance: 'Tokens act as viewer — schema columns carry their marking so consumers can pre-mask.',
    params: [
      { name: 'id', where: 'path', type: 'string', description: 'Dataset id.', suggest: 'datasetId' },
      { name: 'version', where: 'query', type: 'integer', description: 'Version number (latest when omitted).' },
    ],
  },
  {
    id: 'dataset-rows',
    group: 'Datasets',
    pathTemplate: '/datasets/{id}/rows',
    description:
      'Paginated data rows of one dataset version. Masking is applied BEFORE pagination, so totals never leak hidden row counts.',
    governance:
      'Tokens act as viewer — column markings are enforced: marked values return as ------ (mask-before-filter: search too).',
    params: [
      { name: 'id', where: 'path', type: 'string', description: 'Dataset id.', suggest: 'datasetId' },
      { name: 'version', where: 'query', type: 'integer', description: 'Version number (latest when omitted).' },
      { name: 'page', where: 'query', type: 'integer', description: '1-based page number (default 1).' },
      {
        name: 'pageSize',
        where: 'query',
        type: 'integer',
        description: 'Rows per page (default 50, clamped 1–200).',
      },
    ],
  },
  {
    id: 'dataset-export',
    group: 'Datasets',
    pathTemplate: '/datasets/{id}/export',
    description:
      'Download the dataset version as RFC4180 CSV (attachment). Same masking rules as rows — marked columns export as ------.',
    governance:
      'Tokens act as viewer — column markings are enforced in the CSV body. v1 exports are NOT audited (session exports are).',
    params: [
      { name: 'id', where: 'path', type: 'string', description: 'Dataset id.', suggest: 'datasetId' },
      { name: 'version', where: 'query', type: 'integer', description: 'Version number (latest when omitted).' },
    ],
  },
  {
    id: 'ontology',
    group: 'Ontology',
    pathTemplate: '/ontology',
    description:
      'The full ontology: object types with properties, plus every action type flattened with its owning object type.',
    params: [],
  },
  {
    id: 'objects',
    group: 'Ontology',
    pathTemplate: '/objects/{type}',
    description:
      'List objects of one type with pk, property values, title and masked-column metadata. Supports free-text search.',
    governance:
      'Tokens act as viewer — column markings are enforced: marked values return as ------ (mask-before-filter: search too).',
    params: [
      { name: 'type', where: 'path', type: 'string', description: 'Object type apiName, e.g. supplier.', suggest: 'objectType' },
      { name: 'page', where: 'query', type: 'integer', description: '1-based page number (default 1).' },
      {
        name: 'pageSize',
        where: 'query',
        type: 'integer',
        description: 'Rows per page (default 50, clamped 1–200).',
      },
      { name: 'q', where: 'query', type: 'string', description: 'Search across property values (masked columns excluded BEFORE matching).' },
    ],
  },
  {
    id: 'object-detail',
    group: 'Ontology',
    pathTemplate: '/objects/{type}/{pk}',
    description:
      'One object by primary key. The row is located on raw data (so you can address masked values) then masked before it leaves the server.',
    governance: 'Tokens act as viewer — marked property values return as ------ and _masked lists the column names.',
    params: [
      { name: 'type', where: 'path', type: 'string', description: 'Object type apiName, e.g. supplier.', suggest: 'objectType' },
      { name: 'pk', where: 'path', type: 'string', description: 'Primary key value, e.g. SUP-001.', suggest: 'objectPk' },
    ],
  },
  {
    id: 'pipelines',
    group: 'Pipelines',
    pathTemplate: '/pipelines',
    description: 'List pipelines with node counts and the status of their last run, paginated.',
    params: [
      { name: 'page', where: 'query', type: 'integer', description: '1-based page number (default 1).' },
      {
        name: 'pageSize',
        where: 'query',
        type: 'integer',
        description: 'Rows per page (default 50, clamped 1–200).',
      },
    ],
  },
  {
    id: 'pipeline-detail',
    group: 'Pipelines',
    pathTemplate: '/pipelines/{id}',
    description:
      'One pipeline: full graph (nodes + edges) and its 5 latest runs (no logs — logs live in the platform UI).',
    params: [
      { name: 'id', where: 'path', type: 'string', description: 'Pipeline id.', suggest: 'pipelineId' },
    ],
  },
]

const GROUP_ORDER: EndpointGroup[] = ['Metadata', 'Datasets', 'Ontology', 'Pipelines']

const RATE_HEADER_KEYS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
] as const

// ── Small presentational helpers ─────────────────────────────────────

/** Mono path with {placeholders} tinted amber. */
function PathText({ path, className }: { path: string; className?: string }) {
  const parts = path.split(/(\{[^}]+\})/g)
  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.startsWith('{') && part.endsWith('}') ? (
          <span key={i} className="text-amber-600 dark:text-amber-400">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  )
}

/** Tiny GET method badge (emerald = read-only method convention). */
function GetBadge() {
  return (
    <span className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px font-mono text-[9px] font-semibold tracking-wider text-emerald-600 dark:text-emerald-400">
      GET
    </span>
  )
}

/** Hand-rolled JSON syntax highlighter (no deps): keys zinc, strings emerald,
    numbers amber, literals teal. Operates on the pretty-printed text. */
function JsonHighlight({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: React.ReactNode[] = []
    const re = /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)|("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g
    let last = 0
    let m: RegExpExecArray | null
    let k = 0
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(<span key={k++}>{text.slice(last, m.index)}</span>)
      if (m[1] !== undefined) {
        // Property key (followed by colon)
        out.push(
          <span key={k++} className="text-foreground">
            {m[1]}
          </span>,
          <span key={k++}>{m[2]}</span>,
        )
      } else if (m[3] !== undefined) {
        out.push(
          <span key={k++} className="text-emerald-700 dark:text-emerald-300">
            {m[3]}
          </span>,
        )
      } else if (m[4] !== undefined) {
        out.push(
          <span key={k++} className="text-amber-600 dark:text-amber-300">
            {m[4]}
          </span>,
        )
      } else if (m[5] !== undefined) {
        out.push(
          <span key={k++} className="text-teal-700 dark:text-teal-300">
            {m[5]}
          </span>,
        )
      }
      last = re.lastIndex
    }
    if (last < text.length) out.push(<span key={k++}>{text.slice(last)}</span>)
    return out
  }, [text])
  return <pre className="font-mono text-xs leading-5 text-muted-foreground">{nodes}</pre>
}

function CopyChip({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`${label} copied`)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Copy failed')
    }
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted px-2 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground',
        className,
      )}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {value}
    </button>
  )
}

// ── Try-it types ─────────────────────────────────────────────────────

interface TryResult {
  status: number
  statusText: string
  durationMs: number
  sizeBytes: number
  headers: Record<string, string>
  bodyText: string
  isJson: boolean
  requestPath: string
}

// ── Page ─────────────────────────────────────────────────────────────

export default function ApiDocsPage() {
  const { canAdminister } = usePermissions()
  const [selectedId, setSelectedId] = useState<string>('whoami')
  const endpoint = ENDPOINTS.find((e) => e.id === selectedId) ?? ENDPOINTS[0]

  // Param values, keyed per endpoint so switching tabs preserves entries.
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const getParam = useCallback(
    (epId: string, name: string) => paramValues[`${epId}:${name}`] ?? '',
    [paramValues],
  )
  const setParam = useCallback((epId: string, name: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [`${epId}:${name}`]: value }))
  }, [])

  // Token state: saved secrets (localStorage) + free-text secret input.
  const [savedTokens, setSavedTokens] = useState<SavedApiToken[]>([])
  const [tokenInput, setTokenInput] = useState('')
  const [selectedSavedId, setSelectedSavedId] = useState<string>('none')
  const [showToken, setShowToken] = useState(false)

  useEffect(() => {
    setSavedTokens(loadSavedTokens())
  }, [])

  const applySaved = (id: string) => {
    setSelectedSavedId(id)
    if (id === 'none') return
    const found = savedTokens.find((t) => t.id === id)
    if (found) setTokenInput(found.secret)
  }

  const handleClearSaved = () => {
    clearSavedTokens()
    setSavedTokens([])
    setSelectedSavedId('none')
    toast.success('Saved secrets cleared', {
      description: `localStorage key ${SAVED_TOKENS_KEY} is now empty.`,
    })
  }

  const trimmedToken = tokenInput.trim()
  const tokenLooksValid = trimmedToken.startsWith('mf_live_')

  // Which path param is focused → drives smart suggestions.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const focusedParam = endpoint.params.find((p) => `${endpoint.id}:${p.name}` === focusKey) ?? null

  // ── Smart suggestions (TanStack Query, fetched only when focused) ──
  const v1Headers = useMemo(
    () => (trimmedToken ? { Authorization: `Bearer ${trimmedToken}` } : undefined),
    [trimmedToken],
  )

  const datasetSuggestQuery = useQuery({
    queryKey: ['v1-suggest-datasets', trimmedToken.slice(0, 12)],
    queryFn: async () => {
      const res = await fetch(`${BASE_PATH}/datasets?pageSize=1`, { headers: v1Headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { data: { id: string; name: string }[] }
    },
    enabled: focusedParam?.suggest === 'datasetId' && !!trimmedToken,
    staleTime: Infinity,
    retry: false,
  })

  const pipelineSuggestQuery = useQuery({
    queryKey: ['v1-suggest-pipelines', trimmedToken.slice(0, 12)],
    queryFn: async () => {
      const res = await fetch(`${BASE_PATH}/pipelines?pageSize=1`, { headers: v1Headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { data: { id: string; name: string }[] }
    },
    enabled: focusedParam?.suggest === 'pipelineId' && !!trimmedToken,
    staleTime: Infinity,
    retry: false,
  })

  const ontologySuggestQuery = useQuery<OntologyListResponse>({
    queryKey: ['ontology'],
    queryFn: () => apiJson<OntologyListResponse>('/api/ontology'),
    enabled: focusedParam?.suggest === 'objectType',
    staleTime: Infinity,
  })

  const currentType = getParam(endpoint.id, 'type')
  const pkSuggestQuery = useQuery({
    queryKey: ['v1-suggest-objects', currentType, trimmedToken.slice(0, 12)],
    queryFn: async () => {
      const res = await fetch(`${BASE_PATH}/objects/${encodeURIComponent(currentType)}?pageSize=1`, {
        headers: v1Headers,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { data: { pk: unknown }[] }
    },
    enabled: focusedParam?.suggest === 'objectPk' && !!currentType && !!trimmedToken,
    staleTime: Infinity,
    retry: false,
  })

  // Auto-fill a focused, still-empty input once its suggestion arrives.
  const autoFilledRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!focusedParam) return
    const key = `${endpoint.id}:${focusedParam.name}`
    if (getParam(endpoint.id, focusedParam.name)) return
    if (autoFilledRef.current.has(key)) return
    let suggestion: string | null = null
    if (focusedParam.suggest === 'datasetId')
      suggestion = datasetSuggestQuery.data?.data[0]?.id ?? null
    else if (focusedParam.suggest === 'pipelineId')
      suggestion = pipelineSuggestQuery.data?.data[0]?.id ?? null
    else if (focusedParam.suggest === 'objectType')
      suggestion = ontologySuggestQuery.data?.objectTypes[0]?.apiName ?? null
    else if (focusedParam.suggest === 'objectPk') {
      const pk = pkSuggestQuery.data?.data[0]?.pk
      suggestion = pk === null || pk === undefined ? null : String(pk)
    }
    if (suggestion) {
      autoFilledRef.current.add(key)
      setParam(endpoint.id, focusedParam.name, suggestion)
    }
  }, [
    focusedParam,
    endpoint.id,
    getParam,
    setParam,
    datasetSuggestQuery.data,
    pipelineSuggestQuery.data,
    ontologySuggestQuery.data,
    pkSuggestQuery.data,
  ])

  // ── Resolved path + query string ────────────────────────────────────
  const resolvedPath = useMemo(() => {
    let path = endpoint.pathTemplate
    for (const p of endpoint.params) {
      if (p.where === 'path') {
        path = path.replace(`{${p.name}}`, encodeURIComponent(getParam(endpoint.id, p.name)) || `{${p.name}}`)
      }
    }
    const qs = new URLSearchParams()
    for (const p of endpoint.params) {
      if (p.where === 'query') {
        const v = getParam(endpoint.id, p.name).trim()
        if (v) qs.set(p.name, v)
      }
    }
    const query = qs.toString()
    return query ? `${path}?${query}` : path
  }, [endpoint, getParam])

  const curlCommand = `curl -H "Authorization: Bearer $TOKEN" "${ORIGIN}${BASE_PATH}${resolvedPath}"`

  // ── Try-it send ─────────────────────────────────────────────────────
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<TryResult | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)

  const handleSend = async () => {
    if (!trimmedToken || pending) return
    setPending(true)
    const started = performance.now()
    try {
      const res = await fetch(`${BASE_PATH}${resolvedPath}`, {
        headers: { Authorization: `Bearer ${trimmedToken}` },
      })
      const bodyText = await res.text()
      const headers: Record<string, string> = {}
      for (const key of [...RATE_HEADER_KEYS, 'retry-after', 'content-type', 'content-disposition']) {
        const v = res.headers.get(key)
        if (v) headers[key] = v
      }
      setResult({
        status: res.status,
        statusText: res.statusText,
        durationMs: Math.round(performance.now() - started),
        sizeBytes: new TextEncoder().encode(bodyText).length,
        headers,
        bodyText,
        isJson: (res.headers.get('content-type') ?? '').includes('json'),
        requestPath: resolvedPath,
      })
    } catch {
      toast.error('Request failed', {
        description: 'Network error — is the dev server running?',
      })
    } finally {
      setPending(false)
      // Let the panel paint, then scroll it into view on small screens.
      requestAnimationFrame(() =>
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
      )
    }
  }

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curlCommand)
      toast.success('curl command copied', {
        description: 'Paste it in a shell and export TOKEN=mf_live_… first.',
      })
    } catch {
      toast.error('Copy failed')
    }
  }

  // Reset try-result when the endpoint or path changes.
  useEffect(() => {
    setResult(null)
  }, [endpoint.id, resolvedPath])

  const prettyBody = useMemo(() => {
    if (!result) return null
    if (result.isJson) {
      try {
        return JSON.stringify(JSON.parse(result.bodyText), null, 2)
      } catch {
        return null
      }
    }
    return null
  }, [result])

  const statusPill = (status: number) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold',
      status < 300 && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      status === 429 && 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      status >= 400 && status !== 429 && 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
    )

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            <Terminal className="h-5 w-5 text-muted-foreground" aria-hidden />
            API Explorer
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The public read API, live. Pick an endpoint, fill the placeholders, paste a token and
            send real requests — governance markings included.
          </p>
        </div>
        {canAdminister && <Link
          href="/api-tokens"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <KeyRound className="h-3 w-3" aria-hidden />
          manage tokens <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>}
      </div>

      {/* Rate limits strip */}
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/40 px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Rate limits
        </span>
        <span>
          <span className="text-foreground">60</span> requests/min/token
        </span>
        <span aria-hidden className="text-muted-foreground/50">|</span>
        <span>
          beyond → <span className="text-amber-600 dark:text-amber-400">429</span> +{' '}
          <span className="text-foreground">Retry-After</span>
        </span>
        <span aria-hidden className="text-muted-foreground/50">|</span>
        <span>
          headers <span className="text-foreground">X-RateLimit-Limit / Remaining / Reset</span>
        </span>
        <span aria-hidden className="hidden text-muted-foreground/50 sm:inline">|</span>
        <span className="text-emerald-700 dark:text-emerald-300">all endpoints READ-ONLY GET</span>
      </div>

      {/* Two panes */}
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
        {/* ── Left: endpoint list ── */}
        <aside className="w-full shrink-0 lg:w-72 xl:w-80" aria-label="Endpoint list">
          <div className="flex h-full flex-col rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Endpoints
              </h2>
              <div className="flex items-center gap-1.5">
                <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
                  API v1
                </span>
                <CopyChip value={BASE_PATH} label="base path" />
              </div>
            </div>

            <div className="foundry-scroll max-h-[420px] flex-1 overflow-y-auto p-2 lg:max-h-[640px]">
              {GROUP_ORDER.map((group) => (
                <div key={group} className="mb-2">
                  <p className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80">
                    {group}
                  </p>
                  <ul className="space-y-0.5">
                    {ENDPOINTS.filter((e) => e.group === group).map((ep) => {
                      const active = ep.id === selectedId
                      return (
                        <li key={ep.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(ep.id)}
                            aria-current={active ? 'true' : undefined}
                            className={cn(
                              'flex min-h-11 w-full items-center gap-2 rounded-md border-l-2 px-3 py-2 text-left transition-colors lg:min-h-0',
                              active
                                ? 'border-l-foreground bg-accent hover:bg-accent'
                                : 'border-l-transparent hover:bg-accent',
                            )}
                          >
                            <GetBadge />
                            <PathText
                              path={ep.pathTemplate}
                              className={cn(
                                'min-w-0 flex-1 truncate font-mono text-xs',
                                active ? 'text-foreground' : 'text-muted-foreground',
                              )}
                            />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>

            <div className="border-t border-border px-4 py-3">
              <p className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground/80">
                <BookOpenText className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                {canAdminister ? <>Create tokens on <Link href="/api-tokens" className="text-foreground underline-offset-2 hover:underline">/api-tokens</Link> — secrets made there are remembered in this browser (max 10).</> : 'Ask an Organization Owner or Organization Admin for an API token to use the explorer.'}
              </p>
            </div>
          </div>
        </aside>

        {/* ── Right: endpoint detail ── */}
        <div className="min-w-0 flex-1 space-y-4">
          {/* Title row */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <GetBadge />
              <code className="min-w-0 break-all font-mono text-sm font-semibold text-foreground">
                <span className="text-muted-foreground">{BASE_PATH}</span>
                <PathText path={endpoint.pathTemplate} />
              </code>
            </div>
            <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">{endpoint.description}</p>
          </div>

          {/* Governance callout */}
          {endpoint.governance && (
            <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-4 py-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="text-xs leading-5 text-muted-foreground">{endpoint.governance}</p>
            </div>
          )}

          {/* Params */}
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-2.5">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Parameters
              </h3>
            </div>
            {endpoint.params.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground/80">
                No parameters — just send it.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {endpoint.params.map((p) => {
                  const value = getParam(endpoint.id, p.name)
                  const isFocused = focusKey === `${endpoint.id}:${p.name}`
                  return (
                    <li key={p.name} className="grid grid-cols-1 gap-1.5 px-4 py-3 md:grid-cols-[10rem_1fr] md:gap-4">
                      {/* name + type */}
                      <div className="flex items-baseline gap-2 md:flex-col md:gap-1">
                        <code className="font-mono text-xs font-semibold text-foreground">
                          {p.name}
                          {p.where === 'path' && <span className="ml-1 text-amber-600 dark:text-amber-400">*</span>}
                        </code>
                        <span className="font-mono text-[10px] text-muted-foreground/80">
                          {p.where} · {p.type}
                        </span>
                      </div>
                      {/* description + input */}
                      <div className="min-w-0 space-y-1.5">
                        <p className="text-xs leading-4 text-muted-foreground">{p.description}</p>
                        <Input
                          value={value}
                          onChange={(e) => setParam(endpoint.id, p.name, e.target.value)}
                          onFocus={() => setFocusKey(`${endpoint.id}:${p.name}`)}
                          onBlur={() => setFocusKey(null)}
                          placeholder={p.where === 'path' ? `{${p.name}}` : `optional ${p.name}`}
                          aria-label={`Parameter ${p.name} (${p.where})`}
                          inputMode={p.type === 'integer' ? 'numeric' : undefined}
                          className={cn(
                            'h-10 font-mono text-xs sm:h-8',
                            p.where === 'path' && !value && 'border-amber-500/30',
                          )}
                        />
                        {isFocused && p.suggest === 'datasetId' && (
                          <p className="font-mono text-[10px] text-muted-foreground/80">
                            {datasetSuggestQuery.isFetching
                              ? 'fetching first dataset id…'
                              : datasetSuggestQuery.data
                                ? `pre-filled from /datasets → ${datasetSuggestQuery.data.data[0]?.name}`
                                : 'needs a token to suggest an id'}
                          </p>
                        )}
                        {isFocused && p.suggest === 'pipelineId' && (
                          <p className="font-mono text-[10px] text-muted-foreground/80">
                            {pipelineSuggestQuery.isFetching
                              ? 'fetching first pipeline id…'
                              : pipelineSuggestQuery.data
                                ? `pre-filled from /pipelines → ${pipelineSuggestQuery.data.data[0]?.name}`
                                : 'needs a token to suggest an id'}
                          </p>
                        )}
                        {isFocused && p.suggest === 'objectType' && ontologySuggestQuery.data && (
                          <p className="truncate font-mono text-[10px] text-muted-foreground/80">
                            known types:{' '}
                            {ontologySuggestQuery.data.objectTypes.map((t) => t.apiName).join(', ')}
                          </p>
                        )}
                        {isFocused && p.suggest === 'objectPk' && (
                          <p className="font-mono text-[10px] text-muted-foreground/80">
                            {pkSuggestQuery.isFetching
                              ? 'fetching first object…'
                              : pkSuggestQuery.data
                                ? `pre-filled from /objects/${currentType}`
                                : currentType
                                  ? 'needs a token to suggest a pk'
                                  : 'fill {type} first'}
                          </p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Try-it console */}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {/* prompt line */}
            <div className="border-b border-border px-4 py-2.5">
              <p className="truncate font-mono text-xs" aria-label={`Request prompt: GET ${BASE_PATH}${endpoint.pathTemplate}`}>
                <span className="mr-2 text-muted-foreground" aria-hidden>
                  ❯
                </span>
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">GET</span>{' '}
                <span className="text-foreground">
                  {BASE_PATH}
                  <PathText path={resolvedPath} />
                </span>
                <span className="foundry-cursor ml-1 inline-block h-3.5 w-[7px] translate-y-0.5" aria-hidden />
              </p>
            </div>

            <div className="space-y-3 p-4">
              {/* Token row */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select value={selectedSavedId} onValueChange={applySaved}>
                  <SelectTrigger
                    aria-label="Pick a saved token secret"
                    className="h-11 w-full shrink-0 font-mono text-xs sm:h-8 sm:w-[220px]"
                  >
                    <SelectValue placeholder="Saved tokens" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="font-mono text-xs text-muted-foreground">
                      none — paste below
                    </SelectItem>
                    {savedTokens.map((t) => (
                      <SelectItem key={t.id} value={t.id} className="font-mono text-xs">
                        {t.name} · {t.prefix}…
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative min-w-0 flex-1">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    value={tokenInput}
                    onChange={(e) => {
                      setTokenInput(e.target.value)
                      setSelectedSavedId('none')
                    }}
                    placeholder="paste mf_live_… secret"
                    aria-label="API token secret"
                    autoComplete="off"
                    className="h-11 pr-9 font-mono text-xs sm:h-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((s) => !s)}
                    aria-label={showToken ? 'Hide token' : 'Show token'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showToken ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <KeyRound className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearSaved}
                  disabled={savedTokens.length === 0}
                  className="h-11 shrink-0 justify-start text-xs text-muted-foreground hover:bg-accent hover:text-rose-600 dark:hover:text-rose-400 sm:h-8"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Clear saved
                </Button>
              </div>

              {/* Send row */}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={handleSend}
                  disabled={!trimmedToken || pending || resolvedPath.includes('{')}
                  className="h-11 font-mono sm:h-9"
                >
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden />
                  )}
                  Send
                </Button>
                {!trimmedToken && (
                  <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
                    Paste a token secret or pick a saved one
                  </p>
                )}
                {trimmedToken && !tokenLooksValid && (
                  <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
                    Hmm — valid secrets start with mf_live_
                  </p>
                )}
                {resolvedPath.includes('{') && trimmedToken && (
                  <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
                    Fill the highlighted path parameters first
                  </p>
                )}
              </div>

              {/* Response panel */}
              {result && (
                <div ref={resultRef} className="space-y-2 border-t border-border pt-3">
                  {/* status meta */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className={statusPill(result.status)}>
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                      {result.status} {result.statusText}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {result.durationMs} ms · {(result.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                    {result.headers['content-disposition'] && (
                      <span className="max-w-full truncate rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {result.headers['content-disposition']}
                      </span>
                    )}
                  </div>

                  {/* rate-limit headers */}
                  {result.headers['x-ratelimit-limit'] && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 font-mono text-[10px]">
                      <span className="text-muted-foreground">rate-limit:</span>
                      <span className="text-foreground">
                        limit <span className="text-emerald-700 dark:text-emerald-300">{result.headers['x-ratelimit-limit']}</span>
                      </span>
                      <span className="text-foreground">
                        remaining{' '}
                        <span
                          className={cn(
                            Number(result.headers['x-ratelimit-remaining']) <= 5
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-700 dark:text-emerald-300',
                          )}
                        >
                          {result.headers['x-ratelimit-remaining']}
                        </span>
                      </span>
                      <span className="text-foreground">
                        reset{' '}
                        <span className="text-emerald-700 dark:text-emerald-300">
                          {formatRelative(new Date(Number(result.headers['x-ratelimit-reset'])).toISOString())}
                        </span>
                      </span>
                    </div>
                  )}

                  {/* 429 Retry-After */}
                  {result.status === 429 && result.headers['retry-after'] && (
                    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
                      <span className="font-semibold">Retry-After: {result.headers['retry-after']}s</span>{' '}
                      — the token hit its 60 req/min window. Wait, or switch tokens.
                    </div>
                  )}

                  {/* 401 hint */}
                  {result.status === 401 && (
                    <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
                      {canAdminister ? <>The API rejected the credential. Create a fresh token on <Link href="/api-tokens" className="font-semibold underline underline-offset-2">/api-tokens</Link> and paste its secret here.</> : 'The API rejected the credential. Ask an Organization Owner or Organization Admin for a valid token.'}
                    </div>
                  )}

                  {/* body */}
                  <div className="foundry-scroll max-h-[480px] overflow-auto rounded-lg border border-border bg-card p-3">
                    {result.isJson && prettyBody !== null ? (
                      <JsonHighlight text={prettyBody} />
                    ) : (
                      <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-muted-foreground">
                        {result.bodyText || '(empty body)'}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* curl block */}
          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" aria-hidden />
                curl
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyCurl}
                className="h-7 px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden />
                Copy
              </Button>
            </div>
            <div className="foundry-scroll overflow-x-auto p-4">
              <pre className="font-mono text-xs leading-5 text-foreground">
                <span className="text-muted-foreground">$ </span>
                {curlCommand}
              </pre>
              <p className="mt-2 text-[11px] text-muted-foreground/80">
                <span className="font-mono text-muted-foreground">$TOKEN</span> is a placeholder — export it
                first (<span className="font-mono text-muted-foreground">export TOKEN=mf_live_…</span>); the
                secret is never inlined here.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
