import * as React from 'react'
import { cn } from '@/lib/utils'

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'pointer-events-none inline-flex shrink-0 select-none items-center rounded border border-current/30 px-1.5 font-mono text-[10px] font-medium leading-5 opacity-70',
        className,
      )}
      {...props}
    />
  )
}
