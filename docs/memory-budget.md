# Memory budget

Rewind Vault builds one ZIP part at a time and holds that part in memory while it is hashed and
written. So peak memory is driven by the part size limits, not by vault size.

Planning figure (`estimatePeakMb` in `src/helpers/memoryBudget.ts`):
`min(max source MB, max output MB) x 2 + chunk size x 2`.

| Profile | Part limit | Chunk | Peak (about) |
|---|---|---|---|
| Desktop default | 500 MB | 1024 KB | 1000 MB |
| Mobile default | 50 MB | 256 KB | 100 MB |
| Low-memory mode | 16 MB (files per part 500) | 64 KB | 32 MB |

Low-memory mode only ever lowers a setting: someone who chose a smaller part size keeps it.
It also shortens the longest uninterrupted work slice from 30 ms to 10 ms, so the UI keeps
redrawing on slow phones. The limits are applied in `resolveProfile`, so backup, restore,
verify and rehearsal all see the same values.

What low-memory mode costs: more, smaller ZIP parts, and a slower backup. Backups stay standard
ZIPs and restore the same way.

Not measured: these are estimates. Real-device figures go in the Manual Test Queue (MT-31).
