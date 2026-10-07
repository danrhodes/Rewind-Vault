# PLAN.md — Vault Backup Plugin Spec

## 1. Goal
Plugin: **Rewind Vault** (id `rewind-vault`). All command names use the prefix "Rewind Vault:".
Obsidian plugin, mobile + desktop. Backup and restore stored inside the local vault. Every feature configurable. Optional backup on open, optional scheduled/background backup, optional verification of each backup.

## 2. Platform constraints
- Mobile (iOS/Android) suspends the app in background. No true background backup. Triggers: startup, resume (foreground), foreground timers, edit events.
- Desktop runs while Obsidian is open, including minimized.
- `manifest.json`: `isDesktopOnly: false`. Gate desktop features with `Platform.isDesktop`.
- Storage via `app.vault.adapter` only (mobile-safe). Node `fs` allowed only in `storage/ExternalCopy.ts`, behind a platform check.
- Large vaults: stream and chunk. Yield to UI between chunks. Avoid whole-vault buffers.
- Backup folder inside the vault: always excluded from its own backup. Warn the user to exclude it from Sync/iCloud/Git.

## 3. Architecture rules
- `core/` imports only `storage/`, `crypto/`, `helpers/`, `types.ts`, `constants.ts`.
- `core/` never imports `ui/`, `triggers/`, `commands/`, or `obsidian` types beyond `storage/` abstractions.
- `triggers/` call `BackupEngine`. Never the reverse.
- `ui/` and `commands/` call engines through a `services` object created in `main.ts`.
- `main.ts` contains lifecycle only: load settings, build services, register triggers/commands/UI, unload cleanup.
- Dependency injection: engines take interfaces (`IVaultStore`, `ILogger`, `IClock`). Tests pass mocks.

## 4. File structure
```
src/
  main.ts
  types.ts
  constants.ts
  services.ts                 Service container (DI)
  settings/   defaults.ts SettingsTab.ts profiles.ts migrate.ts transfer.ts
  core/       BackupEngine.ts RestoreEngine.ts VerifyEngine.ts Scanner.ts Differ.ts
              Packer.ts Unpacker.ts Splitter.ts Manifest.ts Retention.ts
              Checkpoint.ts LockManager.ts MassChangeGuard.ts
  crypto/     kdf.ts cipher.ts hash.ts sign.ts
  triggers/   Scheduler.ts StartupTrigger.ts ResumeTrigger.ts EventTrigger.ts
              CloseTrigger.ts Conditions.ts
  storage/    VaultStore.ts AtomicWriter.ts FreeSpace.ts ExternalCopy.ts
  ui/         StatusBar.ts BackupBrowserModal.ts RestorePreviewModal.ts DiffModal.ts
              ProgressModal.ts VerifyReportModal.ts notify.ts
  commands/   register.ts
  helpers/    glob.ts format.ts chunk.ts yieldToUI.ts platform.ts logger.ts errors.ts time.ts
tests/
  mocks/      MockVaultStore.ts MockClock.ts MockLogger.ts
  core/ crypto/ triggers/ storage/ helpers/
```

## 5. Tooling
- TypeScript strict. esbuild bundle. Vitest. ESLint + Prettier.
- Libraries: `fflate` (ZIP streaming), Web Crypto API (AES-GCM, PBKDF2, HMAC, SHA-256).
- Scripts: `typecheck`, `lint`, `test`, `build`, `dev`.
- No runtime dependencies beyond `fflate`. Justify any addition in Decisions.

## 6. Data formats

### Backup folder layout (default `backup/`, configurable)
```
backup/
  index.json                    Registry of backups (id, type, time, status, pinned, size)
  state.json                    Last-known file state (path → mtime, size, hash) for differential
  lock.json                     Lock file
  checkpoint.json               In-progress resume data
  2026-10-07T21-24-00_full/
    manifest.json
    part-001.zip  part-002.zip ...
  2026-10-08T09-00-00_diff/
    manifest.json
    part-001.zip
  log.txt                       Rotated by size
```

### Manifest (versioned, `schemaVersion`)
- `id`, `type` (full|diff), `baseId`, `createdAt`, `pluginVersion`, `platform`
- `encryption`: `{ enabled, kdf, iterations, salt, algo }`
- `parts[]`: `{ name, size, sha256, entryCount }`
- `entries[]`: `{ path, size, mtime, sha256, part, action (add|change) }`
- `tombstones[]`: `{ path, deletedAt }`
- `status`: `ok | corrupt | partial | in-progress`
- `verify`: `{ lastLevel, lastAt, result }`
- `hmac`: manifest signature (if signing enabled)

### Encryption
- Not ZIP-standard. Per-entry AES-256-GCM, PBKDF2-SHA256 ≥600,000 iterations, random salt + IV per entry.
- Document a decrypt recipe in README (script plus OpenSSL-free steps).
- Unencrypted backups: standard ZIP, openable anywhere.

## 7. Settings (all configurable; separate desktop/mobile profiles)

