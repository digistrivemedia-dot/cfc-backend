import { Router } from "express";
import type { TicketDetail, TicketListItem } from "@cfc/types";
import { badRequest, notFound } from "../error";
import { actorOf, requireAuth, requireSection } from "../middleware/auth";
import {
  Ticket,
  publicMessages,
  type TicketDoc,
  type TicketRole,
} from "../models/ticket";
import { AdminUser, type AdminUserDoc } from "../models/admin-user";
import { notify } from "../models/notification";
import { newId } from "../models/id";
import { param } from "../params";

/**
 * Customer 40–41, Pro 32 — raising and following a ticket.
 * Admin 43–44 — the queue, the thread, and working it.
 */

function toListItem(doc: TicketDoc): TicketListItem {
  return {
    id: doc._id,
    subject: doc.subject,
    fromName: doc.fromName,
    fromRole: doc.fromRole,
    priority: doc.priority,
    status: doc.status,
    assignedTo: doc.assignedTo,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toDetail(doc: TicketDoc, forAdmin: boolean): TicketDetail {
  // The whole thread for the office; the public half for the person who
  // raised it. Internal notes say things like "disputed three bookings".
  const messages = forAdmin ? doc.messages : publicMessages(doc);
  return {
    ...toListItem(doc),
    messages: messages.map((m) => ({
      id: m.id,
      author: m.author,
      isInternal: m.isInternal,
      body: m.body,
      sentAt: m.sentAt.toISOString(),
    })),
  };
}

function readBody(input: unknown, field = "body"): string {
  const v = (input as Record<string, unknown> | undefined)?.[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw badRequest("A message cannot be empty.", "MISSING_FIELD");
  }
  return v.trim().slice(0, 5000);
}

function message(author: string, body: string, isInternal = false) {
  return { id: newId("msg"), author, isInternal, body, sentAt: new Date() };
}

// -- The raiser's side (customer and pro share it) ----------------------------

function raiserRouter(role: TicketRole): Router {
  const router = Router();

  router.use(requireAuth, (req, _res, next) => {
    if (actorOf(req).role !== role) {
      next(notFound());
      return;
    }
    next();
  });

  /**
   * Their own tickets only — scoped on the token, never a parameter.
   *
   * Returns **full details**, not list items: the screens render the last
   * message in the row, and a person has a handful of tickets rather than the
   * hundreds the admin queue carries. Internal notes are stripped.
   */
  router.get("/", async (req, res) => {
    const docs = await Ticket.find({ fromId: actorOf(req).id })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean<TicketDoc[]>();
    res.json(docs.map((d) => toDetail(d, false)));
  });

  router.get("/:id", async (req, res) => {
    const doc = await Ticket.findOne({
      _id: param(req, "id"),
      // In the query, so someone else's ticket is a 404 rather than a leak.
      fromId: actorOf(req).id,
    }).lean<TicketDoc>();
    if (!doc) throw notFound("Ticket not found.");
    res.json(toDetail(doc, false));
  });

  router.post("/", async (req, res) => {
    const actor = actorOf(req);
    const subjectRaw = (req.body as { subject?: unknown })?.subject;
    const subject =
      typeof subjectRaw === "string" ? subjectRaw.trim().slice(0, 200) : "";
    if (subject === "") throw badRequest("A subject is required.", "MISSING_FIELD");

    const doc = await Ticket.create({
      _id: newId("tkt"),
      subject,
      fromId: actor.id,
      fromName: actor.name || "A customer",
      fromRole: role,
      priority: "medium",
      status: "open",
      assignedTo: null,
      assignedToId: null,
      messages: [message(actor.name || "You", readBody(req.body))],
    });

    res.status(201).json(toDetail(doc.toObject() as TicketDoc, false));
  });

  router.post("/:id/reply", async (req, res) => {
    const actor = actorOf(req);
    const body = readBody(req.body);

    const doc = await Ticket.findOne({
      _id: param(req, "id"),
      fromId: actor.id,
    }).lean<TicketDoc>();
    if (!doc) throw notFound("Ticket not found.");

    const msg = message(actor.name || "You", body);
    await Ticket.updateOne(
      { _id: doc._id },
      {
        $push: { messages: msg },
        // A reply to a resolved or closed ticket reopens it. Otherwise it
        // lands somewhere nobody is looking.
        ...(doc.status === "resolved" || doc.status === "closed"
          ? { $set: { status: "open" } }
          : {}),
      },
    );

    res.status(201).json({
      id: msg.id,
      author: msg.author,
      isInternal: false,
      body: msg.body,
      sentAt: msg.sentAt.toISOString(),
    });
  });

  return router;
}

export const consumerTicketRouter = raiserRouter("customer");
export const proTicketRouter = raiserRouter("pro");

// -- The office's side --------------------------------------------------------

export const adminTicketRouter = Router();

adminTicketRouter.use(requireAuth, requireSection("support"));

adminTicketRouter.get("/", async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  if (typeof q["status"] === "string" && q["status"] !== "all") {
    filter["status"] = q["status"];
  }
  if (typeof q["priority"] === "string" && q["priority"] !== "all") {
    filter["priority"] = q["priority"];
  }
  if (typeof q["assignedTo"] === "string") filter["assignedToId"] = q["assignedTo"];

  const docs = await Ticket.find(filter)
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean<TicketDoc[]>();
  res.json(docs.map(toListItem));
});

adminTicketRouter.get("/:id", async (req, res) => {
  const doc = await Ticket.findById(param(req, "id")).lean<TicketDoc>();
  if (!doc) throw notFound("Ticket not found.");
  res.json(toDetail(doc, true));
});

/**
 * Admin 44 — reply, or leave an internal note.
 *
 * One endpoint for both, because they are the same action with one flag: an
 * agent writing a note and an agent writing a reply are both adding to the
 * thread, and splitting them invites a UI that posts to the wrong one.
 *
 * A reply notifies the raiser. **An internal note does not** — that is the
 * entire point of it.
 */
adminTicketRouter.post("/:id/reply", async (req, res) => {
  const actor = actorOf(req);
  const body = readBody(req.body);
  const isInternal = (req.body as { isInternal?: unknown })?.isInternal === true;

  const doc = await Ticket.findById(param(req, "id")).lean<TicketDoc>();
  if (!doc) throw notFound("Ticket not found.");

  const msg = message(actor.name, body, isInternal);
  await Ticket.updateOne(
    { _id: doc._id },
    {
      $push: { messages: msg },
      $set: {
        // Replying is working it. An untouched ticket is the one an agent
        // should pick up next, so it must not stay "open" once answered.
        ...(doc.status === "open" && !isInternal ? { status: "in_progress" } : {}),
        ...(doc.assignedToId === null ? { assignedTo: actor.name, assignedToId: actor.id } : {}),
      },
    },
  );

  if (!isInternal) {
    await notify({
      role: doc.fromRole,
      to: doc.fromId,
      kind: doc.fromRole === "pro" ? "announcement" : "reminder",
      title: "Support replied",
      body: doc.subject,
      href: `/support/${doc._id}`,
    });
  }

  res.status(201).json({
    id: msg.id,
    author: msg.author,
    isInternal,
    body: msg.body,
    sentAt: msg.sentAt.toISOString(),
  });
});

adminTicketRouter.patch("/:id", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};

  if (typeof b["priority"] === "string") {
    if (!["low", "medium", "high"].includes(b["priority"])) {
      throw badRequest("Priority is low, medium or high.", "BAD_PRIORITY");
    }
    update["priority"] = b["priority"];
  }

  if (typeof b["status"] === "string") {
    if (!["open", "in_progress", "resolved", "closed"].includes(b["status"])) {
      throw badRequest("Unknown status.", "BAD_STATUS");
    }
    update["status"] = b["status"];
  }

  if (b["assignedToId"] !== undefined) {
    if (b["assignedToId"] === null) {
      update["assignedTo"] = null;
      update["assignedToId"] = null;
    } else {
      const admin = await AdminUser.findById(b["assignedToId"]).lean<AdminUserDoc>();
      // Validated against the admin list rather than taking a name: a ticket
      // assigned to a misspelled person is assigned to nobody, and nobody
      // notices until the customer chases it.
      if (!admin) throw badRequest("No such admin.", "BAD_ASSIGNEE");
      if (!admin.active) {
        throw badRequest("That admin's access has been revoked.", "INACTIVE_ASSIGNEE");
      }
      update["assignedTo"] = admin.name;
      update["assignedToId"] = admin._id;
    }
  }

  if (Object.keys(update).length === 0) {
    throw badRequest("Nothing to change.", "NO_CHANGE");
  }

  const doc = await Ticket.findOneAndUpdate(
    { _id: param(req, "id") },
    { $set: update },
    { new: true },
  ).lean<TicketDoc>();
  if (!doc) throw notFound("Ticket not found.");

  res.json(toDetail(doc, true));
});
