/** Split an array into consecutive groups of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Lazily yield views of `data` of at most `size` bytes. No copying. */
export function* iterateBytes(data: Uint8Array, size: number): Generator<Uint8Array> {
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError("chunk size must be a positive integer");
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, Math.min(offset + size, data.length));
  }
}

export function chunkBytes(data: Uint8Array, size: number): Uint8Array[] {
  return [...iterateBytes(data, size)];
}
