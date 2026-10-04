import path from 'node:path'
import { PrismaClient } from '.prisma/client'

/**
 * Cache-bust marker for the dev-server global singleton.
 * Bump whenever the Prisma client is (re)generated with new models, so a running
 * `next dev` picks up the new client on the next HMR recompile instead of
 * forever reusing the stale global instance.
 */
const PRISMA_CLIENT_STAMP = 'gap-closure-20261004b'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaStamp?: string
}

/**
 * Resolve the SQLite database path. Only overrides when the configured path
 * is clearly unusable (missing file or non-native platform path).
 * Relative paths are left for Prisma to resolve from the schema location.
 */
function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL
  if (!envUrl) {
    const dbPath = path.resolve(process.cwd(), 'db', 'custom.db')
    return `file:${dbPath}`
  }
  if (!envUrl.startsWith('file:')) return envUrl

  const filePath = envUrl.slice(5)

  // Absolute paths — check if the file exists; if not, try project-relative
  if (path.isAbsolute(filePath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').accessSync(filePath)
      return envUrl
    } catch {
      // File doesn't exist at the absolute path — fall back to project-relative
      const fallback = path.resolve(process.cwd(), 'db', 'custom.db')
      return `file:${fallback}`
    }
  }

  // Relative paths — let Prisma resolve them from the schema dir (prisma/).
  // But verify the resolved path exists; if not, try from project root.
  const schemaResolved = path.resolve(process.cwd(), 'prisma', filePath)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').accessSync(schemaResolved)
    return envUrl
  } catch {
    // Not found from schema dir — try from project root
    const cwdResolved = path.resolve(process.cwd(), filePath)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').accessSync(cwdResolved)
      return `file:${cwdResolved}`
    } catch {
      // Neither worked — return original and let Prisma error clearly
      return envUrl
    }
  }
}

function getClient(): PrismaClient {
  if (globalForPrisma.prisma && globalForPrisma.prismaStamp === PRISMA_CLIENT_STAMP) {
    return globalForPrisma.prisma
  }
  const datasources = { db: { url: resolveDatabaseUrl() } }
  const client = new PrismaClient({
    log: process.env.MF_PRISMA_QUERY_LOG === '1' ? ['query'] : ['error', 'warn'],
    datasources,
  })
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
    globalForPrisma.prismaStamp = PRISMA_CLIENT_STAMP
  }
  return client
}

export const db = getClient()
