// One-off cleanup: strip empty `oneOf: []` arrays from stored ActionType
// parametersJson so the persisted contract matches the normalized writer
// (empty allowed-value lists are omitted). Run: node .zscripts/normalize-action-oneof.cjs
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
  const actions = await p.actionType.findMany({ select: { id: true, apiName: true, parametersJson: true } })
  let changed = 0
  for (const a of actions) {
    let params
    try {
      params = JSON.parse(a.parametersJson)
    } catch {
      console.log(`skip ${a.apiName}: unparseable parametersJson`)
      continue
    }
    if (!Array.isArray(params)) continue
    let dirty = false
    const next = params.map((param) => {
      if (!param || typeof param !== 'object') return param
      const oneOf = Array.isArray(param.oneOf) ? param.oneOf.filter((o) => typeof o === 'string' && o.trim() !== '') : null
      if (oneOf === null) return param
      dirty = true
      if (oneOf.length > 0) return { ...param, oneOf }
      const { oneOf: _drop, ...rest } = param
      return rest
    })
    if (dirty) {
      await p.actionType.update({ where: { id: a.id }, data: { parametersJson: JSON.stringify(next) } })
      changed += 1
      console.log(`normalized ${a.apiName}`)
    }
  }
  console.log(`done — ${changed} of ${actions.length} action types updated`)
  await p.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
