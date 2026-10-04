// MiniFoundry — Phase 3 (guided curriculum): the progress-tracked learning
// path. Each step maps a platform capability to a REAL, verifiable action.
//
// Verification model (the teaching point — trust but verify):
//   • verify: 'auto'    → completion is computed LIVE from real platform
//     state (row counts, runs, tokens…). Nothing is stored: you cannot fake
//     a step by flipping a flag, you must actually DO the thing.
//   • verify: 'manual'  → completion is a persisted check-off per actor
//     (CurriculumProgress) for steps that live in the reader's head
//     ("read the concepts", "give the tour a try").
//
// actorKey = session email, or 'sim:<role>' for the demo-mode simulator.

import { db } from '@/lib/db'

export interface CurriculumStep {
  id: string
  title: string
  /** What this step is about (platform feature). */
  description: string
  /** The data-engineering idea it teaches. */
  teaches: string
  /** Where to do it. */
  href: string
  cta: string
  verify: 'auto' | 'manual'
}

export const CURRICULUM_STEPS: CurriculumStep[] = [
  {
    id: 'orient',
    title: 'Orient — take the platform tour',
    description:
      'Skim the "Using this app" tab below: what each module does and how they fit together.',
    teaches: 'Before touching data, know the map: ingest → store → transform → serve.',
    href: '/learn',
    cta: 'Open the guide',
    verify: 'manual',
  },
  {
    id: 'connectors',
    title: 'Register a connector',
    description:
      'Create a connector on the Connectors page — a named, reusable source (sample, CSV/JSON upload or REST URL).',
    teaches: 'Connectors decouple WHERE data comes from from HOW it is ingested.',
    href: '/connectors',
    cta: 'Open connectors',
    verify: 'auto',
  },
  {
    id: 'ingest',
    title: 'Run an ingestion',
    description:
      'Pull data through a connector (or upload a file) until an ingestion reports success.',
    teaches: 'Ingestion is a job with observable status — not a side effect of uploading.',
    href: '/connectors',
    cta: 'Run an ingestion',
    verify: 'auto',
  },
  {
    id: 'datasets',
    title: 'Explore a versioned dataset',
    description:
      'Open a dataset in the studio: preview rows, check the inferred schema, look at its version history.',
    teaches: 'Datasets are immutable: every write produces a NEW version, never an overwrite.',
    href: '/datasets',
    cta: 'Open the catalog',
    verify: 'auto',
  },
  {
    id: 'transform-write',
    title: 'Write a code transform',
    description:
      'Create a workbook (SQL, JavaScript or Python) in Transforms that reads a dataset and outputs another.',
    teaches: 'Code transforms are versioned first-class assets, like in a real code repo.',
    href: '/transforms',
    cta: 'Open transforms',
    verify: 'auto',
  },
  {
    id: 'transform-run',
    title: 'Run the transform',
    description:
      'Execute the workbook and confirm it wrote a new dataset version from its output.',
    teaches: 'Running code produces immutable outputs — same contract as visual pipelines.',
    href: '/transforms',
    cta: 'Run it',
    verify: 'auto',
  },
  {
    id: 'pipeline-build',
    title: 'Build a pipeline graph',
    description:
      'Save a pipeline version in the visual builder (source → filter/derive → output).',
    teaches: 'Pipelines are declarative DAGs; saving a version snapshots the whole graph.',
    href: '/pipelines',
    cta: 'Open pipelines',
    verify: 'auto',
  },
  {
    id: 'pipeline-run',
    title: 'Run a pipeline to success',
    description: 'Trigger a run and watch it go green on the Orchestration jobs table.',
    teaches: 'A run records what it read and wrote — provenance is captured, not reconstructed.',
    href: '/orchestration',
    cta: 'Run one',
    verify: 'auto',
  },
  {
    id: 'schedule',
    title: 'Schedule a pipeline',
    description:
      'Add a schedule (an interval) to a pipeline so the Bun scheduler service picks it up.',
    teaches: 'Orchestration is outside the app: a separate service calls credentialed endpoints.',
    href: '/orchestration',
    cta: 'Add a schedule',
    verify: 'auto',
  },
  {
    id: 'ontology',
    title: 'Register an object type',
    description:
      'Back an object type with a dataset in Ontology and pick its primary key.',
    teaches: 'The ontology projects rows into business objects people can reason about.',
    href: '/ontology',
    cta: 'Open ontology',
    verify: 'auto',
  },
  {
    id: 'action-run',
    title: 'Execute an action (write-back)',
    description:
      'Submit an action on an object and see the new dataset version it produced.',
    teaches: 'Actions are governed writes: UI → action → new immutable version → pipelines react.',
    href: '/objects',
    cta: 'Open objects',
    verify: 'auto',
  },
  {
    id: 'dashboard',
    title: 'Build a dashboard',
    description: 'Add at least one widget backed by a dataset on the Dashboards page.',
    teaches: 'Dashboards read the consumer pointer — the same view decisions see.',
    href: '/dashboards',
    cta: 'Open dashboards',
    verify: 'auto',
  },
  {
    id: 'column-marking',
    title: 'Mark a sensitive column',
    description:
      'Attach a marking with a minRole to a dataset column and view it as a lower role.',
    teaches: 'Governance is enforced at READ time: masking happens per viewer, per cell.',
    href: '/governance',
    cta: 'Open governance',
    verify: 'auto',
  },
  {
    id: 'quality-gate',
    title: 'Publish through the quality gate',
    description:
      'Turn on a dataset\'s publication gate, ingest a draft, then publish it (see the dataset banner).',
    teaches: 'Preview → validate → approve → publish: bad data never reaches consumers.',
    href: '/datasets',
    cta: 'Try the gate',
    verify: 'auto',
  },
  {
    id: 'run-replay',
    title: 'Replay a run from its manifest',
    description:
      'Open any run\'s build record on Orchestration and click "Replay from recorded inputs".',
    teaches: 'Reproducible builds: retry uses latest inputs; replay uses the RECORDED ones.',
    href: '/orchestration',
    cta: 'Open jobs',
    verify: 'auto',
  },
  {
    id: 'version-lineage',
    title: 'Trace version-level lineage',
    description:
      'Open the lineage impact panel and follow which input versions fed an output version.',
    teaches: 'Dataset-level edges say WHAT connects; version-level edges say WHEN and WITH WHAT.',
    href: '/lineage',
    cta: 'Open lineage',
    verify: 'auto',
  },
  {
    id: 'api-token',
    title: 'Mint an API token',
    description:
      'Create a token on API Tokens and call the public API with it (see the curl snippet).',
    teaches: 'Machine access is credentialed, rate-limited and logged per request.',
    href: '/api-tokens',
    cta: 'Open tokens',
    verify: 'auto',
  },
  {
    id: 'de-concepts',
    title: 'Read the DE concepts',
    description:
      'Work through the "DE concepts" tab and connect each idea to the module you just used.',
    teaches: 'The tooling changes; the concepts (immutability, lineage, gates) transfer.',
    href: '/learn',
    cta: 'Read concepts',
    verify: 'manual',
  },
]

