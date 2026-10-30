import { Booking, type BookingDoc } from "../models/booking";
import { Customer, type CustomerDoc } from "../models/customer";
import { Pro, type ProDoc } from "../models/pro";
import { notify } from "../models/notification";

/** Paise as plain rupees for a notification body. No decimals — these are
 *  whole-rupee quotes and "₹4,500.00" reads like a bill, not an alert. */
function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}
import { Service, type ServiceDoc } from "../models/catalog";
import {
  Quotation,
  quoteTotal,
  splitQuotation,
  type MaterialLineSub,
  type QuotationDoc,
} from "../models/quotation";
import { newId } from "../models/id";

/**
 * The quotation flow. Pro 16 → Admin 4/5 → Customer 22–24.
 *
 * Every figure here is from the agreement:
 *
 * | Rule | Value |
 * |---|---|
 * | Before-photos on a quotation | **minimum 2** — fewer is auto-rejected |
 * | Phone confirmation | above **₹5,000** |
 * | Admin decision window | **15 minutes** |
 * | Customer advance on accept | **50%**, balance on completion |
 * | Template comparison | a quote over the admin's template triggers review |
 */

/** Minimum before-photos. Below this the submission is refused. */
export const QUOTATION_MIN_BEFORE_PHOTOS = 2;

/** Above this, the admin phones the customer. A flag, not a block. */
export const PHONE_CONFIRM_THRESHOLD_PAISE = 500_000;

/** The admin's decision window. How long the pro is standing in a house. */
export const QUOTATION_WINDOW_MINUTES = 15;

export type QuoteRejection =
  | { reason: "too-few-photos"; needed: number }
  | { reason: "no-description" }
  | { reason: "no-amount" }
  | { reason: "bad-state"; message: string };

export type QuoteSubmission =
  | {
      ok: true;
      quotationId: string;
      totalPaise: number;
      needsPhoneConfirmation: boolean;
      decisionBy: string;
    }
  | { ok: false; error: QuoteRejection };

/**
 * Pro 16 — submit a quotation for admin approval.
 *
 * Failures come back as **named reasons**, not a boolean. "Submission failed"
 * tells a pro standing in a customer's house nothing about what to fix.
 *
 * The before-photos are the job's own: the pro has already uploaded them
 * through the photo route, so the count is read from the booking rather than
 * trusted from the request. A client-sent `beforePhotoCount` would make the
 * two-photo rule advisory.
 */
