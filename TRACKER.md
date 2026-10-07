# TRACKER.md — Build State

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
Format: `T-ID [Pn] description | deps | acceptance`
Priority: P1 now · P2 schedule · P3 delegate/later · P4 defer.

## Status
- Current phase: 4
- Last session: 2026-10-07
- Next task: T-063 (T-005 awaiting MT-1)
- Tasks done: 41 / 118

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
- [x] T-032 [P1] `crypto/cipher.ts` AES-256-GCM chunked encrypt/decrypt | T-031 | round-trip; tamper fails; wrong key fails
- [x] T-033 [P2] `crypto/sign.ts` HMAC manifest signing | T-031 | tamper detection test
- [x] T-034 [P2] Session passphrase cache + prompt-on-demand service | T-031 | cleared on unload

## Phase 3 — Core backup
- [x] T-040 [P1] `core/Scanner.ts` list files with exclusions, hidden toggle, forced backup-folder exclusion | T-015,T-018 | tests incl. hidden/trash/.git
- [x] T-041 [P1] `core/Manifest.ts` load/save/validate/version | T-010,T-019 | schema validation tests
- [x] T-042 [P1] `core/Differ.ts` added/changed/deleted via mtime+size then hash | T-040,T-030,T-041 | property tests
- [x] T-043 [P1] `core/Splitter.ts` max files, max source MB, max output MB, over-max toggle | T-042 | boundary tests
- [x] T-044 [P1] `core/Packer.ts` fflate streaming ZIP, level 0–9, optional encryption | T-032,T-043 | opens in standard unzip when unencrypted
- [x] T-045 [P1] `core/LockManager.ts` acquire/release/stale detection | T-019 | concurrent-run test
- [x] T-046 [P1] `BackupIndex` + `state.json` read/write | T-041 | tests
- [x] T-047 [P1] `core/BackupEngine.ts` full mode | T-040–T-046 | 1k-file vault round-trip
- [x] T-048 [P1] BackupEngine differential mode with tombstones | T-047 | chain test
- [x] T-049 [P1] BackupEngine non-destructive style | T-048 | never deletes prior backups
- [x] T-050 [P1] Progress + cancel hooks in engine | T-047 | cancel leaves no partial `ok` backup
- [x] T-051 [P2] `core/Checkpoint.ts` resume interrupted backup | T-047 | kill-and-resume test
- [x] T-052 [P2] Pre-run free-space check | T-020,T-047 | blocks when below threshold
- [x] T-053 [P2] Skip-if-no-changes | T-048 | no backup created when diff empty

