import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/orchestration'

export const Route = createFileRoute('/orchestration')({
  component: Page,
})