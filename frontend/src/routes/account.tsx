import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/account'

export const Route = createFileRoute('/account')({
  component: Page,
})
