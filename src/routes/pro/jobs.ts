import { Router } from "express";
import type { ProJob, ProJobStatus } from "@cfc/types";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { badRequest, conflict, forbidden, notFound } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { Booking, type BookingDoc } from "../../models/booking";
import { Offer, type OfferDoc } from "../../models/offer";
import { Pro, canReceiveOffers, ratingOf, type ProDoc } from "../../models/pro";
import { Service, type ServiceDoc } from "../../models/catalog";
import {
  OFFER_WINDOW_SECONDS,
  acceptOffer,
  declineOffer,
} from "../../services/dispatch";
import { PUBLIC_PREFIX } from "../../uploads";
import { imageUpload, verifyImageBytes } from "../../middleware/upload";
import {
  addExtraCharge,
  completeJob,
  grossFor,
  settle,
  startJob,
} from "../../services/job-lifecycle";
import { submitQuotation } from "../../services/quotation";
import { Quotation, type QuotationDoc } from "../../models/quotation";
import { param } from "../../params";

/**
 * Pro 10–20 — the pro's own jobs, and the offer stream.
 *
 * The shape that matters here is what an **offer** is allowed to contain. Three
 * pros see one, two will not attend, so it carries the area and the distance and
 * withholds the address, the phone and the coordinates. They are released by
 * `acceptOffer`, to the one pro who took it.
 */
export const proJobsRouter = Router();

proJobsRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "pro") {
    next(forbidden());
    return;
  }
  next();
});

async function loadPro(id: string): Promise<ProDoc> {
  const found = await Pro.findById(id).lean<ProDoc>();
  if (!found) throw notFound("That account no longer exists.");
  return found;
}

/**
 * What the pro earns on a booking.
 *
 * Delegates to `grossFor` and `settle` in `services/job-lifecycle.ts` rather
 * than computing it here.
 *
 * This file had its own copy, and the two had **already drifted**: the local
 * version summed the service and add-ons but omitted on-site extra charges,
 * while the settlement included them. So a pro would have been shown one figure
 * on the job screen and paid a different one at completion — which is the exact
 * failure the "one place owns the pro's money" rule exists to prevent, arrived
 * at within a single phase.
 */
function earningsFor(booking: BookingDoc, pro: ProDoc) {
  const { grossPaise, netPaise } = settle(grossFor(booking), pro.jobsCompleted);
  return { grossEarningPaise: grossPaise, netEarningPaise: netPaise };
}

/** First name plus an initial. A pro does not need a full name to travel. */
function shortName(full: string, phone: string): string {
  if (full.trim() === "") return `Customer ${phone.slice(-4)}`;
  const parts = full.trim().split(/\s+/);
  const first = parts[0] ?? full;
  return parts[1] ? `${first} ${parts[1].charAt(0)}.` : first;
}

/** Maps a booking status onto the pro's own workflow vocabulary. */
function proStatus(booking: BookingDoc, offered: boolean): ProJobStatus {
  if (offered) return "offered";
  switch (booking.status) {
    case "assigned":
      // "Upcoming" if it is not today; a pro's Active tab should hold what they
      // are doing now, not something booked for Friday.
      return isToday(booking.scheduledAt) ? "on_the_way" : "upcoming";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "upcoming";
  }
}

