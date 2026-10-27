import { CFC_COMMISSION_BPS, COMMISSION_FREE_JOBS } from "@cfc/types";
import { Booking, canTransition, type BookingDoc } from "../models/booking";
import { Pro, type ProDoc } from "../models/pro";
import { getSettings } from "../models/settings";
import { newId } from "../models/id";

/**
 * Pro 13–19 — travelling, working, and closing the job.
 *
 * The completion gate is **ported from `pro-work.ts` in the exact order it was
 * written**, and the order is the substance:
 *
 *   1. **OTP first.** It is the customer's own confirmation that the work is
 *      done, and no other check matters without it.
 *   2. **At least one after-photo.** Proof of what was left behind.
 *   3. **GPS within the configured limit** — and a *known* distance beyond it
 *      blocks while an *unknown* one does not.
 *
 * That third rule is the one to not "improve". A pro who has done the work must
 * be able to close the job. A weak indoor signal is the one thing they cannot
 * fix, and blocking there turns the platform's proof requirement into their
 * problem. The missing fix is recorded for admin review instead
 * (`PRO-OPEN-ITEMS` 2.4).
 */

/** Metres between two coordinates. Haversine. */
export function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Commission on one job. **Ported, not re-derived** (BACKEND-PLAN.md §9).
 *
 * 15%, with the **first 20 jobs free**. `jobsCompletedBefore` makes the
 * boundary unambiguous: job 20 arrives with 19 behind it and is free, job 21
 * arrives with 20 and is charged.
 *
 * Rounded **down**, and the net derived by **subtraction** — so gross, fee and
 * net always reconcile. A settlement that does not add up is worse than a rupee.
 */
export function settle(grossPaise: number, jobsCompletedBefore: number) {
  const commissionFree = jobsCompletedBefore < COMMISSION_FREE_JOBS;
  const cfcFeePaise = commissionFree
    ? 0
    : Math.floor((grossPaise * CFC_COMMISSION_BPS) / 10_000);
  return {
    grossPaise,
    cfcFeePaise,
    netPaise: grossPaise - cfcFeePaise,
    commissionFree,
  };
}

/**
 * What the pro earns on a booking.
 *
 * The work plus any on-site extras, less the discount. **Not the customer's
 * total**: the platform fee and its GST are CFC's, and `PRO-OPEN-ITEMS` is
 * explicit that treating GST as a pro deduction would cost each pro ₹270 on a
 * ₹1,500 job.
 */
export function grossFor(booking: BookingDoc): number {
  const extras = booking.extraCharges.reduce((s, c) => s + c.amountPaise, 0);
  return (
    booking.breakdown.servicePaise +
    booking.breakdown.addOnsPaise +
    extras -
    booking.breakdown.discountPaise
  );
}

export type StartResult =
  | { ok: true; booking: BookingDoc }
  | { ok: false; reason: string };

/**
 * Pro 15 — the pro has arrived and is starting work.
 *
 * `assigned → in_progress`, through the shared state machine. This is also the
 * point the customer's completion OTP becomes visible to them: before a pro is
 * on site there is nothing to confirm, and a code shown for days is a code that
 * leaks.
 */
export async function startJob(
  proId: string,
  bookingId: string,
): Promise<StartResult> {
  const booking = await Booking.findOne({
    _id: bookingId,
    proId,
  }).lean<BookingDoc>();
  if (!booking) return { ok: false, reason: "That job could not be found." };

  if (!canTransition(booking.status, "in_progress")) {
    return {
      ok: false,
      reason:
        booking.status === "in_progress"
          ? "That job is already under way."
          : `A ${booking.status} job cannot be started.`,
    };
  }

  const updated = await Booking.findOneAndUpdate(
    // Guarded on the current status, so two taps cannot both transition.
    { _id: bookingId, proId, status: "assigned" },
    {
      $set: { status: "in_progress" },
      $push: { events: { at: new Date(), label: "Work started", actor: "Professional" } },
    },
    { new: true },
  ).lean<BookingDoc>();

  if (!updated) return { ok: false, reason: "That job is no longer startable." };
  return { ok: true, booking: updated };
}

