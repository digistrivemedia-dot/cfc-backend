import { Router } from "express";
import type { BookingStatus, PriceBreakdown } from "@cfc/types";
import { badRequest, conflict, forbidden, notConfigured, notFound } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { Service, type ServiceDoc } from "../../models/catalog";
import { Customer, type AddressSub, type CustomerDoc } from "../../models/customer";
import {
  Booking,
  canTransition,
  newReference,
  type BookingDoc,
} from "../../models/booking";
import { Coupon, redeemCoupon, releaseCoupon, type CouponDoc } from "../../models/coupon";
import { WalletEntry, walletBalance } from "../../models/wallet";
import { Pro, ratingOf, type ProDoc } from "../../models/pro";
import { trackingFor } from "../../services/job-lifecycle";
import { newId } from "../../models/id";
import { durationMinutes, priceBooking } from "../../services/pricing";
import { dispatch } from "../../services/dispatch";
import { getSettings } from "../../models/settings";
import { PUBLIC_PREFIX } from "../../uploads";

/**
 * Customer 18–30 — pricing a booking, placing it, and the customer's own list.
 *
 * The rule that shapes this whole file: **money is server-authoritative.** The
 * client prices a draft for display, and the server recomputes and uses its own
 * number. A total sent by a browser is never trusted — it is the one field
 * someone has a direct financial reason to tamper with.
 */
export const consumerBookingRouter = Router();

consumerBookingRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "customer") {
    next(forbidden());
    return;
  }
  next();
});

async function loadCustomer(id: string): Promise<CustomerDoc> {
  const found = await Customer.findById(id).lean<CustomerDoc>();
  if (!found) throw notFound("That account no longer exists.");
  return found;
}

async function loadService(id: unknown): Promise<ServiceDoc> {
  if (typeof id !== "string" || id === "") {
    throw badRequest("Which service?", "MISSING_SERVICE");
  }
  const found = await Service.findById(id).lean<ServiceDoc>();
  if (!found) throw notFound("That service is not available.");
  if (!found.active) throw notFound("That service is not available.");
  return found;
}

