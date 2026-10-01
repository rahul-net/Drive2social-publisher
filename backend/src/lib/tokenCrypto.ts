import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { config } from "../config.js";

// ============================================================
// tokenCrypto — AES-256-GCM encryption for OAuth tokens at rest.
//
// Tokens are stored in Firestore ONLY in encrypted form. The
// encryption key comes from TOKEN_ENCRYPTION_KEY and must resolve to
// exactly 32 bytes: either base64-encoded 32 bytes (recommended:
// `openssl rand -base64 32`) or a raw 32-byte UTF-8 string.
//
// Wire format: "v1:" + base64(iv[12] || authTag[16] || ciphertext).
// The version prefix lets us rotate algorithms later.
//
// Plaintext tokens are NEVER logged — callers must treat them as
// secrets and keep them out of logs, URLs, and error messages.
// ============================================================

const WIRE_VERSION = "v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * The raw 32-byte key, for HMAC and other server-side keyed operations
 * (e.g. signed preview URLs). Never leaves the server.
 */
export function getTokenEncryptionKey(): Buffer {
  return resolveKey();
}

function resolveKey(): Buffer {
  const raw = config.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw === "placeholder") {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not configured. Generate one with " +
        "`openssl rand -base64 32` and set it in the environment.",
    );
  }

  // Prefer base64 interpretation when it yields exactly 32 bytes.
  if (/^[A-Za-z0-9+/=_-]+$/.test(raw)) {
    try {
      const asBase64 = Buffer.from(raw, "base64");
      if (asBase64.length === 32) return asBase64;
    } catch {
      // fall through to the UTF-8 interpretation below
    }
  }

  const asUtf8 = Buffer.from(raw, "utf8");
  if (asUtf8.length === 32) return asUtf8;

  throw new Error(
    "TOKEN_ENCRYPTION_KEY is invalid: it must decode to exactly 32 bytes " +
      "(base64 of 32 random bytes, or a raw 32-character string). Generate " +
      "one with `openssl rand -base64 32`.",
  );
}

/**
 * Encrypt a plaintext token. Returns the opaque wire string; the
 * plaintext is never logged or retained.
 */
export function encryptToken(plain: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LENGTH) {
    throw new Error("Unexpected AES-GCM auth tag length");
  }
  const payload = Buffer.concat([iv, tag, ciphertext]);
  return `${WIRE_VERSION}:${payload.toString("base64")}`;
}

/**
 * Decrypt a wire string produced by encryptToken. Throws on wrong
 * version, malformed input, or authentication failure (wrong key /
 * tampered data). The plaintext is returned to the caller — keep it
 * out of logs.
 */
export function decryptToken(wire: string): string {
  const key = resolveKey();
  const prefix = `${WIRE_VERSION}:`;
  if (!wire.startsWith(prefix)) {
    throw new Error("Unsupported encrypted token format");
  }
  let payload: Buffer;
  try {
    payload = Buffer.from(wire.slice(prefix.length), "base64");
  } catch {
    throw new Error("Malformed encrypted token");
  }
  if (payload.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Malformed encrypted token");
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Failed to decrypt token (wrong key or tampered data)");
  }
}

/**
 * Constant-time string comparison for HMAC tokens. Returns false on
 * length mismatch instead of throwing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
