import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/applications'

export const Route = createFileRoute('/applications/')({
  component: Page,
})