function isToday(d: Date): boolean {
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

/**
 * A booking as the pro sees it.
 *
 * `released` is the whole point of this function. While false — an offer — the
 * address, phone, landmark and coordinates are null. A coordinate **is** an
 * address, so publishing the latitude while withholding the street would be no
 * protection at all.
 */
function projectJob(
  booking: BookingDoc,
  pro: ProDoc,
  options: {
    released: boolean;
    offered: boolean;
    distanceKm: number | null;
    offerId?: string;
    expiresInSeconds?: number;
    checklist: string[];
  },
): ProJob & { offerId?: string; expiresInSeconds?: number } {
  const { grossEarningPaise, netEarningPaise } = earningsFor(booking, pro);
  const { released } = options;

  return {
    id: booking._id,
    reference: booking.reference,
    serviceName: booking.serviceName,
    status: proStatus(booking, options.offered),
    scheduledAt: booking.scheduledAt.toISOString(),
    customerName: shortName(booking.customerName, booking.customerPhone),
    area: booking.address.area,

    address: released
      ? [
          booking.address.line1,
          booking.address.line2,
          booking.address.area,
          booking.address.city,
        ]
          .filter(Boolean)
          .join(", ")
      : null,
    customerPhone: released ? booking.customerPhone : null,
    landmark: released ? (booking.address.landmark ?? null) : null,
    notes: booking.notes,

    distanceKm: options.distanceKm ?? 0,
    location: released
      ? { lat: booking.address.lat, lng: booking.address.lng }
      : null,

    netEarningPaise,
    grossEarningPaise,

    // Shown to the pro only once they are on site — it is the customer's code
    // to give, not the pro's to hold in advance.
    completionOtp:
      released && booking.status === "in_progress" ? booking.completionOtp : null,

    checklist: options.checklist,
    beforePhotoUrls: booking.beforePhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),
    afterPhotoUrls: booking.afterPhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),

    ...(options.offerId !== undefined ? { offerId: options.offerId } : {}),
    ...(options.expiresInSeconds !== undefined
      ? { expiresInSeconds: options.expiresInSeconds }
      : {}),
  };
}

/** The service's inclusions, which are what the pro and customer both work from. */
async function checklistFor(serviceId: string): Promise<string[]> {
  const svc = await Service.findById(serviceId)
    .select({ inclusions: 1 })
    .lean<Pick<ServiceDoc, "inclusions">>();
  return svc?.inclusions ?? [];
}

// -- Online / offline (Pro 11) -----------------------------------------------

/**
 * Going online or offline.
 *
 * **Offline is the default** and only an approved, unblocked pro may go online
 * — otherwise a pending pro sits in the dispatch pool and is alerted for work
 * they cannot legally take.
 */
proJobsRouter.put("/online", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const next = Boolean((req.body as { online?: unknown })?.online);

  if (next && !canReceiveOffers(pro)) {
    throw forbidden(
      pro.blocked
        ? "Your account is blocked. Contact the office."
        : "Your account is still being reviewed.",
    );
  }

  await Pro.updateOne({ _id: pro._id }, { $set: { online: next } });
  res.json({ online: next });
});

/**
 * Pro location ping, while on a job.
 *
 * Expected every 15–30 seconds, not every second: it is the pro's battery and
 * their data. Stored as GeoJSON so the dispatch `2dsphere` index can use it.
 */
proJobsRouter.put("/location", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const body = (req.body ?? {}) as { lat?: unknown; lng?: unknown };

  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    throw badRequest("A location needs a lat and a lng.", "BAD_LOCATION");
  }

  await Pro.updateOne(
    { _id: pro._id },
    { $set: { location: { type: "Point", coordinates: [body.lng, body.lat] } } },
  );
  res.status(204).end();
});

// -- Offers (Pro 12) ----------------------------------------------------------

/**
 * The pro's live offer, or null.
 *
 * Null is the ordinary case — a pro is not offered a job every time they look.
 * Polled by `offer-listener.tsx` today; FCM is a delivery channel on top of
 * this, not a replacement for it (a web app cannot wake a sleeping phone).
 */
