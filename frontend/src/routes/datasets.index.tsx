import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/datasets'

export const Route = createFileRoute('/datasets/')({
  component: Page,
})