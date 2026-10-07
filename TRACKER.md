# TRACKER.md — Build State

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
Format: `T-ID [Pn] description | deps | acceptance`
Priority: P1 now · P2 schedule · P3 delegate/later · P4 defer.

## Status
- Current phase: 2
- Last session: 2026-10-07
- Next task: T-032 (T-005 awaiting MT-1)
- Tasks done: 21 / 118

---

## Phase 0 — Scaffold
- [x] T-001 [P1] Init repo, `package.json`, tsconfig strict, esbuild, vitest, eslint, prettier | — | all 4 scripts run green on empty project
- [x] T-002 [P1] `manifest.json` (id `rewind-vault`, name "Rewind Vault", `isDesktopOnly:false`), `versions.json`, `main.ts` stub that loads/unloads | T-001 | builds `main.js`; id has no "obsidian"
- [x] T-003 [P1] Folder skeleton per PLAN §4 with empty index files | T-001 | structure matches plan
- [x] T-004 [P1] Mock layer: `MockVaultStore`, `MockClock`, `MockLogger` in `tests/mocks` | T-003 | used by one passing sample test
- [~] T-005 [P2] CI workflow: typecheck, lint, test, build | T-001 | green on push

## Phase 1 — Foundations
- [x] T-010 [P1] `types.ts`: Settings, Manifest, BackupEntry, FileInfo, VerifyReport, BackupIndex | T-003 | compiles, no `any`
- [x] T-011 [P1] `constants.ts`: schema versions, file names, defaults | T-010 | —
- [x] T-012 [P1] `helpers/errors.ts` typed error classes | T-010 | unit tests
- [x] T-013 [P1] `helpers/logger.ts` with level + rotating file sink | T-004 | rotation test
- [x] T-014 [P1] `helpers/time.ts`, `format.ts` (bytes, durations, timestamps for folder names) | T-010 | unit tests
- [x] T-015 [P1] `helpers/glob.ts` exclusion matcher | T-010 | tests for `**`, `*`, negation, hidden dirs
- [x] T-016 [P1] `helpers/chunk.ts`, `yieldToUI.ts` | T-010 | chunker tests; yield returns control
- [x] T-017 [P1] `helpers/platform.ts` (isMobile, isDesktop, battery, visibility wrappers) | T-010 | mockable
- [x] T-018 [P1] `storage/VaultStore.ts` adapter wrapper (read/write binary, list, stat, mkdir, remove, rename) | T-010,T-004 | contract tests run on Mock + real impl shape
- [x] T-019 [P1] `storage/AtomicWriter.ts` temp → rename | T-018 | fault test: crash mid-write leaves old file intact
- [x] T-020 [P2] `storage/FreeSpace.ts` estimate + precheck | T-018 | tests
- [x] T-021 [P1] `settings/defaults.ts` full defaults, desktop + mobile profiles | T-010 | typed against Settings
- [x] T-022 [P1] `settings/profiles.ts` resolveProfile(platform) | T-021,T-017 | tests
- [x] T-023 [P1] `settings/migrate.ts` | T-021 | old → new fixture tests
- [x] T-024 [P1] `services.ts` DI container | T-018,T-013 | main wires it

## Phase 2 — Crypto
- [x] T-030 [P1] `crypto/hash.ts` streaming SHA-256 | T-016 | known-vector tests
- [x] T-031 [P1] `crypto/kdf.ts` PBKDF2 ≥600k, salt gen | T-010 | vector tests; iterations configurable
- [ ] T-032 [P1] `crypto/cipher.ts` AES-256-GCM chunked encrypt/decrypt | T-031 | round-trip; tamper fails; wrong key fails
- [ ] T-033 [P2] `crypto/sign.ts` HMAC manifest signing | T-031 | tamper detection test
- [ ] T-034 [P2] Session passphrase cache + prompt-on-demand service | T-031 | cleared on unload

