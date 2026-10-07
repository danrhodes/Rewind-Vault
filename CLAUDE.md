# CLAUDE.md — Session Protocol

Project: Rewind Vault (id `rewind-vault`), Obsidian backup/restore plugin (mobile + desktop, TypeScript).
Spec: `PLAN.md`. State: `TRACKER.md`. This file: rules for every session.

## Session start (mandatory, in order)
1. Read `TRACKER.md` fully.
2. Read the `PLAN.md` sections referenced by the chosen task.
3. Run `git status` and `git log --oneline -10`. Confirm the tree matches the tracker.
4. If a task is marked `[~]`, resume it. Else pick the first `[ ]` task:
   - Lowest phase number first.
   - Within a phase, P1 before P2 before P3 before P4.
   - All `deps` must be `[x]`. If not, pick the dependency.
5. Set the task to `[~]` and add a line to the Session Log before writing code.

## During work
- One task at a time. Finish or block it before starting another.
- Scope per session: complete as many tasks as fit. Never leave a task half-done without `[~]` and a handoff note.
- Obey the architecture rules in `PLAN.md` §3. Violations are bugs.
- No Node APIs outside `storage/ExternalCopy.ts`. Mobile must work.
- No `any`. No default exports. Files under 300 lines. One responsibility per file.
- Every function in `core/` and `crypto/` has unit tests. Use the mock adapter, not a real vault.
- Add no feature outside the plan. Log ideas in TRACKER "Ideas Parking Lot".

## Definition of done (task cannot be `[x]` until all pass)
- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm test` passes, including new tests for the task.
- `npm run build` passes.
- Acceptance criteria in the task line are met.
- Settings added by the task are configurable in the settings UI (or the task states which later task adds the UI).

## Session end (mandatory)
1. Update task statuses in `TRACKER.md`.
2. Append the Session Log entry: date, tasks touched, tests added, decisions, blockers, next task ID.
3. Record any decision that changes the plan under "Decisions" with a date.
4. Commit: `T-xxx: short description`. One commit per task minimum.
5. Print a 5-line handoff: done, in progress, blocked, next, risks.

## Blocker rules
- Mark `[!]` with a reason. Move to the next unblocked task.
- Never delete tests to pass a build.
- Never mark `[x]` on partial work.
- Unverifiable behavior (real mobile device, real Obsidian runtime) goes in "Manual Test Queue" in TRACKER.md. Do not claim it works.

## Tracker edit rules
- Edit only: status markers, Session Log (append), Decisions (append), Manual Test Queue, Ideas Parking Lot, Blockers.
- Never renumber task IDs. Add new tasks at the end of their phase with the next free ID.
