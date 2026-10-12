import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/dashboard-detail'

export const Route = createFileRoute('/dashboards/$id')({
  component: Page,
})