function strList(body: unknown, field: string): string[] {
  const raw = (body as Record<string, unknown> | undefined)?.[field];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * The city override, if one applies to this customer's chosen address.
 *
 * Admin 28 allows one city to override a service's base price. Read here rather
 * than in the pricing function so the pricing stays a pure calculation.
 */
function overrideFor(
  service: ServiceDoc,
  address: AddressSub | undefined,
): number | undefined {
  if (!service.cityOverride || !address) return undefined;
  return service.cityOverride.city.toLowerCase() === address.city.toLowerCase()
    ? service.cityOverride.basePricePaise
    : undefined;
}

// -- Pricing (Customer 18) ----------------------------------------------------

/**
 * Prices a draft. Customer 18.
 *
 * The client calls this to show a summary; `POST /` recomputes from the same
 * function before writing anything, so the two cannot disagree and the
 * displayed figure is the one charged.
 */
consumerBookingRouter.post("/price", async (req, res) => {
  const customer = await loadCustomer(actorOf(req).id);
  const service = await loadService((req.body as { serviceId?: unknown })?.serviceId);

  const addressId = (req.body as { addressId?: unknown })?.addressId;
  const address = customer.addresses.find((a) => a.id === addressId);

  const couponCode = (req.body as { couponCode?: unknown })?.couponCode;
  const discountPaise =
    typeof couponCode === "string" && couponCode.trim() !== ""
      ? (await evaluateCoupon(couponCode, customer, service, req.body)).discountPaise
      : 0;

  const breakdown = priceBooking({
    service,
    variantId: (req.body as { variantId?: unknown })?.variantId as string | null,
    addOnIds: strList(req.body, "addOnIds"),
    quantity: Number((req.body as { quantity?: unknown })?.quantity) || 1,
    discountPaise,
    overrideBasePricePaise: overrideFor(service, address),
  });

  res.json(breakdown);
});

// -- Coupons (Customer 19) ----------------------------------------------------

type CouponFailure =
  | "unknown"
  | "expired"
  | "exhausted"
  | "min-order"
  | "service"
  | "area"
  | "first-booking"
  | "per-customer";

/**
 * Checks a code against a draft, and says **why** when it fails.
 *
 * Every restriction is enforced and the reason is named, because "invalid code"
 * is the least useful message a checkout can give: a customer told they are
 * ₹200 short of the minimum will add something, a customer told "invalid"
 * leaves. The six original reasons are preserved and two added for the
 * restrictions Admin 36 allows.
 */
async function evaluateCoupon(
  code: string,
  customer: CustomerDoc,
  service: ServiceDoc,
  body: unknown,
): Promise<{
  ok: boolean;
  reason?: CouponFailure;
  discountPaise: number;
  coupon?: CouponDoc;
}> {
  const found = await Coupon.findOne({
    code: code.trim().toUpperCase(),
    active: true,
  }).lean<CouponDoc>();

  if (!found) return { ok: false, reason: "unknown", discountPaise: 0 };
  if (found.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired", discountPaise: 0, coupon: found };
  }
  if (found.maxUses > 0 && found.usedCount >= found.maxUses) {
    return { ok: false, reason: "exhausted", discountPaise: 0, coupon: found };
  }

  // Priced without a discount first, so the minimum-order test runs against
  // what the customer would actually pay rather than the headline price.
  const addressId = (body as { addressId?: unknown })?.addressId;
  const address = customer.addresses.find((a) => a.id === addressId);
  const undiscounted = priceBooking({
    service,
    variantId: (body as { variantId?: unknown })?.variantId as string | null,
    addOnIds: strList(body, "addOnIds"),
    quantity: Number((body as { quantity?: unknown })?.quantity) || 1,
    overrideBasePricePaise: overrideFor(service, address),
  });

  // The work, not the total: a coupon discounts the service and its add-ons.
  const workPaise = undiscounted.servicePaise + undiscounted.addOnsPaise;

  const r = found.restrictions;
  if (r.minOrderPaise > 0 && undiscounted.totalPaise < r.minOrderPaise) {
    return { ok: false, reason: "min-order", discountPaise: 0, coupon: found };
  }
  if (r.serviceIds.length > 0 && !r.serviceIds.includes(service._id)) {
    return { ok: false, reason: "service", discountPaise: 0, coupon: found };
  }
  if (r.areas.length > 0 && (!address || !r.areas.includes(address.area))) {
    return { ok: false, reason: "area", discountPaise: 0, coupon: found };
  }

  if (found.firstBookingOnly) {
    const previous = await Booking.countDocuments({
      customerId: customer._id,
      status: { $ne: "cancelled" },
    });
    if (previous > 0) {
      return { ok: false, reason: "first-booking", discountPaise: 0, coupon: found };
    }
  }

  if (r.perCustomerLimit > 0) {
    const used = await Booking.countDocuments({
      customerId: customer._id,
      couponCode: found.code,
      status: { $ne: "cancelled" },
    });
    if (used >= r.perCustomerLimit) {
      return { ok: false, reason: "per-customer", discountPaise: 0, coupon: found };
    }
  }

  const raw =
    found.discountType === "percent"
      ? Math.round((workPaise * found.discountValue) / 100)
      : found.discountValue;

  // A percentage coupon can carry a rupee ceiling — "20% off up to ₹300".
  const capped = r.maxDiscountPaise > 0 ? Math.min(raw, r.maxDiscountPaise) : raw;

  return {
    ok: true,
    // Never more than the work it applies to, or the total goes negative.
    discountPaise: Math.min(capped, workPaise),
    coupon: found,
  };
}

consumerBookingRouter.post("/coupon", async (req, res) => {
  const customer = await loadCustomer(actorOf(req).id);
  const service = await loadService((req.body as { serviceId?: unknown })?.serviceId);
  const code = (req.body as { code?: unknown })?.code;

  if (typeof code !== "string" || code.trim() === "") {
    throw badRequest("Enter a code.", "MISSING_CODE");
  }

  const result = await evaluateCoupon(code, customer, service, req.body);

  res.json({
    ok: result.ok,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.ok ? { discountPaise: result.discountPaise } : {}),
    ...(result.coupon
      ? {
          coupon: {
            id: result.coupon._id,
            code: result.coupon.code,
            discountType: result.coupon.discountType,
            discountValue: result.coupon.discountValue,
            maxUses: result.coupon.maxUses,
            usedCount: result.coupon.usedCount,
            expiresAt: result.coupon.expiresAt.toISOString(),
            firstBookingOnly: result.coupon.firstBookingOnly,
            restrictions: {
              areas: result.coupon.restrictions.areas,
              serviceNames: [],
              minOrderPaise: result.coupon.restrictions.minOrderPaise,
              maxDiscountPaise: result.coupon.restrictions.maxDiscountPaise,
              perCustomerLimit: result.coupon.restrictions.perCustomerLimit,
            },
            active: result.coupon.active,
          },
        }
      : {}),
  });
});

