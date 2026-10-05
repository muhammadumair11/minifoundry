'use client'

// Learn (Task 12-d) — the teaching tab. Three layers:
//   "Using this app"  → module-by-module guide to MiniFoundry itself
//   "DE concepts"     → the data-engineering ideas each module demonstrates
//   "Learning path"   → an ordered curriculum: what to learn, in what order,
//                       with practice drills inside MiniFoundry and pointers
//                       to the real-world tooling each step maps to.
// Static content — no backend.

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  ArrowRight,
  BookOpen,
  Boxes,
  CalendarClock,
  Database,
  GitBranch,
  GitFork,
  GraduationCap,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Map,
  Network,
  Plug,
  ShieldCheck,
  SquareCode,
  Zap,
} from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import CurriculumTracker from '@/components/foundry/learn/curriculum-tracker'
import { Suspense } from 'react'

// ── Content ──────────────────────────────────────────────────────────────

interface GuideModule {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  title: string
  href: string
  what: string
  steps: string[]
  teaches: string
}

const GUIDE: GuideModule[] = [
  {
    icon: Plug,
    title: '1 · Connectors — get data in',
    href: '/connectors',
    what: 'Connectors are the front door: they define where data comes from (CSV upload, JSON upload, a REST URL, or a built-in sample) and produce ingestions that land rows into datasets. REST connectors do a real HTTP fetch — Test connection dry-runs it, ingest lands the rows.',
    steps: [
      'Open Connectors and create a connector (try "CSV upload" or a REST URL).',
      'Run an ingestion — MiniFoundry parses the payload (or fetches the URL live) and writes it as version 1 of a new dataset.',
      'Watch the ingestion status flip running → success, with the row count recorded.',
    ],
    teaches: 'Teaches: extraction & loading (the "EL" of ELT), and why ingestion is its own observable step.',
  },
  {
    icon: Boxes,
    title: '2 · Datasets — versioned, immutable tables',
    href: '/datasets',
    what: 'A dataset is an immutable, versioned table. Every write creates a NEW version (schema + rows snapshot) — nothing is ever edited in place, exactly like real Foundry.',
    steps: [
      'Browse the catalog: tags, owning project, latest version, freshness.',
      'Open a dataset: inspect the schema, preview rows, flip between versions, and read the version history to see who/what produced each one.',
      'Note the "createdBy" lineage on each version — ingestion, a pipeline run, or a code workbook.',
    ],
    teaches: 'Teaches: immutability, time-travel, reproducibility — the foundations of trustworthy data.',
  },
  {
    icon: SquareCode,
    title: '3 · Code workbooks — SQL, Python & JavaScript transforms',
    href: '/transforms',
    what: 'Workbooks are code-first transformations. Pick input datasets, write SQL / Python / JavaScript, run it, and the result rows are published as a new version of an output dataset.',
    steps: [
      'Open Transforms and pick a workbook — or create one (SQL is easiest to start).',
      'In SQL your inputs are queryable tables (use real column names — IntelliSense knows them); in Python define transform(input) and return a list of dicts; in JavaScript you get rows as arrays of objects.',
      'Press Run (⌘/Ctrl+↵). Inspect the Preview, Logs and Run history tabs; the output dataset appears in the catalog.',
    ],
    teaches: 'Teaches: code-first transformation (the "T"), push-down SQL vs. programmatic transforms, and output publishing.',
  },
  {
    icon: GitBranch,
    title: '4 · Pipelines — build the flow visually',
    href: '/pipelines',
    what: 'The pipeline builder is a node graph: Source → Derive/Filter/… → Output. Running a pipeline executes the nodes in dependency order and writes the output dataset, capturing lineage automatically.',
    steps: [
      'Open a pipeline (or create one), drag nodes from the palette, wire them up.',
      'Configure a node (click it): expressions like row.quantity * row.unitPrice in Derive, conditions in Filter.',
      'Save (that snapshots version 1) and Run. Every run pins the graph version it executed — check the Versions panel to restore any snapshot.',
    ],
    teaches: 'Teaches: DAG thinking, node-based modeling, and why runs should be pinned to graph versions.',
  },
  {
    icon: CalendarClock,
    title: '5 · Orchestration — schedules & health',
    href: '/orchestration',
    what: 'Orchestration is where pipelines become "always-on data infrastructure": schedules run pipelines on intervals, and the health strip shows success rate, failures and freshness at a glance.',
    steps: [
      'Create a schedule for a pipeline (e.g. every 10 minutes) and enable it.',
      'Watch runs accumulate in the Jobs table, each stamped with the pipeline version it ran.',
      'Use the health strip to spot failing pipelines and stale datasets before they matter.',
    ],
    teaches: 'Teaches: scheduling, idempotent refresh loops, and data-ops monitoring habits.',
  },
  {
    icon: Network,
    title: '6 · Ontology — the semantic layer',
    href: '/ontology',
    what: 'The ontology maps raw tables into business objects (Shipment, Warehouse…) with typed properties, links and write-back Actions — so apps and analysts work with "shipments", not "dataset row 41".',
    steps: [
      'Open Ontology: each object type points at a backing dataset and a primary-key property.',
      'Explore Objects: browse instances, follow links between related objects.',
      'Run an Action (e.g. update a shipment status) — it writes back to the dataset as a new version, logged for audit.',
    ],
    teaches: 'Teaches: why the semantic layer exists, object/property/link modeling, and governed write-back.',
  },
  {
    icon: GitFork,
    title: '7 · Lineage — where data comes from',
    href: '/lineage',
    what: 'Every pipeline and workbook that writes a dataset records an edge in the lineage graph. The lineage view reconstructs upstream → downstream flow automatically from actual runs.',
    steps: [
      'Open Lineage after running a pipeline or workbook.',
      'Trace an output dataset back to its raw sources — then click through to the producers.',
      'Notice there is nothing to configure: lineage is captured, not declared.',
    ],
    teaches: 'Teaches: impact analysis ("what breaks if I change this table?") and provenance.',
  },
  {
    icon: ShieldCheck,
    title: '8 · Governance — roles, markings, approvals, audit',
    href: '/governance',
    what: 'Governance is the control plane: viewer/editor/admin roles gate every button, column markings restrict sensitive values by role, publish approvals add human review, and the audit trail records everything.',
    steps: [
      'Switch your role in the top bar (viewer/editor/admin) and watch buttons disable with a reason.',
      'Attach a marking to a dataset column, then view the data as a viewer — values are masked.',
      'Request a publish approval as editor, approve it as admin, and read the audit trail.',
    ],
    teaches: 'Teaches: least-privilege access, data protection, review workflows, and auditability.',
  },
  {
    icon: KeyRound,
    title: '9 · Platform API — data as a product',
    href: '/api-docs',
    what: 'Everything in the catalog is exposed over a versioned REST API (/api/foundry/v1/…) authenticated by personal tokens, with per-request usage logging and a 24h traffic dashboard.',
    steps: [
      'Create a token on the API tokens page (the plaintext is shown once — store it).',
      'Call GET /api/foundry/v1/datasets with Authorization: Bearer <token>.',
      'Review the usage dashboard: traffic by hour, by token, by route, plus error rates.',
    ],
    teaches: 'Teaches: token auth, API-first data products, and observability of consumption.',
  },
  {
    icon: GitBranch,
    title: '10 · Branches — experiment safely',
    href: '/datasets',
    what: 'Any dataset can be branched (like Git): a branch is an isolated commit line. New versions created on the branch never touch main until you merge. Transforms and pipelines always publish to main.',
    steps: [
      'Open a dataset, press New branch, give it a name.',
      'Compare versions with the History view — added / removed / changed rows are highlighted.',
      'Merge the branch: its head becomes a new main version, and the branch is marked merged.',
    ],
    teaches: 'Teaches: isolation vs publication, fast-forward-style merges, and why immutable versioning makes branching cheap.',
  },
  {
    icon: ShieldCheck,
    title: '11 · Data quality — expectations on data',
    href: '/datasets',
    what: 'Attach expectations (rules) to a dataset: not-null, unique, ranges, allowed values, regex, freshness, or minimum row count. Evaluate anytime; error-severity failures raise platform notifications.',
    steps: [
      'Open a dataset → Quality tab → Add rule (try not_null on the id column).',
      'Press Evaluate now — each rule gets a pass/fail with the observed metric.',
      'Set one rule to error severity, break the data on a branch, and watch the bell ring.',
    ],
    teaches: 'Teaches: data contracts, expectation suites, and how health gates trust in downstream consumers.',
  },
  {
    icon: Zap,
    title: '12 · Automation — upstream triggers & retries',
    href: '/pipelines',
    what: 'Pipelines can run themselves: set trigger mode to upstream, pick the datasets to watch, and every new version of those datasets fires the pipeline automatically. Failed runs retry up to maxRetries.',
    steps: [
      'Open a pipeline → Automation → set "On upstream update" and pick a dataset.',
      'Trigger an update (e.g. submit an ontology action with write-back) — the run appears with an UPSTREAM badge in Orchestration.',
      'Watch the bell: triggered and failed runs create notifications.',
    ],
    teaches: 'Teaches: event-driven DAGs, trigger graphs, retry policies, and the difference between time schedules and data-driven triggers.',
  },
  {
    icon: LayoutDashboard,
    title: '13 · Applications — operational workflows',
    href: '/applications',
    what: 'Build a task-focused application over Ontology objects. Pages and sections hold maps, charts, tables, metrics and actions; global filters and chart selections coordinate the whole app.',
    steps: [
      'Open Applications → Create sample → explore its Overview and Shipments pages.',
      'Click a chart category to filter the workflow, then select a table row to inspect linked objects.',
      'Press Edit → add a page or section, then add and place a widget; save the application.',
    ],
    teaches: 'Teaches: the operational layer — how governed objects become a shared interface for decisions and write-back.',
  },
  {
    icon: ShieldCheck,
    title: '14 · Publication gate — the trust workflow',
    href: '/datasets',
    what: 'Turn a dataset\'s quality gate on and the platform enforces a trust workflow: new versions land as drafts, every version is automatically evaluated against the quality rules, and error-severity failures BLOCK publication. Pipelines, dashboards and objects keep reading the last published version until an editor presses Publish.',
    steps: [
      'Open a dataset → Quality → enable "Publication gate" (consumers stay pinned to the published version).',
      'Write new data (pipeline run, ingest, action) — the banner shows the draft, its quality state, and "consumers see vN".',
      'Press Validate then Publish — failing error rules return the exact reasons; the Lineage page shows the downstream impact of publishing.',
    ],
    teaches: 'Teaches: preview → validate → approve → publish, quality-as-a-gate, consumer/producer separation, and why provenance (which input versions made this output) is the foundation of trust.',
  },
]

