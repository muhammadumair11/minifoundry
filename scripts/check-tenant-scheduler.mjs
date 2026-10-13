// Verify the real scheduler claims each tenant's due window and keeps its
// jobs/outputs isolated. Test schedules are disabled even if a check fails.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
const base = process.env.BASE_URL ?? 'http://localhost:3000'
const local = await readFile(new URL('../docs/qa/2026-10-12-role-flow/local-test-accounts.md', import.meta.url), 'utf8').catch(() => '')
const password = process.env.QA_PASSWORD ?? local.match(/test password: `([^`]+)`/)?.[1]
assert.ok(password)
async function request(cookie, path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  assert.ok(response.ok, `${method} ${path}: ${response.status}`)
  return response.json()
}
const targets = []
try {
  for (const role of ['owner', 'isolation']) {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `qa.${role}.20261012@example.test`, password }) })
    assert.equal(response.status, 200)
    const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const pipeline = (await request(cookie, '/api/pipelines')).pipelines.find((p) => p.name === 'QA Role Flow Pipeline')
    const scheduled = await request(cookie, '/api/schedules', 'POST', { pipelineId: pipeline.id, name: 'QA scheduler ownership', intervalMinutes: 5, enabled: true })
    targets.push({ cookie, pipelineId: pipeline.id, scheduleId: scheduled.schedule.id, started: Date.now() })
    const organization = (await request(cookie, '/api/session')).organizationId
    assert.match(organization, /^[a-f0-9-]{36}$/)
    assert.match(scheduled.schedule.id, /^[a-f0-9-]{36}$/)
    // Advance only this disposable test window instead of waiting five minutes.
    execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'minifoundry', '-v', 'ON_ERROR_STOP=1', '-c', `UPDATE orchestration.schedules SET next_run_at = now() WHERE id = '${scheduled.schedule.id}' AND organization_id = '${organization}' AND name = 'QA scheduler ownership'`], { encoding: 'utf8' })
  }
  for (let attempt = 0; attempt < 110; attempt++) {
    for (const target of targets) {
      if (target.job) continue
      target.job = (await request(target.cookie, '/api/execution-jobs')).jobs.find((job) => job.pipelineId === target.pipelineId && job.trigger === 'schedule' && job.status === 'succeeded' && Date.parse(job.createdAt) >= target.started - 1000)
    }
    if (targets.every((target) => target.job)) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(targets.every((target) => target.job), 'both tenant schedules completed inside the scheduler window')
  for (const [index, target] of targets.entries()) {
    const other = targets[1 - index]
    const denied = await fetch(base + `/api/execution-jobs/${target.job.id}`, { headers: { cookie: other.cookie } })
    assert.equal(denied.status, 404)
  }
  console.log('PASS real scheduled jobs complete in both organizations and remain isolated')
} finally {
  for (const target of targets) await request(target.cookie, `/api/schedules/${target.scheduleId}`, 'PATCH', { enabled: false })
  console.log('PASS test schedules are disabled')
}
