import { Button } from '@/components/ui/button'
import { usePermissions } from '@/lib/use-permissions'

/** Data mutation controls shared by ingestion, pipelines and scheduling. */
export function EditorButton(props: React.ComponentProps<typeof Button>) {
  const { canEdit } = usePermissions()
  return canEdit ? <Button {...props} /> : null
}