interface Concept {
  title: string
  body: string
  where: string
  href: string
}

const CONCEPTS: Concept[] = [
  {
    title: 'EL(T): extract, load, then transform',
    body: 'Modern platforms land raw data first (ingestion), then transform it in place. Keeping raw data and transforms separate means you can fix a bug and reprocess history instead of re-collecting it. Connectors land; transforms and pipelines refine.',
    where: 'Connectors → Transforms',
    href: '/connectors',
  },
  {
    title: 'Immutability & versioning',
    body: 'Never overwrite data — append new versions. Versioned datasets give you time-travel, reproducible experiments (run a pipeline against v3), and an audit story. MiniFoundry datasets are write-once: every change is a new version with its own schema and row snapshot.',
    where: 'Datasets',
    href: '/datasets',
  },
  {
    title: 'Transformations: SQL first, code when needed',
    body: 'SQL is the lingua franca of analytics transformations (set-based, optimizable, familiar). Python earns its place for scoring, ranking and API-shaped logic; JavaScript for lightweight row math. Choosing the right language per step is a data-engineering skill in itself.',
    where: 'Code workbooks',
    href: '/transforms',
  },
  {
    title: 'Pipelines as DAGs',
    body: 'Real data platforms are directed acyclic graphs: sources feed derives feed filters feed outputs. Modeling flow as a graph (not a script) gives you dependency order, parallelism potential, and per-node reuse — plus a picture the business can read.',
    where: 'Pipelines',
    href: '/pipelines',
  },
  {
    title: 'Orchestration & freshness',
    body: 'One manual run proves correctness; schedules prove reliability. Orchestration turns pipelines into always-on infrastructure with intervals, retries-by-rerun, and freshness monitoring — the difference between a demo and a data product.',
    where: 'Orchestration',
    href: '/orchestration',
  },
  {
    title: 'Lineage & provenance',
    body: 'Lineage answers "where did this number come from?" and "what breaks if this source changes?" — automatically captured from actual runs, never hand-drawn diagrams that drift from reality.',
    where: 'Lineage',
    href: '/lineage',
  },
  {
    title: 'The semantic layer (ontology)',
    body: 'Analysts think in entities (shipments, warehouses, orders), not tables. A semantic layer maps governed, versioned data into business objects with links and actions — the layer that makes operational analytics apps possible.',
    where: 'Ontology · Objects',
    href: '/ontology',
  },
  {
    title: 'Governance: roles, markings, audit',
    body: 'Least-privilege roles decide who can act; markings protect sensitive columns; approvals add human review before publishing; an append-only audit trail answers "who did what, when". Governance is a feature of the platform, not a policy PDF.',
    where: 'Governance',
    href: '/governance',
  },
  {
    title: 'Data as a product (API-first)',
    body: 'A curated dataset nobody can consume is a dead end. Publishing data behind a versioned, authenticated API — with usage analytics — turns the platform from storage into a product that serves dashboards, apps and ML.',
    where: 'API docs · API tokens',
    href: '/api-docs',
  },
  {
    title: 'Observability of the data platform',
    body: 'Run history, durations, success rates, freshness, API traffic: the platform watches itself so you can watch the business. Most "data issues" are orchestration issues in disguise — observability finds them first.',
    where: 'Orchestration · API tokens',
    href: '/orchestration',
  },
]

