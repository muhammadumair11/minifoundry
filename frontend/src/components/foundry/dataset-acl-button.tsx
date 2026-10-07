'use client'

// Small local wrapper so the dataset page can render the 14-e ACL dialog
// without a hard build dependency if the shared component moves/changes.

import AclDialog from '@/components/foundry/acl-dialog'

export default function DatasetAclButton({
  datasetId,
  canManage,
}: {
  datasetId: string
  canManage: boolean
}) {
  return <AclDialog resourceType="dataset" resourceId={datasetId} canManage={canManage} />
}
