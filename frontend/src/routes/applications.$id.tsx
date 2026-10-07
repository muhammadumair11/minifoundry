import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/application-detail'

export const Route = createFileRoute('/applications/$id')({
  component: Page,
})