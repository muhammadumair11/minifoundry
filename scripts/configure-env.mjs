import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const template = readFileSync(new URL('.env.example', root), 'utf8')
const demoUsers = process.argv.includes('--demo-users')
const content = template.replace(/^([A-Z_]+)=$/gm, (line, key) => {
  if (key === 'MF_DEMO_USER_PASSWORD' && !demoUsers) return line
  return `${key}=${randomBytes(32).toString('hex')}`
})

// Never overwrite deployed credentials, and never print generated values.
const target = new URL('.env', root)
writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
console.log(`Created private configuration at ${fileURLToPath(target)}. Keep it out of Git.`)
