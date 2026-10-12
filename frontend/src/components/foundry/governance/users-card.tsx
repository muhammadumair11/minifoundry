import { OrganizationSettings } from '@/components/foundry/organization-settings'

/** Compatibility export; member administration is scoped to the active organization. */
export function UsersCard() {
  return <OrganizationSettings rosterOnly />
}