proJobsRouter.get("/offers/next", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  if (!canReceiveOffers(pro)) {
    res.json(null);
    return;
  }

  const offer = await Offer.findOne({
    proId: pro._id,
    status: "offered",
    // Filtered here as well as swept: an offer that lapsed a second ago must
    // not be handed out with a countdown of zero.
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean<OfferDoc>();

  if (!offer) {
    res.json(null);
    return;
  }

  const booking = await Booking.findById(offer.bookingId).lean<BookingDoc>();
  if (!booking || booking.status !== "pending" || booking.proId !== null) {
    // Taken between the sweep and this read.
    res.json(null);
    return;
  }

  res.json(
    projectJob(booking, pro, {
      // The offer withholds everything identifying. This is that rule.
      released: false,
      offered: true,
      distanceKm: offer.distanceKm,
      offerId: offer._id,
      expiresInSeconds: Math.max(
        0,
        Math.round((offer.expiresAt.getTime() - Date.now()) / 1000),
      ),
      checklist: await checklistFor(booking.serviceId),
    }),
  );
});

proJobsRouter.post("/offers/:id/accept", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const result = await acceptOffer(pro._id, req.params.id);

  if (result.kind !== "accepted") {
    // Not an error: "taken by another professional" is the documented rule
    // working, and the UI already renders it as a real outcome.
    res.json({ kind: result.kind });
    return;
  }

  // Re-read: the pro went offline as part of accepting.
  const updated = await loadPro(pro._id);

  res.json({
    kind: "accepted",
    job: projectJob(result.booking, updated, {
      // Released now, to the one pro attending.
      released: true,
      offered: false,
      distanceKm: null,
      checklist: await checklistFor(result.booking.serviceId),
    }),
  });
});

proJobsRouter.post("/offers/:id/decline", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  await declineOffer(pro._id, req.params.id);
  res.json({ kind: "declined" });
});

export const OFFER_WINDOW = OFFER_WINDOW_SECONDS;

// -- The pro's jobs (Pro 10, 20) ---------------------------------------------

const TAB_STATUSES: Record<string, string[]> = {
  active: ["assigned", "in_progress"],
  upcoming: ["assigned"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

proJobsRouter.get("/jobs", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const tab = typeof req.query["tab"] === "string" ? req.query["tab"] : undefined;

  const filter: Record<string, unknown> = { proId: pro._id };
  if (tab && TAB_STATUSES[tab]) filter["status"] = { $in: TAB_STATUSES[tab] };

  const rows = await Booking.find(filter)
    .sort({ scheduledAt: 1 })
    .lean<BookingDoc[]>();

  const jobs = await Promise.all(
    rows.map(async (b) =>
      projectJob(b, pro, {
        // Assigned to this pro, so there is nothing to withhold.
        released: true,
        offered: false,
        distanceKm: null,
        checklist: await checklistFor(b.serviceId),
      }),
    ),
  );

  res.json(jobs);
});

proJobsRouter.get("/jobs/counts", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const rows = await Booking.find({ proId: pro._id })
    .select({ status: 1 })
    .lean<{ status: string }[]>();

  res.json({
    active: rows.filter((r) => ["assigned", "in_progress"].includes(r.status)).length,
    upcoming: rows.filter((r) => r.status === "assigned").length,
    completed: rows.filter((r) => r.status === "completed").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
  });
});

/** Pro 10 — the dashboard. `todayNetPaise`, never gross. */
proJobsRouter.get("/stats", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [todayDone, all] = await Promise.all([
    Booking.find({
      proId: pro._id,
      status: "completed",
      updatedAt: { $gte: startOfDay },
    }).lean<BookingDoc[]>(),
    Booking.find({ proId: pro._id }).lean<BookingDoc[]>(),
  ]);

  const net = (list: BookingDoc[]) =>
    list.reduce((sum, b) => sum + earningsFor(b, pro).netEarningPaise, 0);

  res.json({
    // Net, not gross: the number on the dashboard has to be the number that
    // reaches their bank, or a pro feels short-changed every single time.
    todayNetPaise: net(todayDone),
    todayJobCount: todayDone.length,
    activeCount: all.filter((b) =>
      ["assigned", "in_progress"].includes(b.status),
    ).length,
    upcomingCount: all.filter(
      (b) => b.status === "assigned" && !isToday(b.scheduledAt),
    ).length,
    completedTotal: pro.jobsCompleted,
    rating: ratingOf(pro),
    totalEarnedNetPaise: net(all.filter((b) => b.status === "completed")),
  });
});

proJobsRouter.get("/jobs/:id", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const booking = await Booking.findOne({
    _id: req.params.id,
    proId: pro._id,
  }).lean<BookingDoc>();

  // Another pro's job is a 404. "That exists but is not yours" is more than
  // anyone needs to know.
  if (!booking) throw notFound("That job could not be found.");

  res.json(
    projectJob(booking, pro, {
      released: true,
      offered: false,
      distanceKm: null,
      checklist: await checklistFor(booking.serviceId),
    }),
  );
});

