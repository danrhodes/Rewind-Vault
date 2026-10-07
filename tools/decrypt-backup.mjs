#!/usr/bin/env node
// Decrypt one Rewind Vault backup folder WITHOUT the plugin.
//
//   node decrypt-backup.mjs <backup-folder> <output-folder>
//
// <backup-folder> is one dated folder inside your backup folder, for example
// backup/2026-10-07T21-24-00_full, holding manifest.json and part-001.zip ...
// The passphrase is read from the REWIND_PASSPHRASE environment variable, or asked for.
// Needs Node 18 or newer. No other software or packages.
//
// Format, in case you want to write your own tool (all integers big-endian):
//   key       = HMAC-SHA256( PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 bytes),
//                            "rewind-vault/encrypt/v1" )
//   salt, iterations: manifest.json > encryption.salt (base64), encryption.iterations
//   each ZIP entry is STORED (not compressed) and holds an encrypted stream:
//     "RVE1" | chunkSize u32 | frame*       frame = iv(12) | ciphertext | tag(16)
//     every frame uses AES-256-GCM with AAD = "RVE1" | chunkSize u32 | frameIndex u32 | isFinal u8
//     every frame but the last holds exactly chunkSize bytes of plaintext
//   the decrypted bytes are raw DEFLATE data; inflate them to get the original file.

import { createDecipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { inflateRawSync } from "node:zlib";

const [folder, outDir] = process.argv.slice(2);
if (!folder || !outDir) {
  console.error("Usage: node decrypt-backup.mjs <backup-folder> <output-folder>");
  process.exit(2);
}

async function askPassphrase() {
  if (process.env.REWIND_PASSPHRASE) return process.env.REWIND_PASSPHRASE;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((done) => rl.question("Passphrase: ", done));
  rl.close();
  return answer;
}

/** Entries of a ZIP, read from its central directory. Only STORED (method 0) entries. */
function zipEntries(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a ZIP file");
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error("Damaged ZIP directory");
    const method = zip.readUInt16LE(pos + 10);
    const size = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.toString("utf8", pos + 46, pos + 46 + nameLen);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (method !== 0) throw new Error(`${name}: expected a stored entry, found method ${method}`);
    entries.push({ name, data: zip.subarray(dataStart, dataStart + size) });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decryptStream(key, data) {
  if (data.toString("latin1", 0, 4) !== "RVE1")
    throw new Error("Not an encrypted Rewind Vault entry");
  const chunkSize = data.readUInt32BE(4);
  const frameLen = 12 + chunkSize + 16;
  const parts = [];
  for (let offset = 8, index = 0; offset < data.length; offset += frameLen, index++) {
    const frame = data.subarray(offset, Math.min(offset + frameLen, data.length));
    const isFinal = offset + frameLen >= data.length;
    const aad = Buffer.alloc(13);
    data.copy(aad, 0, 0, 8);
    aad.writeUInt32BE(index, 8);
    aad.writeUInt8(isFinal ? 1 : 0, 12);
    const decipher = createDecipheriv("aes-256-gcm", key, frame.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(frame.subarray(frame.length - 16));
    parts.push(decipher.update(frame.subarray(12, frame.length - 16)), decipher.final());
  }
  return Buffer.concat(parts);
}

const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
if (!manifest.encryption?.enabled) {
  console.error("This backup is not encrypted: open its part-*.zip with any unzip tool.");
  process.exit(1);
}
const { salt, iterations } = manifest.encryption;
const master = pbkdf2Sync(
  await askPassphrase(),
  Buffer.from(salt, "base64"),
  iterations,
  32,
  "sha256",
);
const key = createHmac("sha256", master).update("rewind-vault/encrypt/v1").digest();

const root = resolve(outDir);
let written = 0;
for (const part of manifest.parts) {
  for (const entry of zipEntries(readFileSync(join(folder, part.name)))) {
    const target = resolve(root, entry.name);
    if (!target.startsWith(root + sep)) throw new Error(`Refusing unsafe path: ${entry.name}`);
    let plain;
    try {
      plain = inflateRawSync(decryptStream(key, entry.data));
    } catch {
      console.error(`Cannot decrypt ${entry.name}: wrong passphrase, or the backup is damaged.`);
      process.exit(1);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, plain);
    written++;
  }
}
console.log(`Decrypted ${written} file(s) into ${root}`);
if (manifest.type === "diff") {
  console.log(
    "This is a differential backup: it holds only what changed. Restore the full backup first.",
  );
}
