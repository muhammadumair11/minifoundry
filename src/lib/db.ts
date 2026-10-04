import { PrismaClient } from '.prisma/client'

/**
 * Cache-bust marker for the dev-server global singleton.
 * Bump whenever the Prisma client is (re)generated with new models, so a running
 * `next dev` picks up the new client on the next HMR recompile instead of
 * forever reusing the stale global instance (e.g. Schedule added in Round 2,
 * ObjectType/Property/LinkType/ActionType/ActionLog added in Round 3).
 */
const PRISMA_CLIENT_STAMP = 'gap-closure-20261004'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaStamp?: string
}

function getClient(): PrismaClient {
  if (globalForPrisma.prisma && globalForPrisma.prismaStamp === PRISMA_CLIENT_STAMP) {
    return globalForPrisma.prisma
  }
  const client = new PrismaClient({
    log: process.env.MF_PRISMA_QUERY_LOG === '1' ? ['query'] : ['error', 'warn'],
  })
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
    globalForPrisma.prismaStamp = PRISMA_CLIENT_STAMP
  }
  return client
}

export const db = getClient()