## Phase 3 — Core backup
- [ ] T-040 [P1] `core/Scanner.ts` list files with exclusions, hidden toggle, forced backup-folder exclusion | T-015,T-018 | tests incl. hidden/trash/.git
- [ ] T-041 [P1] `core/Manifest.ts` load/save/validate/version | T-010,T-019 | schema validation tests
- [ ] T-042 [P1] `core/Differ.ts` added/changed/deleted via mtime+size then hash | T-040,T-030,T-041 | property tests
- [ ] T-043 [P1] `core/Splitter.ts` max files, max source MB, max output MB, over-max toggle | T-042 | boundary tests
- [ ] T-044 [P1] `core/Packer.ts` fflate streaming ZIP, level 0–9, optional encryption | T-032,T-043 | opens in standard unzip when unencrypted
- [ ] T-045 [P1] `core/LockManager.ts` acquire/release/stale detection | T-019 | concurrent-run test
- [ ] T-046 [P1] `BackupIndex` + `state.json` read/write | T-041 | tests
- [ ] T-047 [P1] `core/BackupEngine.ts` full mode | T-040–T-046 | 1k-file vault round-trip
- [ ] T-048 [P1] BackupEngine differential mode with tombstones | T-047 | chain test
- [ ] T-049 [P1] BackupEngine non-destructive style | T-048 | never deletes prior backups
- [ ] T-050 [P1] Progress + cancel hooks in engine | T-047 | cancel leaves no partial `ok` backup
- [ ] T-051 [P2] `core/Checkpoint.ts` resume interrupted backup | T-047 | kill-and-resume test
- [ ] T-052 [P2] Pre-run free-space check | T-020,T-047 | blocks when below threshold
- [ ] T-053 [P2] Skip-if-no-changes | T-048 | no backup created when diff empty

## Phase 4 — Restore
- [ ] T-060 [P1] `core/Unpacker.ts` stream entries with filter | T-044 | tests
- [ ] T-061 [P1] Chain resolver: base + diffs + tombstones to a point in time | T-060,T-041 | tests
- [ ] T-062 [P1] `RestoreEngine.preview()` add/change/delete lists | T-061 | tests
- [ ] T-063 [P1] Restore single file | T-061 | tests
- [ ] T-064 [P1] Restore folder | T-063 | tests
- [ ] T-065 [P1] Restore whole vault, default to restore folder, explicit overwrite option | T-064 | no overwrite by default
- [ ] T-066 [P1] Automatic pre-restore safety snapshot | T-065,T-047 | snapshot exists before any write
- [ ] T-067 [P2] Restore progress + cancel | T-065 | tests
- [ ] T-068 [P2] Restore specific file version across backups | T-063 | tests

## Phase 5 — Verification
- [ ] T-070 [P1] `VerifyEngine` L1 structure | T-060 | corrupt-header fixture detected
- [ ] T-071 [P1] L2 CRC | T-070 | flipped-byte fixture detected
- [ ] T-072 [P1] L3 SHA-256 vs manifest | T-071,T-030 | tampered-entry fixture detected
- [ ] T-073 [P1] Auto-verify after backup, configurable level | T-072,T-047 | setting honoured
- [ ] T-074 [P1] Failure handling: mark corrupt, exclude from retention, force next full | T-073 | state transitions tested
- [ ] T-075 [P2] L4 decrypt check | T-072,T-032 | wrong passphrase reported, not crash
- [ ] T-076 [P2] L5 chain verification | T-072 | broken-base fixture detected
- [ ] T-077 [P2] Sampling verify (X% random entries) | T-072 | deterministic with seed in tests
- [ ] T-078 [P2] Scheduled deep verify | T-076 | wired to scheduler (T-082)
- [ ] T-079 [P3] L6 rehearsal (restore to memory, compare to live) | T-076,T-061 | tests

## Phase 6 — Triggers & conditions
- [ ] T-080 [P1] `triggers/Conditions.ts` battery, free space, no-change | T-017,T-020 | tests
- [ ] T-081 [P1] `StartupTrigger` onLayoutReady + delay | T-047 | fake-timer test
- [ ] T-082 [P1] `Scheduler` interval + daily times via `registerInterval` | T-047 | fake-timer tests
- [ ] T-083 [P1] `ResumeTrigger` visibilitychange, min-gap setting | T-047 | tests
- [ ] T-084 [P2] `EventTrigger` N edits, idle N min, create/delete/rename | T-047 | debounce tests
- [ ] T-085 [P2] `CloseTrigger` desktop best effort | T-047 | manual queue
- [ ] T-086 [P2] Trigger de-duplication (no overlapping runs, cooldown) | T-045 | tests

