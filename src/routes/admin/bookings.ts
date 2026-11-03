import { Router } from "express";
import type {
  BookingDetail,
  BookingListItem,
  BookingStatus,
  Page,
} from "@cfc/types";
import { badRequest, conflict, notFound } from "../../error";
import {
  actorOf,
  requireAuth,
  requirePermission,
  requireSection,
  scopeArea,
} from "../../middleware/auth";
import { Booking, type BookingDoc } from "../../models/booking";
import { Pro, type ProDoc } from "../../models/pro";
import { PUBLIC_PREFIX } from "../../uploads";
import { audit } from "../../models/audit";
import { param } from "../../params";

/**
 * Admin 6–8 — the bookings list, one booking in full, and forcing a status.
 *
 * Area scoping is applied **in the query**, never by filtering the result: an
 * area admin must not receive rows outside their area in the first place, and
 * a post-fetch filter leaks them into the response body and the page count.
 */
export const adminBookingsRouter = Router();

adminBookingsRouter.use(requireAuth, requireSection("bookings"));

const SORTABLE = new Set(["scheduledAt", "totalPaise", "reference"]);

function buildFilter(req: Parameters<typeof scopeArea>[0]): Record<string, unknown> {
  const q = (req as { query: Record<string, unknown> }).query;
  const filter: Record<string, unknown> = {};

  const status = typeof q["status"] === "string" ? q["status"] : "all";
  if (status !== "all") filter["status"] = status;

  const area = scopeArea(req) ?? (typeof q["area"] === "string" ? q["area"] : undefined);
  if (area) filter["address.area"] = area;

  const search = typeof q["search"] === "string" ? q["search"].trim() : "";
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["$or"] = [
      { reference: { $regex: escaped, $options: "i" } },
      { customerName: { $regex: escaped, $options: "i" } },
      { serviceName: { $regex: escaped, $options: "i" } },
    ];
  }

  // The date filters bound the same field the list sorts by, so a filtered
  // range and the rows shown inside it cannot describe different things.
  const range: Record<string, Date> = {};
  if (typeof q["from"] === "string" && !Number.isNaN(Date.parse(q["from"]))) {
    range["$gte"] = new Date(q["from"]);
  }
  if (typeof q["to"] === "string" && !Number.isNaN(Date.parse(q["to"]))) {
    range["$lte"] = new Date(q["to"]);
  }
  if (Object.keys(range).length > 0) filter["scheduledAt"] = range;

  return filter;
}

async function toListItems(docs: BookingDoc[]): Promise<BookingListItem[]> {
  const proIds = [...new Set(docs.map((d) => d.proId).filter((p): p is string => !!p))];
  const pros = await Pro.find({ _id: { $in: proIds } })
    .select({ name: 1 })
    .lean<Pick<ProDoc, "_id" | "name">[]>();
  const nameOf = new Map(pros.map((p) => [p._id, p.name]));

  return docs.map((d) => ({
    id: d._id,
    reference: d.reference,
    customerName: d.customerName,
    proName: d.proId ? (nameOf.get(d.proId) ?? null) : null,
    serviceName: d.serviceName,
    status: d.status,
    scheduledAt: d.scheduledAt.toISOString(),
    totalPaise: d.breakdown.totalPaise,
    area: d.address.area,
  }));
}

