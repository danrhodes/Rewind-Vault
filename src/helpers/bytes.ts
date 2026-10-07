/** Web Crypto wants BufferSource; Uint8Array<ArrayBufferLike> needs a cast to satisfy the types. */
export function bufferSource(data: Uint8Array): BufferSource {
  return data as BufferSource;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * FIFO of byte pieces that hands out exact-size slices without re-copying the
 * backlog on every push. Used to re-frame arbitrary stream pieces into fixed chunks.
 */
export class ByteQueue {
  private pieces: Uint8Array[] = [];
  private total = 0;

  get length(): number {
    return this.total;
  }

  push(piece: Uint8Array): void {
    if (piece.length === 0) return;
    this.pieces.push(piece);
    this.total += piece.length;
  }

  /** Remove and return exactly `count` bytes. Caller must ensure `count <= length`. */
  take(count: number): Uint8Array {
    if (count > this.total) throw new RangeError("Not enough bytes queued");
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.pieces[0] as Uint8Array;
      const need = count - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.pieces.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.pieces[0] = head.subarray(need);
        filled += need;
      }
    }
    this.total -= count;
    return out;
  }

  takeAll(): Uint8Array {
    return this.take(this.total);
  }
}