## Phase 7 — Retention
- [ ] T-090 [P1] `Retention` keep-last-N | T-046 | never prune last verified-ok
- [ ] T-091 [P2] Keep-N-days | T-090 | tests
- [ ] T-092 [P2] GFS daily/weekly/monthly | T-090 | tests
- [ ] T-093 [P2] Max folder size, oldest-first | T-090 | tests
- [ ] T-094 [P2] Pinned milestones exempt | T-090 | tests
- [ ] T-095 [P1] Differential chain safety: never prune a base with live dependents | T-090 | tests

## Phase 8 — UI, settings, commands
- [ ] T-100 [P1] `ui/notify.ts` silent/errors/verbose | T-013 | —
- [ ] T-101 [P1] `ui/StatusBar.ts` | T-047 | desktop only; mobile skipped
- [ ] T-102 [P1] `ui/ProgressModal.ts` cancellable | T-050 | —
- [ ] T-103 [P1] `settings/SettingsTab.ts` sections for every PLAN §7 group | T-021 | every setting reachable
- [ ] T-104 [P1] `commands/register.ts` backup now (full/diff), restore, verify, ribbon icon | T-047,T-062,T-073 | palette entries present
- [ ] T-105 [P1] `ui/BackupBrowserModal.ts` list, search, pin, delete, verify | T-046 | —
- [ ] T-106 [P1] `ui/RestorePreviewModal.ts` with selective checkboxes | T-062 | —
- [ ] T-107 [P1] `ui/VerifyReportModal.ts` | T-073 | —
- [ ] T-108 [P2] `ui/DiffModal.ts` backup vs current | T-063 | —
- [ ] T-109 [P2] `settings/transfer.ts` export/import via URI + clipboard | T-021 | round-trip test
- [ ] T-110 [P2] Settings passphrase protection | T-109,T-031 | —
- [ ] T-111 [P2] Reset backup state command | T-046 | forces next full

## Phase 9 — Safety extras
- [ ] T-120 [P1] `MassChangeGuard` pause on >N changes in M s | T-042 | threshold tests; protects last good backup
- [ ] T-121 [P2] Pre-risk snapshots (plugin update, bulk delete/rename) | T-120 | —
- [ ] T-122 [P2] Failure alert: daily-note append (optional) | T-100 | —
- [ ] T-123 [P2] Sync-conflict file detector | T-040 | flags `conflicted copy` patterns
- [ ] T-124 [P2] Desktop external copy (`ExternalCopy.ts`) | T-047 | platform-guarded; mobile build has no `fs`

## Phase 10 — Novel features
- [ ] T-130 [P1] Per-note time machine (commands + modal) | T-068,T-108 | —
- [ ] T-131 [P2] Tombstone recovery command | T-048,T-063 | —
- [ ] T-132 [P2] Pinned milestones UI (name on create) | T-094 | —
- [ ] T-133 [P2] `Backup Status.md` health note with frontmatter | T-073 | Dataview-readable
- [ ] T-134 [P2] Monthly restore rehearsal (scheduled) | T-079,T-082 | —
- [ ] T-135 [P2] Restore link report | T-063 | lists broken/fixed wikilinks
- [ ] T-136 [P3] Edit-volume trigger (words typed) | T-084 | —
- [ ] T-137 [P3] Low-battery flush | T-080 | —
- [ ] T-138 [P3] QR settings transfer | T-109 | —
- [ ] T-139 [P3] Content-addressed dedup | T-044 | design note in Decisions first
- [ ] T-140 [P3] Recovery records (parity) | T-044 | design note in Decisions first
- [ ] T-141 [P3] Vault time travel (read-only view) | T-061 | —

## Phase 11 — Mobile hardening
- [ ] T-150 [P1] Chunk size + yield tuning; low-memory mode | T-016,T-044 | memory budget doc
- [ ] T-151 [P2] Wake-lock during backup (where supported) | T-047 | feature-detected
- [ ] T-152 [P2] Resume-from-checkpoint on app resume | T-051,T-083 | —
- [ ] T-153 [P1] Mobile profile defaults (compression off in low-mem, no status bar, no external copy) | T-022 | —

## Phase 12 — Release
- [ ] T-160 [P1] README (install, settings, decrypt recipe, mobile limits, sync warning) | all P1 | —
- [ ] T-161 [P1] Full manual test pass: desktop | Manual Test Queue empty | —
- [ ] T-162 [P1] Full manual test pass: iOS + Android | T-161 | —
- [ ] T-163 [P2] BRAT beta release | T-162 | tag + release assets
- [ ] T-164 [P2] Community plugin submission | T-163 | —

