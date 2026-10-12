import { createFileRoute } from '@tanstack/react-router'
import Page from '@/pages/invite-accept'

export const Route = createFileRoute('/invite/$token')({
  component: Page,
})