import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/ontology'

export const Route = createFileRoute('/ontology')({
  component: Page,
})