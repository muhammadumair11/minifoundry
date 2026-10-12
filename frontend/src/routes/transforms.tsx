import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/transforms'

export const Route = createFileRoute('/transforms')({
  component: Page,
})