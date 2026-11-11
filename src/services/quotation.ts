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
  type MaterialLineSub,
  type QuotationDoc,
} from "../models/quotation";
import { newId } from "../models/id";

/**
 * The quotation flow. Pro 16 → Customer 22–24, with the office alongside.
 *
 * | Rule | Value |
 * |---|---|
 * | Before-photos on a quotation | **minimum 2** — fewer is refused |
 * | Phone confirmation | above **₹5,000** — a flag, never a block |
 * | Admin **edit** window | **15 minutes** from submission |
 * | Customer payment | **the full amount on completion.** No advance |
 * | Template comparison | a quote over the admin's template is flagged |
 *
 * ## Two gates were removed, on the client's instruction
 *
 * **The admin no longer approves.** A quotation goes straight to the customer
 * when the pro raises it. The 15 minutes became an *edit window*: the office
 * can change the figures or cancel it outright while the window runs, and a
 * window that lapses changes nothing at all except that they no longer can.
 *
 * That is why there is **no sweep in this file any more**. The old one marked
 * a lapsed quotation `rejected`, which was right when the window was an
 * approval deadline and is now exactly wrong — it would delete a live decision
 * out from under a customer who had not got round to it. A quotation with no
 * decision simply waits, which is what "waiting on the customer" means. No
 * customer-side deadline is documented anywhere, so none is invented.
 *
 * **There is no advance.** The customer pays the whole amount when the job is
 * finished, with the booking. So accepting a quotation moves no money, and the
 * acceptance is an agreement rather than a transaction.
 *
 * ## `customer_accepted` is the lock
 *
 * Acceptance freezes the figures even while the admin's window is still open.
 * The alternative — the office editing a price the customer has already agreed
 * to — bills someone for a number they never read, and is the one dispute this
 * flow cannot settle.
 */

/** Minimum before-photos. Below this the submission is refused. */
export const QUOTATION_MIN_BEFORE_PHOTOS = 2;

/** Above this, the admin phones the customer. A flag, not a block. */
export const PHONE_CONFIRM_THRESHOLD_PAISE = 500_000;

/**
 * How long the office may change a quotation after the pro raises it.
 *
 * **An edit window, not a deadline.** Nothing expires when it closes; the
 * quotation stays with the customer exactly as it was.
 */
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
          // Not "sent to the office for approval" — nobody approves it now.
          label: `Quotation raised — ${rupees(totalPaise)}, awaiting your approval`,
          actor: pro?.name ?? "Professional",
        },
      },
    },
  );

  /**
   * **The customer is told immediately.** This is the removed gate.
   *
   * It used to wait for an admin to approve before the customer heard anything,
   * which is why the notification lived in `decideQuotation`. The quotation now
   * reaches them the moment it is raised, while the professional is still
   * standing there.
   */
  await notify({
    role: "customer",
    to: booking.customerId,
    kind: "quotation",
    title: "Extra work needs your approval",
    body: `${booking.serviceName} — ${rupees(totalPaise)}. Nothing is charged until you approve, and you pay when the job is done.`,
    href: `/quotes/${doc._id}`,
  });

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
 * Is the office still allowed to touch this quotation?
 *
 * **Two conditions, and the order of the messages matters.** Acceptance is
 * checked first: an operator who edited a quote the customer had already
 * agreed to would be told "the window closed", which is true but not the
 * reason — the reason is that there is now an agreement, and it is binding.
 */
function editable(quote: QuotationDoc): { ok: true } | { ok: false; reason: string } {
  if (quote.status === "customer_accepted") {
    return {
      ok: false,
      reason:
        "The customer has already accepted this quotation. What they agreed to is what they pay — raise a new quotation if the work has changed.",
    };
  }
  if (quote.status === "customer_declined") {
    return { ok: false, reason: "The customer declined this quotation." };
  }
  if (quote.status === "rejected") {
    return { ok: false, reason: "That quotation was already cancelled." };
  }
  if (quote.decisionBy.getTime() < Date.now()) {
    /**
     * The window closed. **The quotation is untouched and still live.**
     *
     * The old code marked it `rejected` here, which was right when the window
     * was an approval deadline and is now exactly wrong: it would delete a
     * decision out from under a customer who simply had not got round to it.
     */
    return {
      ok: false,
      reason: `The ${QUOTATION_WINDOW_MINUTES}-minute window for changes has closed. The quotation is with the customer as it stands.`,
    };
  }
  return { ok: true };
}

/**
 * The office changes a quotation's figures, inside its window.
 *
 * **Not an approval.** The quotation already reached the customer when the pro
 * raised it; this adjusts what they are looking at. The pro's `submitted*`
 * figures are never overwritten — an approved amount differing from the
 * submitted one with no history is a dispute nobody can settle — and `edited`
 * is set so both the pro and the customer can see that the office changed it.
 */
