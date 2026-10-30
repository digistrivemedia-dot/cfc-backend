import { Router } from "express";
import type {
  CustomerBooking,
  CustomerComplaint,
  CustomerDetail,
  Page,
} from "@cfc/types";
import { badRequest, notFound } from "../../error";
import { actorOf, requireAuth, requireSection } from "../../middleware/auth";
import { Customer, type CustomerDoc } from "../../models/customer";
import { Booking, type BookingDoc } from "../../models/booking";
import { Pro, type ProDoc } from "../../models/pro";
import { walletBalance } from "../../models/wallet";
import { audit } from "../../models/audit";
import { param } from "../../params";

/**
 * Admin 19–21 — customers, their history, and blocking.
 *
 * Gated by section alone. There is no `customers.block` permission because the
 * `customers` section is Super Admin only to begin with — a sub admin cannot
 * open the screen, so a second check beneath it would guard a door nobody can
 * reach. If the section is ever delegated, blocking needs its own permission
 * at that point, the way `pros.block` is kept apart from `pros.approve_kyc`.
 */
export const adminCustomersRouter = Router();

adminCustomersRouter.use(requireAuth, requireSection("customers"));

/**
 * Booking totals and spend, for a page of customers at a time.
 *
 * One aggregate for the page rather than two queries per row: a 20-row list
 * was otherwise 40 round trips to render a column.
 *
 * Cancelled bookings count toward neither. A customer who booked and cancelled
 * has not spent anything, and showing it as spend overstates every figure an
 * operator uses to judge standing.
 */
async function bookingStats(
  customerIds: string[],
): Promise<Map<string, { totalBookings: number; totalSpentPaise: number }>> {
  if (customerIds.length === 0) return new Map();

  const rows = await Booking.aggregate<{
    _id: string;
    count: number;
    spent: number;
  }>([
    { $match: { customerId: { $in: customerIds }, status: { $ne: "cancelled" } } },
    {
      $group: {
        _id: "$customerId",
        count: { $sum: 1 },
        spent: { $sum: "$breakdown.totalPaise" },
      },
    },
  ]);

  return new Map(
    rows.map((r) => [r._id, { totalBookings: r.count, totalSpentPaise: r.spent }]),
  );
}

async function toDetail(
  doc: CustomerDoc,
  stats: { totalBookings: number; totalSpentPaise: number },
): Promise<CustomerDetail> {
  return {
    id: doc._id,
    name: doc.name,
    phone: doc.phone,
    area: doc.area,
    totalBookings: stats.totalBookings,
    totalSpentPaise: stats.totalSpentPaise,
    walletPaise: await walletBalance(doc._id),
    blocked: doc.blocked,
    joinedAt: doc.createdAt.toISOString(),
    // The customer record has no email: nothing in the sign-up flow asks for
    // one, and the type already allows null rather than an empty string.
    email: null,
    addresses: doc.addresses.map((a) =>
      [a.line1, a.line2, a.area, a.pincode].filter(Boolean).join(", "),
    ),
    // Complaints and no-shows have no model yet — neither is raised anywhere in
    // the system today, so these are true zeroes rather than placeholders.
    // `SCREEN-INVENTORY` names both (Admin 20, 40); they arrive with support.
    complaintCount: 0,
    noShowCount: 0,
  };
}

adminCustomersRouter.get("/", async (req, res) => {
  const q = req.query;
  const filter: Record<string, unknown> = {};

  const search = typeof q["search"] === "string" ? q["search"].trim() : "";
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["$or"] = [
      { name: { $regex: escaped, $options: "i" } },
      { phone: { $regex: escaped } },
    ];
  }

  const page = Math.max(1, Number(q["page"]) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q["pageSize"]) || 20));

  const [docs, total] = await Promise.all([
    Customer.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<CustomerDoc[]>(),
    Customer.countDocuments(filter),
  ]);

  const stats = await bookingStats(docs.map((d) => d._id));
  const empty = { totalBookings: 0, totalSpentPaise: 0 };

  const result: Page<CustomerDetail> = {
    items: await Promise.all(
      docs.map((d) => toDetail(d, stats.get(d._id) ?? empty)),
    ),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
  res.json(result);
});

adminCustomersRouter.get("/:id", async (req, res) => {
  const id = param(req, "id");
  const doc = await Customer.findById(id).lean<CustomerDoc>();
  if (!doc) throw notFound("Customer not found.");

  const stats = await bookingStats([id]);
  res.json(
    await toDetail(doc, stats.get(id) ?? { totalBookings: 0, totalSpentPaise: 0 }),
  );
});

/** Admin 20 — the customer's bookings, newest first. */
adminCustomersRouter.get("/:id/bookings", async (req, res) => {
  const id = param(req, "id");

  const docs = await Booking.find({ customerId: id })
    .sort({ scheduledAt: -1 })
    .limit(200)
    .lean<BookingDoc[]>();

  // One lookup for every pro on the page, rather than one per booking.
  const proIds = [...new Set(docs.map((d) => d.proId).filter((p): p is string => !!p))];
  const pros = await Pro.find({ _id: { $in: proIds } })
    .select({ name: 1 })
    .lean<Pick<ProDoc, "_id" | "name">[]>();
  const nameOf = new Map(pros.map((p) => [p._id, p.name]));

  const result: CustomerBooking[] = docs.map((d) => ({
    id: d._id,
    reference: d.reference,
    serviceName: d.serviceName,
    proName: d.proId ? (nameOf.get(d.proId) ?? null) : null,
    status: d.status,
    scheduledAt: d.scheduledAt.toISOString(),
    totalPaise: d.breakdown.totalPaise,
  }));
  res.json(result);
});

/**
 * Admin 20 — complaints raised by this customer.
 *
 * Empty until complaints exist. There is no model and no screen that raises
 * one, so the honest answer is "none" — fabricating a few so the panel looks
 * populated is how a demo teaches an operator to trust a number that is not
 * real. Arrives with support (§8c).
 */
adminCustomersRouter.get("/:id/complaints", async (req, res) => {
  void param(req, "id");
  const result: CustomerComplaint[] = [];
  res.json(result);
});

/**
 * Admin 21 — block and unblock.
 *
 * The block is enforced at **sign-in** (`consumer/auth.ts`), so a blocked
 * customer is refused at the door rather than let in to discover it at
 * checkout. A reason is required and audited: this is someone losing access to
 * an account, and "who did this and why" has to survive the operator.
 */
adminCustomersRouter.post("/:id/block", async (req, res) => {
  const id = param(req, "id");
  const raw = (req.body as { reason?: unknown })?.reason;
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 3) {
    throw badRequest("A reason is required.", "REASON_REQUIRED");
  }

  const doc = await Customer.findOneAndUpdate(
    { _id: id },
    { $set: { blocked: true, blockedReason: reason } },
    { new: true },
  ).lean<CustomerDoc>();
  if (!doc) throw notFound("Customer not found.");

  await audit(actorOf(req), "customer.blocked", { subject: id, detail: { reason } });
  res.json({ id: doc._id, blocked: true });
});

adminCustomersRouter.post("/:id/unblock", async (req, res) => {
  const id = param(req, "id");

  const doc = await Customer.findOneAndUpdate(
    { _id: id },
    { $set: { blocked: false }, $unset: { blockedReason: "" } },
    { new: true },
  ).lean<CustomerDoc>();
  if (!doc) throw notFound("Customer not found.");

  await audit(actorOf(req), "customer.unblocked", { subject: id });
  res.json({ id: doc._id, blocked: false });
});
