import { Router } from "express";
import { badRequest, conflict, forbidden, notFound } from "../../error";

/** Paise as plain rupees for a timeline label or a notification body. */
function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}
import { actorOf, requireAuth } from "../../middleware/auth";
import { Quotation, type QuotationDoc } from "../../models/quotation";
import { Booking, newJobOtp } from "../../models/booking";
import { notify } from "../../models/notification";
import { param } from "../../params";
import { PUBLIC_PREFIX } from "../../uploads";

/**
 * Customer 22–24 — the quotations waiting on this customer.
 *
 * The flow is what shapes this file, and it changed: a pro raises a quotation
 * and it comes **straight here**. There is no approval gate. `pending` used to
 * mean "waiting on the office" and was hidden from the customer; it now means
 * the opposite — *their* decision is the one outstanding — so it is the main
 * thing this file serves.
 *
 * **There is no advance.** Accepting moves no money: the customer pays the
 * whole amount when the job is finished, alongside the booking. So accepting is
 * an agreement, and the only thing it produces is the code that lets the
 * professional begin.
 *
 * **No customer-side countdown.** The 15 minutes is the office's window to
 * change the figures, not a deadline on the customer. No customer deadline is
 * documented, so none is shown — a timer here would be a pressure tactic we
 * invented.
 */
export const consumerQuotationsRouter = Router();

consumerQuotationsRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "customer") {
    next(forbidden());
    return;
  }
  next();
});

/**
 * What the customer may see: **everything**.
 *
 * `pending` is now theirs to decide on, and `approved` survives only on rows
 * taken under the old flow — treated identically, so a quotation approved last
 * week does not become unreachable.
 */
const VISIBLE = [
  "pending",
  "approved",
  "rejected",
  "customer_accepted",
  "customer_declined",
];

/** The two statuses a customer may still act on. */
const DECIDABLE = ["pending", "approved"];

function project(q: QuotationDoc) {
  return {
    id: q._id,
    jobRef: q.jobRef,
    proName: q.proName,
    customerName: q.customerName,
    serviceName: q.serviceName,
    totalPaise: q.totalPaise,
    status: q.status,
    submittedAt: q.createdAt.toISOString(),
    // Null always: the window is the admin's, and by the time a customer sees
    // this it has already been decided.
    minutesRemaining: null,
    proNotes: q.proNotes,
    materials: q.materials,
    laborPaise: q.labourPaise,
    beforePhotoUrls: q.beforePhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),
    customerAreaHistory: 0,
    ...(q.rejectionReason !== undefined
      ? { rejectionReason: q.rejectionReason }
      : {}),

    /**
     * The code the customer reads out to let the quoted work begin.
     *
     * **Only ever on this projection.** The customer holds it; the pro's own
     * projection (`projectQuotation` in `routes/pro/jobs.ts`) must never carry
     * it, or the code proves nothing. Null before they confirm and null again
     * once the pro has used it.
     */
    startOtp: q.startOtp,
    /** So the screen can say "work under way" rather than only "accepted". */
    workStarted: q.workStartedAt !== undefined,

    /**
     * Whether the office can still change these figures.
     *
     * Shown because it is the honest answer to "is this final?" — and because
     * a customer who accepts while it is true has **locked it**, which is worth
     * knowing. It stops being true the moment they accept.
     */
    officeMayStillEdit:
      DECIDABLE.includes(q.status) && q.decisionBy.getTime() > Date.now(),
  };
}

consumerQuotationsRouter.get("/", async (req, res) => {
  const rows = await Quotation.find({
    customerId: actorOf(req).id,
    status: { $in: VISIBLE },
  })
    .sort({ createdAt: -1 })
    .lean<QuotationDoc[]>();

  res.json(rows.map(project));
});

/** How many are waiting on the customer. Drives a nav badge. */
consumerQuotationsRouter.get("/count", async (req, res) => {
  res.json(
    await Quotation.countDocuments({
      customerId: actorOf(req).id,
      status: "approved",
    }),
  );
});

consumerQuotationsRouter.get("/:id", async (req, res) => {
  const q = await Quotation.findOne({
    _id: param(req, "id"),
    customerId: actorOf(req).id,
  }).lean<QuotationDoc>();

  if (!q || !VISIBLE.includes(q.status)) {
    throw notFound("That quotation could not be found.");
  }
  res.json(project(q));
});

/**
 * Customer 23 — approve the extra work.
 *
 * **No money moves here.** The 50% advance is gone: the customer pays the whole
 * quotation when the job is finished, with the booking. So this takes no
 * payment method, debits no wallet, and answers no 503 — it is an agreement,
 * and the only thing it produces is the code that lets the professional begin.
 *
 * Accepting also **locks the figures**. The office's 15-minute edit window may
 * still be open, and it stops applying the moment this succeeds: what the
 * customer read is what they pay.
 */
