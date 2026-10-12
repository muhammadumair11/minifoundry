'use client'

// Shared action gate: render only when the current role has permission.

import { Button } from '@/components/ui/button'

export function GatedButton({
  allowed,
  reason,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { allowed: boolean; reason: string }) {
  // Unauthorized actions are absent from the UI.
  if (!allowed) return null
  return <Button {...props}>{children}</Button>
}
