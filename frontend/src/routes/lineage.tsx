import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/lineage'

export const Route = createFileRoute('/lineage')({
  component: Page,
})