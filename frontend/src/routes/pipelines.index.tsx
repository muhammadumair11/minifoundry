import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/pipelines'

export const Route = createFileRoute('/pipelines/')({
  component: Page,
})