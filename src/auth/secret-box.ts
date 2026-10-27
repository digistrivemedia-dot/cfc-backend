import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { env } from "../env";

/**
 * Encryption at rest for the few fields that need it.
 *
 * Right now that is one thing: a pro's **bank account number**. The reference
 * plan is explicit — *"never store a full account number in plaintext"* — and
 * `bankAccountLast4` is all any screen ever shows.
 *
 * So why keep the full number at all? Because a payout needs it. Discarding it
 * would mean asking every approved pro to re-enter their bank details the day
 * transfers go live, which is worse for them and worse for us. Encrypted at
 * rest, decrypted only at the moment a transfer is made.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than returning plausible garbage that gets sent to a bank.
 *
 * `ponytail:` one key from the environment, no rotation or envelope encryption.
 * The stored format carries a version prefix, so adding a KMS or a second key
 * later does not invalidate what is already written.
 */

const VERSION = "v1";

/**
 * The 32-byte key, derived from the configured secret.
 *
 * Hashed rather than used raw so any length of configured string produces a
 * valid key — a 20-character secret would otherwise throw at the first write,
 * which is a bad time to find out.
 */
function key(): Buffer {
  return createHash("sha256").update(env.bankEncryptionKey).digest();
}

/** `v1:<iv>:<authTag>:<ciphertext>`, all base64. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Opens a sealed value.
 *
 * Throws on anything unexpected rather than returning a partial result. The one
 * caller is a payout, and a half-decrypted account number must never reach a
 * bank transfer — failing loudly there is the only safe behaviour.
 */
export function open(sealed: string): string {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Sealed value is not in the expected format.");
  }
  const [, ivB64, tagB64, dataB64] = parts;

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64 ?? "", "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64 ?? "", "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64 ?? "", "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** The only part of an account number any screen is allowed to show. */
export function last4(accountNumber: string): string {
  return accountNumber.slice(-4);
}
