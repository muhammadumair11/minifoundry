import { afterEach, expect, test } from 'bun:test'
import type { NextRequest } from 'next/server'
import { isServiceAuthorized } from '../src/lib/runtime-mode'

const originalMode = process.env.MF_DEMO_MODE
const originalToken = process.env.MF_SERVICE_TOKEN

afterEach(() => {
  if (originalMode === undefined) delete process.env.MF_DEMO_MODE
  else process.env.MF_DEMO_MODE = originalMode
  if (originalToken === undefined) delete process.env.MF_SERVICE_TOKEN
  else process.env.MF_SERVICE_TOKEN = originalToken
})

function request(token?: string): NextRequest {
  const headers = new Headers()
  if (token) headers.set('x-service-token', token)
  return { headers } as NextRequest
}

test('demo mode without a configured service token never bypasses a role guard', () => {
  process.env.MF_DEMO_MODE = 'true'
  delete process.env.MF_SERVICE_TOKEN
  expect(isServiceAuthorized(request())).toBe(false)
})

test('shared mode requires the configured token', () => {
  process.env.MF_DEMO_MODE = 'false'
  process.env.MF_SERVICE_TOKEN = 'secret-token'
  expect(isServiceAuthorized(request())).toBe(false)
  expect(isServiceAuthorized(request('wrong-token'))).toBe(false)
  expect(isServiceAuthorized(request('secret-token'))).toBe(true)
})
