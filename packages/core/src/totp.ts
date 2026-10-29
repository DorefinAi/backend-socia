// TOTP (RFC 6238, SHA-1, 6 digits, 30 s): the second factor for the 8–9 desk users.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) throw new Error("Not a base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, at: Date, step = 30, digits = 6): string {
  const counter = Math.floor(at.getTime() / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/** The 30 s time step (counter) of an instant */
export function totpStep(at: Date, step = 30): number {
  return Math.floor(at.getTime() / 1000 / step);
}

/**
 * The time step the code belongs to (now or one step either side, for clock drift), or null when it matches
 * none. Callers must record the step and refuse any code whose step is not newer than the last accepted one
 * (no replay); `verifyTotp` alone does not do that.
 */
export function matchTotpStep(secret: string, code: string, at: Date, window = 1): number | null {
  const given = Buffer.from(code.replace(/\s/g, ""));
  const now = totpStep(at);
  let matched: number | null = null;
  // Every step is checked (no early return); the newest match wins
  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(totpCode(secret, new Date((now + i) * 30_000)));
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = now + i;
  }
  return matched;
}

/** Accepts the code for now and one step either side, for clock drift. Does not guard against replay. */
export function verifyTotp(secret: string, code: string, at: Date, window = 1): boolean {
  return matchTotpStep(secret, code, at, window) !== null;
}

export function totpUri(secret: string, account: string, issuer = "Socia"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
