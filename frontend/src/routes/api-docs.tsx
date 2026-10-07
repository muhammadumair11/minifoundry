import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/api-docs'

export const Route = createFileRoute('/api-docs')({
  component: Page,
})