export async function editQuotation(input: {
  quotationId: string;
  by: string;
  materials?: MaterialLineSub[];
  labourPaise?: number;
}): Promise<DecisionResult> {
  const quote = await Quotation.findById(input.quotationId).lean<QuotationDoc>();
  if (!quote) return { ok: false, reason: "That quotation could not be found." };

  const allowed = editable(quote);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  const materials = input.materials ?? quote.materials;
  const labourPaise = input.labourPaise ?? quote.labourPaise;
  const totalPaise = quoteTotal(materials, labourPaise);

  if (totalPaise <= 0) {
    return { ok: false, reason: "A quotation must have an amount." };
  }

  const updated = await Quotation.findOneAndUpdate(
    // Guarded on the status it was read at, so an edit cannot land on a
    // quotation the customer accepted a moment ago.
    { _id: quote._id, status: quote.status },
    {
      $set: {
        materials,
        labourPaise,
        totalPaise,
        edited: true,
        // Above ₹5,000 the office phones the customer. Recomputed, because an
        // edit is exactly how a quote crosses that line in either direction.
        needsPhoneConfirmation: totalPaise > PHONE_CONFIRM_THRESHOLD_PAISE,
        decidedAt: new Date(),
        decidedBy: input.by,
      },
    },
    { new: true },
  ).lean<QuotationDoc>();

  if (!updated) {
    return { ok: false, reason: "That quotation changed while you were editing it." };
  }

  /**
   * Both sides are told, and the customer is told **because the thing they are
   * deciding on moved while they were reading it.**
   */
  await notify({
    role: "customer",
    to: updated.customerId,
    kind: "quotation",
    title: "Your quotation was updated",
    body: `Our team adjusted the quotation for ${updated.serviceName} to ${rupees(updated.totalPaise)}. Review it before you approve.`,
    href: `/quotes/${updated._id}`,
  });
  await notify({
    role: "pro",
    to: updated.proId,
    kind: "quotation",
    title: "The office changed your quotation",
    // The pro must not learn the figure moved from their payout.
    body: `${updated.jobRef} is now ${rupees(updated.totalPaise)}. You submitted ${rupees(updated.submittedTotalPaise)}; your original is kept on the record.`,
    href: `/jobs/${updated.bookingId}/quote/status`,
  });

  return { ok: true, quotation: updated };
}

/**
 * The office cancels a quotation outright, inside its window.
 *
 * The power to stop a ₹50,000 quote for a tap washer, not only to trim it. A
 * reason is **required**: the pro reads it, they are still standing in the
 * customer's house, and a cancellation they cannot act on is worse than none.
 */
