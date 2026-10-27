import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Actor, AdminSection, Permission } from "@cfc/types";
import { areaScope, can, canOpen } from "@cfc/types";
import { forbidden, unauthorized } from "../error";
import { verifyToken } from "../auth/token";

/**
 * Authentication and authorisation.
 *
 * The permission rules are **imported from `@cfc/types`, not restated here.**
 * `can()`, `canOpen()` and `areaScope()` are the same functions the admin UI
 * renders from, which is the only way the two can agree: a second copy on the
 * server would be the one that drifts, and the drift would be silent until
 * someone saw a screen they should not have.
 *
 * The division of labour, from BACKEND-PLAN.md's reference section:
 *
 *   the frontend's copy decides **what to draw**
 *   this one decides **what is allowed** — and it is the only one that counts
 *
 * `ADMIN-SUMMARY.md`: *"Permissions were assigned but never enforced"* — an
 * area admin saw the full eleven-item sidebar. The fix is here, in the server,
 * not in a conditional on a component.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Absent on public routes. */
      actor?: Actor;
    }
  }
}

/** The actor on a request that has been through `requireAuth`. */
export function actorOf(req: Request): Actor {
  const { actor } = req;
  // Reaching here without an actor means a route was mounted without
  // `requireAuth`. A 401 would blame the caller for the server's mistake, so
  // this throws loudly instead.
  if (!actor) throw new Error("actorOf() on a route with no requireAuth");
  return actor;
}

/**
 * Requires a valid bearer token.
 *
 * Does not care which role. Use `requireSection` or `requirePermission` for
 * that — a route guarded only by this one is readable by any signed-in user of
 * any role, including a customer, which is almost never what an admin endpoint
 * wants.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(unauthorized("Please sign in."));
    return;
  }

  try {
    req.actor = verifyToken(header.slice("Bearer ".length).trim());
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Requires the actor to be able to open an admin section.
 *
 * This is the route-level equivalent of the sidebar: the same `canOpen` that
 * decides whether a nav item is drawn decides whether the URL answers. A
 * sub-admin who types `/settings` gets a 403 from here even though their
 * sidebar never offered it.
 */
export function requireSection(section: AdminSection): RequestHandler {
  return (req, _res, next) => {
    const actor = actorOf(req);
    if (!canOpen(actor, section)) {
      next(forbidden());
      return;
    }
    next();
  };
}

/**
 * Requires a specific permission.
 *
 * Opening a section and acting inside it are different questions — a sub-admin
 * may open Payments and still not approve a payout — so this is a separate
 * check rather than a finer-grained section list.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const actor = actorOf(req);
    if (!can(actor, permission)) {
      next(forbidden());
      return;
    }
    next();
  };
}

/**
 * The area an actor is confined to, or null for unrestricted.
 *
 * Applied **in the query**, never by filtering rows after fetching them: a
 * post-fetch filter means the restricted data was read, counted and paginated
 * before being dropped, so totals leak what the rows themselves do not.
 */
export function scopeArea(req: Request): string | null {
  return areaScope(actorOf(req));
}

/**
 * Restricts a route to one of the three admin roles.
 *
 * `requireSection` covers most cases; this is for the endpoints that are not
 * section-shaped — `/me`, for instance, which every admin may call and no
 * customer should.
 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  const { role } = actorOf(req);
  if (role !== "super_admin" && role !== "sub_admin" && role !== "area_admin") {
    next(forbidden());
    return;
  }
  next();
};

/**
 * Express 5 forwards a rejected async handler automatically, but only for
 * **route** handlers — a middleware that returns a promise is not awaited. This
 * wraps the few async middlewares so a rejection cannot become an unhandled
 * promise that hangs the request.
 */
export function asyncMiddleware(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
