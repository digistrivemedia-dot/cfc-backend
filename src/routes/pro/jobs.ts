import { Router } from "express";
import type { ProJob, ProJobQuotation, ProJobStatus } from "@cfc/types";
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
  claimBooking,
  declineOffer,
  unclaimedFor,
} from "../../services/dispatch";
import { PUBLIC_PREFIX, PUBLIC_ROOT } from "../../uploads";
import {
  MAX_JOB_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  formatBytes,
  isVideoPath,
  mediaUpload,
  verifyImageBytes,
  verifyVideoBytes,
} from "../../middleware/upload";
import {
  addExtraCharge,
  completeJob,
  grossFor,
  settle,
  startJob,
} from "../../services/job-lifecycle";
import {
  proRights,
  reviseQuotation,
  startQuotedWork,
  submitQuotation,
  withdrawQuotation,
} from "../../services/quotation";
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

/**
 * A quotation as the pro sees it. **The one mapper.**
 *
 * Used by `GET /jobs/:id/quotation` *and* by every job projection, so the
 * figures and the clock on the job screen cannot drift from the ones on the
 * quotation screen.
 */
function projectQuotation(q: QuotationDoc): ProJobQuotation {
  return {
    id: q._id,
    status: q.status,
    submittedTotalPaise: q.submittedTotalPaise,
    totalPaise: q.totalPaise,
    // So a pro sees that the office changed the figure, and by how much —
    // rather than discovering it from the customer.
    edited: q.edited,
    minutesRemaining:
      q.status === "pending"
        ? Math.max(0, Math.ceil((q.decisionBy.getTime() - Date.now()) / 60_000))
        : null,
    decisionBy: q.decisionBy.toISOString(),
    rejectionReason: q.rejectionReason ?? null,

    /**
     * The quotation's own content, so the work screen can show what was quoted
     * and the quote form can be reopened with it rather than from blank.
     *
     * The pro wrote all of this. Withholding it was not a privacy decision,
     * just an omission — and it meant a pro could see that a quotation existed
     * without seeing what was in it.
     */
    proNotes: q.proNotes,
    materials: q.materials,
    labourPaise: q.labourPaise,

    /**
     * What this professional may still do about it.
     *
     * Sent rather than derived on the screen, so the button and the server
     * cannot disagree — an Edit the server then refuses is worse than no Edit.
     * `restriction` carries the *reason*, because a disabled control with no
     * explanation is the most frustrating thing in any app.
     */
    ...(() => {
      const rights = proRights(q);
      return {
        mayRevise: rights.mayRevise,
        mayWithdraw: rights.mayWithdraw,
        restriction: rights.reason,
      };
    })(),
    /**
     * Whether the customer's code has been entered.
     *
     * **`startOtp` is deliberately absent from this projection.** It is the
     * customer's to read aloud; a pro who could pull it out of their own job
     * response could start — and be paid for — quoted work the customer never
     * confirmed, which is the entire thing the code exists to prevent. Same
     * rule as `completionOtp`, which this file already forces to null.
     */
    workStarted: q.workStartedAt !== undefined,
  };
}

/**
 * The latest quotation on each of these bookings, keyed by booking id.
 *
 * One query for a whole list rather than one per row: the job list already
 * pays an N+1 for its checklists and that is enough of them.
 */
async function quotationsFor(
  bookingIds: string[],
  proId: string,
): Promise<Map<string, ProJobQuotation>> {
  if (bookingIds.length === 0) return new Map();

  const rows = await Quotation.find({
    bookingId: { $in: bookingIds },
    proId,
  })
    // Newest first, so the first one seen per booking is the one that counts: a
    // rejected quote can be revised, and what the pro needs is where they
    // stand now.
    .sort({ createdAt: -1 })
    .lean<QuotationDoc[]>();

  const byBooking = new Map<string, ProJobQuotation>();
  for (const q of rows) {
    if (!byBooking.has(q.bookingId)) {
      byBooking.set(q.bookingId, projectQuotation(q));
    }
  }
  return byBooking;
}