adminBookingsRouter.get("/", async (req, res) => {
  const q = req.query;
  const filter = buildFilter(req);

  const page = Math.max(1, Number(q["page"]) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q["pageSize"]) || 20));

  const sortBy =
    typeof q["sortBy"] === "string" && SORTABLE.has(q["sortBy"])
      ? q["sortBy"]
      : "scheduledAt";
  const dir = q["sortDir"] === "asc" ? 1 : -1;
  const sortField = sortBy === "totalPaise" ? "breakdown.totalPaise" : sortBy;

  const [docs, total] = await Promise.all([
    Booking.find(filter)
      .sort({ [sortField]: dir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<BookingDoc[]>(),
    Booking.countDocuments(filter),
  ]);

  const result: Page<BookingListItem> = {
    items: await toListItems(docs),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
  res.json(result);
});

/**
 * Every row matching the current filters, ignoring pagination.
 *
 * The export takes what the operator is looking at, not just the visible page.
 * Capped all the same — an unbounded export is a way to take the server down
 * from a screen that looks harmless.
 */
adminBookingsRouter.get(
  "/export",
  requirePermission("bookings.export"),
  async (req, res) => {
    const docs = await Booking.find(buildFilter(req))
      .sort({ scheduledAt: -1 })
      .limit(10_000)
      .lean<BookingDoc[]>();
    res.json(await toListItems(docs));
  },
);

async function buildDetail(doc: BookingDoc): Promise<BookingDetail> {
  const pro = doc.proId
    ? await Pro.findById(doc.proId).select({ name: 1, phone: 1 }).lean<ProDoc>()
    : null;

  const [item] = await toListItems([doc]);
  return {
    ...(item as BookingListItem),
    customerPhone: doc.customerPhone,
    proPhone: pro?.phone ?? null,
    address: [doc.address.line1, doc.address.line2, doc.address.area, doc.address.pincode]
      .filter(Boolean)
      .join(", "),
    landmark: doc.address.landmark ?? null,
    notes: doc.notes,
    timeline: doc.events.map((e) => ({
      label: e.label,
      at: e.at.toISOString(),
      actor: e.actor,
      ...(e.forced ? { forced: true } : {}),
    })),
    // Read from the frozen breakdown, never recomputed from current pricing —
    // §4.1, the reason a fee change must not rewrite old invoices.
    platformFeePaise: doc.breakdown.platformFeePaise,
    // CGST + SGST. `BookingDetail` carries one GST figure; the breakdown keeps
    // them apart because the tax invoice has to show both lines.
    gstPaise: doc.breakdown.cgstPaise + doc.breakdown.sgstPaise,
    proPayoutPaise: doc.settlement?.netPaise ?? 0,
    paymentMethod: doc.paymentMethod,
    paid: doc.paid,
    /**
     * The job's own evidence — what the professional walked into and what
     * they left. Photos and videos both.
     *
     * The office had no way to see any of it, which is the one thing a
     * complaint actually turns on: "they said it was done" against a photo of
     * it done. Served from the public root, so these are plain URLs.
     */
    beforePhotoUrls: doc.beforePhotoPaths.map((f) => `${PUBLIC_PREFIX}/${f}`),
    afterPhotoUrls: doc.afterPhotoPaths.map((f) => `${PUBLIC_PREFIX}/${f}`),
  };
}

/** Admin 7 — one booking, with the timeline and the settlement split. */
adminBookingsRouter.get("/:id", async (req, res) => {
  const doc = await Booking.findById(param(req, "id")).lean<BookingDoc>();
  if (!doc) throw notFound("Booking not found.");

  // Area admins are scoped on the detail route too. Without this, a row they
  // cannot see in the list is still readable by pasting its id.
  const area = scopeArea(req);
  if (area && doc.address.area !== area) throw notFound("Booking not found.");

  res.json(await buildDetail(doc));
});

/**
 * Admin 8 — force a status. "Admin intervention on disputes."
 *
 * An override is **allowed to break the normal transition table** — that is
 * what forcing means, and a dispute is exactly the case the table does not
 * anticipate. What it is not allowed to do is reopen a terminal booking:
 * completion has already written a settlement row and paid the pro, so moving
 * a completed job back would let a second completion credit them twice. That
 * correction is a ledger adjustment, not a rewrite of what happened.
 *
 * The reason is required, audited, and written onto the timeline as `forced`,
 * so the customer-visible history says an operator did this rather than
 * presenting it as something that occurred on its own.
 */
adminBookingsRouter.post(
  "/:id/status",
  requirePermission("bookings.override_status"),
  async (req, res) => {
    const id = param(req, "id");
    const body = (req.body ?? {}) as { status?: unknown; reason?: unknown };

    const next = body.status;
    if (typeof next !== "string") {
      throw badRequest("Which status?", "MISSING_FIELD");
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) {
      throw badRequest(
        "An override needs a reason for the audit trail.",
        "REASON_REQUIRED",
      );
    }

    const doc = await Booking.findById(id).lean<BookingDoc>();
    if (!doc) throw notFound("Booking not found.");

    const area = scopeArea(req);
    if (area && doc.address.area !== area) throw notFound("Booking not found.");

    if (doc.status === "completed" || doc.status === "cancelled") {
      throw conflict(
        `A ${doc.status} booking cannot be reopened. Correct it on the ledger instead.`,
        "TERMINAL",
      );
    }
    if (doc.status === next) {
      throw conflict(`That booking is already ${next}.`, "NO_CHANGE");
    }

    const actor = actorOf(req);
    await Booking.updateOne(
      { _id: id },
      {
        $set: { status: next as BookingStatus },
        $push: {
          events: {
            label: `Status forced to ${next} — ${reason}`,
            at: new Date(),
            actor: actor.name,
            forced: true,
          },
        },
      },
    );

    await audit(actor, "booking.status.forced", {
      subject: id,
      detail: { from: doc.status, to: next, reason },
    });

    // The updated detail, so the screen re-renders from the record rather than
    // from what it hoped the write did.
    const updated = await Booking.findById(id).lean<BookingDoc>();
    res.json(await buildDetail(updated as BookingDoc));
  },
);