export async function submitQuotation(input: {
  proId: string;
  bookingId: string;
  description: string;
  materials: MaterialLineSub[];
  labourPaise: number;
}): Promise<QuoteSubmission> {
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
          "Start the job before raising a quotation — the quote describes what you found on site.",
      },
    };
  }

  // One live quotation per job. A second would leave the customer with two
  // prices for the same work and no way to know which one holds.
  const existing = await Quotation.findOne({
    bookingId: input.bookingId,
    status: { $in: ["pending", "approved", "customer_accepted"] },
  }).lean<QuotationDoc>();
  if (existing) {
    return {
      ok: false,
      error: {
        reason: "bad-state",
        message:
          existing.status === "pending"
            ? "A quotation for this job is already with the office."
            : "This job already has an approved quotation.",
      },
    };
  }

  // Counted from the booking, not from the request.
  const photoCount = booking.beforePhotoPaths.length;
  if (photoCount < QUOTATION_MIN_BEFORE_PHOTOS) {
    return {
      ok: false,
      error: {
        reason: "too-few-photos",
        needed: QUOTATION_MIN_BEFORE_PHOTOS - photoCount,
      },
    };
  }

  if (input.description.trim() === "") {
    return { ok: false, error: { reason: "no-description" } };
  }

  const totalPaise = quoteTotal(input.materials, input.labourPaise);
  if (totalPaise <= 0) {
    return { ok: false, error: { reason: "no-amount" } };
  }

  const [pro, customer, service] = await Promise.all([
    Pro.findById(input.proId).lean<ProDoc>(),
    Customer.findById(booking.customerId).lean<CustomerDoc>(),
    Service.findById(booking.serviceId).lean<ServiceDoc>(),
  ]);

  const decisionBy = new Date(
    Date.now() + QUOTATION_WINDOW_MINUTES * 60_000,
  );

  const doc = await Quotation.create({
    _id: newId("qt"),
    bookingId: booking._id,
    jobRef: booking.reference,
    proId: input.proId,
    proName: pro?.name ?? "",
    customerId: booking.customerId,
    customerName: customer?.name ?? "",
    serviceName: booking.serviceName,
    proNotes: input.description.trim(),

    // Both sets start equal. An edit changes only the second pair.
    submittedMaterials: input.materials,
    submittedLabourPaise: input.labourPaise,
    submittedTotalPaise: totalPaise,
    materials: input.materials,
    labourPaise: input.labourPaise,
    totalPaise,
    edited: false,

    beforePhotoPaths: booking.beforePhotoPaths,
    status: "pending",
    decisionBy,
    needsPhoneConfirmation: totalPaise > PHONE_CONFIRM_THRESHOLD_PAISE,
    // Frozen, so the comparison the operator saw is the one on the record even
    // if the catalogue price moves afterwards.
    templatePricePaise: service?.basePricePaise ?? 0,
  });

  await Booking.updateOne(
    { _id: booking._id },
    {
      $push: {
        events: {
          at: new Date(),
          label: "Quotation sent to the office for approval",
          actor: pro?.name ?? "Professional",
        },
      },
    },
  );

  return {
    ok: true,
    quotationId: doc._id,
    totalPaise,
    needsPhoneConfirmation: doc.needsPhoneConfirmation,
    decisionBy: decisionBy.toISOString(),
  };
}

export type DecisionResult =
  | { ok: true; quotation: QuotationDoc }
  | { ok: false; reason: string };

/**
 * Admin 5 — approve, optionally at edited figures.
 *
 * `materials` and `labourPaise` are **optional**: omitting them approves what
 * the pro submitted, supplying them is "Edit & approve". Either way the pro's
 * original stays on the record — see the note on the model.
 *
 * The advance is computed here, at approval, rather than when the customer
 * accepts: the figure they are shown when deciding has to be the figure they
 * are charged.
 */