/** Coupons a customer can see and tap, rather than having to know the code. */
consumerBookingRouter.get("/coupons", async (_req, res) => {
  const rows = await Coupon.find({
    active: true,
    expiresAt: { $gt: new Date() },
    $expr: {
      $or: [{ $eq: ["$maxUses", 0] }, { $lt: ["$usedCount", "$maxUses"] }],
    },
  }).lean<CouponDoc[]>();

  res.json(
    rows.map((c) => ({
      id: c._id,
      code: c.code,
      discountType: c.discountType,
      discountValue: c.discountValue,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      expiresAt: c.expiresAt.toISOString(),
      firstBookingOnly: c.firstBookingOnly,
      restrictions: {
        areas: c.restrictions.areas,
        serviceNames: [],
        minOrderPaise: c.restrictions.minOrderPaise,
        maxDiscountPaise: c.restrictions.maxDiscountPaise,
        perCustomerLimit: c.restrictions.perCustomerLimit,
      },
      active: c.active,
    })),
  );
});

// -- Placing a booking (Customer 20, 21) --------------------------------------

/**
 * Places the booking.
 *
 * **Idempotent on a client key.** A double-tap on a slow connection must not
 * create two bookings, and a customer charged twice for one job is the worst
 * bug this flow can have. The key is unique in the database, so the second
 * request loses a race rather than being caught by a check that can itself race.
 */
