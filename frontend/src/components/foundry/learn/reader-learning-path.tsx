import Link from '@/components/link'
import { usePermissions } from '@/lib/use-permissions'

export function ReaderLearningPath() {
  const access = usePermissions()
  const tasks = [
    { href: '/datasets', title: 'Inspect a dataset', description: 'Search rows, compare versions, inspect the schema and export a CSV.' },
    { href: '/lineage', title: 'Follow the data', description: 'Trace a source through its pipeline and inspect the derived dataset.' },
    { href: '/objects', title: 'Explore objects', description: 'Search business objects, inspect properties and follow their links.' },
    { href: '/applications', title: 'Use an application', description: 'Select a page, filter the data and inspect a chart or table.' },
    ...(access.canManageMembers ? [{ href: '/settings#organization', title: 'Manage Editors and Viewers', description: 'Inspect the roster, invite a member and review the roles you can assign.' }] : []),
    ...(access.canAudit ? [{ href: '/governance', title: 'Review organization activity', description: 'Inspect members and filter the audit trail by action or resource.' }] : []),
  ]
  return <div className="space-y-3 rounded-lg border bg-card p-4">
    <h2 className="text-sm font-medium">Your learning path</h2>
    <p className="text-xs text-muted-foreground">Practice the workflows available to your role. Editors and administrators handle data creation and changes.</p>
    <ol className="space-y-3">{tasks.map((task, index) => <li key={task.href} className="flex gap-3 rounded border p-3"><span className="text-xs text-muted-foreground">{index + 1}</span><div><Link href={task.href} className="text-sm font-medium underline underline-offset-4">{task.title}</Link><p className="mt-1 text-xs text-muted-foreground">{task.description}</p></div></li>)}</ol>
  </div>
}
