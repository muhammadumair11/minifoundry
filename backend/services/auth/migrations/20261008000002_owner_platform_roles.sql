-- Organization owners are platform administrators in the legacy role surface.
-- This keeps accounts created before the organization signup flow consistent
-- with accounts created after it.
UPDATE users u
SET role = 'admin'
FROM organization_memberships m
WHERE m.user_id = u.id
  AND m.role = 'owner'
  AND u.role <> 'admin';
