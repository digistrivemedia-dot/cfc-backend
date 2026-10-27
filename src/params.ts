import { badRequest } from "./error";

/**
 * Reads a route parameter as a string.
 *
 * Express infers param names from the path literal, but **only on the overload
 * without extra middleware** — add a `requirePermission` and `req.params` falls
 * back to a loose union that `exactOptionalPropertyTypes` then rejects.
 *
 * This normalises it, so a guarded route reads the same as an unguarded one.
 * Shared rather than copied: it came up on the catalogue, the pro and the
 * quotation routers, and a third local copy was the point at which it belonged
 * in one place.
 */
export function param(
  req: { params: Record<string, unknown> },
  name: string,
): string {
  const value = req.params[name];
  if (typeof value !== "string" || value === "") {
    throw badRequest(`Missing ${name} in the URL.`, "BAD_PARAM");
  }
  return value;
}
