import { describe, expect, it } from "vitest";
import { BusyFlag } from "../../src/commands/actions";
import { RestoreActions } from "../../src/commands/restoreActions";
import type { RestoreProgress } from "../../src/core/RestoreTypes";
import { readText } from "../../src/storage/VaultStore";
import { Notifier } from "../../src/ui/notify";
import type { CancelSource } from "../../src/ui/progressModel";
import { RestoreSelection, chooseRestore } from "../../src/ui/restorePreviewModel";
import { enc, restoreEngineFor, rig, runOk, type Rig } from "../support/engineRig";

interface Opened {
  title: string;
  cancel: CancelSource;
  updates: RestoreProgress[];
  closed: boolean;
}

async function setup(cancelOnOpen = false) {
  const r: Rig = rig((p) => {
    p.notifications.level = "verbose";
  });
  await r.store.seed("a.md", "a v1");
  await r.store.seed("b.md", "b");
  await r.store.seed("sub/c.md", "c");
  r.clock.advance(10_000);
  const { backupId } = await runOk(r.engine, { mode: "full" });

  const notices: string[] = [];
  const opened: Opened[] = [];
  const flag = new BusyFlag();
  const actions = new RestoreActions(
    {
      restore: restoreEngineFor(r),
      notifier: new Notifier(
        (m) => notices.push(m),
        () => r.profile,
      ),
      logger: r.logger,
      progress: {
        open(title, cancel) {
          const rec: Opened = { title, cancel, updates: [], closed: false };
          opened.push(rec);
          if (cancelOnOpen) cancel.cancel(); // the user presses Cancel as soon as the dialog is up
          return {
            updateBackup: () => undefined,
            updateRestore: (p) => rec.updates.push(p),
            close: () => {
              rec.closed = true;
            },
          };
        },
      },
    },
    flag,
  );
  return { r, backupId, actions, notices, opened, flag };
}

const FOLDER = { kind: "restore-folder" } as const;
const VAULT = { kind: "vault" } as const;
const joined = (n: string[]): string => n.join(" | ");

describe("RestoreActions.preview", () => {
  it("lists what would be restored without writing anything", async () => {
    const { r, backupId, actions } = await setup();
    const before = (await r.store.list("")).files.length;
    const preview = await actions.preview(backupId, FOLDER);
    expect(preview?.additions.map((i) => i.path).sort()).toEqual(["a.md", "b.md", "sub/c.md"]);
    expect(preview?.destinationRoot).toBe(`restore/${backupId}`);
    expect((await r.store.list("")).files.length).toBe(before);
  });

  it("against the vault, files that match are counted and ones that differ are changes", async () => {
    const { r, backupId, actions } = await setup();
    await r.store.writeBinary("a.md", enc("edited"));
    const preview = await actions.preview(backupId, VAULT);
    expect(preview?.changes.map((i) => i.path)).toEqual(["a.md"]);
    expect(preview?.unchanged).toBe(2);
  });

  it("an unknown backup gives a message and null, not an exception", async () => {
    const { actions, notices } = await setup();
    expect(await actions.preview("nope", FOLDER)).toBeNull();
    expect(joined(notices)).toContain("Reading the backup");
  });

  it("works while another operation is running (it only reads)", async () => {
    const { backupId, actions, flag } = await setup();
    flag.tryAcquire();
    expect(await actions.preview(backupId, FOLDER)).not.toBeNull();
  });
});

describe("RestoreActions.run", () => {
  it("restores the ticked files only, shows progress, reports, and frees the flag", async () => {
    const { r, backupId, actions, notices, opened, flag } = await setup();
    const preview = (await actions.preview(backupId, FOLDER))!;
    const selection = new RestoreSelection(preview, { changesSelected: true });
    selection.toggle("b.md");
    const ok = await actions.run(backupId, FOLDER, chooseRestore(selection)!);
    expect(ok).toBe(true);
    const root = `restore/${backupId}`;
    expect(await readText(r.store, `${root}/a.md`)).toBe("a v1");
    expect(await r.store.exists(`${root}/b.md`)).toBe(false);
    expect(joined(notices)).toContain(
      `Restore complete into restore/${backupId}/: 2 new, 0 replaced`,
    );
    expect(opened[0]?.title).toBe("Restoring");
    expect(opened[0]?.updates.length).toBeGreaterThan(0);
    expect(opened[0]?.closed).toBe(true);
    expect(flag.isBusy).toBe(false);
  });

  it("everything ticked restores the whole backup", async () => {
    const { r, backupId, actions } = await setup();
    const preview = (await actions.preview(backupId, FOLDER))!;
    const choice = chooseRestore(new RestoreSelection(preview, { changesSelected: true }))!;
    expect(choice.kind).toBe("vault");
    await actions.run(backupId, FOLDER, choice);
    expect(await readText(r.store, `restore/${backupId}/sub/c.md`)).toBe("c");
  });

  it("into the vault: replaces only what was ticked, after a safety snapshot", async () => {
    const { r, backupId, actions, notices } = await setup();
    await r.store.writeBinary("a.md", enc("live a"));
    await r.store.writeBinary("b.md", enc("live b"));
    const preview = (await actions.preview(backupId, VAULT))!;
    const selection = new RestoreSelection(preview, { changesSelected: false });
    selection.toggle("a.md"); // tick only a.md
    expect(selection.selectedReplacements).toBe(1);
    await actions.run(backupId, VAULT, chooseRestore(selection)!);
    expect(await readText(r.store, "a.md")).toBe("a v1");
    expect(await readText(r.store, "b.md")).toBe("live b");
    expect(joined(notices)).toContain("into your vault: 0 new, 1 replaced");
    const folders = (await r.store.list("backup")).folders;
    expect(folders.length).toBe(2); // the original backup and the safety snapshot
  });

  it("refuses while another operation runs, without opening a dialog", async () => {
    const { backupId, actions, notices, opened, flag } = await setup();
    flag.tryAcquire();
    const ok = await actions.run(backupId, FOLDER, { kind: "vault", overwrite: false });
    expect(ok).toBe(false);
    expect(joined(notices)).toContain("already running");
    expect(opened).toHaveLength(0);
  });

  it("cancelling reports that written files were kept and frees the flag", async () => {
    const { backupId, actions, notices, opened, flag } = await setup(true);
    const ok = await actions.run(backupId, FOLDER, { kind: "vault", overwrite: false });
    expect(ok).toBe(false);
    expect(joined(notices)).toContain("Restore cancelled");
    expect(flag.isBusy).toBe(false);
    expect(opened[0]?.closed).toBe(true);
  });

  it("a path that is not in the backup gives a clear message and writes nothing", async () => {
    const { r, backupId, actions, notices } = await setup();
    const ok = await actions.run(backupId, FOLDER, {
      kind: "files",
      paths: ["ghost.md"],
      overwrite: false,
    });
    expect(ok).toBe(false);
    expect(joined(notices)).toContain("Restore stopped");
    expect(joined(notices)).toContain("ghost.md");
    expect(await r.store.exists(`restore/${backupId}`)).toBe(false);
  });

  it("replacing without overwrite is refused as a whole", async () => {
    const { r, backupId, actions, notices } = await setup();
    await r.store.writeBinary("a.md", enc("live a"));
    const ok = await actions.run(backupId, VAULT, {
      kind: "files",
      paths: ["a.md", "b.md"],
      overwrite: false,
    });
    expect(ok).toBe(false);
    expect(joined(notices)).toContain("Restore stopped");
    expect(await readText(r.store, "a.md")).toBe("live a");
  });
});
