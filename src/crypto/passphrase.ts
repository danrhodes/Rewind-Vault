import { toBase64 } from "../helpers/bytes";
import { CancelledError, ConfigError } from "../helpers/errors";
import { deriveKeyBytes } from "./kdf";

export interface PassphrasePolicy {
  /** Keep the passphrase and derived keys in memory until unload or `clear()`. */
  sessionCache: boolean;
  /** Ask the user when no passphrase is available. */
  promptOnDemand: boolean;
  /** A passphrase saved in settings. Empty string means none. */
  storedPassphrase: string;
}

/** Shows a prompt. Resolves to null if the user cancels. Supplied by the UI layer. */
export type PassphrasePrompt = () => Promise<string | null>;
export type DeriveFn = (
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
) => Promise<Uint8Array>;

/**
 * Supplies passphrases and derived keys to the engines. Policy is read on every call,
 * so changing settings takes effect immediately. JavaScript strings cannot be wiped, so
 * `clear()` drops the passphrase reference and zero-fills derived key bytes.
 */
export class PassphraseService {
  private cached: string | null = null;
  private pending: Promise<string> | null = null;
  private readonly keys = new Map<string, Uint8Array>();

  constructor(
    private readonly policy: () => PassphrasePolicy,
    private readonly prompt: PassphrasePrompt,
    private readonly derive: DeriveFn = deriveKeyBytes,
  ) {}

  /** Passphrase from cache, settings, or a prompt, in that order. */
  async getPassphrase(): Promise<string> {
    const policy = this.policy();
    if (this.cached !== null && policy.sessionCache) return this.cached;
    if (policy.storedPassphrase !== "") return this.remember(policy.storedPassphrase, policy);
    if (!policy.promptOnDemand) {
      throw new ConfigError("No passphrase is available and prompting is turned off");
    }
    // Concurrent callers share one prompt.
    this.pending ??= this.askUser().finally(() => {
      this.pending = null;
    });
    return this.remember(await this.pending, policy);
  }

  /** Derived 256-bit master key for this salt and iteration count, cached when allowed. */
  async getKey(salt: Uint8Array, iterations: number): Promise<Uint8Array> {
    const id = `${toBase64(salt)}:${iterations}`;
    const hit = this.keys.get(id);
    if (hit && this.policy().sessionCache) return hit;
    const key = await this.derive(await this.getPassphrase(), salt, iterations);
    if (this.policy().sessionCache) this.keys.set(id, key);
    return key;
  }

  /** Forget everything, e.g. after a wrong-passphrase failure or on plugin unload. */
  clear(): void {
    this.cached = null;
    this.pending = null;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }

  get hasCachedPassphrase(): boolean {
    return this.cached !== null;
  }

  private async askUser(): Promise<string> {
    const answer = await this.prompt();
    if (answer === null) throw new CancelledError("Passphrase entry cancelled");
    if (answer === "") throw new ConfigError("Passphrase must not be empty");
    return answer;
  }

  private remember(passphrase: string, policy: PassphrasePolicy): string {
    if (policy.sessionCache) this.cached = passphrase;
    return passphrase;
  }
}
