// Keep this contract aligned with mf-compute engine::assign_table_names.
const protectedTables = new Set([
  'project', 'connector', 'ingestion', 'dataset', 'datasetversion', 'pipeline',
  'pipelinerun', 'schedule', 'objecttype', 'property', 'linktype', 'actiontype',
  'actionlog', 'lineageedge', 'marking', 'columnmarking', 'approvalrequest',
  'auditentry', 'transform', 'transformrun', '_prisma_migrations',
  'sqlite_sequence', 'sqlite_stat1', 'sqlite_schema', 'sqlite_master',
])

export function workbookTableNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    const base = Array.from(name.toLowerCase()).map((c) => /[a-z0-9_]/.test(c) ? c : '_').join('') || 'table'
    let table = base
    let suffix = 2
    while (used.has(table) || protectedTables.has(table)) table = `${base}_${suffix++}`
    used.add(table)
    return table
  })
}

export function workbookSqlStarter(names: string[]): string {
  const first = workbookTableNames(names)[0]
  return first ? `SELECT *\nFROM "${first}"\nLIMIT 20` : 'SELECT 1 AS example'
}
