import { useQuery } from '@tanstack/react-query'
import { apiJson } from '@/lib/foundry-api'
import { permissions } from '@/lib/permissions'
import type { SessionResponse } from '@/lib/foundry-types'

export function usePermissions() {
  const { data: session } = useQuery<SessionResponse>({
    queryKey: ['session'], queryFn: () => apiJson('/api/session'), staleTime: 30_000,
  })
  return permissions(session)
}