interface PathStep {
  level: 'Beginner' | 'Intermediate' | 'Advanced'
  title: string
  learn: string
  practice: string
  deeper: string
}

const PATH: PathStep[] = [
  {
    level: 'Beginner',
    title: 'SQL fundamentals',
    learn: 'SELECT / WHERE / GROUP BY / JOIN / ORDER BY, aggregates, NULL semantics, CASE expressions.',
    practice: 'Write a workbook per concept: filter shipments by status, aggregate spend per supplier, JOIN suppliers to shipments. Use the schema-aware IntelliSense to explore columns.',
    deeper: 'Window functions (ROW_NUMBER, RANK), CTEs, query plans. Next tools: PostgreSQL + any SQL client.',
  },
  {
    level: 'Beginner',
    title: 'Data thinking: immutability & versions',
    learn: 'Why write-once datasets beat in-place edits: reproducibility, time-travel, blame-free debugging.',
    practice: 'Run an ingestion twice, compare dataset versions; restore an old pipeline version and rerun it; diff outputs.',
    deeper: 'Delta Lake / Iceberg table formats do this at scale in industry.',
  },
  {
    level: 'Beginner',
    title: 'Pipelines & the builder mindset',
    learn: 'Modeling flow as nodes and edges; derive vs. filter vs. aggregate; keeping one concern per node.',
    practice: 'Rebuild the sample Shipment Overview pipeline from scratch: source → derive total value → filter → output.',
    deeper: 'Draw the DAG on paper before building it — the graph IS the design doc.',
  },
  {
    level: 'Intermediate',
    title: 'Python for data work',
    learn: 'Core Python, dicts/lists fluency, comprehensions, sorting with keys, error handling with try/except.',
    practice: 'Write a Python workbook: transform(input) that ranks warehouses by load and buckets them into priority tiers; break it on purpose and read the traceback in the logs.',
    deeper: 'pandas / Polars for dataframe thinking; typing & pytest for robustness.',
  },
  {
    level: 'Intermediate',
    title: 'Orchestration & data ops',
    learn: 'Schedules vs. events, idempotent refresh loops, monitoring success rate & freshness, alert fatigue.',
    practice: 'Schedule your pipeline every 10 minutes, deliberately break an upstream transform, then use the health strip and run history to find and fix the failure.',
    deeper: 'Study how Airflow / Dagster model schedules, retries and SLAs.',
  },
  {
    level: 'Intermediate',
    title: 'Modeling the business: ontology',
    learn: 'Entities, primary keys, relationships (1:N, M:N), properties, and mapping tables → objects.',
    practice: 'Add a new object type on a dataset you built; define links to Shipment; create an Action that updates a status; perform it and inspect the write-back version.',
    deeper: 'Read about data mesh & data products — the ontology is the product interface.',
  },
  {
    level: 'Advanced',
    title: 'Governance by design',
    learn: 'RBAC, column-level protection, approval workflows, append-only audit, least privilege.',
    practice: 'Mark a salary-like column, verify viewer masking; run a publish through approval; audit-trail the whole story.',
    deeper: 'Map these to SOC 2 / GDPR vocabulary — compliance is governance with paperwork.',
  },
  {
    level: 'Advanced',
    title: 'Serving data: APIs & products',
    learn: 'Token auth, REST shape, pagination & filtering, rate limits, usage analytics as product telemetry.',
    practice: 'Create a token, consume your own dataset over /api/foundry/v1, then read the traffic dashboard: which routes are hot, what errors look like.',
    deeper: 'Study versioned public APIs (Stripe-style) and slowness budgets; try building a tiny dashboard on your own API.',
  },
]