---

## Decisions (append only)
| Date | Decision | Reason |
|------|----------|--------|
| 2026-10-07 | Plugin name: Rewind Vault. id: `rewind-vault`. Command prefix: "Rewind Vault:". Backup folder default stays `backup/`. | Owner choice. Collision check passed (owner-verified). |
| 2026-10-07 | Default exports allowed only in `src/main.ts` (Obsidian requires the plugin class as default export) and `*.config.ts` (tool requirement). ESLint enforces elsewhere. | Resolves CLAUDE.md "no default exports" vs. Obsidian entry contract. |
| 2026-10-07 | `obsidian` added as devDependency (types only; not bundled). Runtime deps remain `fflate` only. | PLAN §5 forbids extra runtime deps; devDep does not violate. |

## Blockers
_None._

## Manual Test Queue
_Items needing a real Obsidian runtime or device. Format: `MT-n | device | what to test | linked task | result`._
MT-1 | GitHub | Push branch, confirm the CI workflow (typecheck, lint, test, build) runs green | T-005 | pending
MT-2 | Obsidian desktop + mobile | Copy manifest.json + main.js into a test vault, enable the plugin: it loads without error, and backup/log.txt receives "Rewind Vault loaded" (checks AdapterVaultStore against the real DataAdapter) | T-024 | pending

## Ideas Parking Lot
_Out-of-plan ideas. Do not build until promoted to a task._

