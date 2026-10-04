'use client'

// Governance console (M9) — roles & capabilities, ABAC markings, approval
// flow, audit trail (Task 4-c). The four sections teach the model and operate
// it: switch roles in the header to watch masking and permissions react live.

import { ShieldCheck } from 'lucide-react'
import { RoleCapabilitiesCard } from '@/components/foundry/governance/role-capabilities-card'
import { MarkingsCard } from '@/components/foundry/governance/markings-card'
import { ApprovalsCard } from '@/components/foundry/governance/approvals-card'
import { UsersCard } from '@/components/foundry/governance/users-card'
import { AuditLogCard } from '@/components/foundry/governance/audit-card'

export default function GovernancePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium tracking-tight text-foreground">Governance</h1>
        <span className="text-xs text-muted-foreground">
          roles · markings · approvals · audit — the control plane
        </span>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <RoleCapabilitiesCard />
        </div>
        <div className="lg:col-span-3">
          <MarkingsCard />
        </div>
        <div className="lg:col-span-2">
          <ApprovalsCard />
        </div>
        <div className="lg:col-span-3">
          <UsersCard />
        </div>
        <div className="lg:col-span-5">
          <AuditLogCard />
        </div>
      </div>
    </div>
  )
}
