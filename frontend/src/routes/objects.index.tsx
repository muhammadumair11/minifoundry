import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/objects'

export const Route = createFileRoute('/objects/')({
  component: Page,
})