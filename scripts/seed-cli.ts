// MiniFoundry — tiny CLI runner for the seeder.
// Usage: cd /home/z/my-project && bun scripts/seed-cli.ts

import { seedDatabase } from '../src/lib/seed'

seedDatabase()
  .then((r) => {
    console.log(JSON.stringify(r))
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
