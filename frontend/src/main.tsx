import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './fonts.css'
import './globals.css'
import { routeTree } from './routeTree.gen'

// NOTE: no <StrictMode> — the legacy Next.js app ran with
// reactStrictMode: false; keep effect timing identical.

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
