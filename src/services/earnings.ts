import type { EarningsPeriod } from "@cfc/types";
import { COMMISSION_FREE_JOBS } from "@cfc/types";
import { ProLedger, PAYOUT_WINDOW_HOURS, type ProLedgerDoc } from "../models/pro-ledger";
import { Pro, type ProDoc } from "../models/pro";
import { newId } from "../models/id";

/**
 * Pro 19–25 — what a pro earned, and when they can take it.
 *
 * **One function owns each period's cutoff**, and that is the whole reason this
 * module exists rather than each route computing its own window.
 * `PRO-OPEN-ITEMS` 4.4 records the alternative: the summary counted from the
 * start of the calendar week while the chart walked back a fixed seven days,
 * so on a Wednesday the same screen showed a **₹1,205 disagreement about the
 * pro's own income.** Both windows were defensible, which was exactly the
 * problem. A chart that does not add up to the figure above it destroys trust
 * in both numbers.
 */

/**
 * The start of a period. **The single source.**
 *
 * Calendar-aligned, not rolling: "this week" means since Monday, because that
 * is what a pro means by it. Anything reading a period reads this.
 */
export function cutoffFor(period: EarningsPeriod): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);

  if (period === "today") return d;

  if (period === "week") {
    // Monday as the week's start. `getDay()` returns 0 for Sunday, which is
    // the end of the week here rather than the beginning.
    const day = d.getDay();
    const backToMonday = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - backToMonday);
    return d;
  }

  d.setDate(1);
  return d;
}

/** Credits only — a penalty is not an earning, and a payout is not income. */
function creditFilter(proId: string, from?: Date) {
  return {
    proId,
    kind: "credit" as const,
    ...(from ? { at: { $gte: from } } : {}),
  };
}

export async function earningsSummary(
  proId: string,
  period: EarningsPeriod,
): Promise<{
  grossPaise: number;
  cfcFeePaise: number;
  netPaise: number;
  jobCount: number;
  commissionFreeJobs: number;
}> {
  const rows = await ProLedger.find(
    creditFilter(proId, cutoffFor(period)),
  ).lean<ProLedgerDoc[]>();

  return {
    grossPaise: rows.reduce((t, r) => t + (r.grossPaise ?? 0), 0),
    cfcFeePaise: rows.reduce((t, r) => t + (r.feePaise ?? 0), 0),
    netPaise: rows.reduce((t, r) => t + r.amountPaise, 0),
    jobCount: rows.length,
    commissionFreeJobs: rows.filter((r) => (r.feePaise ?? 0) === 0).length,
  };
}

/**
 * Pro 22 — a daily series for the chart.
 *
 * Built from the same rows and **the same cutoff** the summary sums, so the two
 * cannot disagree.
 *
 * Days with no work are kept as zero rather than skipped: a gap in a line reads
 * as missing data, a zero reads as a day off, and only one of those is true.
 */
