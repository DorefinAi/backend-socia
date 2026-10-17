// AES-256-GCM for secrets at rest: X tokens (which rotate, so they cannot live in env vars) and
// TOTP seeds. The key comes from SECRET_KEY (32 bytes, base64) and never touches the database.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(secretKeyB64: string): Buffer {
  const k = Buffer.from(secretKeyB64, "base64");
  if (k.length !== 32) throw new Error("SECRET_KEY must be 32 bytes, base64-encoded");
  return k;
}

/** Output: base64 of iv (12) + tag (16) + ciphertext */
export function encryptSecret(plain: string, secretKeyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secretKeyB64), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptSecret(sealed: string, secretKeyB64: string): string {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(secretKeyB64), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