export type CompletionRejection =
  | { reason: "wrong-otp" }
  | { reason: "no-after-photos" }
  | { reason: "too-far"; metres: number; limit: number }
  | { reason: "bad-state"; message: string };

export type CompletionResult =
  | {
      ok: true;
      booking: BookingDoc;
      earning: ReturnType<typeof settle>;
    }
  | { ok: false; error: CompletionRejection };

/**
 * Pro 18 → 19 — close the job.
 *
 * Returns the settlement rather than a bare success, because the very next
 * screen the pro sees is what they earned. Computing it there from separate
 * inputs is how the completion screen and the earnings screen come to disagree.
 */
export async function completeJob(input: {
  proId: string;
  bookingId: string;
  otp: string;
  /** From the device's own GPS. **Null means no fix** — see the file header. */
  proPoint: { lat: number; lng: number } | null;
}): Promise<CompletionResult> {
  const booking = await Booking.findOne({
    _id: input.bookingId,
    proId: input.proId,
  }).lean<BookingDoc>();

  if (!booking) {
    return {
      ok: false,
      error: { reason: "bad-state", message: "That job could not be found." },
    };
  }
  if (booking.status !== "in_progress") {
    return {
      ok: false,
      error: {
        reason: "bad-state",
        message:
          booking.status === "completed"
            ? "That job is already closed."
            : "Start the job before completing it.",
      },
    };
  }

  // 1. The OTP first. The customer's own confirmation, and nothing else matters
  //    without it — not the photos, not the distance.
  if (
    booking.completionOtp === null ||
    input.otp.trim() !== booking.completionOtp
  ) {
    return { ok: false, error: { reason: "wrong-otp" } };
  }

  // 2. At least one after-photo.
  if (booking.afterPhotoPaths.length < 1) {
    return { ok: false, error: { reason: "no-after-photos" } };
  }

  // 3. The GPS gate. A *known* distance beyond the limit blocks; an *unknown*
  //    one does not. Do not "improve" this — see the file header.
  const settings = await getSettings();
  const limit = settings.gpsLimitMetres;
  const distanceM =
    input.proPoint && booking.address.locationVerified
      ? metresBetween(input.proPoint, {
          lat: booking.address.lat,
          lng: booking.address.lng,
        })
      : null;

  if (distanceM !== null && distanceM > limit) {
    return {
      ok: false,
      error: { reason: "too-far", metres: distanceM, limit },
    };
  }

  const pro = await Pro.findById(input.proId).lean<ProDoc>();
  if (!pro) {
    return {
      ok: false,
      error: { reason: "bad-state", message: "That account no longer exists." },
    };
  }

  // Settled against the pro's count *before* this job, which is what makes the
  // first-20-free boundary unambiguous.
  const earning = settle(grossFor(booking), pro.jobsCompleted);
  const at = new Date();

  const updated = await Booking.findOneAndUpdate(
    { _id: input.bookingId, proId: input.proId, status: "in_progress" },
    {
      $set: {
        status: "completed",
        completedAt: at,
        completionDistanceM: distanceM,
        // Cash is collected on site, so completing the job is when it is paid.
        paid: booking.paymentMethod === "cash" ? true : booking.paid,
        settlement: { ...earning, at },
        // The code has done its job. Clearing it means a screenshot taken
        // during the visit is worth nothing afterwards.
        completionOtp: null,
      },
      $push: {
        events: { at, label: "Job completed", actor: pro.name },
      },
    },
    { new: true },
  ).lean<BookingDoc>();

  if (!updated) {
    return {
      ok: false,
      error: { reason: "bad-state", message: "That job is no longer open." },
    };
  }

  // **Online again on completion**, per the agreement, and the job counter
  // moves — which is what shifts the next job past the commission-free 20.
  await Pro.updateOne(
    { _id: input.proId },
    { $inc: { jobsCompleted: 1 }, $set: { online: true } },
  );

  return { ok: true, booking: updated, earning };
}

