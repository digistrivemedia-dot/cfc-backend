import jwt from "jsonwebtoken";
import type { Actor, AdminSection, Role } from "@cfc/types";
import { env } from "../env";
import { unauthorized } from "../error";

/**
 * Session tokens.
 *
 * The payload carries the whole `Actor` — id, name, role, area and the
 * per-person section grant — because every authorisation decision is made from
 * it and a database read per request to rebuild it buys nothing.
 *
 * That is safe **only because the token is signed**: a sub-admin who edits
 * `role` to `super_admin` in their browser invalidates the signature and is
 * refused. `ADMIN-SUMMARY.md` records the frontend failure this replaces —
 * *"permissions were assigned but never enforced"* — so the signature is the
 * thing doing the real work here, not the payload.
 *
 * **No session length is stated on any screen.** `PLATFORM-FACTS.md` lists
 * session length under "not stated anywhere — do not claim", so the expiry is
 * configuration and no UI mentions it.
 */

/** 12 hours. Long enough for an operator's shift, short enough to matter. */
const TTL_SECONDS = 12 * 60 * 60;

interface TokenPayload {
  /** The actor's id. `sub` is the registered JWT claim for this. */
  sub: string;
  name: string;
  role: Role;
  area?: string;
  sections?: AdminSection[];
}

export function signToken(actor: Actor): string {
  const payload: TokenPayload = {
    sub: actor.id,
    name: actor.name,
    role: actor.role,
    ...(actor.area !== undefined ? { area: actor.area } : {}),
    ...(actor.sections !== undefined
      ? { sections: [...actor.sections] }
      : {}),
  };

  return jwt.sign(payload, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: TTL_SECONDS,
  });
}

/**
 * Verifies a token and returns the actor inside it.
 *
 * `algorithms` is pinned. Without it, `jsonwebtoken` would accept whatever
 * algorithm the token's own header claims — the algorithm-confusion attack,
 * where a token says `alg: none` or swaps HMAC for RSA and verification becomes
 * a formality. The list of accepted algorithms is the server's to decide, never
 * the token's.
 */
export function verifyToken(token: string): Actor {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    // An expired, tampered or malformed token are one case to a caller: sign in
    // again. Distinguishing them would only tell an attacker which part worked.
    throw unauthorized();
  }

  if (typeof decoded !== "object" || decoded === null) throw unauthorized();
  const p = decoded as Partial<TokenPayload>;
  if (typeof p.sub !== "string" || typeof p.role !== "string") {
    throw unauthorized();
  }

  return {
    id: p.sub,
    name: typeof p.name === "string" ? p.name : "",
    role: p.role as Role,
    ...(p.area !== undefined ? { area: p.area } : {}),
    ...(p.sections !== undefined ? { sections: p.sections } : {}),
  };
}
