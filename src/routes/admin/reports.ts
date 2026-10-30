import { Router } from "express";
import type {
  ActiveUsersPoint,
  BookingsPoint,
  CustomerGrowthPoint,
  PeakHourRow,
  ProPerformanceRow,
  RatingTrendPoint,
  RevenueBreakdownRow,
  RevenuePoint,
  ServiceDemandRow,
} from "@cfc/types";
import { requireAuth, requireSection } from "../../middleware/auth";
import { Booking } from "../../models/booking";
import { Customer } from "../../models/customer";
import { Pro, ratingOf, type ProDoc } from "../../models/pro";
import { Review } from "../../models/review";
import { Service, SubCategory, Category } from "../../models/catalog";
import { ProLedger } from "../../models/pro-ledger";

/**
 * Admin 38–42 — reports.
 *
 * Every figure is aggregated from the collections the earlier phases fill.
 * Nothing here keeps its own counter, so a report and the screen it summarises
 * cannot disagree — the cost is a `$group` per request over a pre-launch
 * dataset, which is the right trade until a profiler says otherwise.
 *
 * `ponytail:` *aggregate per request, no materialised rollups. Add a nightly
 * rollup collection when a report is slow enough to notice, and let the
 * measurement pick which one.*
 *
 * **Revenue is recognised at completion**, by `updatedAt`, matching the GST
 * report. A booking placed last week and finished today is today's revenue —
 * counting it on the day it was scheduled would book money for work that may
 * never happen.
 */
export const adminReportsRouter = Router();

adminReportsRouter.use(requireAuth, requireSection("reports"));

/** The window every time series covers. Matches what the charts render. */
const DAYS = 14;

/**
 * Every bucket boundary is **IST**, on both sides of the comparison.
 *
 * `$dateToString` defaults to UTC. Bucket keys built from local date parts
 * therefore stopped matching the aggregation's keys for any booking completed
 * after 18:30 UTC — the whole evening fell into the next day's bucket, and
 * "today" read zero while the money was plainly in the database. The operator
 * reads these in Trichy, so IST is the right boundary; what matters is that
 * one timezone names both sides.
 */
const IST = "Asia/Kolkata";

/** `YYYY-MM-DD` in IST — the same shape `$dateToString` is asked to produce. */
function istKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: IST });
}

/**
 * The last `DAYS` days as `YYYY-MM-DD` keys with their display labels.
 *
 * Built up front and zero-filled, so a day with no bookings is a gap in the
 * line rather than a missing point — a chart that silently drops empty days
 * compresses the x-axis and makes a quiet week look busy.
 *
 * Labels are formatted **here**: `RevenuePoint.label` is documented as
 * already-formatted because a chart never formats a date.
 */
function dayBuckets(): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86_400_000);
    out.push({
      key: istKey(d),
      label: d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short" }),
    });
  }
  return out;
}

