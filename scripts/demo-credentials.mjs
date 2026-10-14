import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let local = ''
try { local = readFileSync(new URL('../.env', import.meta.url), 'utf8') } catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const configured = local.match(/^MF_DEMO_USER_PASSWORD=(.*)$/m)?.[1]?.trim()
export const demoPassword = process.env.MF_DEMO_USER_PASSWORD ?? configured
assert.ok(demoPassword?.length >= 32, 'Configure a private MF_DEMO_USER_PASSWORD for the disposable test users')
