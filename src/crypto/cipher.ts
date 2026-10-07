import { ENCRYPTION } from "../constants";
import { ByteQueue, bufferSource, concatBytes } from "../helpers/bytes";
import { ConfigError, CryptoError, TamperError } from "../helpers/errors";

/**
 * Encrypted stream format (all integers big-endian):
 *
 *   magic "RVE1" (4) | chunkSize u32 (4) | frame*
 *   frame = iv (12) | AES-256-GCM(ciphertext of up to chunkSize bytes) | tag (16)
 *
 * Every frame but the last holds exactly chunkSize plaintext bytes. Each frame is
 * authenticated with AAD = magic | chunkSize | frameIndex u32 | isFinal u8, so
 * reordering, truncation, extension and header edits all fail authentication.
 * A fresh random IV is drawn for every frame.
 */
const MAGIC = new Uint8Array([0x52, 0x56, 0x45, 0x31]); // "RVE1"
const HEADER_BYTES = 8;
const TAG_BYTES = 16;
const IV_BYTES = ENCRYPTION.ivBytes;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export const DEFAULT_CHUNK_BYTES = 256 * 1024;

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ConfigError("AES-256 key must be exactly 32 bytes");
  return crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function checkChunkSize(size: number): void {
  if (!Number.isInteger(size) || size < 1 || size > MAX_CHUNK_BYTES) {
    throw new ConfigError(`Chunk size must be an integer between 1 and ${MAX_CHUNK_BYTES}`);
  }
}

function buildHeader(chunkSize: number): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setUint32(4, chunkSize);
  return header;
}

function buildAad(chunkSize: number, index: number, isFinal: boolean): Uint8Array {
  const aad = new Uint8Array(HEADER_BYTES + 5);
  aad.set(buildHeader(chunkSize), 0);
  const view = new DataView(aad.buffer);
  view.setUint32(HEADER_BYTES, index);
  view.setUint8(HEADER_BYTES + 4, isFinal ? 1 : 0);
  return aad;
}

async function seal(
  key: CryptoKey,
  plain: Uint8Array,
  chunkSize: number,
  index: number,
  isFinal: boolean,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(iv),
      additionalData: bufferSource(buildAad(chunkSize, index, isFinal)),
    },
    key,
    bufferSource(plain),
  );
  return concatBytes([iv, new Uint8Array(sealed)]);
}

async function open(
  key: CryptoKey,
  frame: Uint8Array,
  chunkSize: number,
  index: number,
  isFinal: boolean,
): Promise<Uint8Array> {
  if (frame.length < IV_BYTES + TAG_BYTES) throw new TamperError("Encrypted frame is truncated");
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bufferSource(frame.subarray(0, IV_BYTES)),
        additionalData: bufferSource(buildAad(chunkSize, index, isFinal)),
      },
      key,
      bufferSource(frame.subarray(IV_BYTES)),
    );
    return new Uint8Array(plain);
  } catch (cause) {
    throw new TamperError("Authentication failed: wrong key, or the data was modified", { cause });
  }
}

type ByteSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** Encrypt a stream of arbitrary-sized pieces. Emits the header, then one frame at a time. */
export async function* encryptStream(
  key: CryptoKey,
  source: ByteSource,
  chunkSize: number = DEFAULT_CHUNK_BYTES,
): AsyncGenerator<Uint8Array> {
  checkChunkSize(chunkSize);
  yield buildHeader(chunkSize);

  const queue = new ByteQueue();
  let held: Uint8Array | null = null; // a full chunk waiting to learn whether it is the last
  let index = 0;

  for await (const piece of source) {
    queue.push(piece);
    while (queue.length >= chunkSize) {
      if (held) yield await seal(key, held, chunkSize, index++, false);
      held = queue.take(chunkSize);
    }
  }

  if (queue.length > 0 || held === null) {
    if (held) yield await seal(key, held, chunkSize, index++, false);
    yield await seal(key, queue.takeAll(), chunkSize, index, true);
  } else {
    yield await seal(key, held, chunkSize, index, true);
  }
}

/** Decrypt a stream produced by `encryptStream`. Throws TamperError on any modification. */
export async function* decryptStream(
  key: CryptoKey,
  source: ByteSource,
): AsyncGenerator<Uint8Array> {
  const queue = new ByteQueue();
  let chunkSize = 0;
  let frameBytes = 0;
  let index = 0;

  for await (const piece of source) {
    queue.push(piece);
    if (chunkSize === 0) {
      if (queue.length < HEADER_BYTES) continue;
      const header = queue.take(HEADER_BYTES);
      if (!MAGIC.every((b, i) => header[i] === b)) {
        throw new CryptoError("Not an encrypted Rewind Vault stream");
      }
      chunkSize = new DataView(header.buffer, header.byteOffset).getUint32(4);
      checkChunkSize(chunkSize);
      frameBytes = IV_BYTES + chunkSize + TAG_BYTES;
    }
    // A full frame is only known to be non-final once more bytes follow it.
    while (queue.length > frameBytes) {
      yield await open(key, queue.take(frameBytes), chunkSize, index++, false);
    }
  }

  if (chunkSize === 0) throw new TamperError("Encrypted stream is missing its header");
  if (queue.length === 0) throw new TamperError("Encrypted stream is truncated");
  yield await open(key, queue.takeAll(), chunkSize, index, true);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return concatBytes(parts);
}

export function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  chunkSize: number = DEFAULT_CHUNK_BYTES,
): Promise<Uint8Array> {
  return collect(encryptStream(key, [plaintext], chunkSize));
}

export function decrypt(key: CryptoKey, encrypted: Uint8Array): Promise<Uint8Array> {
  return collect(decryptStream(key, [encrypted]));
}

/** Size of the encrypted output for a given plaintext length. */
export function encryptedSize(
  plainLength: number,
  chunkSize: number = DEFAULT_CHUNK_BYTES,
): number {
  checkChunkSize(chunkSize);
  const frames = Math.max(1, Math.ceil(plainLength / chunkSize));
  return HEADER_BYTES + plainLength + frames * (IV_BYTES + TAG_BYTES);
}