function windowStart(): Date {
  const d = new Date(Date.now() - (DAYS - 1) * 86_400_000);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Group by IST calendar day, matching `istKey`. */
const DAY_KEY = {
  $dateToString: { format: "%Y-%m-%d", date: "$updatedAt", timezone: IST },
};

adminReportsRouter.get("/revenue-series", async (_req, res) => {
  const rows = await Booking.aggregate<{
    _id: string;
    revenue: number;
    fee: number;
    gst: number;
  }>([
    { $match: { status: "completed", updatedAt: { $gte: windowStart() } } },
    {
      $group: {
        _id: DAY_KEY,
        revenue: { $sum: "$breakdown.totalPaise" },
        fee: { $sum: "$breakdown.platformFeePaise" },
        gst: { $sum: { $add: ["$breakdown.cgstPaise", "$breakdown.sgstPaise"] } },
      },
    },
  ]);

  const byDay = new Map(rows.map((r) => [r._id, r]));
  const result: RevenuePoint[] = dayBuckets().map(({ key, label }) => ({
    label,
    revenuePaise: byDay.get(key)?.revenue ?? 0,
    platformFeePaise: byDay.get(key)?.fee ?? 0,
    gstPaise: byDay.get(key)?.gst ?? 0,
  }));
  res.json(result);
});

adminReportsRouter.get("/bookings-series", async (_req, res) => {
  const rows = await Booking.aggregate<{
    _id: { day: string; status: string };
    count: number;
  }>([
    {
      $match: {
        status: { $in: ["completed", "cancelled"] },
        updatedAt: { $gte: windowStart() },
      },
    },
    { $group: { _id: { day: DAY_KEY, status: "$status" }, count: { $sum: 1 } } },
  ]);

  const at = (day: string, status: string) =>
    rows.find((r) => r._id.day === day && r._id.status === status)?.count ?? 0;

  const result: BookingsPoint[] = dayBuckets().map(({ key, label }) => ({
    label,
    completed: at(key, "completed"),
    cancelled: at(key, "cancelled"),
  }));
  res.json(result);
});

/**
 * Admin 41 — pro performance.
 *
 * `completionRateBps` is completed over everything ever assigned to them, in
 * basis points. A pro with nothing assigned reads 0 rather than 100: a perfect
 * score from no work is the kind of figure that sorts a new joiner to the top
 * of a leaderboard.
 *
 * `noShowCount` is **always 0** — no-shows are not tracked anywhere in the
 * system (§2.6, Admin 20/40). Reported as a real zero rather than omitted,
 * because the column exists on the screen; it becomes meaningful when a
 * no-show can actually be recorded.
 */
adminReportsRouter.get("/pro-performance", async (_req, res) => {
  const pros = await Pro.find({ approvalStatus: "approved" })
    .select({ name: 1, ratingSum: 1, ratingCount: 1 })
    .lean<Pick<ProDoc, "_id" | "name" | "ratingSum" | "ratingCount">[]>();
  if (pros.length === 0) {
    res.json([]);
    return;
  }

  const ids = pros.map((p) => p._id);
  const [assigned, earned] = await Promise.all([
    Booking.aggregate<{ _id: { pro: string; status: string }; count: number }>([
      { $match: { proId: { $in: ids } } },
      { $group: { _id: { pro: "$proId", status: "$status" }, count: { $sum: 1 } } },
    ]),
    ProLedger.aggregate<{ _id: string; total: number }>([
      { $match: { proId: { $in: ids }, kind: "credit" } },
      { $group: { _id: "$proId", total: { $sum: "$amountPaise" } } },
    ]),
  ]);

  const earnedBy = new Map(earned.map((e) => [e._id, e.total]));

  const result: ProPerformanceRow[] = pros
    .map((p) => {
      const mine = assigned.filter((a) => a._id.pro === p._id);
      const total = mine.reduce((s, a) => s + a.count, 0);
      const done = mine.find((a) => a._id.status === "completed")?.count ?? 0;
      return {
        proName: p.name,
        completionRateBps: total === 0 ? 0 : Math.round((done / total) * 10_000),
        avgRating: ratingOf(p),
        jobsCompleted: done,
        noShowCount: 0,
        earnedPaise: earnedBy.get(p._id) ?? 0,
      };
    })
    .sort((a, b) => b.jobsCompleted - a.jobsCompleted);
  res.json(result);
});

/**
 * Admin 39 — which services are in demand, and where.
 *
 * `area` is the area that service is booked in **most**, not a random one: the
 * row answers "where is this wanted", and an arbitrary pick would answer
 * nothing while looking like it had.
 */
adminReportsRouter.get("/service-demand", async (_req, res) => {
  const rows = await Booking.aggregate<{
    _id: { service: string; area: string };
    count: number;
  }>([
    { $match: { status: { $ne: "cancelled" } } },
    {
      $group: {
        _id: { service: "$serviceName", area: "$address.area" },
        count: { $sum: 1 },
      },
    },
  ]);

  const byService = new Map<string, { count: number; areas: Map<string, number> }>();
  for (const r of rows) {
    const entry = byService.get(r._id.service) ?? { count: 0, areas: new Map() };
    entry.count += r.count;
    entry.areas.set(r._id.area, (entry.areas.get(r._id.area) ?? 0) + r.count);
    byService.set(r._id.service, entry);
  }

  const result: ServiceDemandRow[] = [...byService.entries()]
    .map(([serviceName, v]) => ({
      serviceName,
      bookingCount: v.count,
      area: [...v.areas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
    }))
    .sort((a, b) => b.bookingCount - a.bookingCount);
  res.json(result);
});

/**
 * Admin 42 — customer growth.
 *
 * `repeatBookingRateBps` is, of the customers who booked on that day, the
 * share who had booked at least once **before** it. That is a real definition
 * of "repeat", and it is worth stating because the phrase could equally mean
 * the platform-wide share of repeat customers — a different number that moves
 * for different reasons.
 */
adminReportsRouter.get("/customer-growth", async (_req, res) => {
  const since = windowStart();
  const buckets = dayBuckets();

  const [signups, bookings] = await Promise.all([
    Customer.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: IST } },
          count: { $sum: 1 },
        },
      },
    ]),
    // Every booking in the window, plus each customer's first-ever booking
    // date, so "had they booked before this one" is answerable without a query
    // per row.
    Booking.find({ createdAt: { $gte: since } })
      .select({ customerId: 1, createdAt: 1 })
      .lean<{ customerId: string; createdAt: Date }[]>(),
  ]);

  const firstEver = new Map(
    (
      await Booking.aggregate<{ _id: string; first: Date }>([
        { $group: { _id: "$customerId", first: { $min: "$createdAt" } } },
      ])
    ).map((r) => [r._id, r.first]),
  );

  const signupBy = new Map(signups.map((s) => [s._id, s.count]));
  const dayOf = istKey;

  const result: CustomerGrowthPoint[] = buckets.map(({ key, label }) => {
    const sameDay = bookings.filter((b) => dayOf(b.createdAt) === key);
    const bookers = [...new Set(sameDay.map((b) => b.customerId))];
    const repeats = bookers.filter((id) => {
      const first = firstEver.get(id);
      return first !== undefined && dayOf(first) !== key;
    }).length;

    return {
      label,
      newSignups: signupBy.get(key) ?? 0,
      repeatBookingRateBps:
        bookers.length === 0 ? 0 : Math.round((repeats / bookers.length) * 10_000),
    };
  });
  res.json(result);
});

