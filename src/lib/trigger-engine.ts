// MiniFoundry — R14 upstream-trigger engine (implemented by Task 14-b).
//
// CONTRACT: when any dataset gets a new version, find every pipeline with
// triggerMode === "upstream" that watches this dataset (upstreamDatasetIds
// JSON array) and is not already running, then start a run of its LATEST
// pipeline version with trigger "upstream". Failed runs honor the pipeline's
// maxRetries policy with trigger "retry" (2s delay between attempts).
// Each triggered run emits a Notification (type "pipeline_triggered") via
// src/lib/notify.ts, and final failures emit "run_failed" notifications.
//
// Loop guards (documented limitations):
// - In-request guard: a source of "pipeline:<this pipeline name>" never
//   re-triggers that same pipeline (a pipeline watching its own output).
// - Concurrency: a simple in-process Set of pipeline ids with an active
//   trigger chain, plus a DB check for non-stale 'running' runs.
// - Cycles are NOT detected globally: a cycle A → B → A stops only because
//   the cascade `_chain` guard inside engine.ts stops depth-2 re-entry, and
//   the per-pipeline "already running" guard breaks the ping-pong between
//   events. Do not build cyclic trigger graphs.

import { db } from '@/lib/db'
import { runPipelineVersion } from '@/lib/engine'
import { createNotification } from '@/lib/notify'
import { parseJsonSafe } from '@/lib/api-utils'
import type { LogEntry } from '@/lib/api-utils'
import type { VersionCreatedEvent } from '@/lib/version-events'
import type { PipelineRun } from '@prisma/client'

/** Pipeline ids with a trigger chain currently in flight (in-process guard). */
const triggerRunning = new Set<string>()

/** Delay before each automatic retry attempt (ms). */
const RETRY_DELAY_MS = 2000
/** A 'running' run older than this is stale and no longer blocks triggering. */
const RUNNING_STALE_MS = 10 * 60 * 1000
/** Max length of the error snippet in notifications. */
const ERROR_SNIPPET_MAX = 160

interface WatcherPipeline {
  id: string
  name: string
  maxRetries: number
}

/**
 * Called (awaited, exceptions swallowed) by emitVersionCreated for every new
 * dataset version. See file header for the full behavioral contract.
 */
export async function handleVersionCreated(event: VersionCreatedEvent): Promise<void> {
  try {
    const { datasetId, versionNumber, source } = event
    if (!datasetId) return

    // Which upstream pipelines watch this dataset?
    const candidates = await db.pipeline.findMany({
      where: { triggerMode: 'upstream' },
      select: { id: true, name: true, upstreamDatasetIds: true, maxRetries: true },
      orderBy: { createdAt: 'asc' },
    })
    const watchers: WatcherPipeline[] = candidates.filter((p) => {
      const ids = parseJsonSafe<string[]>(p.upstreamDatasetIds, [])
      return Array.isArray(ids) && ids.includes(datasetId)
    })
    if (watchers.length === 0) return

    const dataset = await db.dataset.findUnique({
      where: { id: datasetId },
      select: { name: true },
    })
    const datasetLabel = `${dataset?.name ?? datasetId} v${versionNumber}`

    // Skip pipelines that already have a (non-stale) running run.
    const runningRows = await db.pipelineRun.findMany({
      where: {
        pipelineId: { in: watchers.map((w) => w.id) },
        status: 'running',
        startedAt: { gt: new Date(Date.now() - RUNNING_STALE_MS) },
      },
      select: { pipelineId: true },
    })
    const busyInDb = new Set(runningRows.map((r) => r.pipelineId))

    for (const pipeline of watchers) {
      // Loop guard: a pipeline never re-triggers itself from its own output.
      if (source?.startsWith('pipeline:')) {
        const sourcePipelineName = source.slice('pipeline:'.length).trim().toLowerCase()
        if (sourcePipelineName === pipeline.name.trim().toLowerCase()) continue
      }
      // Concurrency guards: in-process chain set + non-stale DB run.
      if (triggerRunning.has(pipeline.id) || busyInDb.has(pipeline.id)) continue

      triggerRunning.add(pipeline.id)
      // Kickoff notification (never throws).
      await createNotification({
        type: 'pipeline_triggered',
        title: `Triggered: ${pipeline.name}`,
        body: `upstream update: ${datasetLabel} (source: ${source ?? 'unknown'})`,
        resourceType: 'pipeline',
        resourceId: pipeline.id,
        href: `/pipelines/${pipeline.id}`,
      })
      startTriggerChain(pipeline, datasetLabel, source ?? 'unknown')
    }
  } catch (error) {
    console.error('[trigger-engine] handleVersionCreated failed:', error)
  }
}

/**
 * Fire-and-forget execution chain: attempt 1 with trigger "upstream", then
 * up to maxRetries automatic retries with trigger "retry" after a 2s delay.
 * The in-process guard is released only once the chain settles (success or
 * final failure), so overlapping version events cannot pile up attempts.
 */
function startTriggerChain(pipeline: WatcherPipeline, datasetLabel: string, source: string): void {
  const maxRetries = Math.max(0, Math.min(5, pipeline.maxRetries))
  const totalAttempts = maxRetries + 1

  void (async () => {
    try {
      let attempt = 1
      for (;;) {
        let run: PipelineRun
        try {
          run = await runPipelineVersion(pipeline.id, {
            trigger: attempt === 1 ? 'upstream' : 'retry',
            attempt,
          })
        } catch (err) {
          // runPipelineVersion only throws when the pipeline disappeared.
          console.error(`[trigger-engine] pipeline '${pipeline.name}' could not start:`, err)
          return
        }

        if (run.status === 'success') return

        if (attempt > maxRetries) {
          // Final failure (all attempts exhausted) → notify.
          const snippet = errorSnippetFromRun(run)
          await createNotification({
            type: 'run_failed',
            title: `Pipeline failed: ${pipeline.name}`,
            body: `attempt ${attempt}/${totalAttempts} — ${snippet}`,
            resourceType: 'pipeline',
            resourceId: pipeline.id,
            href: `/pipelines/${pipeline.id}`,
          })
          console.error(
            `[trigger-engine] pipeline '${pipeline.name}' failed after ${attempt}/${totalAttempts} attempts (upstream: ${datasetLabel}, source: ${source})`,
          )
          return
        }

        const nextAttempt = attempt + 1
        console.log(
          `[trigger-engine] pipeline '${pipeline.name}' failed — retrying (attempt ${nextAttempt}/${totalAttempts})…`,
        )
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        attempt = nextAttempt
      }
    } catch (error) {
      // The whole chain must never throw into the caller's stack.
      console.error(`[trigger-engine] trigger chain for '${pipeline.name}' crashed:`, error)
    } finally {
      triggerRunning.delete(pipeline.id)
    }
  })()
}

/** Best-effort error message from a failed run's logs (last error entry). */
function errorSnippetFromRun(run: PipelineRun): string {
  const logs = parseJsonSafe<LogEntry[]>(run.logsJson, [])
  const lastError = [...logs].reverse().find((l) => l.level === 'error')?.msg
  const msg = lastError ?? run.logsJson ?? 'unknown error'
  return msg.length > ERROR_SNIPPET_MAX ? `${msg.slice(0, ERROR_SNIPPET_MAX)}…` : msg
}
