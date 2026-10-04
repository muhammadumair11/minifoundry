import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', 'src', 'app', 'api', 'foundry', 'v1')

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? routes(path) : entry.name === 'route.ts' ? [path] : []
  })
}

test('every public API route validates a bearer token after the middleware exemption', () => {
  const files = routes(root)
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    expect(readFileSync(file, 'utf8')).toContain('withApiToken(req,')
  }
})
