import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

/**
 * Where files land on disk, and the one rule about it.
 *
 * Two roots, and the split is the whole point:
 *
 *   `public/`  — service images, category icons, banners, before/after job
 *                photos. Served straight off disk at `/uploads/...`.
 *   `private/` — KYC documents: Aadhaar, PAN, selfies. **Never served
 *                statically.** Read back only through an authenticated route
 *                that checks the caller may see that pro's documents.
 *
 * An Aadhaar on a guessable public URL is a data-protection incident, and the
 * only reliable way to prevent one is for the file to be somewhere the static
 * handler cannot reach — not a filename nobody will guess.
 *
 * `ponytail:` local disk, single VPS. Move to object storage when there is a
 * second app server or a CDN; the stored path stays relative either way, so
 * that migration is a copy and a base-URL change.
 */

export const PUBLIC_ROOT = path.join(env.uploadRoot, "public");
export const PRIVATE_ROOT = path.join(env.uploadRoot, "private");

/** The URL prefix the public root is served at. Stored paths begin with this. */
export const PUBLIC_PREFIX = "/uploads";

export function ensureUploadDirs(): void {
  for (const dir of [PUBLIC_ROOT, PRIVATE_ROOT]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolves a stored relative path to a file on disk, or throws.
 *
 * `../` in a path that reached a filesystem call is the oldest bug in serving
 * files, and it does not take a hostile client — a mangled stored value is
 * enough.
 *
 * **Refuses rather than sanitises.** The first version of this normalised the
 * path instead, which is safe but silent: `../public/leak.jpg` quietly became
 * `<root>/public/leak.jpg`, so a wrong stored path resolved to a real
 * neighbouring file and nothing anywhere reported a problem. For a KYC
 * document that is the worst outcome available — the wrong person's Aadhaar,
 * served with a 200. A stored path is either exactly right or it is a bug, so
 * anything unexpected throws.
 *
 * Both checks are kept. The segment check is the one that fires; the resolved
 * prefix check catches whatever the first one failed to anticipate, which on
 * past form is the one that matters.
 */
export function resolveWithin(root: string, relative: string): string {
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
    throw new Error(`Expected a relative path, got an absolute one: ${relative}`);
  }

  // Split on both separators: a Windows-style path reaching a Linux VPS would
  // otherwise pass through as one long filename containing "..".
  const segments = relative.split(/[/\\]+/);
  if (segments.some((s) => s === "..")) {
    throw new Error(`Path escapes its root: ${relative}`);
  }

  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Path escapes its root: ${relative}`);
  }
  return full;
}