/**
 * Maps a booking status onto the pro's own workflow vocabulary.
 *
 * **A pending quotation outranks the booking's own status.** `awaiting_quote`
 * has existed in `@cfc/types` from the start — labelled "Quote sent", and
 * collected by the Active tab — and nothing ever returned it, so a pro who had
 * raised a quotation saw a job reading "In progress" with no sign the office
 * had it. The rule belongs here rather than on a screen, because the job list
 * and the job detail both read this and must not disagree.
 */
function proStatus(
  booking: BookingDoc,
  offered: boolean,
  quotation: ProJobQuotation | null,
): ProJobStatus {
  if (offered) return "offered";
  if (quotation?.status === "pending") return "awaiting_quote";
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
    /**
     * Optional, defaulting to none.
     *
     * The paths where a quotation cannot yet exist — an offer, a fresh claim,
     * the moment work starts — say nothing rather than each having to pass an
     * explicit null.
     */
    quotation?: ProJobQuotation | null;
  },
): ProJob & { offerId?: string; expiresInSeconds?: number } {
  const { grossEarningPaise, netEarningPaise } = earningsFor(booking, pro);
  const { released } = options;
  const quotation = options.quotation ?? null;

  return {
    id: booking._id,
    reference: booking.reference,
    serviceName: booking.serviceName,
    status: proStatus(booking, options.offered, quotation),
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
    /**
     * **Never sent to the professional.** Always null.
     *
     * It used to be released once the job was `in_progress`, which handed the
     * pro the very code the customer is supposed to read out — so a pro could
     * open devtools, read the response, and close a job they had not done with
     * nobody present. The whole point of the code is that only the customer
     * has it.
     *
     * The server compares it. The field stays in the shape so the pro app's
     * screens keep their types, and so anything reading it gets a null rather
     * than a stale value.
     */
    completionOtp: null,

    checklist: options.checklist,
    beforePhotoUrls: booking.beforePhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),
    afterPhotoUrls: booking.afterPhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),

    quotation,

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

  // One query for the lot, so the "Quote sent" status on this list is the same
  // one the job screen shows.
  const quotations = await quotationsFor(
    rows.map((b) => b._id),
    pro._id,
  );

  const jobs = await Promise.all(
    rows.map(async (b) =>
      projectJob(b, pro, {
        // Assigned to this pro, so there is nothing to withhold.
        released: true,
        offered: false,
        distanceKm: null,
        checklist: await checklistFor(b.serviceId),
        quotation: quotations.get(b._id) ?? null,
      }),
    ),
  );

  res.json(jobs);
});

/**
 * Pro 13b — bookings nobody accepted, that this pro could take.
 *
 * **Registered before `/jobs/:id`.** Express matches in order, so the other way
 * round a request for `/jobs/unclaimed` is read as a request for the job whose
 * id is "unclaimed" and answers 404.
 *
 * Shown with the customer's identity **withheld**, exactly like an offer: this
 * pro has not been assigned the job yet, and a list anyone eligible can read is
 * not a place to publish an address and a phone number.
 */
proJobsRouter.get("/jobs/unclaimed", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const rows = await unclaimedFor(pro._id);

  const jobs = await Promise.all(
    rows.map(async (b) =>
      projectJob(b, pro, {
        // Not theirs yet. The address and phone are released on claiming.
        released: false,
        offered: true,
        distanceKm: null,
        checklist: await checklistFor(b.serviceId),
      }),
    ),
  );

  res.json(jobs);
});

/**
 * Takes one.
 *
 * A refusal is a **200 with `kind`**, not an error status: "another
 * professional got there first" is the documented rule working, and the screen
 * renders it as a real outcome rather than a failure.
 */
proJobsRouter.post("/jobs/:id/claim", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const result = await claimBooking(pro._id, param(req, "id"));

  if (result.kind !== "claimed") {
    res.json({ kind: result.kind });
    return;
  }

  res.json({
    kind: "claimed",
    job: projectJob(result.booking, pro, {
      // Theirs now, so the customer's details are released.
      released: true,
      offered: false,
      distanceKm: null,
      checklist: await checklistFor(result.booking.serviceId),
    }),
  });
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
    // Not this pro's bookings at all — work going begging that they could take.
    // Counted here so the tab can carry a badge without a second request.
    unclaimed: (await unclaimedFor(pro._id)).length,
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

  const quotations = await quotationsFor([booking._id], pro._id);

  res.json(
    projectJob(booking, pro, {
      released: true,
      offered: false,
      distanceKm: null,
      checklist: await checklistFor(booking.serviceId),
      quotation: quotations.get(booking._id) ?? null,
    }),
  );
});