export async function decideQuotation(input: {
  quotationId: string;
  by: string;
  outcome: "approved" | "rejected";
  materials?: MaterialLineSub[];
  labourPaise?: number;
  reason?: string;
}): Promise<DecisionResult> {
  const quote = await Quotation.findById(input.quotationId).lean<QuotationDoc>();
  if (!quote) return { ok: false, reason: "That quotation could not be found." };

  if (quote.status !== "pending") {
    return {
      ok: false,
      reason:
        quote.status === "approved"
          ? "That quotation has already been approved."
          : `That quotation is already ${quote.status.replace("_", " ")}.`,
    };
  }

  // Expiry is checked here as well as swept. An operator whose tab sat open
  // past the window must not be able to approve on a stale view — the pro has
  // already been told the quote lapsed.
  if (quote.decisionBy.getTime() < Date.now()) {
    await Quotation.updateOne(
      { _id: quote._id, status: "pending" },
      { $set: { status: "rejected", rejectionReason: "The 15-minute window expired." } },
    );
    return {
      ok: false,
      reason: "The 15-minute window has expired. Ask the professional to resubmit.",
    };
  }

  if (input.outcome === "rejected") {
    if (!input.reason || input.reason.trim().length < 3) {
      // The pro reads this. A rejection with no reason is one they cannot act
      // on, and they are still standing in the customer's house.
      return { ok: false, reason: "A reason for the rejection is required." };
    }

    const updated = await Quotation.findOneAndUpdate(
      { _id: quote._id, status: "pending" },
      {
        $set: {
          status: "rejected",
          rejectionReason: input.reason.trim(),
          decidedAt: new Date(),
          decidedBy: input.by,
        },
      },
      { new: true },
    ).lean<QuotationDoc>();

    if (updated) {
      await notify({
        role: "pro",
        to: updated.proId,
        kind: "quotation",
        title: "Quotation rejected",
        body: input.reason.trim(),
        href: `/quotations/${updated._id}`,
      });
    }

    return updated
      ? { ok: true, quotation: updated }
      : { ok: false, reason: "That quotation is no longer pending." };
  }

  const edited =
    input.materials !== undefined || input.labourPaise !== undefined;
  const materials = input.materials ?? quote.submittedMaterials;
  const labourPaise = input.labourPaise ?? quote.submittedLabourPaise;
  const totalPaise = quoteTotal(materials, labourPaise);

  if (totalPaise <= 0) {
    return { ok: false, reason: "An approved quotation must have an amount." };
  }

  const { advancePaise, balancePaise } = splitQuotation(totalPaise);

  const updated = await Quotation.findOneAndUpdate(
    { _id: quote._id, status: "pending" },
    {
      $set: {
        status: "approved",
        // Only these change. `submitted*` is left exactly as the pro sent it.
        materials,
        labourPaise,
        totalPaise,
        edited,
        advancePaise,
        balancePaise,
        decidedAt: new Date(),
        decidedBy: input.by,
      },
    },
    { new: true },
  ).lean<QuotationDoc>();

  if (updated) {
    await notify({
      role: "customer",
      to: updated.customerId,
      kind: "quotation",
      title: "A quotation needs your approval",
      body: `${updated.serviceName} — ${rupees(updated.totalPaise)}. A 50% advance is taken on acceptance.`,
      href: `/quotations/${updated._id}`,
    });
    await notify({
      role: "pro",
      to: updated.proId,
      kind: "quotation",
      title: edited ? "Quotation approved, with edits" : "Quotation approved",
      body: edited
        // The pro must not learn the figure changed from their payout.
        ? `The office approved ${rupees(updated.totalPaise)}. Your original figure is kept on the record.`
        : "Sent to the customer for acceptance.",
      href: `/quotations/${updated._id}`,
    });
  }

  return updated
    ? { ok: true, quotation: updated }
    : { ok: false, reason: "That quotation is no longer pending." };
}

/**
 * Marks lapsed quotations.
 *
 * Swept rather than noticed by a screen: a quote left pending forever because
 * the operator closed their tab is a pro left waiting forever. Returns the
 * count so the self-check can assert on it without sleeping 15 minutes.
 */
export async function sweepQuotations(): Promise<{ expired: number }> {
  const stale = await Quotation.find({
    status: "pending",
    decisionBy: { $lt: new Date() },
  })
    .select({ _id: 1, bookingId: 1, proId: 1 })
    .lean<{ _id: string; bookingId: string; proId: string }[]>();

  if (stale.length === 0) return { expired: 0 };

  await Quotation.updateMany(
    { _id: { $in: stale.map((q) => q._id) }, status: "pending" },
    {
      $set: {
        // Rejected rather than a separate "expired" status: `QuotationStatus`
        // has no such member, and to the pro the outcome is the same — the
        // reason is what distinguishes them.
        status: "rejected",
        rejectionReason:
          "The 15-minute approval window expired without a decision.",
        decidedAt: new Date(),
        decidedBy: "system:expired",
      },
    },
  );

  for (const q of stale) {
    await notify({
      role: "pro",
      to: q.proId,
      kind: "quotation",
      title: "Quotation expired",
      body: "The 15-minute window passed without a decision. Resubmit if you are still on site.",
      href: `/quotations/${q._id}`,
    });
    await Booking.updateOne(
      { _id: q.bookingId },
      {
        $push: {
          events: {
            at: new Date(),
            label: "Quotation expired without a decision",
            actor: "System",
          },
        },
      },
    );
  }

  return { expired: stale.length };
}
