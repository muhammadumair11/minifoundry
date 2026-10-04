# MiniFoundry Row Storage Benchmarks

Measured on Windows with SQLite, Node 22, Bun runtime.

## Results (2026-10-04)

| Size | Ingest | Read (page 1) | Read (mid) | Read (last) | Heap | RSS |
|------|--------|---------------|------------|-------------|------|-----|
| 10,000 | 1,481ms (6,752 rows/s) | 9ms | 7ms | 10ms | 11.6 MB | 247 MB |
| 100,000 | 26,640ms (3,754 rows/s) | 145ms | 145ms | 141ms | 98.0 MB | 325 MB |
| 1,000,000 | 231,682ms (4,316 rows/s) | 366ms | 683ms | 631ms | 746 MB | 1,061 MB |

## Key findings

- **Paged reads scale well**: Even at 1M rows, page reads stay under 700ms because they use indexed SQLite queries instead of parsing the entire JSON blob.
- **Ingest is batch-bound**: Write throughput is limited by SQLite transaction overhead. Batched inserts (100 rows/batch) keep variable counts manageable.
- **Memory grows with dataset size**: The JSON serialization during ingest dominates memory. Streaming ingestion would reduce peak heap.
- **No silent truncation**: Versions above MAX_ROWS fail explicitly rather than dropping rows.

## Configuration

Set `MAX_ROWS` environment variable to override the default 5,000 row limit:

```bash
MAX_ROWS=100000 bun run dev
```

## Future improvements

- Stream ingestion to avoid holding all rows in memory
- Columnar storage (Parquet) for analytical workloads
- Connection pooling for concurrent reads
