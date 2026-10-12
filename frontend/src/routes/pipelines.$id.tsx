import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/pipeline-detail'

export const Route = createFileRoute('/pipelines/$id')({
  component: Page,
})