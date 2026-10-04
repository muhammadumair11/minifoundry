// MiniFoundry — seed a demo schedule for the existing "Shipment Overview" pipeline.
// Idempotent: creates the schedule only if it does not already exist.
// Usage: cd /home/z/my-project && bun scripts/seed-schedule-cli.ts
//
// NOTE: intervalMinutes = 10 means the FIRST scheduled run fires up to 10 minutes
// after creation (nextRunAt = now + interval). The scheduler mini-service polls
// every 30s, so the first run lands within [nextRunAt, nextRunAt + 30s].

import { db } from '../src/lib/db'

const DEMO_PIPELINE_NAME = 'Shipment Overview'
const DEMO_SCHEDULE_NAME = 'Every 10 minutes'
const INTERVAL_MINUTES = 10

async function main() {
  const pipeline = await db.pipeline.findFirst({ where: { name: DEMO_PIPELINE_NAME } })
  if (!pipeline) {
    throw new Error(`Pipeline '${DEMO_PIPELINE_NAME}' not found — run "bun scripts/seed-cli.ts" first`)
  }

  const existing = await db.schedule.findFirst({
    where: { pipelineId: pipeline.id, name: DEMO_SCHEDULE_NAME },
  })
  if (existing) {
    console.log(JSON.stringify({
      created: false,
      schedule: {
        id: existing.id,
        pipelineId: existing.pipelineId,
        name: existing.name,
        enabled: existing.enabled,
        intervalMinutes: existing.intervalMinutes,
        lastRunAt: existing.lastRunAt,
        nextRunAt: existing.nextRunAt,
      },
    }))
    return
  }

  const now = new Date()
  const schedule = await db.schedule.create({
    data: {
      pipelineId: pipeline.id,
      name: DEMO_SCHEDULE_NAME,
      intervalMinutes: INTERVAL_MINUTES,
      enabled: true,
      nextRunAt: new Date(now.getTime() + INTERVAL_MINUTES * 60_000),
    },
  })
  console.log(JSON.stringify({
    created: true,
    schedule: {
      id: schedule.id,
      pipelineId: schedule.pipelineId,
      name: schedule.name,
      enabled: schedule.enabled,
      intervalMinutes: schedule.intervalMinutes,
      lastRunAt: schedule.lastRunAt,
      nextRunAt: schedule.nextRunAt,
    },
  }))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
