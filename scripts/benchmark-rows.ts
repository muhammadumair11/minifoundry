#!/usr/bin/env bun
// MiniFoundry — row storage benchmark.
// Measures ingestion, paged read, and export at 10k, 100k, and 1m rows.
// Usage: DATABASE_URL=file:../db/custom.db bun scripts/benchmark-rows.ts

import { db } from '../src/lib/db'
import { createDatasetFromRows, readVersionRowsPaged, type Row } from '../src/lib/dataset-service'

const SIZES = [10_000, 100_000, 1_000_000]
const PAGE_SIZE = 100

function generateRows(count: number): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `row-${i}`,
      name: `Item ${i}`,
      value: Math.round(Math.random() * 10000) / 100,
      active: i % 3 !== 0,
      category: `cat-${i % 50}`,
      description: `Description for item ${i} with some padding text to simulate realistic row sizes`,
    })
  }
  return rows
}

async function benchmark(size: number) {
  console.log(`\n=== Benchmark: ${size.toLocaleString()} rows ===`)

  // Clean up previous benchmark dataset
  const benchName = `benchmark-${size}`
  await db.dataset.deleteMany({ where: { name: benchName } })

  // Generate rows
  const rows = generateRows(size)
  console.log(`Generated ${rows.length} rows (${(JSON.stringify(rows).length / 1024 / 1024).toFixed(1)} MB JSON)`)

  // Ingestion
  const ingestStart = Date.now()
  const result = await createDatasetFromRows({ name: benchName, rows })
  const ingestMs = Date.now() - ingestStart
  console.log(`Ingest: ${ingestMs}ms (${(size / ingestMs * 1000).toFixed(0)} rows/sec)`)

  // Paged read (first page)
  const readStart = Date.now()
  const page1 = await readVersionRowsPaged(result.dataset.id, result.version.versionNumber, 1, PAGE_SIZE)
  const readMs = Date.now() - readStart
  console.log(`Read page 1: ${readMs}ms (${page1.rows.length} rows, total=${page1.total})`)

  // Paged read (middle page)
  const midPage = Math.floor(size / PAGE_SIZE / 2)
  const midStart = Date.now()
  const pageMid = await readVersionRowsPaged(result.dataset.id, result.version.versionNumber, midPage, PAGE_SIZE)
  const midMs = Date.now() - midStart
  console.log(`Read page ${midPage}: ${midMs}ms (${pageMid.rows.length} rows)`)

  // Paged read (last page)
  const lastPage = Math.ceil(size / PAGE_SIZE)
  const lastStart = Date.now()
  const pageLast = await readVersionRowsPaged(result.dataset.id, result.version.versionNumber, lastPage, PAGE_SIZE)
  const lastMs = Date.now() - lastStart
  console.log(`Read page ${lastPage}: ${lastMs}ms (${pageLast.rows.length} rows)`)

  // Memory estimate
  const memUsage = process.memoryUsage()
  console.log(`Memory: heap=${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB, rss=${(memUsage.rss / 1024 / 1024).toFixed(1)}MB`)

  // Cleanup
  await db.dataset.deleteMany({ where: { name: benchName } })

  return { size, ingestMs, readMs, midMs, lastMs }
}

async function main() {
  console.log('MiniFoundry Row Storage Benchmark')
  console.log('=================================')

  const results: Array<{ size: number; ingestMs: number; readMs: number; midMs: number; lastMs: number }> = []
  for (const size of SIZES) {
    try {
      results.push(await benchmark(size))
    } catch (err) {
      console.error(`Benchmark failed at ${size}:`, err instanceof Error ? err.message : err)
      results.push({ size, ingestMs: -1, readMs: -1, midMs: -1, lastMs: -1 })
    }
  }

  console.log('\n=== Summary ===')
  console.log('Size\t\tIngest\t\tRead(p1)\tRead(mid)\tRead(last)')
  for (const r of results) {
    console.log(`${r.size.toLocaleString()}\t\t${r.ingestMs}ms\t\t${r.readMs}ms\t\t${r.midMs}ms\t\t${r.lastMs}ms`)
  }
}

main().catch(console.error)