export const CURRICULUM_TOTAL = CURRICULUM_STEPS.length

interface Evidence {
  done: boolean
  evidence: string | null
}

/** Compute live, evidence-backed completion for every auto-verified step. */
async function detectAutoSteps(): Promise<Record<string, Evidence>> {
  const [
    connectors,
    ingestions,
    datasets,
    datasetVersions,
    transforms,
    transformRuns,
    pipelineVersions,
    pipelineCount,
    pipelineRuns,
    schedules,
    objectTypes,
    actionLogs,
    dashboards,
    columnMarkings,
    publishAudits,
    gatedPublished,
    replays,
    versionEdges,
    apiTokens,
  ] = await Promise.all([
    db.connector.count(),
    db.ingestion.count({ where: { status: 'success' } }),
    db.dataset.count(),
    db.datasetVersion.count(),
    db.transform.count(),
    db.transformRun.count({ where: { status: 'success' } }),
    db.pipelineVersion.count(),
    db.pipeline.count(),
    db.pipelineRun.count({ where: { status: 'success' } }),
    db.schedule.count(),
    db.objectType.count(),
    db.actionLog.count({ where: { result: 'success' } }),
    db.dashboard.count({ where: { layoutJson: { not: '[]' } } }),
    db.columnMarking.count(),
    db.auditEntry.count({ where: { action: 'dataset.publish' } }),
    db.dataset.count({ where: { qualityGate: true, publishedVersion: { not: null } } }),
    db.pipelineRun.count({ where: { trigger: 'replay' } }),
    db.versionLineageEdge.count(),
    db.apiToken.count({ where: { revokedAt: null } }),
  ])

  const ev = (done: boolean, evidence: string | null): Evidence => ({ done, evidence })

  return {
    connectors: ev(connectors > 0, `${connectors} connector${connectors === 1 ? '' : 's'} registered`),
    ingest: ev(ingestions > 0, `${ingestions} successful ingestion${ingestions === 1 ? '' : 's'}`),
    datasets: ev(
      datasets > 0 && datasetVersions > 0,
      `${datasets} dataset${datasets === 1 ? '' : 's'} · ${datasetVersions} versions total`,
    ),
    'transform-write': ev(transforms > 0, `${transforms} workbook${transforms === 1 ? '' : 's'} saved`),
    'transform-run': ev(
      transformRuns > 0,
      `${transformRuns} successful transform run${transformRuns === 1 ? '' : 's'}`,
    ),
    'pipeline-build': ev(
      pipelineVersions > 0,
      `${pipelineVersions} saved graph version${pipelineVersions === 1 ? '' : 's'} across ${pipelineCount} pipeline${pipelineCount === 1 ? '' : 's'}`,
    ),
    'pipeline-run': ev(
      pipelineRuns > 0,
      `${pipelineRuns} successful pipeline run${pipelineRuns === 1 ? '' : 's'}`,
    ),
    schedule: ev(schedules > 0, `${schedules} schedule${schedules === 1 ? '' : 's'} configured`),
    ontology: ev(objectTypes > 0, `${objectTypes} object type${objectTypes === 1 ? '' : 's'} registered`),
    'action-run': ev(
      actionLogs > 0,
      `${actionLogs} successful action${actionLogs === 1 ? '' : 's'}`,
    ),
    dashboard: ev(dashboards > 0, `${dashboards} dashboard${dashboards === 1 ? '' : 's'} with widgets`),
    'column-marking': ev(
      columnMarkings > 0,
      `${columnMarkings} column marking${columnMarkings === 1 ? '' : 's'} active`,
    ),
    'quality-gate': ev(
      publishAudits > 0 || gatedPublished > 0,
      gatedPublished > 0
        ? `${gatedPublished} gated dataset${gatedPublished === 1 ? '' : 's'} with a published pointer`
        : `${publishAudits} gated publication${publishAudits === 1 ? '' : 's'} in the audit trail`,
    ),
    'run-replay': ev(replays > 0, `${replays} replay run${replays === 1 ? '' : 's'}`),
    'version-lineage': ev(
      versionEdges > 0,
      `${versionEdges} version-level lineage edge${versionEdges === 1 ? '' : 's'} recorded`,
    ),
    'api-token': ev(apiTokens > 0, `${apiTokens} active token${apiTokens === 1 ? '' : 's'}`),
  }
}

