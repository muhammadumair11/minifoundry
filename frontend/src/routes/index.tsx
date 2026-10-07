import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/home'

export const Route = createFileRoute('/')({
  component: Page,
})