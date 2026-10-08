import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/signup'

export const Route = createFileRoute('/signup')({
  component: Page,
})
