// MiniFoundry — R14 dataset branching & merge service.
//
// Version numbers are GLOBAL per dataset (unique across branches):
//   next versionNumber = max(versionNumber over ALL versions of the dataset) + 1.
// "main" head = the version with the highest versionNumber among branch='main'
// versions. A feature branch head = branch.headVersion (a version whose
// `branch` column equals the branch name, or the base main version when the
// branch has no commits yet).
//
// Merges COPY the branch head's data as a NEW main version — branch versions
// are never rewritten (immutability), they simply remain as history.

import { db } from '@/lib/db'
import { emitVersionCreated, getHeadVersionNumber } from '@/lib/version-events'
import type { DatasetBranchInfo, DatasetBranchesResponse, MergeBranchResponse } from '@/lib/foundry-types'
import type { DatasetBranch } from '@prisma/client'
import { MAX_ROWS, inferSchema, normalizeRows, pruneDatasetVersions, type Row } from '@/lib/dataset-service'

function serializeBranch(b: DatasetBranch): DatasetBranchInfo {
  return {
    id: b.id,
    datasetId: b.datasetId,
    name: b.name,
    baseVersion: b.baseVersion,
    headVersion: b.headVersion,
    mergedAt: b.mergedAt ? b.mergedAt.toISOString() : null,
    mergedInto: b.mergedInto,
    description: b.description,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
  }
}

/** List all branches of a dataset + the current main head version number. */
export async function listBranches(datasetId: string): Promise<DatasetBranchesResponse> {
  const [branches, mainHeadRow] = await Promise.all([
    db.datasetBranch.findMany({ where: { datasetId }, orderBy: { createdAt: 'asc' } }),
    db.datasetVersion.findFirst({
      where: { datasetId, branch: 'main' },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    }),
  ])
  return {
    branches: branches.map(serializeBranch),
    mainHead: mainHeadRow?.versionNumber ?? 0,
  }
}

/** Resolve a branch name to its head version number ('main' → main head). Null when unknown. */
export async function resolveBranchHead(datasetId: string, branchName: string): Promise<number | null> {
  if (branchName === 'main') {
    const head = await db.datasetVersion.findFirst({
      where: { datasetId, branch: 'main' },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    })
    return head?.versionNumber ?? null
  }
  const branch = await db.datasetBranch.findUnique({
    where: { datasetId_name: { datasetId, name: branchName } },
    select: { headVersion: true },
  })
  return branch?.headVersion ?? null
}

export interface CreateBranchInput {
  name: string
  description?: string | null
  baseVersion?: number
}

/** Append an isolated branch commit. The expected head prevents stale edits. */
export async function commitBranchVersion(
  datasetId: string,
  branchId: string,
  rows: Row[],
  expectedHeadVersion: number,
  createdBy: string,
): Promise<{ branchName: string; versionNumber: number; rowCount: number }> {
  if (rows.length > MAX_ROWS) throw new BranchError(`Branch commits are limited to ${MAX_ROWS} rows`, 400)
  const branch = await db.datasetBranch.findFirst({ where: { id: branchId, datasetId } })
  if (!branch) throw new BranchError('Branch not found', 404)
  if (branch.headVersion !== expectedHeadVersion) throw new BranchError('Branch head changed; reload before committing', 409)
  const normalized = normalizeRows(rows)
  const next = (await getHeadVersionNumber(datasetId)) + 1
  await db.$transaction(async (tx) => {
    const updated = await tx.datasetBranch.updateMany({
      where: { id: branchId, datasetId, headVersion: expectedHeadVersion },
      data: { headVersion: next, mergedAt: null, mergedInto: null },
    })
    if (updated.count !== 1) throw new BranchError('Branch head changed; reload before committing', 409)
    await tx.datasetVersion.create({
      data: {
        datasetId, versionNumber: next, branch: branch.name,
        parentVersion: expectedHeadVersion, createdBy,
        lifecycle: 'draft', rowCount: normalized.length,
        schemaJson: JSON.stringify(inferSchema(normalized)), dataJson: JSON.stringify(normalized),
      },
    })
    await tx.versionLineageEdge.create({
      data: {
        fromDatasetId: datasetId, fromVersionNumber: expectedHeadVersion,
        toDatasetId: datasetId, toVersionNumber: next,
      },
    })
  })
  return { branchName: branch.name, versionNumber: next, rowCount: normalized.length }
}

/** Create a branch pointing at a main version (defaults to the main head). */
export async function createBranch(
  datasetId: string,
  input: CreateBranchInput,
  createdBy: string | null,
): Promise<DatasetBranchInfo> {
  const name = input.name.trim()
  const mainHead = await resolveBranchHead(datasetId, 'main')
  if (mainHead === null) {
    throw new BranchError('Dataset has no main versions to branch from', 400)
  }
  const baseVersion = input.baseVersion ?? mainHead
  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    throw new BranchError(`Invalid baseVersion '${input.baseVersion}'`, 400)
  }
  const base = await db.datasetVersion.findUnique({
    where: { datasetId_versionNumber: { datasetId, versionNumber: baseVersion } },
    select: { branch: true },
  })
  if (!base) {
    throw new BranchError(`Version ${baseVersion} not found on this dataset`, 400)
  }
  if (base.branch !== 'main') {
    throw new BranchError(`baseVersion must be a main version (v${baseVersion} is on branch '${base.branch}')`, 400)
  }
  const dup = await db.datasetBranch.findUnique({
    where: { datasetId_name: { datasetId, name } },
    select: { id: true },
  })
  if (dup) {
    throw new BranchError(`Branch '${name}' already exists`, 409)
  }
  const branch = await db.datasetBranch.create({
    data: {
      datasetId,
      name,
      baseVersion,
      headVersion: baseVersion,
      description: input.description?.trim() || null,
      createdBy,
    },
  })
  return serializeBranch(branch)
}

