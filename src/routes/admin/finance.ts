import { Router } from "express";
import type {
  DashboardKpis,
  GstReportRow,
  JobFeedItem,
  Page,
  RefundRequest,
  Settlement,
  TransactionListItem,
} from "@cfc/types";
import { CGST_BPS, SGST_BPS } from "@cfc/types";
import { requireAuth, requireSection, scopeArea } from "../../middleware/auth";
import { Booking, type BookingDoc } from "../../models/booking";
import { Quotation } from "../../models/quotation";
import { Pro, type ProDoc } from "../../models/pro";

/**
 * Admin 3 — the dashboard, and Admin 30–34 — the money screens.
 *
 * Everything here is **derived from bookings**, never from a parallel set of
 * finance rows. The dashboard's "new bookings today" and the bookings list's
 * own count have to agree, and the only way to guarantee that is for both to
 * count the same collection.
 */
export const adminDashboardRouter = Router();
export const adminFinanceRouter = Router();

adminDashboardRouter.use(requireAuth);
adminFinanceRouter.use(requireAuth, requireSection("payments"));

/** Midnight today, local to the server — the boundary every "today" uses. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function proNames(docs: BookingDoc[]): Promise<Map<string, string>> {
  const ids = [...new Set(docs.map((d) => d.proId).filter((p): p is string => !!p))];
  const pros = await Pro.find({ _id: { $in: ids } })
    .select({ name: 1 })
    .lean<Pick<ProDoc, "_id" | "name">[]>();
  return new Map(pros.map((p) => [p._id, p.name]));
}

adminDashboardRouter.get("/kpis", async (req, res) => {
  const since = startOfToday();
  const area = scopeArea(req);
  const scoped = area ? { "address.area": area } : {};

  const [newBookingsToday, pendingQuotes, activeJobs, earned] = await Promise.all([
    Booking.countDocuments({ ...scoped, createdAt: { $gte: since } }),
    Quotation.countDocuments({ status: "pending" }),
    Booking.countDocuments({ ...scoped, status: { $in: ["assigned", "in_progress"] } }),
    Booking.aggregate<{ total: number }>([
      // Completed **today**, by when it completed rather than when it was
      // scheduled: a job booked last week and finished this morning is today's
      // earning, and the dashboard is read as a figure for the day's work.
      { $match: { ...scoped, status: "completed", updatedAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: "$breakdown.totalPaise" } } },
    ]),
  ]);

  const result: DashboardKpis = {
    newBookingsToday,
    pendingQuotes,
    activeJobs,
    totalEarningTodayPaise: earned[0]?.total ?? 0,
  };
  res.json(result);
});

adminDashboardRouter.get("/feed", async (req, res) => {
  const raw = Number(req.query["limit"]);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 50) : 8;

  const area = scopeArea(req);
  const docs = await Booking.find(area ? { "address.area": area } : {})
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean<BookingDoc[]>();

  const names = await proNames(docs);
  const result: JobFeedItem[] = docs.map((d) => ({
    id: d._id,
    reference: d.reference,
    customerName: d.customerName,
    proName: d.proId ? (names.get(d.proId) ?? null) : null,
    status: d.status,
    serviceName: d.serviceName,
    // The feed is "what moved", so it reports the last change rather than the
    // appointment time — sorting by one and displaying the other would make
    // the list look unordered.
    at: d.updatedAt.toISOString(),
  }));
  res.json(result);
});

/**
 * Admin 30 — payments taken.
 *
 * A transaction **is** a booking that has been paid: there is no separate
 * payments collection, because a second source for the same money is how a
 * revenue screen comes to disagree with the bookings it is summing. When
 * Razorpay lands it brings gateway rows, and those attach to this same
 * booking rather than replacing it.
 */
