import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/api-tokens'

export const Route = createFileRoute('/api-tokens')({
  component: Page,
})