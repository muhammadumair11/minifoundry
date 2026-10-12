import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/settings'

export const Route = createFileRoute('/settings')({
  component: Page,
})