consumerBookingRouter.post("/", async (req, res) => {
  const customer = await loadCustomer(actorOf(req).id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const idempotencyKey =
    typeof body["idempotencyKey"] === "string" && body["idempotencyKey"] !== ""
      ? `${customer._id}:${body["idempotencyKey"]}`
      : undefined;

  if (idempotencyKey) {
    const already = await Booking.findOne({ idempotencyKey }).lean<BookingDoc>();
    if (already) {
      // The same answer as the first time, so a retry is indistinguishable from
      // a success — which is the whole point of idempotency.
      res.status(200).json({
        reference: already.reference,
        startsAt: already.scheduledAt.toISOString(),
      });
      return;
    }
  }

  const service = await loadService(body["serviceId"]);

  const addressId = body["addressId"];
  const address = customer.addresses.find((a) => a.id === addressId);
  if (!address) {
    throw badRequest("Choose an address for this booking.", "MISSING_ADDRESS");
  }

  const startsAtRaw = body["startsAt"];
  if (typeof startsAtRaw !== "string" || Number.isNaN(Date.parse(startsAtRaw))) {
    throw badRequest("Choose an arrival time.", "MISSING_SLOT");
  }
  const scheduledAt = new Date(startsAtRaw);
  if (scheduledAt.getTime() < Date.now()) {
    // A slot in the past is a stale screen, and accepting it produces a booking
    // no pro can ever attend.
    throw badRequest("That arrival time has passed. Pick another.", "SLOT_PAST");
  }

  const settings = await getSettings();
  const horizonDays = settings.bookingHorizonDays;
  if (
    scheduledAt.getTime() >
    Date.now() + horizonDays * 24 * 60 * 60 * 1000
  ) {
    throw badRequest(
      `Bookings can be made up to ${horizonDays} days ahead.`,
      "SLOT_TOO_FAR",
    );
  }

  const method = body["paymentMethod"];
  if (
    method !== "cash" &&
    method !== "wallet" &&
    method !== "upi" &&
    method !== "card"
  ) {
    throw badRequest("Choose how you would like to pay.", "BAD_PAYMENT_METHOD");
  }

  // Razorpay has no keys (§0.3), so the online methods answer honestly rather
  // than booking and pretending a payment happened. No fake gateway: a stub
  // that auto-succeeds is how an untested signature check reaches production.
  if (method === "upi" || method === "card") {
    throw notConfigured("Online payment");
  }

  const addOnIds = strList(body, "addOnIds");
  const variantId =
    typeof body["variantId"] === "string" ? body["variantId"] : null;
  const quantity = Math.max(1, Math.floor(Number(body["quantity"]) || 1));

  const couponCode =
    typeof body["couponCode"] === "string" && body["couponCode"].trim() !== ""
      ? body["couponCode"].trim().toUpperCase()
      : null;

  let discountPaise = 0;
  if (couponCode) {
    const evaluated = await evaluateCoupon(couponCode, customer, service, body);
    if (!evaluated.ok) {
      throw conflict(
        "That coupon is no longer valid for this booking.",
        "COUPON_INVALID",
      );
    }
    // Claimed atomically here, not at the point it was displayed: a coupon that
    // ran out between the summary screen and this request must not be honoured.
    const claimed = await redeemCoupon(couponCode);
    if (!claimed) {
      throw conflict("That coupon has just run out.", "COUPON_EXHAUSTED");
    }
    discountPaise = evaluated.discountPaise;
  }

  try {
    // Recomputed server-side. Whatever total the client displayed, this is the
    // one that is charged and the one frozen onto the record.
    const breakdown: PriceBreakdown = priceBooking({
      service,
      variantId,
      addOnIds,
      quantity,
      discountPaise,
      overrideBasePricePaise: overrideFor(service, address),
    });

    // A client-sent total is compared, not used. A mismatch means the price
    // moved while they were deciding, and they should see the new one before
    // being charged rather than after.
    const claimedTotal = body["expectedTotalPaise"];
    if (
      typeof claimedTotal === "number" &&
      claimedTotal !== breakdown.totalPaise
    ) {
      throw conflict(
        "The price has changed since you started. Please review it again.",
        "PRICE_CHANGED",
      );
    }

    if (method === "wallet") {
      const balance = await walletBalance(customer._id);
      if (balance < breakdown.totalPaise) {
        throw conflict(
          "Your wallet does not have enough balance for this booking.",
          "INSUFFICIENT_BALANCE",
        );
      }
    }

    const variant =
      service.variants.find((v) => v.id === variantId) ??
      service.variants.find((v) => v.isDefault);

    const booking = await Booking.create({
      _id: newId("bkg"),
      reference: newReference(),
      customerId: customer._id,
      customerName: customer.name,
      customerPhone: customer.phone,
      serviceId: service._id,
      serviceName: service.name,
      variantId: variant?.id ?? null,
      // §4.5 — the chosen variant was being dropped entirely.
      variantName: variant?.name ?? null,
      addOnIds,
      quantity,
      scheduledAt,
      durationMinutes: durationMinutes({ service, variantId, addOnIds }),
      address,
      breakdown,
      couponCode,
      status: "pending",
      events: [
        {
          at: new Date(),
          label: "Booking placed",
          // A nameless customer is ordinary on a first booking, so the event
          // says "Customer" rather than leaving the actor blank.
          actor: customer.name || "Customer",
        },
      ],
      paymentMethod: method,
      // Cash is collected on site; a wallet booking is paid the moment it is
      // placed, because the money has already moved.
      paid: method === "wallet",
      proId: null,
      completionOtp: null,
      notes: typeof body["notes"] === "string" ? body["notes"].trim() : null,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    if (method === "wallet") {
      // A debit is negative, so the balance stays a sum. Written after the
      // booking exists, so there is never a debit with nothing behind it.
      await WalletEntry.create({
        _id: newId("wtx"),
        customerId: customer._id,
        kind: "booking",
        label: service.name,
        amountPaise: -breakdown.totalPaise,
        bookingReference: booking.reference,
        status: "completed",
      });
    }

    /**
     * Dispatch starts immediately, and the response does not wait for it.
     *
     * The booking is already saved, so a dispatch failure must not fail the
     * request — the customer booked successfully, and the job going unassigned
     * is an operational problem the 2-minute alert exists to surface.
     */
    void dispatch(booking._id).catch((err: unknown) => {
      console.error(`[dispatch] failed for ${booking.reference}`, err);
    });

    res.status(201).json({
      reference: booking.reference,
      startsAt: booking.scheduledAt.toISOString(),
    });
  } catch (err) {
    // The coupon was claimed before the booking was written, so a failure here
    // has to give the use back or a campaign silently loses redemptions.
    if (couponCode) await releaseCoupon(couponCode);
    throw err;
  }
});

// -- The customer's own bookings (Customer 25–29) -----------------------------

type BookingTab = "upcoming" | "ongoing" | "completed" | "cancelled";

/**
 * Which statuses each tab collects.
 *
 * The four tabs do not map one-to-one onto the five statuses: "Upcoming" covers
 * both a booking with no pro yet and one with a pro travelling. That grouping
 * belongs here rather than being reimplemented on the screen.
 */
const TAB_STATUSES: Record<BookingTab, BookingStatus[]> = {
  upcoming: ["pending", "assigned"],
  ongoing: ["in_progress"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

/**
 * One booking, as the customer who placed it sees it.
 *
 * Deliberately **not** the admin's shape. It carries the pro's name and phone
 * but none of their financial or disciplinary record — a consumer screen handed
 * the whole pro object would leak it the moment someone opened the network tab.
 */
function projectBooking(b: BookingDoc) {
  return {
    id: b._id,
    reference: b.reference,
    serviceName: b.serviceName,
    variantName: b.variantName,
    status: b.status,
    scheduledAt: b.scheduledAt.toISOString(),
    address: {
      id: b.address.id,
      label: b.address.label,
      line1: b.address.line1,
      line2: b.address.line2,
      landmark: b.address.landmark,
      area: b.address.area,
      city: b.address.city,
      state: b.address.state,
      pincode: b.address.pincode,
      point: { lat: b.address.lat, lng: b.address.lng },
      isDefault: b.address.isDefault,
    },
    totalPaise: b.breakdown.totalPaise,
    /** §4.1 — the frozen breakdown. The invoice reads this, not live pricing. */
    breakdown: b.breakdown,
    paymentMethod: b.paymentMethod,
    // Filled in by `attachPro`. Null while dispatch is still looking, which
    // the screens already render as "finding a professional".
    pro: null as AssignedPro | null,
    completionOtp: b.completionOtp,
    // Filled in by `attachPro`, which has the pro's last ping.
    etaMinutes: null as number | null,
    proPosition: null as { x: number; y: number } | null,
    proPoint: null as { lat: number; lng: number } | null,
    beforePhotoUrls: b.beforePhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),
    afterPhotoUrls: b.afterPhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),
    events: b.events.map((e) => ({ at: e.at.toISOString(), label: e.label })),
    rated: b.rated,
  };
}

/**
 * The pro, as the customer who booked them sees it.
 *
 * Deliberately **not** `ProDetail`. That shape carries bank last-four, IFSC,
 * UPI id, total earnings, pending payout and warning count — a professional's
 * financial record and disciplinary history. None of it is a customer's
 * business, and handing the whole object to a consumer screen would leak it the
 * moment someone opened the network tab.
 *
 * The phone **is** included, unlike on a public profile: a customer with a pro
 * on the way needs to reach them. That is the difference between a booking and
 * a profile.
 */
interface AssignedPro {
  id: string;
  name: string;
  phone: string;
  rating: number;
  jobsCompleted: number;
}

/**
 * Fills in the assigned pro, and the fields that only make sense with one.
 *
 * The completion OTP is released **only once the pro is on the way or on site**
 * — `ConsumerBooking.completionOtp` is documented as null before that, because
 * a code visible for days is a code that leaks.
 */
async function attachPro<
  T extends {
    status: string;
    completionOtp: string | null;
    proPoint: { lat: number; lng: number } | null;
    proPosition: { x: number; y: number } | null;
    etaMinutes: number | null;
  },
>(
  rows: T[],
  bookings: BookingDoc[],
): Promise<T[]> {
  const proIds = [...new Set(bookings.map((b) => b.proId).filter(Boolean))];
  if (proIds.length === 0) {
    return rows.map((r) => ({ ...r, completionOtp: null }));
  }

  const pros = await Pro.find({ _id: { $in: proIds } }).lean<ProDoc[]>();
  const byId = new Map(pros.map((p) => [p._id, p]));

  // Tracking is resolved per booking rather than in the loop, because it is an
  // async read and only live bookings need one.
  const tracking = await Promise.all(
    bookings.map(async (b) =>
      b.proId && (b.status === "assigned" || b.status === "in_progress")
        ? trackingFor(b)
        : { proPoint: null, proPosition: null, etaMinutes: null },
    ),
  );

  return rows.map((row, i) => {
    const booking = bookings[i];
    const pro = booking?.proId ? byId.get(booking.proId) : undefined;
    const onTheWay =
      booking?.status === "assigned" || booking?.status === "in_progress";
    const track = tracking[i];

    return {
      ...row,
      pro: pro
        ? {
            id: pro._id,
            name: pro.name,
            phone: pro.phone,
            rating: ratingOf(pro),
            jobsCompleted: pro.jobsCompleted,
          }
        : null,
      completionOtp: onTheWay ? (booking?.completionOtp ?? null) : null,
      proPoint: track?.proPoint ?? null,
      proPosition: track?.proPosition ?? null,
      etaMinutes: track?.etaMinutes ?? null,
    };
  });
}

consumerBookingRouter.get("/", async (req, res) => {
  const actor = actorOf(req);
  const tab = req.query["tab"] as BookingTab | undefined;

  const filter: Record<string, unknown> = { customerId: actor.id };
  if (tab && tab in TAB_STATUSES) {
    filter["status"] = { $in: TAB_STATUSES[tab] };
  }

  // Newest first: someone opening this is looking for the booking they just
  // made or the one happening now, not their oldest.
  const rows = await Booking.find(filter)
    .sort({ scheduledAt: -1 })
    .lean<BookingDoc[]>();

  res.json(await attachPro(rows.map(projectBooking), rows));
});

consumerBookingRouter.get("/counts", async (req, res) => {
  const actor = actorOf(req);
  const rows = await Booking.find({ customerId: actor.id })
    .select({ status: 1 })
    .lean<{ status: BookingStatus }[]>();

  const counts: Record<BookingTab, number> = {
    upcoming: 0,
    ongoing: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    for (const tab of Object.keys(TAB_STATUSES) as BookingTab[]) {
      if (TAB_STATUSES[tab].includes(row.status)) counts[tab] += 1;
    }
  }
  res.json(counts);
});

/**
 * The one booking worth putting at the top of the home screen.
 *
 * A customer with a pro on the way does not want to browse a catalogue. A job
 * in progress outranks one merely assigned — the pro is on site now — and
 * within a status the soonest wins.
 */
consumerBookingRouter.get("/active", async (req, res) => {
  const actor = actorOf(req);
  const live = await Booking.find({
    customerId: actor.id,
    status: { $in: ["pending", "assigned", "in_progress"] },
  }).lean<BookingDoc[]>();

  if (live.length === 0) {
    res.json(null);
    return;
  }

  const rank: Record<string, number> = {
    in_progress: 0,
    assigned: 1,
    pending: 2,
  };
  const [first] = [...live].sort((a, b) => {
    const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    return a.scheduledAt.getTime() - b.scheduledAt.getTime();
  });

  if (!first) {
    res.json(null);
    return;
  }
  const [withPro] = await attachPro([projectBooking(first)], [first]);
  res.json(withPro ?? null);
});

/**
 * Services this customer has booked before, for "Book again".
 *
 * Completed only — offering to re-book something cancelled, or happening right
 * now, is noise. De-duplicated by service so a monthly clean appears once.
 */
consumerBookingRouter.get("/rebookable", async (req, res) => {
  const actor = actorOf(req);
  const rows = await Booking.find({
    customerId: actor.id,
    status: "completed",
  })
    .sort({ scheduledAt: -1 })
    .lean<BookingDoc[]>();

  const seen = new Set<string>();
  const out: { serviceName: string; lastBookedAt: string; totalPaise: number }[] =
    [];
  for (const b of rows) {
    if (seen.has(b.serviceName)) continue;
    seen.add(b.serviceName);
    out.push({
      serviceName: b.serviceName,
      lastBookedAt: b.scheduledAt.toISOString(),
      totalPaise: b.breakdown.totalPaise,
    });
  }

  res.json(out);
});

/**
 * One booking. Accepts an id or a reference.
 *
 * Scoped to the caller: a booking belonging to someone else is a 404, not a
 * 403. Telling an attacker "that exists but is not yours" is more than they
 * need to know.
 */
consumerBookingRouter.get("/:id", async (req, res) => {
  const actor = actorOf(req);
  const { id } = req.params;

  const found = await Booking.findOne({
    customerId: actor.id,
    $or: [{ _id: id }, { reference: id }],
  }).lean<BookingDoc>();

  if (!found) throw notFound("That booking could not be found.");
  const [withPro] = await attachPro([projectBooking(found)], [found]);
  res.json(withPro);
});

/**
 * Cancels a booking. Customer 26.
 *
 * **No cancellation fee is charged**, because the agreement documents no
 * cancellation policy — `CONSUMER-OPEN-ITEMS.md` 1.1 and §7.2 both record it as
 * outstanding. A fee invented here would be a developer setting commercial
 * terms. A wallet booking is refunded in full for the same reason.
 */
consumerBookingRouter.post("/:id/cancel", async (req, res) => {
  const actor = actorOf(req);
  const { id } = req.params;

  const booking = await Booking.findOne({
    customerId: actor.id,
    $or: [{ _id: id }, { reference: id }],
  }).lean<BookingDoc>();
  if (!booking) throw notFound("That booking could not be found.");

  if (!canTransition(booking.status, "cancelled")) {
    throw conflict(
      booking.status === "cancelled"
        ? "That booking is already cancelled."
        : "A completed booking cannot be cancelled.",
      "BAD_TRANSITION",
    );
  }

  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        status: "cancelled",
        // A code for a job that is not happening is a code that leaks.
        completionOtp: null,
      },
      $push: {
        events: {
          at: new Date(),
          label: "Cancelled by you",
          actor: booking.customerName || "Customer",
        },
      },
    },
  );

  // Paid from the wallet, so the money goes back. A compensating credit, never
  // an edit of the original debit — see models/wallet.ts.
  if (booking.paymentMethod === "wallet" && booking.paid) {
    await WalletEntry.create({
      _id: newId("wtx"),
      customerId: actor.id,
      kind: "refund",
      label: `Refund — ${booking.serviceName}`,
      amountPaise: booking.breakdown.totalPaise,
      bookingReference: booking.reference,
      status: "completed",
    });
  }

  if (booking.couponCode) await releaseCoupon(booking.couponCode);

  res.status(204).end();
});
