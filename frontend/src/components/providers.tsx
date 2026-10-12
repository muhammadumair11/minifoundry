'use client'

import { useState } from 'react'
import { ThemeProvider, useTheme } from 'next-themes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { seedAuthQueries, type AuthBootstrap } from '@/lib/auth-bootstrap'

// Toasts follow the resolved theme so light (default) and dark both read well.
function ThemedToaster() {
  const { resolvedTheme } = useTheme()
  return (
    <Toaster
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      richColors
      position="bottom-right"
      toastOptions={{
        style: {
          fontFamily: 'var(--font-geist-sans)',
        },
      }}
    />
  )
}

export function Providers({ children, initialAuth }: { children: React.ReactNode; initialAuth?: AuthBootstrap | null }) {
  const [queryClient] = useState(
    () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
      seedAuthQueries(client, initialAuth)
      return client
    },
  )

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      themes={['light', 'dark']}
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        {children}
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  )
}
