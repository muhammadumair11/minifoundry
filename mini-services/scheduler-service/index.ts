/// <reference types="bun-types" />
// MiniFoundry — scheduler mini-service (M5 Orchestration).
// Independent bun process that polls the Next.js app for due schedules and
// triggers their pipelines. All traffic goes through http://localhost:3000
// (the scheduler is a trusted internal service, so it may use the direct port).
//
// Auth (Phase 0): when MF_SERVICE_TOKEN is set, every request carries
// `x-service-token: <token>` and the app treats this service as the trusted
// 'system' actor. When the app runs with MF_DEMO_MODE=false and NO token is
// configured here, the app will reject these calls — set both envs in shared
// deployments:
//   app:        MF_DEMO_MODE=false MF_SERVICE_TOKEN=<secret>
//   scheduler:  MF_SERVICE_TOKEN=<same secret>
//
// GET /  -> { service, status, tickIntervalMs, lastTickAt, dueProcessed }
// Every TICK_INTERVAL_MS: GET /api/schedules/due -> POST /api/pipelines/{id}/run
// with body { scheduleId } for each due schedule.

const PORT = Number(process.env.SCHEDULER_PORT ?? 3030)
const NEXT_BASE = process.env.NEXT_BASE_URL ?? 'http://localhost:3000'
const TICK_INTERVAL_MS = 30_000
const SERVICE_TOKEN = process.env.MF_SERVICE_TOKEN?.trim() ?? ''

interface DueSchedule {
  id: string
  pipelineId: string
  name: string
  pipelineName?: string | null
}

let lastTickAt: string | null = null
let dueProcessed = 0

const ts = () => new Date().toISOString()

/** Headers for app calls: the service token when one is configured. */
function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (SERVICE_TOKEN) headers['x-service-token'] = SERVICE_TOKEN
  return headers
}

Bun.serve({
  port: PORT,
  fetch() {
    return Response.json({
      service: 'scheduler-service',
      status: 'ok',
      tickIntervalMs: TICK_INTERVAL_MS,
      lastTickAt,
      dueProcessed,
    })
  },
})

async function triggerSchedule(schedule: DueSchedule): Promise<void> {
  const label = `'${schedule.name}' (pipeline ${schedule.pipelineName ?? schedule.pipelineId})`
  try {
    const res = await fetch(`${NEXT_BASE}/api/pipelines/${schedule.pipelineId}/run`, {
      method: 'POST',
      headers: serviceHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ scheduleId: schedule.id }),
    })
    const body = (await res.json().catch(() => null)) as
      | { job?: { id?: string; status?: string } }
      | null
    const jobStatus = body?.job?.status ?? 'unknown'
    const jobId = body?.job?.id ?? 'n/a'
    if (res.ok) {
      dueProcessed += 1
      console.log(`[${ts()}] queued ${label} -> HTTP ${res.status}, job ${jobId} status: ${jobStatus}`)
    } else {
      console.log(`[${ts()}] trigger ${label} FAILED -> HTTP ${res.status}`)
    }
  } catch (err) {
    console.log(`[${ts()}] trigger ${label} ERROR: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function tick(): Promise<void> {
  lastTickAt = ts()
  try {
    const res = await fetch(`${NEXT_BASE}/api/schedules/due`, {
      headers: serviceHeaders(),
    })
    if (!res.ok) {
      console.log(`[${ts()}] tick: /api/schedules/due -> HTTP ${res.status}`)
      return
    }
    const data = (await res.json().catch(() => ({}))) as { schedules?: DueSchedule[] }
    const due = Array.isArray(data.schedules) ? data.schedules : []
    console.log(`[${ts()}] tick: ${due.length} due schedule(s)`)
    for (const schedule of due) {
      await triggerSchedule(schedule) // sequential: keeps run order deterministic
    }
  } catch (err) {
    console.log(`[${ts()}] tick failed (Next.js on ${NEXT_BASE} reachable?): ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`scheduler-service listening on :${PORT} (tick every ${TICK_INTERVAL_MS}ms, target ${NEXT_BASE})`)
void tick() // fire once at boot (async; do not block boot)
setInterval(tick, TICK_INTERVAL_MS)
