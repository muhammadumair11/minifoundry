import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/projects'

export const Route = createFileRoute('/projects')({
  component: Page,
})