// -- Job lifecycle (Pro 13–19) -----------------------------------------------

/** Pro 15 — arrived, starting work. `assigned → in_progress`. */
proJobsRouter.post("/jobs/:id/start", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);

  const otp = (req.body as { otp?: unknown })?.otp;
  if (typeof otp !== "string") {
    throw badRequest("Enter the code the customer gives you.", "MISSING_OTP");
  }

  const result = await startJob(pro._id, req.params.id, otp);
  if (!result.ok) {
    // A wrong code is the customer reading out the wrong number, not a bad
    // transition — distinguished so the screen can mark the field instead of
    // telling the pro the job cannot be started.
    throw result.wrongOtp
      ? badRequest(result.reason, "WRONG_OTP")
      : conflict(result.reason, "BAD_TRANSITION");
  }

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
  mediaUpload.single("file"),
  async (req, res) => {
    const pro = await loadPro(actorOf(req).id);
    const stage = (req.body as { stage?: unknown })?.stage;

    const discard = async () => {
      if (req.file) await fsPromises.unlink(req.file.path).catch(() => {});
    };

    if (stage !== "before" && stage !== "after") {
      await discard();
      throw badRequest("Say whether this is a before or after photo.", "BAD_STAGE");
    }
    if (!req.file) throw badRequest("No file was uploaded.", "NO_FILE");

    // Multer streams to disk before handing over, so every rejection below has
    // to clean up after itself.
    const video = isVideoPath(req.file.path);
    const valid = video
      ? await verifyVideoBytes(req.file.path)
      : await verifyImageBytes(req.file.path);
    if (!valid) {
      await discard();
      throw badRequest(
        video
          ? "That file is not a valid video. MP4, MOV or WebM."
          : "That file is not a valid image. JPG, PNG or WebP.",
        "BAD_FILE_TYPE",
      );
    }

    if (video) {
      if (req.file.size > MAX_VIDEO_BYTES) {
        await discard();
        throw badRequest(
          `That video is ${formatBytes(req.file.size)}. The limit is ` +
            `${formatBytes(MAX_VIDEO_BYTES)} — record a shorter clip or use ` +
            `your phone's lower video quality setting.`,
          "VIDEO_TOO_LARGE",
        );
      }
    } else {
      /**
       * The image budget is for the **whole job**, not per file.
       *
       * So the existing photos have to be measured, not assumed: eight files
       * that each passed a per-file check can still blow a job budget. The
       * error names every photo and its size, because "too large" when a pro
       * is nine files deep tells them nothing about which one to drop.
       */
      const existing = await Booking.findOne({
        _id: req.params.id,
        proId: pro._id,
      })
        .select({ beforePhotoPaths: 1, afterPhotoPaths: 1 })
        .lean<Pick<BookingDoc, "beforePhotoPaths" | "afterPhotoPaths">>();

      const kept = [
        ...(existing?.beforePhotoPaths ?? []),
        ...(existing?.afterPhotoPaths ?? []),
      ];

      const sizes: { name: string; bytes: number }[] = [];
      for (const name of kept) {
        if (isVideoPath(name)) continue; // videos have their own limit
        try {
          const stat = await fsPromises.stat(nodePath.join(PUBLIC_ROOT, name));
          sizes.push({ name, bytes: stat.size });
        } catch {
          // Missing file: it cannot be using disk, so it cannot count.
        }
      }

      const used = sizes.reduce((sum, f) => sum + f.bytes, 0);
      if (used + req.file.size > MAX_JOB_IMAGE_BYTES) {
        const listed = sizes
          .map((f, i) => `photo ${i + 1}: ${formatBytes(f.bytes)}`)
          .join(", ");
        await discard();
        throw badRequest(
          `Your photos for this job would come to ` +
            `${formatBytes(used + req.file.size)}, over the ` +
            `${formatBytes(MAX_JOB_IMAGE_BYTES)} limit. ` +
            `This one is ${formatBytes(req.file.size)}` +
            (listed ? `, and the rest are — ${listed}.` : ".") +
            ` Remove one, or add a shorter video instead.`,
          "IMAGES_TOO_LARGE",
        );
      }
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
        "Proof can only be added to a job that is under way.",
        "BAD_STATE",
      );
    }

    res.status(201).json({
      stage,
      url: `${PUBLIC_PREFIX}/${filename}`,
      /** So the screen can render a player rather than a broken `<img>`. */
      kind: video ? "video" : "image",
      bytes: req.file.size,
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

  // The same mapper the job projection uses, so this endpoint and the job
  // screen cannot report different figures or a different clock.
  res.json(projectQuotation(quote));
});

