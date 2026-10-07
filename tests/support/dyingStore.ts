import type { IVaultStore, StoreListing, StoreStat } from "../../src/storage/VaultStore";

export type MutationKind = "writeBinary" | "remove" | "removeFolder" | "rename";

/**
 * Simulates the process being killed. `shouldDie` is asked before every mutating call
 * (counting from 1); once it says yes the store is dead: that call and everything after
 * it throws, so no cleanup code gets to run, exactly like a real kill. The wrapped
 * store keeps whatever had been written, and can be used by a "restarted" engine.
 */
export class DyingStore implements IVaultStore {
  private mutations = 0;
  private dead = false;

  constructor(
    private readonly inner: IVaultStore,
    private readonly shouldDie: (n: number, kind: MutationKind, path: string) => boolean,
  ) {}

  get isDead(): boolean {
    return this.dead;
  }

  get mutationCount(): number {
    return this.mutations;
  }

  private alive(): void {
    if (this.dead) throw new Error("process killed");
  }

  private mutate(kind: MutationKind, path: string): void {
    this.alive();
    this.mutations++;
    if (this.shouldDie(this.mutations, kind, path)) {
      this.dead = true;
      throw new Error("process killed");
    }
  }

  exists(p: string): Promise<boolean> {
    return Promise.resolve().then(() => (this.alive(), this.inner.exists(p)));
  }
  readBinary(p: string): Promise<Uint8Array> {
    return Promise.resolve().then(() => (this.alive(), this.inner.readBinary(p)));
  }
  stat(p: string): Promise<StoreStat | null> {
    return Promise.resolve().then(() => (this.alive(), this.inner.stat(p)));
  }
  list(p: string): Promise<StoreListing> {
    return Promise.resolve().then(() => (this.alive(), this.inner.list(p)));
  }
  mkdir(p: string): Promise<void> {
    return Promise.resolve().then(() => (this.alive(), this.inner.mkdir(p)));
  }
  async writeBinary(p: string, d: Uint8Array): Promise<void> {
    this.mutate("writeBinary", p);
    await this.inner.writeBinary(p, d);
  }
  async remove(p: string): Promise<void> {
    this.mutate("remove", p);
    await this.inner.remove(p);
  }
  async removeFolder(p: string): Promise<void> {
    this.mutate("removeFolder", p);
    await this.inner.removeFolder(p);
  }
  async rename(a: string, b: string): Promise<void> {
    this.mutate("rename", a);
    await this.inner.rename(a, b);
  }
}
