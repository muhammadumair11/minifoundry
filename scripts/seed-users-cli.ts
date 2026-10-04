// MiniFoundry — seed the three M9 demo users (real password auth).
// Idempotent: upserts by email (update branch is empty, so re-running never
// clobbers role changes / deactivations). Password for all: '<redacted>'.
// Usage: cd /home/z/my-project && bun scripts/seed-users-cli.ts

import { db } from '../src/lib/db'
import { ensureSeedUsers } from '../src/lib/seed'

async function main() {
  const users = await ensureSeedUsers()
  console.log(JSON.stringify({
    ensured: users.length,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    })),
  }))

  // Cross-check: the total users in the DB (there may be extra API-created ones).
  const total = await db.user.count()
  console.log(JSON.stringify({ totalUsers: total }))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