// -- Job lifecycle (Pro 13–19) -----------------------------------------------

/** Pro 15 — arrived, starting work. `assigned → in_progress`. */
proJobsRouter.post("/jobs/:id/start", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const result = await startJob(pro._id, req.params.id);
  if (!result.ok) throw conflict(result.reason, "BAD_TRANSITION");

  res.json(
    projectJob(result.booking, pro, {
      released: true,
      offered: false,
      distanceKm: null,
      checklist: await checklistFor(result.booking.serviceId),
    }),
  );
});

/**
 * Pro 16, 17 — before and after photos.
 *
 * Kept as separate arrays because they answer different questions in a dispute:
 * `before` shows what the pro walked into, `after` shows what they left. One
 * merged list loses exactly the distinction that matters.
 *
 * Written to the **public** upload root: the customer sees these on their own
 * booking, and they are photographs of a room rather than identity documents.
 */
proJobsRouter.post(
  "/jobs/:id/photos",
  imageUpload.single("file"),
  async (req, res) => {
    const pro = await loadPro(actorOf(req).id);
    const stage = (req.body as { stage?: unknown })?.stage;

    if (stage !== "before" && stage !== "after") {
      if (req.file) await fsPromises.unlink(req.file.path).catch(() => {});
      throw badRequest("Say whether this is a before or after photo.", "BAD_STAGE");
    }
    if (!req.file) throw badRequest("No file was uploaded.", "NO_FILE");

    const ok = await verifyImageBytes(req.file.path);
    if (!ok) {
      await fsPromises.unlink(req.file.path).catch(() => {});
      throw badRequest("That file is not a valid image.", "BAD_FILE_TYPE");
    }

    const filename = nodePath.basename(req.file.path);
    const field = stage === "before" ? "beforePhotoPaths" : "afterPhotoPaths";

    const updated = await Booking.findOneAndUpdate(
      {
        _id: req.params.id,
        proId: pro._id,
        // Only while the job is live. Photos on a closed job would change the
        // evidence after a settlement, and on an unassigned one there is no
        // job to photograph.
        status: { $in: ["assigned", "in_progress"] },
      },
      { $push: { [field]: filename } },
      { new: true },
    ).lean<BookingDoc>();

    if (!updated) {
      await fsPromises.unlink(req.file.path).catch(() => {});
      throw conflict(
        "Photos can only be added to a job that is under way.",
        "BAD_STATE",
      );
    }

    res.status(201).json({
      stage,
      url: `${PUBLIC_PREFIX}/${filename}`,
      beforeCount: updated.beforePhotoPaths.length,
      afterCount: updated.afterPhotoPaths.length,
    });
  },
);

/**
 * Pro 18 → 19 — close the job.
 *
 * The gate order is the substance: OTP, then after-photos, then GPS. See
 * `services/job-lifecycle.ts`.
 *
 * A rejection comes back as a **200 with `ok: false`** and a named reason,
 * rather than an error status. Each one is a real, expected outcome the screen
 * renders as its own message — a wrong OTP is not a server fault.
 */
proJobsRouter.post("/jobs/:id/complete", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const body = (req.body ?? {}) as {
    otp?: unknown;
    lat?: unknown;
    lng?: unknown;
  };

  if (typeof body.otp !== "string") {
    throw badRequest("Enter the code the customer gives you.", "MISSING_OTP");
  }

  // No fix is a legitimate state, not a bad request — see the lifecycle header.
  const proPoint =
    typeof body.lat === "number" && typeof body.lng === "number"
      ? { lat: body.lat, lng: body.lng }
      : null;

  const result = await completeJob({
    proId: pro._id,
    bookingId: req.params.id,
    otp: body.otp,
    proPoint,
  });

  if (!result.ok) {
    res.json({ ok: false, error: result.error });
    return;
  }

  res.json({ ok: true, earning: result.earning });
});