/** Admin 38 — revenue by category, resolved service → sub-category → category. */
adminReportsRouter.get("/revenue-by-category", async (_req, res) => {
  const rows = await Booking.aggregate<{
    _id: string;
    revenue: number;
    fee: number;
    count: number;
  }>([
    { $match: { status: "completed" } },
    {
      $group: {
        _id: "$serviceId",
        revenue: { $sum: "$breakdown.totalPaise" },
        fee: { $sum: "$breakdown.platformFeePaise" },
        count: { $sum: 1 },
      },
    },
  ]);
  if (rows.length === 0) {
    res.json([]);
    return;
  }

  // The service does not carry a categoryId by design, so the chain is walked
  // rather than assumed.
  const services = await Service.find({ _id: { $in: rows.map((r) => r._id) } })
    .select({ subCategoryId: 1 })
    .lean<{ _id: string; subCategoryId: string }[]>();
  const subs = await SubCategory.find({
    _id: { $in: services.map((s) => s.subCategoryId) },
  })
    .select({ categoryId: 1 })
    .lean<{ _id: string; categoryId: string }[]>();
  const cats = await Category.find({ _id: { $in: subs.map((s) => s.categoryId) } })
    .select({ name: 1 })
    .lean<{ _id: string; name: string }[]>();

  const subOf = new Map(services.map((s) => [s._id, s.subCategoryId]));
  const catOf = new Map(subs.map((s) => [s._id, s.categoryId]));
  const nameOf = new Map(cats.map((c) => [c._id, c.name]));

  const totals = new Map<string, RevenueBreakdownRow>();
  for (const r of rows) {
    const label = nameOf.get(catOf.get(subOf.get(r._id) ?? "") ?? "") ?? "Uncategorised";
    const cur = totals.get(label) ?? {
      label,
      revenuePaise: 0,
      platformFeePaise: 0,
      bookingCount: 0,
    };
    cur.revenuePaise += r.revenue;
    cur.platformFeePaise += r.fee;
    cur.bookingCount += r.count;
    totals.set(label, cur);
  }

  res.json([...totals.values()].sort((a, b) => b.revenuePaise - a.revenuePaise));
});

