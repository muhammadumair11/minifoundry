import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/dataset-detail'

export const Route = createFileRoute('/datasets/$id')({
  component: Page,
})