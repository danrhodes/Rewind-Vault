# Rewind Vault

Backup, restore and verification for your Obsidian vault, on desktop and mobile.

Rewind Vault keeps dated backups of your notes inside your vault, checks that they can really be restored, and lets you bring back a whole vault, a folder, a single note, or an older version of a note. Everything is configurable, and nothing it does can overwrite your live notes unless you explicitly ask.

> **Status: early pre-release (0.0.1). Please read before installing.**
>
> - The engines (backup, restore, verification, retention) and the screens are written and covered by more than 1,300 automated tests, but **the screens and triggers have not yet been run in a real copy of Obsidian or on a phone**. The list of checks still to do is in [TRACKER.md](TRACKER.md) (the Manual Test Queue). Treat this as a test build: keep your own copy of anything you cannot lose.
> - It is not in the community plugin list yet. A BRAT beta is planned once the manual tests pass.

## What it does

- **Full and differential backups.** A full backup holds everything. A differential one holds only what changed since the previous backup, plus a note of what you deleted. Backups are normal `.zip` files you can open with any tool (unless you turn on encryption).
- **Restore, safely.** Restores go to a separate `restore/` folder by default, so your notes are never touched. Restoring into the vault itself is a deliberate choice, takes a safety snapshot first, and only replaces the files you tick.
- **Verification.** Each new backup can be checked straight after it is made: structure, CRC checksums, or a SHA-256 comparison of every file. Deeper checks follow the whole chain of differentials, and a rehearsal restores a backup in memory and compares it with your live vault.
- **A damaged backup is never trusted.** If a check fails, the backup is marked corrupt, kept out of retention counts, and the next backup is a full one.
- **Retention.** Keep the newest N backups, keep backups from the last N days, keep daily/weekly/monthly ones, cap the folder size, and pin milestones. The newest good backup is never deleted, and neither is anything a kept differential backup depends on.
- **Encryption (optional).** AES-256-GCM with a passphrase. See [Encryption](#encryption).
- **Automatic backups.** On startup, when the app returns to the foreground, on a timer or at set times, after a number of edits or words typed, when you stop typing, and (desktop) on close. Conditions such as minimum battery, free space and "nothing changed" can hold a backup back.
- **Safety extras.** A mass-change guard pauses automatic backups if a bad sync or plugin changes many files at once (you set how many), so your last good backup is not pushed out. Snapshots are taken before bulk deletes and plugin updates. Sync-conflict copies are flagged.
- **Time machine and recovery.** See every saved version of the current note, compare and restore one; bring back deleted files; browse the whole vault as it was at any backup (read-only); named milestones that are never pruned.
- **Repair.** Optional recovery data (parity files next to each ZIP) lets a damaged backup part be rebuilt.
- **Mobile friendly.** Everything goes through Obsidian's own file API, works in small chunks, never needs a desktop-only feature, and has a low-memory mode.

## Install

There is no release yet. To try it, build it and copy three files:

```bash
git clone https://github.com/danrhodes/Rewind-Vault.git
cd Rewind-Vault
npm install
npm run build
```

Copy `main.js` and `manifest.json` into `<your vault>/.obsidian/plugins/rewind-vault/`, then enable **Rewind Vault** under Settings > Community plugins. Requires Obsidian 1.4.0 or newer. A BRAT-installable beta is planned.

## Using it

Open the command palette and type "Rewind Vault":

| Command | What it does |
|---|---|
| Back up now | Backs up using your chosen automatic style (differential by default). The ribbon icon does the same. |
| Back up now (full) / (differential) | A complete backup, or only what changed since the last one. |
| Restore from a backup… | Opens the backup list; press **Restore** on a backup. |
| Browse backups | The backup list: search, compare, restore, verify, pin, repair, delete. |
| Verify the latest backup | Checks every file's SHA-256 against the backup's record. |
| Time machine for the current note | Every saved version of the open note: show changes, restore a copy, or replace the note. |
| Recover deleted files | Files you deleted since they were last backed up. |
| Vault time travel (read-only) | Look at the vault as it was at any backup, search it and read notes. Nothing is written. |
| Create a named milestone | A full backup with a name, kept until you delete it. |
| Copy / show / import settings | Move settings between devices as a link or QR code. |

With **Show legacy commands** turned on you also get: non-destructive backup, resume an interrupted backup, deep verification (follows the whole chain), a restore rehearsal, reset backup state, and updating the status note.

**Restoring.** Press Restore on a backup. You see the files that would be added and the files that differ from what you have now, each with a checkbox. By default everything goes to `restore/<backup name>/` and your notes stay as they are. Choose "My vault" to restore in place: files that would replace your current ones start unticked, and ticking one is your consent to replace it. Before anything is written, a snapshot of the current vault is taken so the restore can be undone.

## Where backups live

```
backup/                       (configurable; never included in its own backups)
  index.json                  list of backups
  state.json                  what the vault looked like at the last backup
  2026-10-07T21-24-00_full/
    manifest.json             what is in this backup, with checksums
    part-001.zip  part-002.zip …
  2026-10-08T09-00-00_diff/
  log.txt                     activity log (rotated by size)
restore/                      restored files land here by default
```

Folder names are UTC times. **Do not edit the backup folder by hand.**

> **Exclude the backup folder from Obsidian Sync, iCloud, Dropbox and Git.** Otherwise every device uploads copies of the same large files, and a sync conflict can damage a backup. Rewind Vault excludes the folder from its own backups, but it cannot stop another tool syncing it.

## Settings

Settings > Rewind Vault has a section for each group. Desktop and mobile keep **separate** settings, so a vault shared between a laptop and a phone can behave differently on each.

| Section | What you can set |
|---|---|
| Basic | Backup on startup and delay, automatic style (off, full, differential, non-destructive), hidden files, legacy commands |
| Destination | Inside the vault or an external copy folder (desktop), backup folder, restore folder |
| ZIP | Files and size per ZIP part, splitting large output, compression level |
| Triggers | Startup, resume, timer, daily times, after N edits, idle, create/delete/rename, on close |
| Conditions | Minimum battery, skip when nothing changed, minimum free space, Wi-Fi only |
| Exclusions | Path patterns (gitignore style), hidden files, `.obsidian`, `.git`, `node_modules`, trash |
| Retention | Keep newest N, keep N days, daily/weekly/monthly, maximum folder size, pinned exempt |
| Encryption | On/off, passphrase handling, key-derivation strength |
| Verification | Check after each backup (off, L1, L2, L3), deep check schedule, what to do on failure |
| Safety | Snapshot before restoring, lock timeout, and the settings for the features below |
| Notifications | Silent, errors only, or verbose; status bar; log size |
| Misc | Settings passphrase, low-memory mode, keep screen on, chunk size |

Every setting is in the settings screen. If you turn on **Keep a backup status note**, a note with Dataview-readable properties shows the health of your backups.

### About retention and differential backups

A differential backup is built on the one before it, so restoring it needs the full backup and every differential up to it. Retention therefore never deletes a backup that a kept one depends on. The practical effect: with differential backups, "keep the newest 10" can leave more than 10 backups on disk until the next full backup lets the older chain go. If you want a hard limit, use **Maximum backup folder size**, which removes the oldest backups together with the ones built on them (but never the newest good backup or pinned ones).

## Encryption

Turn on **Encrypt backups** and every file inside each ZIP is encrypted with AES-256-GCM, using a key derived from your passphrase with PBKDF2-SHA256 (600,000 iterations or more; you can raise it).

- **If you lose the passphrase, the backups cannot be recovered.** There is no reset and no back door.
- **File names are not encrypted.** The ZIP still lists the names of your notes (the contents are protected). Do not rely on this for hiding what files exist.
- The backup's record is signed, so tampering is detected, and a wrong passphrase is reported as such rather than as "corrupt".
- You can either store the passphrase in the settings or be asked for it each time (prompt on demand). A stored passphrase sits in plain text in the plugin's `data.json`, readable by anyone who can read your vault; prompting is safer.

### Decrypting without the plugin

You are never locked in to the plugin. `tools/decrypt-backup.mjs` in this repository decrypts a backup folder using only Node.js 18 or newer, with no packages to install:

```bash
node tools/decrypt-backup.mjs "backup/2026-10-07T21-24-00_full" "./decrypted"
```

It asks for the passphrase (or reads the `REWIND_PASSPHRASE` environment variable) and writes the original files to the output folder. Decrypt the full backup first, then each differential in date order, letting later files overwrite earlier ones. The header of the script documents the format, if you would rather write your own tool:

1. `master = PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 bytes)`, with `salt` (base64) and `iterations` from `manifest.json`.
2. `key = HMAC-SHA256(master, "rewind-vault/encrypt/v1")`.
3. Each ZIP entry is stored uncompressed and holds `"RVE1"`, a 4-byte chunk size, then frames of `iv (12) | ciphertext | tag (16)`, each AES-256-GCM with the header, frame number and a final-frame flag as associated data.
4. The decrypted bytes are raw DEFLATE data; inflate them to get the original file.

Unencrypted backups need none of this: they are ordinary ZIP files.

## Mobile

Rewind Vault runs on iOS and Android, with these limits:

- **There is no background backup.** Phones suspend Obsidian when it is not on screen. Backups can only happen while the app is open: on startup, when you return to it, or on a timer while it is in the foreground. If a backup is cut off, the next startup or return to the app carries on from the last finished part (setting: Continue an interrupted backup).
- **Memory.** Large vaults are processed in small pieces. Mobile defaults use 50 MB ZIP parts and 256 KB chunks (about 100 MB peak). **Low-memory mode** drops that to 16 MB parts, 64 KB chunks and no compression (about 32 MB). Details in [docs/memory-budget.md](docs/memory-budget.md).
- **Screen on during a backup.** Where the device supports it, the screen is kept on while a backup runs, so the phone does not suspend the app half way (setting: Keep the screen on during a backup).
- **Battery.** The default mobile profile skips automatic backups below 20 % battery, and has an optional low-battery flush that saves once more just before the battery runs out.
- Free-space checks use the browser's storage estimate, which is a hint rather than exact. If it cannot be read, the check is skipped instead of blocking a backup.
- Desktop-only options (external copy, backup on close, the status bar) are hidden on mobile and forced off even if a synced settings file turns them on.

## Safety design

- Backups are written to a temporary name and renamed into place, and the record of each backup is written last, so an interruption never leaves a half-made backup that looks complete.
- A lock stops two backups, or a backup and a restore, from running at once. A crashed run's lock expires after the configured timeout.
- Restores are all-or-nothing about conflicts: if a file would be replaced and you have not agreed, nothing is written. Every restored file is checked against its recorded SHA-256 before it is written.
- Deleting a backup deletes everything built on it, and tells you so first.
- The plugin only uses Obsidian's own file API and the Web Crypto API. The one runtime dependency is [fflate](https://github.com/101arrowz/fflate) for ZIP files.

## Known limitations

- Not yet tested in a real Obsidian or on a phone (see the status note).
- A file edited without its size or modified time changing is not noticed by differential backups (they compare size and time first, for speed). A full backup always catches it.
- Encrypted backups keep file names readable.
- No cloud destinations. The backup is a folder in your vault, optionally copied to another folder on desktop.
- Content-addressed de-duplication is not built; it would break the "every backup is a standalone ZIP" guarantee (design note in TRACKER.md).

## Development

```bash
npm install
npm run typecheck   # TypeScript, strict
npm run lint        # ESLint (no `any`, no default exports, files under 300 lines)
npm test            # Vitest: unit, integration and fault-injection tests
npm run build       # bundle main.js
npm run dev         # watch mode
```

The design is in [PLAN.md](PLAN.md) and the build progress, decisions and open manual tests are in [TRACKER.md](TRACKER.md). The code is layered: `core/` (engines) knows nothing about Obsidian and is tested against an in-memory vault; `ui/` and `commands/` are thin and call the engines through a services object; `main.ts` only wires things together.

Bug reports and ideas are welcome as GitHub issues.

## License

[MIT](LICENSE) © 2026 Dan Rhodes
