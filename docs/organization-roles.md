# Organization permissions

The database membership in the selected organization determines permissions.
Every authenticated gateway request checks the current membership and account
status, so previously issued JWTs cannot retain privileges after a demotion.

Authentication responses (signup, signin, identity, invitation acceptance, and
refresh) expose `organizationId` and `organizationRole`. The legacy `role` field
is only the service permission level: both an Owner and an Organization Admin
map to `admin`. Identity badges and authentication messages display the actual
organization role, never infer ownership from `admin`.
Protected-route bootstrap loads session and organization identity before the
shell mounts and seeds both query caches. Every signin path (including an
already-authenticated account) starts a fresh shell. App HTML is revalidated
on navigation; hashed assets remain immutable.

| Organization role | Data access | Member roster | Invitations and role changes | Governance administration / API tokens | Audit |
| --- | --- | --- | --- | --- | --- |
| Organization Owner | Read and edit | Read | All non-owner roles | Yes | Read |
| Organization Admin | Read and edit | Read | All non-owner roles | Yes | Read |
| Access Manager | Read | Read | Editors and Viewers only | No | No |
| Auditor | Read | Read | No | No | Read |
| Editor | Read and edit | No | No | No | No |
| Viewer | Read | No | No | No | No |

Ownership and self-role changes are protected. Member management in Settings
and Governance uses the same organization component and policy. In shared mode,
the legacy global account-management endpoint, role simulator, and global
workspace reset are unavailable. Role simulation and global reset remain demo
features.

Data mutation controls are hidden for readers. Pipeline canvases are read-only
for readers, and navigation and direct-route access to API tokens require admin
data permissions. Switching organizations clears cached data and reloads the
app to prevent the previous organization's cached permissions from appearing.

With the updated local shared-mode Compose stack running:

```sh
node scripts/check-rbac.mjs
node scripts/check-auth-roles.mjs
cd frontend && bun test tests/auth-bootstrap.test.ts
```

The check creates temporary, uniquely identified organization/member fixtures,
checks all six roles, header spoofing, immediate demotion, disabled accounts,
protected roles, and token-revocation scope, then removes its fixtures.
The authentication check exercises real signup, password signin for every
organization role, transparent refresh, and organization selection across
signout/signin. Credentials and cookies stay in memory; fixtures are removed.
