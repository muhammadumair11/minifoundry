import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/governance'

export const Route = createFileRoute('/governance')({
  component: Page,
})