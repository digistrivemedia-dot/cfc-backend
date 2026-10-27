import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing, on `node:crypto`.
 *
 * `scrypt` is in the standard library and is a real password KDF — memory-hard,
 * which is the property that makes a stolen hash expensive to attack. bcrypt
 * would mean a native dependency for the same guarantee.
 *
 * Stored as `scrypt$N$r$p$salt$hash`, with the parameters inside the string
 * rather than in a constant somewhere. When the cost is raised later, hashes
 * written under the old cost still verify, because each one carries the cost it
 * was made with. A bare hash with the parameters in code cannot be migrated
 * without locking everyone out.
 *
 * `ponytail:` scrypt from stdlib, no argon2 dependency. Raise `N` if hardware
 * makes it cheap; the format already supports it.
 */

/**
 * Hand-wrapped rather than `promisify(scrypt)`: promisify resolves to the
 * three-argument overload and drops the options object, so the cost parameters
 * below would be silently ignored — leaving every hash at Node's defaults.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

// OWASP's current scrypt floor: N=2^17, r=8, p=1. ~128 MB per hash, which is
// the point — it costs an attacker the same per guess.
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(plain, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    // Node's default maxmem is 32 MB and N=2^17 needs more; without this the
    // call throws rather than running slowly, which is a confusing failure.
    maxmem: 256 * 1024 * 1024,
  });

  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupt
 * row should refuse the login, not crash the endpoint for everyone.
 *
 * The comparison is `timingSafeEqual`. A plain `===` on hashes leaks how many
 * leading bytes matched, and while that is a slow attack it is also a
 * completely free one to prevent.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expected = parts[5];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  if (salt === undefined || expected === undefined) return false;

  let expectedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "base64");
  } catch {
    return false;
  }

  try {
    const key = await scryptAsync(plain, Buffer.from(salt, "base64"), expectedBuf.length, {
      N: n,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });

    if (key.length !== expectedBuf.length) return false;
    return timingSafeEqual(key, expectedBuf);
  } catch {
    // Absurd stored parameters (an N that exceeds maxmem) land here.
    return false;
  }
}