adminReportsRouter.get("/revenue-by-area", async (_req, res) => {
  const rows = await Booking.aggregate<{
    _id: string;
    revenue: number;
    fee: number;
    count: number;
  }>([
    { $match: { status: "completed" } },
    {
      $group: {
        _id: "$address.area",
        revenue: { $sum: "$breakdown.totalPaise" },
        fee: { $sum: "$breakdown.platformFeePaise" },
        count: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
  ]);

  const result: RevenueBreakdownRow[] = rows.map((r) => ({
    label: r._id || "Unknown",
    revenuePaise: r.revenue,
    platformFeePaise: r.fee,
    bookingCount: r.count,
  }));
  res.json(result);
});

/**
 * Admin 39 — bookings by hour of day.
 *
 * All 24 hours are returned whether or not anything was booked in them: the
 * chart is read as a shape across the day, and dropping the quiet hours would
 * make 2am look like a busy period simply because it is missing.
 *
 * Bucketed on the **scheduled** time, not when the booking was placed — this
 * answers "when do customers want us there".
 */
adminReportsRouter.get("/peak-hours", async (_req, res) => {
  const rows = await Booking.aggregate<{ _id: number; count: number }>([
    { $match: { status: { $ne: "cancelled" } } },
    {
      $group: {
        _id: { $hour: { date: "$scheduledAt", timezone: "Asia/Kolkata" } },
        count: { $sum: 1 },
      },
    },
  ]);

  const byHour = new Map(rows.map((r) => [r._id, r.count]));
  const result: PeakHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label:
      hour === 0
        ? "12 am"
        : hour < 12
          ? `${hour} am`
          : hour === 12
            ? "12 pm"
            : `${hour - 12} pm`,
    bookingCount: byHour.get(hour) ?? 0,
  }));
  res.json(result);
});

/** Admin 40 — the platform's average rating, day by day. */
adminReportsRouter.get("/rating-trend", async (_req, res) => {
  const rows = await Review.aggregate<{ _id: string; sum: number; count: number }>([
    { $match: { createdAt: { $gte: windowStart() } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: IST } },
        sum: { $sum: "$rating" },
        count: { $sum: 1 },
      },
    },
  ]);

  const byDay = new Map(rows.map((r) => [r._id, r]));
  const result: RatingTrendPoint[] = dayBuckets().map(({ key, label }) => {
    const row = byDay.get(key);
    return {
      label,
      // A day with no ratings is 0, not last known value carried forward: a
      // flat line through a gap reads as "nobody complained" rather than
      // "nobody rated".
      avgRating: row ? Number((row.sum / row.count).toFixed(2)) : 0,
      ratingCount: row?.count ?? 0,
    };
  });
  res.json(result);
});

/**
 * Admin 42 — active users.
 *
 * ⚠️ **"Active" here means placed a booking.** Nothing in the platform records
 * sessions or app opens, so a browse-only visit is invisible to this. That
 * makes these figures a floor rather than the usual DAU/MAU, and they will
 * read far lower than an analytics tool would report.
 *
 * Defined this way deliberately: the alternative is inventing a session
 * counter so a chart has a bigger number on it. When real event tracking
 * lands, this is the endpoint that changes — not the screen.
 *
 * MAU is the trailing 30 days at each point, so DAU can never exceed it.
 */
adminReportsRouter.get("/active-users", async (_req, res) => {
  const buckets = dayBuckets();
  const earliest = new Date(windowStart().getTime() - 30 * 86_400_000);

  const rows = await Booking.find({ createdAt: { $gte: earliest } })
    .select({ customerId: 1, createdAt: 1 })
    .lean<{ customerId: string; createdAt: Date }[]>();

  const result: ActiveUsersPoint[] = buckets.map(({ key, label }) => {
    const end = new Date(`${key}T23:59:59.999`);
    const dayStart = new Date(`${key}T00:00:00.000`);
    const monthStart = new Date(end.getTime() - 30 * 86_400_000);

    const dau = new Set(
      rows
        .filter((r) => r.createdAt >= dayStart && r.createdAt <= end)
        .map((r) => r.customerId),
    ).size;
    const mau = new Set(
      rows
        .filter((r) => r.createdAt > monthStart && r.createdAt <= end)
        .map((r) => r.customerId),
    ).size;

    return { label, dau, mau };
  });
  res.json(result);
});
