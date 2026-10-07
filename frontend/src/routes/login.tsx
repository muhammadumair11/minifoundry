import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/login'

export const Route = createFileRoute('/login')({
  component: Page,
})