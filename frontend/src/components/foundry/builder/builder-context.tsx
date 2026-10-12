'use client'

import { createContext, useContext, useMemo } from 'react'
import type { DatasetSummary } from '@/lib/foundry-types'

export const BuilderDatasetsContext = createContext<DatasetSummary[]>([])

export function useBuilderDatasets(): DatasetSummary[] {
  return useContext(BuilderDatasetsContext)
}

export function useDatasetsById(): Map<string, DatasetSummary> {
  const datasets = useBuilderDatasets()
  return useMemo(() => new Map(datasets.map((d) => [d.id, d])), [datasets])
}
