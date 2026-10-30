import { Router } from "express";
import type { AppNotification, ProNotification } from "@cfc/types";
import { notFound } from "../error";
import { actorOf, requireAuth } from "../middleware/auth";
import {
  Notification,
  type NotificationDoc,
  type NotificationRole,
} from "../models/notification";
import { param } from "../params";

/**
 * Customer 39 and Pro 29 — the bell.
 *
 * One router, mounted twice, because the two audiences differ only in which
 * role their token carries. The recipient always comes from the **token**,
 * never a parameter: a notification list is someone's private activity, and
 * an id in the path is an invitation to read someone else's.
 */
function notificationRouter(role: NotificationRole): Router {
  const router = Router();

  router.use(requireAuth, (req, _res, next) => {
    if (actorOf(req).role !== role) {
      next(notFound());
      return;
    }
    next();
  });

  router.get("/", async (req, res) => {
    const kind = req.query["filter"];
    const filter: Record<string, unknown> = {
      recipientId: actorOf(req).id,
      recipientRole: role,
    };
    if (typeof kind === "string" && kind !== "all") filter["kind"] = kind;

    const rows = await Notification.find(filter)
      // Newest first: a notification list is read from the top and abandoned
      // partway down.
      .sort({ at: -1 })
      .limit(200)
      .lean<NotificationDoc[]>();

    const result: (AppNotification | ProNotification)[] = rows.map((n) => ({
      id: n._id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      at: n.at.toISOString(),
      read: n.read,
      href: n.href,
    })) as (AppNotification | ProNotification)[];
    res.json(result);
  });

  /** Drives the badge. A count, not a list — the badge needs one number. */
  router.get("/unread-count", async (req, res) => {
    const count = await Notification.countDocuments({
      recipientId: actorOf(req).id,
      recipientRole: role,
      read: false,
    });
    res.json({ count });
  });

  router.post("/:id/read", async (req, res) => {
    // Scoped to the caller in the *query*, so marking someone else's
    // notification read is a 404 rather than a silent success.
    const result = await Notification.updateOne(
      { _id: param(req, "id"), recipientId: actorOf(req).id },
      { $set: { read: true } },
    );
    if (result.matchedCount === 0) throw notFound("Notification not found.");
    res.json({ ok: true });
  });

  router.post("/read-all", async (req, res) => {
    await Notification.updateMany(
      { recipientId: actorOf(req).id, recipientRole: role, read: false },
      { $set: { read: true } },
    );
    res.json({ ok: true });
  });

  return router;
}

export const consumerNotificationRouter = notificationRouter("customer");
export const proNotificationRouter = notificationRouter("pro");
