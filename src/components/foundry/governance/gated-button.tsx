'use client'

// Governance — button that renders disabled with an explanatory tooltip when
// the current role lacks permission (e.g. "requires admin role").

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function GatedButton({
  allowed,
  reason,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { allowed: boolean; reason: string }) {
  if (allowed) {
    return <Button {...props}>{children}</Button>
  }
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper: disabled buttons swallow pointer events, so the
              tooltip must attach to an enabled element */}
          <span className="inline-flex cursor-not-allowed" aria-disabled="true">
            <Button {...props} disabled tabIndex={-1}>
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-[11px]">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
