import { Router } from "express";
import type { Actor } from "@cfc/types";
import { openableSections } from "@cfc/types";
import { badRequest, unauthorized } from "../../error";
import { signToken } from "../../auth/token";
import { verifyPassword } from "../../auth/password";
import {
  SUPER_ADMIN,
  isSuperAdminEmail,
  superAdminHash,
} from "../../auth/super-admin";
import { AdminUser } from "../../models/admin-user";
import { audit } from "../../models/audit";
import { actorOf, requireAdmin, requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";

/**
 * Admin 1 — sign in. Admin 2 — password reset (deferred, §0.2).
 *
 * The one temporary thing in this phase is **where the Super Admin's
 * credentials live** (`.env`, per §0.2). Everything else is production: a real
 * signed token carrying a real identity, rate limiting, an audit row, and a
 * role the **server** decides.
 *
 * That last point is the substantive change to the login screen. It had a
 * three-way role picker, and the client choosing their own role is the whole
 * RBAC hole in one control — a sub-admin would simply pick "Super Admin". The
 * role now comes from the account, and the picker is gone from the form.
 */
export const adminAuthRouter = Router();

/** What the login screen gets back. */
interface LoginResponse {
  token: string;
  actor: Actor;
  /**
   * Whether to show the 2FA step. **Always false for now** — TOTP is deferred
   * (§0.2), and the existing code step is kept wired to this flag rather than
   * deleted, so enrolling 2FA later turns the screen back on with no rebuild.
   *
   * It is deliberately not `true` with a step that accepts anything: §2.2 of
   * the plan calls the current admin 2FA *"a switch claiming to be on"*, and
   * a code field that accepts `123456` is the same lie one layer down.
   */
  twoFactorRequired: boolean;
  /** Sections to draw in the sidebar. Server-computed, never client-guessed. */
  sections: string[];
}

adminAuthRouter.post(
  "/login",
  rateLimit({
    windowSeconds: 15 * 60,
    max: 10,
    // IP and email together: by IP alone one attacker locks out a shared
    // office address; by email alone a botnet spreads guesses across addresses.
    keyOf: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return `${req.ip ?? "unknown"}|${typeof email === "string" ? email.toLowerCase() : ""}`;
    },
    message: "Too many sign-in attempts. Please wait 15 minutes and try again.",
  }),
  async (req, res) => {
    const { email, password } = (req.body ?? {}) as {
      email?: unknown;
      password?: unknown;
    };

    if (typeof email !== "string" || typeof password !== "string") {
      throw badRequest("Enter your email and password.");
    }

    const normalised = email.trim().toLowerCase();

    // One message for every failure, and the same one whether the account does
    // not exist, the password is wrong, or the account is suspended.
    // Distinguishing them turns this endpoint into an account-enumeration
    // oracle, and tells an attacker which half of the guess to keep.
    const refuse = () =>
      unauthorized("That email and password do not match an admin account.");

    let actor: Actor;

    if (isSuperAdminEmail(normalised)) {
      // Through the same `verifyPassword` as a stored account, so the timing
      // matches and there is only one place where "is this password right" is
      // answered. See auth/super-admin.ts.
      const ok = await verifyPassword(password, await superAdminHash());
      if (!ok) throw refuse();
      actor = SUPER_ADMIN;
    } else {
      const row = await AdminUser.findOne({ email: normalised }).lean();
      if (!row) throw refuse();

      const ok = await verifyPassword(password, row.passwordHash);
      if (!ok) throw refuse();

      // Checked after the password, so a suspended account cannot be
      // identified as "exists but blocked" without knowing the password.
      if (!row.active) throw refuse();

      actor = {
        id: row._id,
        name: row.name,
        role: row.role,
        ...(row.area !== undefined ? { area: row.area } : {}),
        sections: row.sections,
      };
    }

    const response: LoginResponse = {
      token: signToken(actor),
      actor,
      twoFactorRequired: false,
      sections: openableSections(actor),
    };

    await audit(actor, "admin.signed_in", {
      ...(req.ip !== undefined ? { ip: req.ip } : {}),
    });

    res.json(response);
  },
);

/**
 * The signed-in admin, re-read from the token.
 *
 * The login response already carried the actor, but a reload has only the token
 * — so this is what restores a session, and it is also the cheapest possible
 * check that a token is still valid. A 401 here is the frontend's signal to
 * send someone back to the login screen.
 */
adminAuthRouter.get("/me", requireAuth, requireAdmin, (req, res) => {
  const actor = actorOf(req);
  res.json({ actor, sections: openableSections(actor) });
});

/**
 * Sign out.
 *
 * Deliberately almost nothing: the token is stateless, so the real sign-out is
 * the client discarding it. This exists for the audit row — knowing when an
 * operator's session ended matters in a dispute — and so the frontend has one
 * obvious thing to call.
 *
 * A token stolen before sign-out stays valid until it expires. Fixing that
 * needs a server-side denylist, which means a Mongo read on every request.
 * `ponytail:` stateless tokens with a 12-hour expiry; add a denylist if the
 * client asks for forced revocation.
 */
adminAuthRouter.post("/logout", requireAuth, requireAdmin, async (req, res) => {
  await audit(actorOf(req), "admin.signed_out", {
    ...(req.ip !== undefined ? { ip: req.ip } : {}),
  });
  res.status(204).end();
});