export async function cancelQuotation(input: {
  quotationId: string;
  by: string;
  reason: string;
}): Promise<DecisionResult> {
  const quote = await Quotation.findById(input.quotationId).lean<QuotationDoc>();
  if (!quote) return { ok: false, reason: "That quotation could not be found." };

  const allowed = editable(quote);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  if (input.reason.trim().length < 3) {
    return { ok: false, reason: "A reason for cancelling is required." };
  }

  const updated = await Quotation.findOneAndUpdate(
    { _id: quote._id, status: quote.status },
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

  if (!updated) {
    return { ok: false, reason: "That quotation changed while you were cancelling it." };
  }

  await notify({
    role: "pro",
    to: updated.proId,
    kind: "quotation",
    title: "Quotation cancelled by the office",
    body: input.reason.trim(),
    href: `/jobs/${updated.bookingId}/quote/status`,
  });
  // The customer was already looking at it, so they have to be told it is off
  // the table rather than left with a stale screen they can still tap.
  await notify({
    role: "customer",
    to: updated.customerId,
    kind: "quotation",
    title: "A quotation was withdrawn",
    body: `Our team cancelled the extra work quoted on ${updated.jobRef}. Nothing has been charged.`,
    href: `/quotes/${updated._id}`,
  });

  return { ok: true, quotation: updated };
}

export type ProEditResult =
  | { ok: true; quotation: QuotationDoc }
  | { ok: false; reason: string };

/**
 * May this professional still change their own quotation, and how?
 *
 * **One function, because the two callers must not disagree** — the route that
 * performs the change and the projection that decides whether to draw the
 * button. A screen offering an Edit that the server refuses is worse than no
 * Edit at all.
 */
export function proRights(quote: QuotationDoc): {
  mayRevise: boolean;
  mayWithdraw: boolean;
  reason: string | null;
} {
  if (quote.status === "customer_accepted") {
    return {
      mayRevise: false,
      mayWithdraw: false,
      reason:
        "The customer has approved this. Raise a new quotation if the work has changed.",
    };
  }
  if (quote.status !== "pending" && quote.status !== "approved") {
    return { mayRevise: false, mayWithdraw: false, reason: "This quotation is closed." };
  }
  if (quote.edited) {
    /**
     * The office has adjusted it. **Withdraw only.**
     *
     * Not a technical limit — it stops a tug of war over the price while the
     * customer sits looking at it, and it keeps the record readable: with both
     * sides editing in turn, `submittedTotalPaise` stops meaning anything and
     * the dispute it exists to settle becomes unsettleable again.
     */
    return {
      mayRevise: false,
      mayWithdraw: true,
      reason:
        "Our office adjusted this quotation. You can withdraw it and raise a new one, or call them.",
    };
  }
  return { mayRevise: true, mayWithdraw: true, reason: null };
}

/**
 * Pro 16 — the professional corrects their own quotation.
 *
 * They are standing on site and will spot a missed part a minute after sending
 * it. Until now the only way to fix a wrong figure was to ask the office, and
 * the work screen did not even show that a quotation existed — it offered
 * "Raise a quotation", which the server then refused as a duplicate.
 *
 * **Both figure pairs move.** `submittedTotalPaise` is "what the professional
 * stands behind", not "the first number they typed", so a revision replaces it
 * too. That is only coherent because `proRights` refuses a revision once the
 * office has edited: otherwise the pro's figure and the office's figure would
 * overwrite each other in turns.
 */
export async function reviseQuotation(input: {
  proId: string;
  quotationId: string;
  description?: string;
  materials?: MaterialLineSub[];
  labourPaise?: number;
}): Promise<ProEditResult> {
  const quote = await Quotation.findOne({
    _id: input.quotationId,
    proId: input.proId,
  }).lean<QuotationDoc>();
  if (!quote) return { ok: false, reason: "That quotation could not be found." };

  const rights = proRights(quote);
  if (!rights.mayRevise) {
    return { ok: false, reason: rights.reason ?? "This quotation cannot be changed." };
  }

  const description = (input.description ?? quote.proNotes).trim();
  if (description === "") {
    return { ok: false, reason: "Describe what you found." };
  }

  const materials = input.materials ?? quote.materials;
  const labourPaise = input.labourPaise ?? quote.labourPaise;
  const totalPaise = quoteTotal(materials, labourPaise);
  if (totalPaise <= 0) {
    return { ok: false, reason: "Add a labour cost or at least one material." };
  }

  const updated = await Quotation.findOneAndUpdate(
    // Guarded on the status it was read at, so a revision cannot land on a
    // quotation the customer approved a moment ago.
    { _id: quote._id, status: quote.status, edited: false },
    {
      $set: {
        proNotes: description,
        submittedMaterials: materials,
        submittedLabourPaise: labourPaise,
        submittedTotalPaise: totalPaise,
        materials,
        labourPaise,
        totalPaise,
        needsPhoneConfirmation: totalPaise > PHONE_CONFIRM_THRESHOLD_PAISE,
      },
    },
    { new: true },
  ).lean<QuotationDoc>();

  if (!updated) {
    return {
      ok: false,
      reason: "That quotation changed while you were editing it. Open it again.",
    };
  }

  await Booking.updateOne(
    { _id: quote.bookingId },
    {
      $push: {
        events: {
          at: new Date(),
          label: `Quotation revised — now ${rupees(totalPaise)}`,
          actor: quote.proName || "Professional",
        },
      },
    },
  );

  /**
   * The customer is told, **because the thing they are deciding on moved.**
   *
   * They may well have the quotation open. A figure that changes under them
   * with no word is how somebody approves an amount they did not read.
   */
  await notify({
    role: "customer",
    to: updated.customerId,
    kind: "quotation",
    title: "Your quotation was updated",
    body: `${updated.proName} revised the quotation for ${updated.serviceName} to ${rupees(updated.totalPaise)}. Review it before you approve.`,
    href: `/quotes/${updated._id}`,
  });

  return { ok: true, quotation: updated };
}

/**
 * Pro 16 — the professional withdraws their own quotation.
 *
 * The way back to a clean slate: `submitQuotation` refuses a second live
 * quotation on one job, so a pro who quoted the wrong work had no route to the
 * right one. Withdrawing frees the job for a fresh quotation.
 *
 * Recorded as cancelled with a reason naming **who** withdrew it, rather than
 * deleted. A quotation the customer has already looked at cannot simply vanish
 * from their screen with no explanation.
 */
export async function withdrawQuotation(input: {
  proId: string;
  quotationId: string;
}): Promise<ProEditResult> {
  const quote = await Quotation.findOne({
    _id: input.quotationId,
    proId: input.proId,
  }).lean<QuotationDoc>();
  if (!quote) return { ok: false, reason: "That quotation could not be found." };

  const rights = proRights(quote);
  if (!rights.mayWithdraw) {
    return { ok: false, reason: rights.reason ?? "This quotation cannot be withdrawn." };
  }

  const updated = await Quotation.findOneAndUpdate(
    { _id: quote._id, status: quote.status },
    {
      $set: {
        status: "rejected",
        rejectionReason: "Withdrawn by the professional.",
        decidedAt: new Date(),
        decidedBy: quote.proName || "Professional",
      },
    },
    { new: true },
  ).lean<QuotationDoc>();

  if (!updated) {
    return { ok: false, reason: "That quotation has already been closed." };
  }

  await Booking.updateOne(
    { _id: quote.bookingId },
    {
      $push: {
        events: {
          at: new Date(),
          label: "Quotation withdrawn by the professional",
          actor: quote.proName || "Professional",
        },
      },
    },
  );

  await notify({
    role: "customer",
    to: updated.customerId,
    kind: "quotation",
    title: "A quotation was withdrawn",
    body: `${updated.proName} withdrew the quoted extra work on ${updated.jobRef}. Nothing has been charged.`,
    href: `/quotes/${updated._id}`,
  });

  return { ok: true, quotation: updated };
}

export type StartQuotedWorkResult =
  | { ok: true; quotation: QuotationDoc }
  | { ok: false; reason: string; wrongOtp?: boolean };

/**
 * The pro enters the code the customer read out, and the quoted work begins.
 *
 * ## Why a second code exists at all
 *
 * The booking's own `startOtp` proves the customer let the pro in to do **the
 * work they booked**. It says nothing about a different and usually much larger
 * piece of work priced on the doorstep — on real data here, a ₹350 booking
 * turning into ₹3,700. An admin approving a quotation and a customer tapping
 * Accept in an app are both real agreements, but neither puts the customer and
 * the pro in the same room at the moment the extra work starts, and that is the
 * moment disputes are about.
 *
 * So: one code, generated when the customer confirms, held only by the
 * customer, entered by the pro. **Never sent to the pro** — the server compares
 * it, and a code the pro could read out of a response proves nothing.
 *
 * Cleared on use, so a screenshot taken during the visit is worthless
 * afterwards. `workStartedAt` is what the completion gate reads.
 */
export async function startQuotedWork(input: {
  proId: string;
  quotationId: string;
  otp: string;
}): Promise<StartQuotedWorkResult> {
  const quote = await Quotation.findOne({
    _id: input.quotationId,
    proId: input.proId,
  }).lean<QuotationDoc>();

  if (!quote) {
    return { ok: false, reason: "That quotation could not be found." };
  }

  if (quote.workStartedAt !== undefined) {
    return { ok: false, reason: "That quoted work has already started." };
  }

  if (quote.status !== "customer_accepted") {
    return {
      ok: false,
      reason:
        quote.status === "approved"
          ? "The customer has not confirmed this quotation yet."
          : quote.status === "pending"
            ? "The office has not approved this quotation yet."
            : "That quotation is no longer open.",
    };
  }

  // Compared before anything is written, and reported as its own failure so
  // the screen marks the field rather than showing a banner about state.
  if (quote.startOtp === null || input.otp.trim() !== quote.startOtp) {
    return {
      ok: false,
      reason: "That code is not right. Ask the customer to read it again.",
      wrongOtp: true,
    };
  }

  const at = new Date();
  const started = await Quotation.findOneAndUpdate(
    // Guarded on the code still being unspent, so two taps cannot both start it.
    { _id: quote._id, status: "customer_accepted", startOtp: quote.startOtp },
    { $set: { workStartedAt: at, startOtp: null } },
    { new: true },
  ).lean<QuotationDoc>();

  if (!started) {
    return { ok: false, reason: "That quoted work has already started." };
  }

  await Booking.updateOne(
    { _id: quote.bookingId },
    {
      $push: {
        events: {
          at,
          label: `Quoted work started — ${rupees(quote.totalPaise)}`,
          actor: quote.proName || "Professional",
        },
      },
    },
  );

  await notify({
    role: "customer",
    to: quote.customerId,
    kind: "quotation",
    title: "The extra work has started",
    body: `${quote.proName} has begun the quoted work on ${quote.jobRef}.`,
    href: `/quotes/${quote._id}`,
  });

  return { ok: true, quotation: started };
}
