import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/data-sources'

export const Route = createFileRoute('/data-sources')({
  component: Page,
})