/** Pro 15 — a charge added on site. */
proJobsRouter.post("/jobs/:id/extra-charge", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const body = (req.body ?? {}) as { label?: unknown; amountPaise?: unknown };

  if (typeof body.label !== "string" || body.label.trim().length < 3) {
    // The customer reads this. "Extra" explains nothing and invites a dispute.
    throw badRequest(
      "Say what the charge is for, in words the customer will understand.",
      "MISSING_LABEL",
    );
  }
  if (
    typeof body.amountPaise !== "number" ||
    !Number.isInteger(body.amountPaise) ||
    body.amountPaise <= 0
  ) {
    throw badRequest("An amount must be a whole number of paise.", "BAD_AMOUNT");
  }

  const result = await addExtraCharge(
    pro._id,
    req.params.id,
    body.label,
    body.amountPaise,
  );
  if (!result.ok) throw conflict(result.reason, "BAD_STATE");

  res.status(201).json(result.charge);
});

// -- Quotations (Pro 16, 17) --------------------------------------------------

/**
 * Pro 16 — submit a quotation for admin approval.
 *
 * Refusals come back as **200 with a named reason**, not an error status. Each
 * is an expected outcome with its own message on the screen — a pro who has
 * taken one photo instead of two has made a fixable mistake, not caused a
 * server fault.
 */
proJobsRouter.post("/jobs/:id/quotation", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const body = (req.body ?? {}) as {
    description?: unknown;
    materials?: unknown;
    labourPaise?: unknown;
  };

  if (typeof body.description !== "string") {
    throw badRequest("Describe what you found.", "MISSING_DESCRIPTION");
  }
  if (
    typeof body.labourPaise !== "number" ||
    !Number.isInteger(body.labourPaise) ||
    body.labourPaise < 0
  ) {
    throw badRequest("Labour must be a whole number of paise.", "BAD_AMOUNT");
  }

  const materials = Array.isArray(body.materials)
    ? body.materials.map((m, i) => {
        const line = m as { description?: unknown; costPaise?: unknown };
        if (
          typeof line.description !== "string" ||
          line.description.trim() === ""
        ) {
          // The customer reads these lines. An unlabelled cost invites a
          // dispute the pro will be on the wrong end of.
          throw badRequest(
            `Material ${i + 1} needs a description.`,
            "BAD_MATERIAL",
          );
        }
        if (
          typeof line.costPaise !== "number" ||
          !Number.isInteger(line.costPaise) ||
          line.costPaise < 0
        ) {
          throw badRequest(
            `Material ${i + 1} cost must be a whole number of paise.`,
            "BAD_AMOUNT",
          );
        }
        return {
          description: line.description.trim(),
          costPaise: line.costPaise,
        };
      })
    : [];

  const result = await submitQuotation({
    proId: pro._id,
    bookingId: param(req, "id"),
    description: body.description,
    materials,
    labourPaise: body.labourPaise,
  });

  res.json(result);
});

/**
 * Pro 17 — where the quotation has got to.
 *
 * The pro is waiting on this while standing in a customer's house, so it
 * reports the minutes left as well as the status.
 */
proJobsRouter.get("/jobs/:id/quotation", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const quote = await Quotation.findOne({
    bookingId: param(req, "id"),
    proId: pro._id,
  })
    .sort({ createdAt: -1 })
    .lean<QuotationDoc>();

  if (!quote) {
    res.json(null);
    return;
  }

  res.json({
    id: quote._id,
    status: quote.status,
    submittedTotalPaise: quote.submittedTotalPaise,
    totalPaise: quote.totalPaise,
    // So a pro sees that the office changed the figure, and by how much —
    // rather than discovering it from the customer.
    edited: quote.edited,
    minutesRemaining:
      quote.status === "pending"
        ? Math.max(0, Math.ceil((quote.decisionBy.getTime() - Date.now()) / 60_000))
        : null,
    rejectionReason: quote.rejectionReason ?? null,
    advancePaise: quote.advancePaise,
    advancePaid: quote.advancePaid,
  });
});