**Basic**: backup on startup (+ delay 0–300 s), auto-style (off | full | differential | non-destructive), include hidden folders, show legacy commands.
**Destination**: location (inside vault | external copy, desktop), backup folder, restore folder.
**ZIP**: max files per ZIP, max source MB per ZIP, process-over-max toggle, max output ZIP MB (split), compression level 0–9.
**Triggers**: startup, resume, interval (min/h), daily times, after N edits, idle N min, on create/delete/rename, on close (desktop).
**Conditions**: min battery %, skip if no changes, min free space MB, Wi-Fi-only (if synced).
**Exclusions**: glob list, hidden folders, `.obsidian`, `.git`, `node_modules`, trash, backup folder (forced).
**Retention**: keep last N, keep N days, GFS (daily/weekly/monthly), max folder size, pinned exempt.
**Encryption**: enable, passphrase, session cache, prompt-on-demand.
**Verification**: auto-verify after backup (off|L1|L2|L3), sampling %, scheduled deep verify, on-failure actions.
**Safety**: mass-change guard thresholds, pre-restore snapshot, pre-risk snapshots, lock timeout.
**Notifications**: silent | errors | verbose, daily-note failure append, status bar toggle, log size cap.
**Misc**: export/import settings (URI, clipboard, QR), settings passphrase, reset backup state, low-memory mode (mobile).

## 8. Verification levels
| L | Check | Needs |
|---|-------|-------|
| 1 | Structure: central directory readable, entry count = manifest | — |
| 2 | CRC32 per entry | full read |
| 3 | SHA-256 per entry vs manifest | full read + hash |
| 4 | Decrypt all chunks, GCM tag check | passphrase |
| 5 | Chain: every diff links to intact base | all prior backups |
| 6 | Rehearsal: restore to memory, compare to live vault | highest |

On failure: mark `corrupt`, exclude from retention counts, force next backup to full, notify, log, optional daily-note append.

## 9. Engine behavior
**BackupEngine.run(mode)**: acquire lock → check conditions → mass-change guard → scan → diff → split → pack (stream) → atomic write → write manifest → update state → verify (if enabled) → retention → release lock → notify.
**Differential**: compare mtime+size, hash on mismatch. Added/changed go to the ZIP. Deleted become tombstones.
**Non-destructive**: never removes or overwrites previous backups. Only adds.
**Checkpoint**: after each part, write checkpoint. On start, offer resume.
**RestoreEngine**: `preview()` returns add/change/delete lists. Restore targets: vault, folder, file, or file-version. Default target is the restore folder. Overwrite requires explicit choice. Pre-restore safety snapshot runs automatically.
**Chain restore**: full base + diffs in order up to the chosen point; tombstones applied.

## 10. Novel features
- Mass-change guard (ransomware/bad sync/bad plugin): pause, protect last good backup, alert.
- Restore rehearsal: monthly sampled restore + hash compare.
- Per-note time machine: version list across backups, diff, restore.
- Pre-risk snapshots: before updates, bulk rename, bulk delete.
- Pinned milestones: named, retention-exempt.
- Tombstones + "Recover deleted files".
- Restore link report: broken wikilinks caused/fixed.
- Backup health note: `Backup Status.md` with frontmatter for Dataview.
- Sync-conflict detector.
- Content-addressed dedup (P3).
- Recovery records, Reed-Solomon parity (P3).
- QR settings transfer (P3).
- Vault time travel, read-only (P3).
- Edit-volume trigger by words typed (P3).
- Low-battery flush (P3).
- Deferred (P4): cloud targets, plugin API, Todoist/calendar triggers.

## 11. Test strategy
- Unit: every `core/`, `crypto/`, `helpers/` function. Target ≥85% coverage in `core/` and `crypto/`.
- Integration: `MockVaultStore` with generated vaults (small, 1k files, 10k files).
- Property tests: diff + restore round-trip equals original vault.
- Fault injection: kill mid-write, corrupt a byte, truncate a ZIP, wrong passphrase, full disk.
- Manual queue: real Obsidian desktop, iOS, Android (tracked in TRACKER).
- Performance budgets: 10k-file vault differential scan <5 s desktop; UI never blocked >50 ms per chunk.

## 12. Risks
| Risk | Mitigation |
|------|------------|
| Mobile OOM on large vaults | Streaming, chunk size setting, low-memory mode |
| Backup syncs back into itself | Forced exclusion + sync-exclusion warning |
| Passphrase loss | Warn at setup; no recovery; optional recovery key export |
| Corrupt backup undetected | Auto-verify, scheduled deep verify, rehearsal |
| Retention deletes last good backup | Never prune below 1 verified-ok backup |
| Obsidian API change | Isolate in `storage/` and `main.ts` |

## 13. Release checklist
- README: install, settings, decrypt recipe, mobile limits, sync warning.
- `manifest.json`, `versions.json`, `styles.css` (if used).
- Manual test pass on desktop, iOS, Android.
- BRAT beta, then community plugin submission.
