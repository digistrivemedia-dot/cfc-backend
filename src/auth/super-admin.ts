import type { Actor } from "@cfc/types";
import { env } from "../env";
import { hashPassword } from "./password";

/**
 * The Super Admin, from configuration (§0.2).
 *
 * The agreement says there is exactly one, and it has to exist before anyone
 * can create anything — so it comes from `.env` rather than from a bootstrap
 * row that could be edited, deleted, or have its role changed.
 *
 * The configured password is **hashed once at boot** and then verified through
 * the same `verifyPassword` as any stored account. Two reasons, and the second
 * is the one that matters:
 *
 * 1. Timing. A plain string compare answers in microseconds while a sub-admin's
 *    scrypt verify takes ~100 ms, which marks the super admin's address out as
 *    special to anyone timing the endpoint.
 * 2. **One verification path.** Two mechanisms for "is this password right" is
 *    a split where one gets fixed and the other quietly does not.
 *
 * To be clear about what this is not: hashing a value that sits in plaintext in
 * `.env` protects nothing by itself. The protection for that file is file
 * permissions and it never reaching the repository.
 */

let cachedHash: string | null = null;

export async function superAdminHash(): Promise<string> {
  cachedHash ??= await hashPassword(env.superAdminPassword);
  return cachedHash;
}

/**
 * Computes the hash at boot rather than on the first login.
 *
 * Without this the first sign-in of the process pays for two scrypt runs and
 * takes noticeably longer than every later one — which looks like a bug in the
 * login screen.
 */
export async function warmSuperAdmin(): Promise<void> {
  await superAdminHash();
}

export function isSuperAdminEmail(email: string): boolean {
  return email.trim().toLowerCase() === env.superAdminEmail.trim().toLowerCase();
}

/**
 * `super_admin` carries no `sections`, which `canOpen` reads as "whatever the
 * role allows" — everything.
 */
export const SUPER_ADMIN: Actor = {
  id: "adm_super",
  name: "Super Admin",
  role: "super_admin",
};