/**
 * Pro 15 — an extra charge added on site.
 *
 * Every one carries a label the customer will read. Allowed only while the job
 * is under way: adding to a closed job would change a settled total after the
 * fact, and adding before arrival is what the quotation flow is for.
 */
export async function addExtraCharge(
  proId: string,
  bookingId: string,
  label: string,
  amountPaise: number,
): Promise<{ ok: true; charge: { id: string; label: string; amountPaise: number } } | { ok: false; reason: string }> {
  const charge = {
    id: newId("xc"),
    label: label.trim(),
    amountPaise,
    at: new Date(),
  };

  const updated = await Booking.findOneAndUpdate(
    { _id: bookingId, proId, status: "in_progress" },
    {
      $push: {
        extraCharges: charge,
        events: {
          at: new Date(),
          label: `Extra charge added — ${charge.label}`,
          actor: "Professional",
        },
      },
    },
    { new: true },
  ).lean<BookingDoc>();

  if (!updated) {
    return {
      ok: false,
      reason: "Extra charges can only be added while the job is under way.",
    };
  }

  return { ok: true, charge };
}

/**
 * Where the pro is, and roughly when they will arrive. Customer 27.
 *
 * The ETA is a **straight-line estimate at an assumed urban speed**, not a
 * routed one: the Maps distance matrix needs the API key that is still
 * outstanding (§7.1). It is deliberately coarse and rounded up to the nearest
 * five minutes rather than precise-looking — "about 15 minutes" is honest about
 * its own accuracy in a way "13 minutes" is not.
 */
const ASSUMED_SPEED_KMH = 20;

export async function trackingFor(booking: BookingDoc): Promise<{
  proPoint: { lat: number; lng: number } | null;
  proPosition: { x: number; y: number } | null;
  etaMinutes: number | null;
}> {
  if (!booking.proId || booking.status === "completed" || booking.status === "cancelled") {
    return { proPoint: null, proPosition: null, etaMinutes: null };
  }

  const pro = await Pro.findById(booking.proId)
    .select({ location: 1 })
    .lean<Pick<ProDoc, "location">>();

  if (!pro?.location) {
    // A pro who has never pinged. Null rather than a guess — the screen draws
    // nothing instead of a pin in the wrong place.
    return { proPoint: null, proPosition: null, etaMinutes: null };
  }

  const proPoint = {
    lat: pro.location.coordinates[1],
    lng: pro.location.coordinates[0],
  };
  const customer = { lat: booking.address.lat, lng: booking.address.lng };

  const metres = metresBetween(proPoint, customer);
  const etaMinutes =
    booking.status === "in_progress"
      ? // Already on site; an ETA would be nonsense.
        null
      : Math.max(1, Math.ceil(metres / 1000 / ASSUMED_SPEED_KMH * 60 / 5) * 5);

  /**
   * Canvas percentages for `MapView`, derived from the two real points.
   *
   * A presentation value, not truth — `proPoint` above is the truth. The
   * customer sits at the centre and the pro is placed relative to them within
   * a notional 2 km window, clamped to the canvas. When `MapView` gains a real
   * Maps SDK this goes and `proPoint` is what it consumes (§4.2).
   */
  const WINDOW_M = 2000;
  const clamp = (v: number) => Math.max(5, Math.min(95, v));
  const dx = ((proPoint.lng - customer.lng) * 111_320 * Math.cos((customer.lat * Math.PI) / 180)) / WINDOW_M;
  const dy = ((proPoint.lat - customer.lat) * 110_540) / WINDOW_M;

  return {
    proPoint,
    proPosition: {
      x: clamp(50 + dx * 45),
      // Screen y grows downwards while latitude grows upwards.
      y: clamp(50 - dy * 45),
    },
    etaMinutes,
  };
}