export interface CurriculumStepStatus extends CurriculumStep {
  done: boolean
  /** How it was verified: 'auto' evidence string, 'manual' check-off, or null when incomplete. */
  evidence: string | null
  source: 'auto' | 'manual' | null
  completedAt: string | null
}

export interface CurriculumStatus {
  steps: CurriculumStepStatus[]
  completed: number
  total: number
  percent: number
  /** 'Up next' step id (see pick logic below), null when finished. */
  nextStepId: string | null
}

/**
 * Full curriculum status for an actor: auto steps detected live from platform
 * state, manual steps merged from the actor's persisted check-offs.
 */
export async function getCurriculumStatus(actorKey: string): Promise<CurriculumStatus> {
  const [auto, manualRows] = await Promise.all([
    detectAutoSteps().catch(() => ({}) as Record<string, Evidence>),
    db.curriculumProgress.findMany({ where: { actorKey } }),
  ])
  const manual = new Map(manualRows.map((r) => [r.stepId, r]))

  const steps = CURRICULUM_STEPS.map((step) => {
    if (step.verify === 'auto') {
      const e = auto[step.id] ?? { done: false, evidence: null }
      return {
        ...step,
        done: e.done,
        evidence: e.done ? e.evidence : null,
        source: e.done ? ('auto' as const) : null,
        completedAt: null,
      }
    }
    const row = manual.get(step.id)
    return {
      ...step,
      done: Boolean(row),
      evidence: row ? 'checked off by you' : null,
      source: row ? ('manual' as const) : null,
      completedAt: row ? row.completedAt.toISOString() : null,
    }
  })

  const completed = steps.filter((s) => s.done).length

  // 'Up next' pick — the guided path should feel like it knows where you are:
  //   1. A brand-new user (0%) starts with the tour ('orient' is the designed
  //      entry point).
  //   2. Otherwise prefer the first incomplete AUTO-verified step — it is
  //      actionable right now. A stale manual check-off (e.g. "Orient" was
  //      never ticked) must not hijack the pointer and send a 78%-complete
  //      user back to step 1.
  //   3. Only when every auto step is done do the manual check-offs surface.
  const firstIncomplete = steps.find((s) => !s.done) ?? null
  const firstIncompleteAuto =
    steps.find((s) => !s.done && s.verify === 'auto') ?? null
  const next =
    completed === 0 && firstIncomplete?.id === 'orient'
      ? firstIncomplete
      : (firstIncompleteAuto ?? firstIncomplete)

  return {
    steps,
    completed,
    total: steps.length,
    percent: steps.length ? Math.round((completed / steps.length) * 100) : 0,
    nextStepId: next?.id ?? null,
  }
}
