import { Router } from "express";
import { badRequest, conflict, forbidden, notConfigured, notFound } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { Quotation, type QuotationDoc } from "../../models/quotation";
import { Booking } from "../../models/booking";
import { WalletEntry, walletBalance } from "../../models/wallet";
import { newId } from "../../models/id";
import { param } from "../../params";
import { PUBLIC_PREFIX } from "../../uploads";

/**
 * Customer 22–24 — the quotations waiting on this customer.
 *
 * The flow is what shapes this file: a pro raises a quotation, **the admin
 * approves it**, and only then does it reach the customer. So a customer never
 * sees a `pending` one — that status means "waiting on the office", and showing
 * it would invite them to accept something CFC has not yet agreed to.
 *
 * **No customer-side countdown.** The 15 minutes is an *admin* rule ("the pro
 * cannot wait longer"). No customer deadline is documented, so none is shown —
 * a timer here would be a pressure tactic we invented.
 */
export const consumerQuotationsRouter = Router();

consumerQuotationsRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "customer") {
    next(forbidden());
    return;
  }
  next();
});

/** What the customer may see. `pending` is deliberately absent. */
const VISIBLE = ["approved", "rejected", "customer_accepted", "customer_declined"];

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

    // The 50% split, computed at approval so the figure shown when deciding is
    // the figure charged.
    advancePaise: q.advancePaise,
    balancePaise: q.balancePaise,
    advancePaid: q.advancePaid,
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

  // A pending quotation has not cleared review, so as far as the customer is
  // concerned it does not exist yet.
  if (!q || !VISIBLE.includes(q.status)) {
    throw notFound("That quotation could not be found.");
  }
  res.json(project(q));
});

/**
 * Customer 23 — accept, paying the 50% advance.
 *
 * The advance is **real money moving**, so the payment method matters. Cash and
 * wallet work; UPI and card answer 503 until Razorpay has keys (§0.3) rather
 * than accepting the quote and pretending the advance was collected — a quote
 * marked accepted with no advance behind it would send a pro to do ₹4,000 of
 * work against nothing.
 */
consumerQuotationsRouter.post("/:id/accept", async (req, res) => {
  const customerId = actorOf(req).id;
  const method = (req.body as { paymentMethod?: unknown })?.paymentMethod;

  if (method !== "cash" && method !== "wallet" && method !== "upi" && method !== "card") {
    throw badRequest("Choose how to pay the advance.", "BAD_PAYMENT_METHOD");
  }
  if (method === "upi" || method === "card") {
    throw notConfigured("Online payment");
  }

  const quote = await Quotation.findOne({
    _id: param(req, "id"),
    customerId,
  }).lean<QuotationDoc>();
  if (!quote) throw notFound("That quotation could not be found.");

  if (quote.status !== "approved") {
    throw conflict(
      quote.status === "customer_accepted"
        ? "You have already accepted this quotation."
        : "That quotation is no longer open.",
      "BAD_STATE",
    );
  }

  if (method === "wallet") {
    const balance = await walletBalance(customerId);
    if (balance < quote.advancePaise) {
      throw conflict(
        "Your wallet does not have enough balance for the advance.",
        "INSUFFICIENT_BALANCE",
      );
    }
  }

  const claimed = await Quotation.findOneAndUpdate(
    // Guarded on the status, so a double-tap cannot charge the advance twice.
    { _id: quote._id, status: "approved" },
    {
      $set: {
        status: "customer_accepted",
        acceptedAt: new Date(),
        // Cash is collected on site; a wallet advance has moved already.
        advancePaid: method === "wallet",
      },
    },
    { new: true },
  ).lean<QuotationDoc>();

  if (!claimed) throw conflict("That quotation is no longer open.", "BAD_STATE");

  if (method === "wallet") {
    await WalletEntry.create({
      _id: newId("wtx"),
      customerId,
      kind: "booking",
      label: `Advance — ${quote.serviceName}`,
      amountPaise: -quote.advancePaise,
      bookingReference: quote.jobRef,
      status: "completed",
    });
  }

  await Booking.updateOne(
    { _id: quote.bookingId },
    {
      $push: {
        events: {
          at: new Date(),
          label: `Quotation accepted — 50% advance ${
            method === "wallet" ? "paid from wallet" : "due in cash"
          }`,
          actor: "Customer",
        },
      },
    },
  );

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
    { _id: param(req, "id"), customerId, status: "approved" },
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
