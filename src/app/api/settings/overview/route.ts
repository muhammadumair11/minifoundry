// GET /api/settings/overview — platform-wide counts for the Settings page.
// Readable by ANY role: aggregate numbers only, no secrets, nothing audited.

import { jsonOk, serverError } from '@/lib/api-utils'
import { getWorkspaceOverview } from '@/lib/settings-service'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const overview = await getWorkspaceOverview()
    return jsonOk(overview)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load workspace overview')
  }
}
