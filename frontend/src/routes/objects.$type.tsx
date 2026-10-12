import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/object-type'

export const Route = createFileRoute('/objects/$type')({
  component: Page,
})