## Session Log (append only)
_Format: `YYYY-MM-DD | tasks touched | tests added | decisions | blockers | next`._
- 2026-10-07 | T-001 done | none (vitest runs with --passWithNoTests; first test lands in T-004) | Placeholder src/main.ts so typecheck/build have an entry; T-002 replaces it. Prettier ignores *.md so spec files stay untouched. | — | T-002
- 2026-10-07 | T-002 done | none (stub has no logic; build verified to emit CJS with default Plugin export) | Added `obsidian` as devDependency (types only, external in bundle). | — | T-003
- 2026-10-07 | T-003 done | none (stubs only) | Skeleton = every file named in PLAN §4 as `export {};` (52 src files, 3 mocks) plus .gitkeep in tests subfolders. | — | T-004
- 2026-10-07 | T-004 done | tests/mocks/mocks.test.ts (2 tests) | Mocks are structural (no interfaces yet): IVaultStore/ILogger/IClock do not exist until T-018/T-013/T-014, which should extract interfaces from these shapes. MockVaultStore has exists/readBinary/writeBinary/stat/mkdir/list/remove/rename + seed helper. | — | T-005
- 2026-10-07 | T-005 workflow written, left [~] | none | Local equivalents of all CI steps pass and `npm ci` dry-run works; acceptance is 'green on push', which needs a real push (MT-1). Mark [x] once MT-1 passes. | — | T-010 (next unblocked P1)
- 2026-10-07 | T-010, T-011 done | none (declarations and constants only; no `core/`/`crypto/` functions) | Settings = `{schemaVersion, desktop, mobile}` profiles, each with 12 groups mirroring PLAN §7. Added `BackupState`/`FileState` for state.json. Settings UI for all new fields is T-103; defaults are T-021. | — | T-012
- 2026-10-07 | T-012 done | tests/helpers/errors.test.ts (3) | `cause` declared manually (lib ES2020 has no Error.cause). | — | T-013
- 2026-10-07 | T-013 done | tests/helpers/logger.test.ts (5) | ILogger defined in helpers/logger.ts (matches MockLogger). Rotating sink keeps one rotation (`log.txt.1`) and takes a minimal LogFileStore interface so it does not depend on T-018. Size cap setting (`logSizeCapKb`) UI is T-103. | — | T-014
- 2026-10-07 | T-014 done | tests/helpers/time.test.ts (7) | Folder timestamps are UTC (sort chronologically, no DST ambiguity). IClock defined in helpers/time.ts. Backup id = folder name. | — | T-015
- 2026-10-07 | T-015 done | tests/helpers/glob.test.ts (11) | Gitignore-style semantics (unanchored w/o slash, trailing / = dir contents only, last match wins, matched folder covers contents). Added isHiddenPath and isInsideFolder for the Scanner's hidden toggle and forced backup-folder exclusion. | — | T-016
- 2026-10-07 | T-016 done | tests/helpers/chunk.test.ts (8) | `chunkBytes` returns subarray views (no copy). `createYielder(budgetMs, now, yieldFn)` added so loops yield only when ~30 ms of work has passed. Session total: T-012..T-016, 35 tests passing. | — | T-017
- 2026-10-07 | T-017 done | tests/helpers/platform.test.ts (4); added tests/mocks/MockPlatform.ts (extra mock, not in PLAN section 4 list) | IPlatform takes isMobile/isDesktop from main.ts so helpers never import obsidian. Battery via feature-detected navigator.getBattery, null if unavailable. | — | T-018
- 2026-10-07 | T-018 done | tests/storage/VaultStore.contract.test.ts (17 incl. both impls), mocks/FakeAdapter.ts | IVaultStore + AdapterVaultStore (wraps Obsidian DataAdapter via AdapterLike subset; main.ts will pass app.vault.adapter). Semantics fixed by contract: rename fails if destination exists, mkdir recursive, writes create parents, errors wrapped in StorageError. Added removeFolder (needed by Retention). MockVaultStore now implements IVaultStore. | — | T-019
- 2026-10-07 | T-019 done | tests/storage/AtomicWriter.test.ts (10, crash injected at each of the 4 mutating steps) | Replace protocol: write .tmp, verify size, old->.bak, tmp->target, delete .bak; recoverAtomic restores .bak if target missing, else clears leftovers (called automatically before each write; call on startup for index/state/manifest files too). | — | T-021
- 2026-10-07 | T-021 done | tests/settings/defaults.test.ts (4) | Defaults: differential auto-style, startup+resume triggers on, interval on for desktop only, verify L2, keep last 10, mass-change guard on, encryption off. Mobile: 1000 files/50 MB zips, 256 KB chunks, 20% battery floor, no status bar. NOTE: Basic.includeHidden and Exclusions.excludeHidden overlap (both from PLAN section 7); Scanner (T-040) must define precedence: hidden files are included only if includeHidden && !excludeHidden. | — | T-022
- 2026-10-07 | T-022 done | tests/settings/profiles.test.ts (5) | resolveProfile returns a deep copy and forces desktop-only options off on mobile (external destination, on-close trigger, status bar). Session total: T-017, T-018, T-019, T-021, T-022; 77 tests passing. | — | T-023 (T-020 is P2, deferred until P1s in phase 1 are done)
- 2026-10-07 | T-023 done | tests/settings/migrate.test.ts (7) | migrateSettings: merge-over-defaults (unknown keys dropped, wrong types fall back), range clamps, KDF iterations floored at 600k, v0 (flat profile) -> v1 (desktop/mobile) step. v0 shape is my reconstruction of a pre-profile layout; no released version ever wrote it. | — | T-024
- 2026-10-07 | T-024 done | tests/services.test.ts (4) | Services = store, logger, clock, platform, settings, getProfile(), saveSettings(). main.ts now loads+migrates settings and builds services (lifecycle only). Default logger writes to <backupFolder>/log.txt, level debug only when notifications.level is verbose. Real-runtime load check queued as MT-2. | — | T-020
- 2026-10-07 | T-020 done | tests/storage/FreeSpace.test.ts (7) | Free space comes from navigator.storage.estimate() (browser quota, a hint not true disk space) and the check PASSES when unknown so backups are never blocked by a missing API. Estimate assumes 60% compression (level>0). minFreeMb reserve is added on top; T-052 wires it into the engine. Phase 1 complete. | — | T-030
- 2026-10-07 | T-030 done | tests/crypto/hash.test.ts (11: NIST vectors incl. 1M-a, all split sizes, 0-200 byte lengths vs Web Crypto, async streams) | Hand-written incremental SHA-256 (class Sha256) because Web Crypto digest() cannot stream. No new dependency. Test references use Web Crypto, not node:crypto, so src/tests stay free of Node typings. Also toHex/fromHex here. | — | T-031
- 2026-10-07 | T-031 done | tests/crypto/kdf.test.ts (10: published PBKDF2-SHA256 vectors c=1,2,4096 and dkLen 40) | Two layers: pbkdf2Sha256 (raw, no policy, for vectors) and deriveKeyBytes (enforces >=600k iterations, rejects empty passphrase). Iterations are configurable above the floor. Session total: T-023, T-024, T-020, T-030, T-031; 116 tests passing. Coverage % not yet measured (PLAN wants >=85% in core/crypto); add a coverage script before Phase 3. | — | T-032