## Phase 4 — Restore
- [x] T-060 [P1] `core/Unpacker.ts` stream entries with filter | T-044 | tests
- [x] T-061 [P1] Chain resolver: base + diffs + tombstones to a point in time | T-060,T-041 | tests
- [x] T-062 [P1] `RestoreEngine.preview()` add/change/delete lists | T-061 | tests
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
- Garbage-collect unindexed backup folders (kill between manifest and index) and rebuild index.json from manifests if it is lost (2026-10-07).

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
- 2026-10-07 | T-032 done | tests/crypto/cipher.test.ts (~34 cases incl. every-byte-flip, truncation, reorder, duplicate, append, wrong key), tests/helpers/bytes.test.ts (6) | Format: magic RVE1 + chunkSize + frames (iv12|ct|tag16); AAD binds header, frame index and final flag, so truncation/reorder/extension fail. Streaming encryptStream/decryptStream; encrypt/decrypt wrap them. Wrong key and tampering are indistinguishable under GCM (both TamperError): T-075 needs a separate key-check value to report 'wrong passphrase'. Callers should pass a subkey, not the raw PBKDF2 output (see T-033). helpers/bytes.ts added (concat, base64, ByteQueue, bufferSource). | — | T-033
- 2026-10-07 | T-033 done | tests/crypto/sign.test.ts (21: RFC 4231 HMAC vector, 11 tamper cases, key order independence, wrong key/missing/malformed) | HMAC covers all manifest fields EXCEPT hmac, status, verify (those legitimately change after creation, e.g. marking corrupt); canonical key-sorted JSON; constant-time verify via subtle.verify. Added hmacSha256, deriveSubKey, KEY_LABELS to kdf.ts: callers derive separate encrypt and manifest-HMAC subkeys from the PBKDF2 output. | — | T-034
- 2026-10-07 | T-034 done | tests/crypto/passphrase.test.ts (13), 2 added to tests/services.test.ts | PassphraseService (src/crypto/passphrase.ts, a file not named in PLAN section 4) order: session cache, stored passphrase, prompt; concurrent prompts share one dialog; cancel is never cached; derived keys cached per salt+iterations and zero-filled on clear(). Services.passphrase added; main.onunload calls clear(). Prompt UI is injected (ServiceDeps.promptPassphrase) and absent until a UI task adds a modal: until then on-demand prompts count as cancelled. Settings UI for session cache/prompt toggles is T-103. Phase 2 complete. | — | T-040
- 2026-10-07 | T-040 done | tests/core/Scanner.test.ts (13) | Precedence settled: hidden paths kept only if includeHidden && !excludeHidden; .obsidian/.trash/.git/node_modules have their own toggles (.git and node_modules match at any depth, .obsidian and .trash only at vault root); backup folder always excluded (segment-exact, so backup2/ is NOT excluded). Excluded folders are never listed. User globs are gitignore-style; a folder-level match cannot be rescued by negation. Restore folder is NOT excluded (PLAN only forces the backup folder). | — | T-041
- 2026-10-07 | T-041 done | tests/core/Manifest.test.ts (~50 cases) | validateManifest returns a clean typed copy and rejects: bad enums/hashes/numbers, duplicate paths and parts, unknown part refs, entryCount mismatches, change-actions or tombstones in a full backup, a diff without baseId, paths that are absolute, contain .. or backslashes (path-traversal guard for restore), weak KDF when encryption is on, newer schemaVersion (upgrade message). saveManifest validates then writes atomically. Manifest.ts is 288 lines: split before adding more. Session total: T-032, T-033, T-034, T-040, T-041; 239 tests passing. | — | T-042
- 2026-10-07 | T-042 done | tests/core/Differ.test.ts (21 incl. 12 seeded property runs: applying diff to old state == state of new vault) | Added files are NOT hashed by the differ (nothing to compare; the packer hashes what it stores), so a first backup reads each file once. Changed/touched are hashed. Known limit: same-size edit that preserves mtime is missed (metadata-first design from PLAN section 9). applyDiffToState takes the hashes the packer produced. | — | T-043
- 2026-10-07 | T-043 done | tests/core/Splitter.test.ts (20 incl. 8 random-property runs) | Limits: file count, source bytes, output bytes (0 = unlimited). Output size is unknowable before compression, so the output cap is applied as an extra source-size bound (min of the two caps). Over-max file: own part if processOverMax, else skipped and reported. partName(n) = part-NNN.zip. | — | T-044
- 2026-10-07 | T-044 done | tests/core/Packer.test.ts (19) | fflate 0.8.3 added as the one runtime dependency (PLAN section 5). Unencrypted parts verified externally: python -m zipfile -t and unzip -t both pass at levels 0, 6, 9 with non-ASCII names. Encrypted parts: ZIP container whose entry payloads are AES-GCM(deflate(data)); FILE NAMES STAY PLAINTEXT in the ZIP and manifest (privacy trade-off, flag for README / possible later task). Parts are assembled in memory (IVaultStore has no append), so memory is bounded by the splitter caps. Packer hashes the bytes it actually reads; vanished files go to skipped; cancel hook between files. | — | T-045
- 2026-10-07 | T-045 done | tests/core/LockManager.test.ts (14) | Advisory lock in <backupFolder>/lock.json with heartbeat. Acquire = check, write, settle 50 ms, re-read to confirm ownership (the adapter has no exclusive create). Stale when now - heartbeat > timeoutMin (boundary: exactly at timeout is still live). Calls on one instance are serialised; unreadable lock files count as abandoned; release never removes another owner's lock; a taken-over owner learns on refresh(). Residual risk: across synced devices an overlap is still possible, which is why part files and manifests are written atomically and the manifest last. Engine must call refresh() between parts (T-047). | — | T-046
- 2026-10-07 | T-046 done | tests/core/BackupIndex.test.ts (24), tests/core/BackupState.test.ts (15) | New files outside PLAN section 4: core/BackupIndex.ts (index.json registry + add/update/remove/sort/chainFor), core/BackupState.ts (state.json), helpers/validate.ts (shared FieldValidator, isSafeRelPath, isHex64). Manifest.ts refactored onto the validator (288 -> 241 lines, its 50 tests unchanged and green). Loading runs recoverAtomic first; a missing index/state is empty (no history), a damaged one is an ERROR (never silently reset, engine decides: state damaged -> force full). Session total: T-042..T-046; 349 tests passing. | — | T-047
- 2026-10-07 | T-047 done | tests/core/BackupEngine.test.ts (10), BackupEngine.encryption.test.ts (2), support/engineRig.ts + support/readBackup.ts (independent reader: plain unzip, then decrypt+inflate) | Engine split into BackupPlanner.ts (scan -> plan, serialisable RunPlan) and BackupEngine.ts (lock, execute, manifest, index, state). Order: lock -> parts (atomic) -> manifest LAST -> index -> state; any failure removes only the new folder. Crash between manifest and index leaves an unindexed folder (harmless: next diff re-backs-up). Encrypted: fresh salt per backup, subkeys via deriveSubKey, manifest HMAC always set when encrypted. 1k-file vault round-trips byte-for-byte; real PBKDF2 path tested. | — | T-048
- 2026-10-07 | T-048 done | tests/core/BackupEngine.diff.test.ts (9), support/chain.ts (independent chain reconstruction: full resets, tombstones delete) | Planner now diffs against state.json: added->add, changed->change, deleted->tombstones (deletedAt = now), timestamp-only changes refresh state without an entry. baseId = newest intact (status ok) full backup; each diff is relative to the PREVIOUS backup, so restore applies full + all diffs up to the target in order (matches core chainFor). Forced full (with reason in result + warn log) when: state unreadable, state never written, or no intact full backup. A damaged state.json no longer blocks backups. Chain test: 3 rounds of edit/add/delete/rename/re-create, reconstruction == live vault after each. | — | T-049
- 2026-10-07 | T-049 done | tests/core/NonDestructive.test.ts (10) | Non-destructive = differential chain + runtime write-protection: NonDestructiveGuard wraps the store so any write/rename/remove inside a pre-existing backup folder is rejected (always as a rejected promise), on top of an engine-level test recording every mutation across 3 runs. Result carries nonDestructive:true; RETENTION (T-090) MUST SKIP runs where options.nonDestructive is set. runOptionsForStyle maps the autoStyle setting (off -> null). | — | T-050
- 2026-10-07 | T-050 done | tests/core/BackupEngine.control.test.ts (8), existing engine tests moved to runOk() helper | Engine split: BackupEngine (lock, plan, cleanup), BackupExecutor (parts -> manifest -> index -> state), RunControl (progress + cancel), RunTypes. onProgress(phase scanning/packing/finalizing, part/file/byte counters, currentFile); isCancelled polled before start, after scan, between files and parts. Cancelled runs THROW CancelledError (not a result); a sweep test cancels at every poll point 1..N and asserts folder listing, state, index and lock are byte-identical to before. Cancel is ignored after the manifest commit. NEW: state-save failure now rolls the index back so it never points at a deleted folder. RunResult is now completed | skipped (union); tests use runOk(). | — | T-051
- 2026-10-07 | T-051 done | tests/core/BackupEngine.resume.test.ts (10 incl. KILL SWEEP: process killed at every mutating call of a run, then resume(), reconstruction == live vault each time), support/dyingStore.ts | core/Checkpoint.ts: checkpoint.json written after every part (and once at start); API: engine.findResumable() (read-only), engine.resume(options) (falls back to a fresh backup, using options.mode, if there is no checkpoint or a finished part fails its size/hash check). A normal run() discards an unfinished backup left by a crash (never one with a manifest). Checkpoint removed on success, failure and cancel; a leftover one for an already-indexed backup is ignored. Kill leaves the lock until lockTimeoutMin passes (resume after a crash must wait out the stale lock). Orphan folders that have a manifest but are not indexed (kill between manifest and index) remain: harmless, not yet cleaned (see Ideas). UI offer-to-resume belongs to the command/UI tasks. | — | T-052
- 2026-10-07 | T-052 done | tests/core/BackupEngine.space.test.ts (5) | EngineDeps.freeSpace (IFreeSpaceProbe) is checked after planning and BEFORE anything is created: required = estimateBackupBytes(remaining parts, compression level) + conditions.minFreeSpaceMb; below that the run throws InsufficientSpaceError with nothing written. Unknown free space passes (debug log). For a resumed run only the remaining parts count. Wiring a real probe (createStorageEstimateProbe) into services happens with the command/UI tasks. | — | T-053
- 2026-10-07 | T-053 done | tests/core/BackupEngine.skip.test.ts (7) | Differential run (incl. non-destructive) returns {status:'skipped',reason:'no-changes'} when nothing was added/changed/deleted and conditions.skipIfNoChanges is on; full runs and the first-ever run are never skipped. Timestamp-only changes are skipped but written to state.json so they are not re-hashed. Resumes are never skipped. Refactor: unfinished-run helpers moved to core/UnfinishedRuns.ts (engine 291 -> 239 lines). Phase 3 complete. | — | T-060
- 2026-10-07 | T-060 done | tests/core/Unpacker.test.ts (21) | unpackPart(store, partPath, {encryptionKey, filter, expectedSha256}) is an async generator over fflate's streaming Unzip: one entry decoded at a time (the part itself is read whole), filtered-out entries are never decompressed (damage in them is invisible), encrypted entries are decrypted then inflated, unsafe names (.., absolute, empty segments) raise VerificationError, hashes from the manifest are verified so corrupt data is never yielded, a wrong key raises TamperError, damaged ZIPs raise VerificationError. | — | T-061
- 2026-10-07 | T-061 done | tests/core/ChainResolver.test.ts (15) | resolveChain(store, folder, index, {id}|{at}) folds base + diffs in order (entries replace, tombstones remove, a full resets) and returns files path -> {entry, backupId} plus deletedPaths (tombstoned and not re-added; feeds T-131 recovery). Verified against live-vault snapshots recorded after EVERY backup of a 6-step history with two fulls. Refuses (BrokenChainError, new error class) on: unknown id, any non-ok link, missing folder/manifest, index/manifest mismatch, diff built on another base, base missing from index. By time = newest ok backup at or before the moment. Limit: a diff deleted from the middle of a chain by hand is only detectable if the index still lists later diffs; T-095 (never prune a base with live dependents) and T-076 (L5) are the guards. chainFor tie-break by id added. | — | T-062
- 2026-10-07 | T-062 done | tests/core/RestoreEngine.preview.test.ts (16), support: restoreEngineFor() | RestoreEngine.preview(request) returns additions / changes / deletions / unchanged count / bytesToWrite without any write (asserted by call recording). Request = source ({id}|{at}) + scope (all | file | folder) + destination: restore-folder (DEFAULT: <restoreFolder>/<backup id>/, live vault untouched) or vault (explicit). Changes detected by size, then SHA-256. deleteExtraneous (vault + all/folder scope only, off by default) lists live files the backup lacks, using the normal scan exclusions so the backup folder and excluded paths are never offered for deletion. Fails early (BrokenChainError) if a part needed by the scope is missing; unneeded missing parts are fine. New error class RestoreError (bad scope, file not in backup). Session total: T-047..T-053, T-060..T-062 (10 tasks); 458 tests passing. | — | T-063