export async function earningsSeries(
  proId: string,
  period: EarningsPeriod,
): Promise<{ day: string; netPaise: number; jobs: number }[]> {
  const cutoff = cutoffFor(period);
  const rows = await ProLedger.find(creditFilter(proId, cutoff)).lean<ProLedgerDoc[]>();

  const buckets = new Map<string, { netPaise: number; jobs: number }>();
  const cursor = new Date(cutoff);
  const end = new Date();
  while (cursor <= end) {
    buckets.set(cursor.toDateString(), { netPaise: 0, jobs: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const row of rows) {
    const bucket = buckets.get(row.at.toDateString());
    if (bucket) {
      bucket.netPaise += row.amountPaise;
      bucket.jobs += 1;
    }
  }

  // Weekday labels while the window is short enough for them to be unique; a
  // date once it is not. "Mon" five times down a month's axis is worse than no
  // label at all.
  const short = buckets.size <= 7;

  return [...buckets.entries()].map(([key, v]) => {
    const d = new Date(key);
    return {
      day: d.toLocaleDateString("en-IN", {
        ...(short ? { weekday: "short" as const } : {}),
        day: "numeric",
        ...(short ? {} : { month: "short" as const }),
      }),
      netPaise: v.netPaise,
      jobs: v.jobs,
    };
  });
}

/** Every settled job, newest first. Pro 23. */
export async function earningsHistory(proId: string): Promise<
  {
    bookingId: string;
    grossPaise: number;
    cfcFeePaise: number;
    cfcFeeBps: number;
    commissionFree: boolean;
    netPaise: number;
    completedAt: string;
  }[]
> {
  const rows = await ProLedger.find(creditFilter(proId))
    .sort({ at: -1 })
    .lean<ProLedgerDoc[]>();

  return rows.map((r) => {
    const gross = r.grossPaise ?? 0;
    const fee = r.feePaise ?? 0;
    return {
      bookingId: r.bookingId ?? "",
      grossPaise: gross,
      cfcFeePaise: fee,
      // Derived from what was actually charged rather than from the current
      // rate, so a historical row keeps the rate it was settled at.
      cfcFeeBps: gross > 0 ? Math.round((fee / gross) * 10_000) : 0,
      commissionFree: fee === 0,
      netPaise: r.amountPaise,
      completedAt: r.at.toISOString(),
    };
  });
}

/**
 * Pro 25 — jobs done where the money has not arrived yet.
 *
 * "Pending" means inside the 48-hour window, which is the only reason a
 * completed job's money is not in the pro's account. Saying so is the point of
 * the screen: a pro looking at a completed job with no payment needs to know
 * whether to wait or to raise a ticket.
 *
 * **Overdue rows sort first.** Past 48 hours the pro is owed money against a
 * stated commitment, and that is the platform's failure rather than a rounding
 * detail — so it goes to the top rather than being buried in date order.
 */
export async function pendingSettlements(proId: string): Promise<
  {
    bookingId: string;
    bookingReference: string;
    netPaise: number;
    grossPaise: number;
    cfcFeePaise: number;
    completedAt: string;
    hoursRemaining: number;
    overdue: boolean;
  }[]
> {
  const now = Date.now();

  // Anything still inside its window, plus anything whose window has passed
  // without a payout — the second group is what "overdue" means.
  const rows = await ProLedger.find({
    proId,
    kind: "credit",
    at: { $gte: new Date(now - 14 * 24 * 3_600_000) },
  })
    .sort({ at: -1 })
    .lean<ProLedgerDoc[]>();

  const out = rows
    .filter((r) => r.availableAt.getTime() > now - 24 * 3_600_000)
    .map((r) => {
      const hoursRemaining =
        Math.round(((r.availableAt.getTime() - now) / 3_600_000) * 10) / 10;
      return {
        bookingId: r.bookingId ?? "",
        bookingReference: r.bookingReference ?? r.label,
        netPaise: r.amountPaise,
        grossPaise: r.grossPaise ?? 0,
        cfcFeePaise: r.feePaise ?? 0,
        completedAt: r.at.toISOString(),
        hoursRemaining,
        overdue: hoursRemaining < 0,
      };
    });

  // Overdue first, then soonest to clear.
  out.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return a.hoursRemaining - b.hoursRemaining;
  });

  return out;
}

/**
 * How many commission-free jobs are left.
 *
 * Zero means the offer is over and the banner disappears — a "0 free jobs
 * remaining" badge is worse than none.
 */
export async function commissionFreeRemaining(proId: string): Promise<number> {
  const pro = await Pro.findById(proId).select({ jobsCompleted: 1 }).lean<
    Pick<ProDoc, "jobsCompleted">
  >();
  return Math.max(0, COMMISSION_FREE_JOBS - (pro?.jobsCompleted ?? 0));
}

/**
 * Credits a completed job to the pro's wallet.
 *
 * Called from completion. **Idempotent** by a unique index on
 * (proId, bookingId, kind: credit) — a retried completion must not pay twice,
 * and that guard belongs in the database rather than in a check that can race.
 */
export async function creditJob(input: {
  proId: string;
  bookingId: string;
  bookingReference: string;
  grossPaise: number;
  cfcFeePaise: number;
  netPaise: number;
  completedAt: Date;
}): Promise<void> {
  try {
    await ProLedger.create({
      _id: newId("ple"),
      proId: input.proId,
      kind: "credit",
      label: input.bookingReference,
      amountPaise: input.netPaise,
      grossPaise: input.grossPaise,
      feePaise: input.cfcFeePaise,
      bookingId: input.bookingId,
      bookingReference: input.bookingReference,
      // The agreement's 48-hour auto-transfer window, stored rather than
      // recomputed per query.
      availableAt: new Date(
        input.completedAt.getTime() + PAYOUT_WINDOW_HOURS * 3_600_000,
      ),
      at: input.completedAt,
    });
  } catch (err) {
    // A duplicate key means this job was already credited, which is exactly
    // what the index is for. Anything else is a real failure.
    if (
      err !== null &&
      typeof err === "object" &&
      (err as { code?: number }).code === 11000
    ) {
      return;
    }
    throw err;
  }
}