/**
 * Merge a branch back into main: the branch head version's data becomes a NEW
 * main version (next global number, parent = branch head). Re-merge is allowed
 * once the branch has new commits after the last merge (headVersion changed).
 */
export async function mergeBranch(
  datasetId: string,
  branchId: string,
): Promise<MergeBranchResponse> {
  const branch = await db.datasetBranch.findFirst({ where: { id: branchId, datasetId } })
  if (!branch) throw new BranchError('Branch not found', 404)
  // Already merged with no new commits since: the branch head still sits at or
  // below the merge target (global version numbers only grow on new commits).
  if (branch.mergedAt && branch.headVersion <= (branch.mergedInto ?? 0)) {
    throw new BranchError(
      `Branch '${branch.name}' is already merged into v${branch.mergedInto} (new commits required to merge again)`,
      409,
    )
  }
  const head = await db.datasetVersion.findUnique({
    where: { datasetId_versionNumber: { datasetId, versionNumber: branch.headVersion } },
  })
  if (!head) {
    throw new BranchError(`Branch head version ${branch.headVersion} no longer exists`, 400)
  }
  if (branch.headVersion === branch.baseVersion) {
    throw new BranchError('Branch has no commits to merge', 409)
  }
  const currentMain = await resolveBranchHead(datasetId, 'main')
  if (currentMain !== branch.baseVersion) {
    throw new BranchError(`Main advanced to v${currentMain}; create a fresh branch from current main before merging`, 409)
  }

  const target = await db.dataset.findUnique({ where: { id: datasetId }, select: { qualityGate: true } })

  const nextVersionNumber = (await getHeadVersionNumber(datasetId)) + 1
  const mergedAt = new Date()

  const [, updatedBranch] = await db.$transaction([
    db.datasetVersion.create({
      data: {
        datasetId,
        versionNumber: nextVersionNumber,
        schemaJson: head.schemaJson,
        rowCount: head.rowCount,
        dataJson: head.dataJson,
        createdBy: `branch-merge:${branch.name}`,
        branch: 'main',
        parentVersion: branch.headVersion,
        lifecycle: target?.qualityGate ? 'draft' : 'published',
      },
    }),
    db.datasetBranch.update({
      where: { id: branch.id },
      data: { baseVersion: nextVersionNumber, mergedAt, mergedInto: nextVersionNumber },
    }),
    db.versionLineageEdge.create({
      data: {
        fromDatasetId: datasetId, fromVersionNumber: branch.headVersion,
        toDatasetId: datasetId, toVersionNumber: nextVersionNumber,
      },
    }),
    db.dataset.update({
      where: { id: datasetId },
      data: { updatedAt: mergedAt, ...(target?.qualityGate ? {} : { publishedVersion: nextVersionNumber }) },
    }),
  ])

  // Retention safety: prunes only main versions and never a branch head/base.
  const ds = await db.dataset.findUnique({ where: { id: datasetId }, select: { keepLastN: true } })
  if (ds) await pruneDatasetVersions(datasetId, ds.keepLastN)

  await emitVersionCreated({
    datasetId,
    versionNumber: nextVersionNumber,
    source: `branch-merge:${branch.name}`,
  })

  return {
    mergedVersion: nextVersionNumber,
    rowsMerged: head.rowCount,
    branchName: updatedBranch.name,
  }
}

/** Delete an UNMERGED branch pointer. Branch version rows stay (they are history). */
export async function deleteBranch(datasetId: string, branchId: string): Promise<DatasetBranch> {
  const branch = await db.datasetBranch.findFirst({ where: { id: branchId, datasetId } })
  if (!branch) throw new BranchError('Branch not found', 404)
  if (branch.mergedAt) {
    throw new BranchError(`Branch '${branch.name}' is merged (v${branch.mergedInto}) and cannot be deleted`, 409)
  }
  await db.datasetBranch.delete({ where: { id: branch.id } })
  return branch
}

/** Typed error so routes can map to the right HTTP status. */
export class BranchError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Branch heads/bases that retention must never prune. */
export async function protectedVersionNumbers(datasetId: string): Promise<Set<number>> {
  const branches = await db.datasetBranch.findMany({
    where: { datasetId },
    select: { headVersion: true, baseVersion: true },
  })
  const set = new Set<number>()
  for (const b of branches) {
    set.add(b.headVersion)
    set.add(b.baseVersion)
  }
  return set
}