adminFinanceRouter.get("/transactions", async (req, res) => {
  const q = req.query;
  const status = typeof q["status"] === "string" ? q["status"] : "all";

  const filter: Record<string, unknown> = {};
  // `success` and `pending` are the only two states a cash or wallet booking
  // reaches. `failed` and `refunded` exist on the type for the gateway and
  // cannot occur yet (§0.3), so they match nothing rather than being faked.
  if (status === "success") filter["paid"] = true;
  if (status === "pending") filter["paid"] = false;
  if (status === "failed" || status === "refunded") filter["_id"] = { $in: [] };

  const area = scopeArea(req);
  if (area) filter["address.area"] = area;

  const page = Math.max(1, Number(q["page"]) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q["pageSize"]) || 20));

  const [docs, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<BookingDoc[]>(),
    Booking.countDocuments(filter),
  ]);

  const result: Page<TransactionListItem> = {
    items: docs.map((d) => ({
      id: d._id,
      bookingRef: d.reference,
      customerName: d.customerName,
      amountPaise: d.breakdown.totalPaise,
      method: d.paymentMethod,
      status: d.paid ? ("success" as const) : ("pending" as const),
      createdAt: d.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
  res.json(result);
});

/**
 * Admin 32 — the internal settlement layer. **Admin only, never a customer.**
 *
 * Read from the settlement frozen onto the booking at completion, not
 * recomputed: the commission rule can change, and a settled job must keep the
 * split it was actually settled on.
 */
adminFinanceRouter.get("/settlements", async (req, res) => {
  const area = scopeArea(req);
  const docs = await Booking.find({
    ...(area ? { "address.area": area } : {}),
    status: "completed",
    settlement: { $ne: null },
  })
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean<BookingDoc[]>();

  const names = await proNames(docs);

  const result: Settlement[] = docs.map((d) => ({
    id: d._id,
    bookingRef: d.reference,
    customerName: d.customerName,
    proName: d.proId ? (names.get(d.proId) ?? "") : "",
    customerPaidPaise: d.breakdown.totalPaise,
    proSharePaise: d.settlement?.grossPaise ?? 0,
    platformFeePaise: d.breakdown.platformFeePaise,
    cgstBps: CGST_BPS,
    sgstBps: SGST_BPS,
    gstPaise: d.breakdown.cgstPaise + d.breakdown.sgstPaise,
    netToProPaise: d.settlement?.netPaise ?? 0,
    settledAt: d.updatedAt.toISOString(),
  }));
  res.json(result);
});

/**
 * Admin 33 — refunds.
 *
 * Empty, and that is the truthful answer today: there is no refund model and
 * no gateway to refund through (§0.3 — Razorpay is inert until there are
 * keys). A refund issued against a cash booking is a different mechanism
 * again. Returning fabricated rows here would put money on an operator's
 * screen that does not exist.
 */
adminFinanceRouter.get("/refunds", async (_req, res) => {
  const result: RefundRequest[] = [];
  res.json(result);
});

/**
 * Admin 34 — GST collected, by month.
 *
 * **On the platform fee only, ever.** That is the agreement's rule and the one
 * thing this report must not get wrong — GST on the whole booking value would
 * overstate the liability by an order of magnitude.
 */
adminFinanceRouter.get("/gst", async (_req, res) => {
  const rows = await Booking.aggregate<{
    _id: string;
    cgst: number;
    sgst: number;
    count: number;
  }>([
    { $match: { status: "completed" } },
    {
      $group: {
        // IST, named explicitly: `$dateToString` defaults to UTC, which puts
        // every completion after 18:30 UTC on the 31st into the next month.
        _id: {
          $dateToString: { format: "%Y-%m", date: "$updatedAt", timezone: "Asia/Kolkata" },
        },
        cgst: { $sum: "$breakdown.cgstPaise" },
        sgst: { $sum: "$breakdown.sgstPaise" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: 24 },
  ]);

  const result: GstReportRow[] = rows.map((r) => ({
    month: r._id,
    cgstPaise: r.cgst,
    sgstPaise: r.sgst,
    totalPaise: r.cgst + r.sgst,
    bookingCount: r.count,
  }));
  res.json(result);
});