const LEVEL_STYLES: Record<PathStep['level'], string> = {
  Beginner: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  Intermediate: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  Advanced: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400',
}

// ── Sections ─────────────────────────────────────────────────────────────

function GuideTab() {
  return (
    <Accordion type="single" collapsible className="space-y-0">
      {GUIDE.map((m) => (
        <AccordionItem key={m.title} value={m.title}>
          <AccordionTrigger className="py-3 text-[13px] font-medium hover:no-underline">
            <span className="flex items-center gap-2">
              <m.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              {m.title}
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pb-4">
            <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">{m.what}</p>
            <ol className="max-w-prose space-y-1.5 text-[13px] text-foreground">
              {m.steps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-px font-mono text-[11px] text-muted-foreground">{i + 1}.</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={m.href}
                className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline"
              >
                Open in the app <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
              <span className="text-xs text-muted-foreground">{m.teaches}</span>
            </div>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}

function ConceptsTab() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {CONCEPTS.map((c) => (
        <Card key={c.title} className="py-0">
          <CardContent className="p-4">
            <h3 className="text-[13px] font-medium text-foreground">{c.title}</h3>
            <p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-muted-foreground">{c.body}</p>
            <Link
              href={c.href}
              className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline"
            >
              {c.where} <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function PathTab() {
  return (
    <div className="space-y-3">
      <p className="max-w-prose text-[13px] text-muted-foreground">
        A self-contained curriculum, ordered. Each step: what to learn, a drill inside MiniFoundry,
        and where to go deeper in the real world.
      </p>
      <ol className="space-y-3">
        {PATH.map((s, i) => (
          <li key={s.title}>
            <Card className="py-0">
              <CardContent className="flex gap-3 p-4">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-medium text-foreground">{s.title}</h3>
                    <Badge variant="outline" className={`h-4 px-1.5 text-[10px] ${LEVEL_STYLES[s.level]}`}>
                      {s.level}
                    </Badge>
                  </div>
                  <p className="max-w-prose text-[13px] text-muted-foreground">
                    <span className="font-medium text-foreground">Learn:</span> {s.learn}
                  </p>
                  <p className="max-w-prose text-[13px] text-muted-foreground">
                    <span className="font-medium text-foreground">Practice here:</span> {s.practice}
                  </p>
                  <p className="max-w-prose text-[13px] text-muted-foreground">
                    <span className="font-medium text-foreground">Go deeper:</span> {s.deeper}
                  </p>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────

function LearnPageInner() {
  // P3 deep link: /learn?step=<id> (dashboard "Resume" button) highlights and
  // scrolls to the requested step on the Getting started tab.
  const highlightStep = useSearchParams().get('step')

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:py-8">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium tracking-tight text-foreground">Learn</h1>
        <span className="text-xs text-muted-foreground">
          how to use MiniFoundry · the data engineering behind it · what to learn next
        </span>
      </header>

      <p className="mb-4 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
        MiniFoundry is a learning-scale model of Palantir Foundry: data lands through
        <span className="text-foreground"> connectors</span>, becomes immutable
        <span className="text-foreground"> datasets</span>, is reshaped by
        <span className="text-foreground"> transforms</span> and
        <span className="text-foreground"> pipelines</span>, runs on a
        <span className="text-foreground"> schedule</span>, is modeled as business
        <span className="text-foreground"> objects</span>, watched by
        <span className="text-foreground"> lineage</span> and
        <span className="text-foreground"> governance</span>, and served over an
        <span className="text-foreground"> API</span>. Every module here teaches the real concept it mirrors.
      </p>

      <Tabs defaultValue="start">
        <div className="foundry-scroll mb-4 max-w-full overflow-x-auto pb-1">
          <TabsList className="min-w-max">
            <TabsTrigger value="start" className="gap-1.5">
              <ListChecks className="h-3.5 w-3.5" aria-hidden /> Getting started
            </TabsTrigger>
            <TabsTrigger value="guide" className="gap-1.5">
              <Map className="h-3.5 w-3.5" aria-hidden /> Using this app
            </TabsTrigger>
            <TabsTrigger value="concepts" className="gap-1.5">
              <Database className="h-3.5 w-3.5" aria-hidden /> DE concepts
            </TabsTrigger>
            <TabsTrigger value="path" className="gap-1.5">
              <GraduationCap className="h-3.5 w-3.5" aria-hidden /> Learning path
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="start">
          <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" aria-hidden />
            A hands-on path through the whole platform. Auto-verified steps check REAL platform state — do the action, get the check.
          </div>
          <CurriculumTracker highlightStep={highlightStep} />
        </TabsContent>
        <TabsContent value="guide">
          <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" aria-hidden />
            Fourteen modules, in the order a data engineer actually meets them. Expand each for the how-to.
          </div>
          <GuideTab />
        </TabsContent>
        <TabsContent value="concepts">
          <ConceptsTab />
        </TabsContent>
        <TabsContent value="path">
          <PathTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// useSearchParams needs a Suspense boundary during prerendering.
export default function LearnPage() {
  return (
    <Suspense fallback={null}>
      <LearnPageInner />
    </Suspense>
  )
}
