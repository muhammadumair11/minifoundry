import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/learn'

export const Route = createFileRoute('/learn')({
  component: Page,
})