/**
 * Pro 16 — revise a quotation the professional already raised.
 *
 * `PATCH`, not a second `POST`: this changes a quotation that exists rather
 * than creating one, and the pro's quote form reopens with the current figures
 * instead of a blank page.
 *
 * Refused once the customer has approved, and once the office has adjusted it.
 * Both rules live in `proRights`, so this route cannot forget either.
 */
proJobsRouter.patch("/quotations/:id", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const body = (req.body ?? {}) as {
    description?: unknown;
    materials?: unknown;
    labourPaise?: unknown;
  };

  if (
    body.labourPaise !== undefined &&
    (typeof body.labourPaise !== "number" ||
      !Number.isInteger(body.labourPaise) ||
      body.labourPaise < 0)
  ) {
    throw badRequest("Labour must be a whole number of paise.", "BAD_AMOUNT");
  }

  let materials: { description: string; costPaise: number }[] | undefined;
  if (Array.isArray(body.materials)) {
    materials = body.materials.map((m, i) => {
      const line = m as { description?: unknown; costPaise?: unknown };
      if (typeof line.description !== "string" || line.description.trim() === "") {
        // The customer reads these lines. An unlabelled cost invites a dispute
        // the pro will be on the wrong end of.
        throw badRequest(`Material ${i + 1} needs a description.`, "BAD_MATERIAL");
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
      return { description: line.description.trim(), costPaise: line.costPaise };
    });
  }

  const result = await reviseQuotation({
    proId: pro._id,
    quotationId: param(req, "id"),
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    ...(materials !== undefined ? { materials } : {}),
    ...(typeof body.labourPaise === "number" ? { labourPaise: body.labourPaise } : {}),
  });

  if (!result.ok) throw conflict(result.reason, "REVISE_FAILED");
  res.json(projectQuotation(result.quotation));
});

/**
 * Pro 16 — withdraw a quotation.
 *
 * The route back to a clean slate: one live quotation per job is the rule, so a
 * pro who quoted the wrong work needs this before they can quote the right
 * work. Available even after the office has adjusted it — a professional must
 * be able to take back a price they no longer stand behind.
 */
proJobsRouter.post("/quotations/:id/withdraw", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const result = await withdrawQuotation({
    proId: pro._id,
    quotationId: param(req, "id"),
  });

  if (!result.ok) throw conflict(result.reason, "WITHDRAW_FAILED");
  res.json(projectQuotation(result.quotation));
});

/**
 * Pro 17 — the customer has confirmed; start the quoted work.
 *
 * The code comes from the customer's screen, read aloud at the door. A wrong
 * one is a **400 with `WRONG_OTP`**, distinct from a bad state, so the pro's
 * screen marks the field rather than claiming the work cannot be started.
 *
 * Gated on the quotation, not the booking: the booking is already
 * `in_progress` — the pro has been working on the original job all along — and
 * what needs confirming is the *extra* work, which is its own agreement at its
 * own price.
 */
proJobsRouter.post("/quotations/:id/start", async (req, res) => {
  const pro = await loadPro(actorOf(req).id);
  const otp = (req.body as { otp?: unknown })?.otp;

  if (typeof otp !== "string" || otp.trim() === "") {
    throw badRequest("Ask the customer to read out their code.", "MISSING_OTP");
  }

  const result = await startQuotedWork({
    proId: pro._id,
    quotationId: param(req, "id"),
    otp,
  });

  if (!result.ok) {
    throw result.wrongOtp
      ? badRequest(result.reason, "WRONG_OTP")
      : conflict(result.reason, "BAD_STATE");
  }

  res.json(projectQuotation(result.quotation));
});
