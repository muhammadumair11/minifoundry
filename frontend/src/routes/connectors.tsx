import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/connectors'

export const Route = createFileRoute('/connectors')({
  component: Page,
})