consumerQuotationsRouter.post("/:id/accept", async (req, res) => {
  const customerId = actorOf(req).id;

  const quote = await Quotation.findOne({
    _id: param(req, "id"),
    customerId,
  }).lean<QuotationDoc>();
  if (!quote) throw notFound("That quotation could not be found.");

  if (!DECIDABLE.includes(quote.status)) {
    throw conflict(
      quote.status === "customer_accepted"
        ? "You have already approved this quotation."
        : quote.status === "rejected"
          ? "Our team withdrew this quotation."
          : "That quotation is no longer open.",
      "BAD_STATE",
    );
  }

  const claimed = await Quotation.findOneAndUpdate(
    // Guarded on the status it was read at, so a double-tap cannot produce two
    // codes, and an office edit landing in between cannot be accepted blind.
    { _id: quote._id, status: quote.status },
    {
      $set: {
        status: "customer_accepted",
        acceptedAt: new Date(),
        /**
         * The code that lets the quoted work start.
         *
         * Generated here, at the moment of agreement, and shown to the
         * customer on the next screen so they can read it to the professional
         * standing in front of them. Four digits, like the booking's own start
         * code — it is read aloud at a doorstep and typed on a phone.
         */
        startOtp: newJobOtp(),
      },
    },
    { new: true },
  ).lean<QuotationDoc>();

  if (!claimed) {
    throw conflict(
      "That quotation changed just now. Open it again and check the amount.",
      "BAD_STATE",
    );
  }

  /**
   * The quoted work joins the booking's payable money.
   *
   * Until this existed an accepted quotation reached nothing: `grossFor` summed
   * the service, add-ons and on-site extras, and the quotation total appeared
   * in no money path at all — so a pro could do ₹3,700 of agreed work and be
   * settled for the original booking.
   *
   * `$inc` rather than a set, because a long job can carry more than one
   * quotation. `breakdown` is deliberately untouched: that is the tax invoice
   * as issued, and quoted work is its own line.
   */
  await Booking.updateOne(
    { _id: quote.bookingId },
    { $inc: { quotedWorkPaise: claimed.totalPaise } },
  );

  await Booking.updateOne(
    { _id: quote.bookingId },
    {
      $push: {
        events: {
          at: new Date(),
          label: `Quotation approved by you — ${rupees(claimed.totalPaise)}. Code issued to start the work; payable when the job is done.`,
          actor: "Customer",
        },
      },
    },
  );

  /**
   * Tell the professional. **Nothing did.**
   *
   * They are standing in the customer's house waiting on this answer — it is
   * the whole reason the 15-minute window exists — and the accept wrote a
   * timeline event the pro never reads. Their own app polls the job, so they
   * would have found out eventually; a pro who has been told explicitly can
   * ask for the code instead of refreshing a screen.
   *
   * It names the code without carrying it: the code is the customer's to read
   * aloud, and a notification is the last place to put it.
   */
  await notify({
    role: "pro",
    to: claimed.proId,
    kind: "quotation",
    title: "Quotation approved — ask for the code",
    body: `The customer approved ${claimed.jobRef}. Ask them for the 4-digit code on their screen to start the work. They pay on completion.`,
    href: `/jobs/${claimed.bookingId}/quote/status`,
  });

  res.json(project(claimed));
});

/**
 * Customer 23 — decline.
 *
 * The visit is still chargeable; the quoted work is not. No fee is added here,
 * because the agreement documents none — the original booking stands as placed.
 */
consumerQuotationsRouter.post("/:id/decline", async (req, res) => {
  const customerId = actorOf(req).id;

  const declined = await Quotation.findOneAndUpdate(
    { _id: param(req, "id"), customerId, status: { $in: DECIDABLE } },
    { $set: { status: "customer_declined", declinedAt: new Date() } },
    { new: true },
  ).lean<QuotationDoc>();

  if (!declined) {
    throw conflict("That quotation is no longer open.", "BAD_STATE");
  }

  await Booking.updateOne(
    { _id: declined.bookingId },
    {
      $push: {
        events: {
          at: new Date(),
          label: "Quotation declined by the customer",
          actor: "Customer",
        },
      },
    },
  );

  // Same reason as the accept: the pro is on site waiting, and "do not do the
  // work" is the more urgent of the two messages to get to them.
  await notify({
    role: "pro",
    to: declined.proId,
    kind: "quotation",
    title: "Quotation declined",
    body: `The customer declined the extra work on ${declined.jobRef}. Finish what the original booking covers.`,
    href: `/jobs/${declined.bookingId}/quote/status`,
  });

  res.json(project(declined));
});

/**
 * Customer 23 — "Ask a question".
 *
 * Recorded, not threaded. There is no message thread on a quotation in the data
 * model, and inventing one would imply a reply the platform cannot deliver.
 *
 * It routes to the **team, not the pro** (`CONSUMER-OPEN-ITEMS` 2.15): the
 * screen promises a call-back from the office, and sending it to a pro standing
 * on a ladder would deliver neither.
 */
consumerQuotationsRouter.post("/:id/question", async (req, res) => {
  const body = (req.body as { question?: unknown })?.question;
  if (typeof body !== "string" || body.trim().length < 3) {
    throw badRequest("What would you like to ask?", "MISSING_QUESTION");
  }

  const updated = await Quotation.findOneAndUpdate(
    { _id: param(req, "id"), customerId: actorOf(req).id },
    { $push: { questions: { body: body.trim(), at: new Date() } } },
    { new: true },
  ).lean<QuotationDoc>();

  if (!updated) throw notFound("That quotation could not be found.");

  res.status(201).json({
    recorded: true,
    // Said plainly, because the screen promises it and nothing else delivers it.
    message: "The office will call you about this.",
  });
});
