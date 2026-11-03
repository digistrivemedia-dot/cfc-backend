import { Router } from "express";
import type { Actor } from "@cfc/types";
import { badRequest, forbidden, notFound } from "../../error";
import { signToken } from "../../auth/token";
import { normalisePhone, sendOtp, verifyOtp } from "../../auth/otp";
import { Customer, type AddressSub, type CustomerDoc } from "../../models/customer";
import { Booking } from "../../models/booking";
import { walletBalance } from "../../models/wallet";
import { newId } from "../../models/id";
import { actorOf, requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import { getSettings } from "../../models/settings";
import { PUBLIC_PREFIX } from "../../uploads";

/**
 * Customer auth and profile. Customer 3, 4, 33, 34.
 *
 * The counterpart to the pro flow, and deliberately simpler: a customer signs
 * in and is **immediately usable**. There is no approval step, so the account
 * is created on first successful OTP rather than by a separate registration
 * call — asking someone to fill a form before they can browse is a step the
 * 3-click booking target cannot afford.
 */
export const consumerAuthRouter = Router();

function customerActor(req: Parameters<typeof actorOf>[0]): Actor {
  const actor = actorOf(req);
  if (actor.role !== "customer") throw forbidden();
  return actor;
}

async function loadCustomer(id: string): Promise<CustomerDoc> {
  const found = await Customer.findById(id).lean<CustomerDoc>();
  if (!found) throw notFound("That account no longer exists.");
  return found;
}

consumerAuthRouter.post(
  "/otp/send",
  rateLimit({
    windowSeconds: 15 * 60,
    max: 5,
    relaxedWhenDummyOtp: true,
    keyOf: (req) => {
      const phone = (req.body as { phone?: unknown } | undefined)?.phone;
      return `${req.ip ?? "unknown"}|${typeof phone === "string" ? phone : ""}`;
    },
    message: "Too many code requests. Please wait before trying again.",
  }),
  async (req, res) => {
    const phone = normalisePhone((req.body as { phone?: unknown })?.phone);
    res.json(await sendOtp(phone, "customer"));
  },
);

/**
 * Verifies the code and signs the customer in, creating the account if new.
 *
 * `isNewUser` drives whether the app shows onboarding. It is reported from
 * whether a record existed, not guessed.
 */
consumerAuthRouter.post(
  "/otp/verify",
  rateLimit({ windowSeconds: 15 * 60, max: 10, relaxedWhenDummyOtp: true }),
  async (req, res) => {
    const phone = normalisePhone((req.body as { phone?: unknown })?.phone);
    await verifyOtp(phone, "customer", (req.body as { code?: unknown })?.code);

    let customer = await Customer.findOne({ phone }).lean<CustomerDoc>();
    const isNewUser = customer === null;

    if (!customer) {
      const created = await Customer.create({
        _id: newId("cust"),
        phone,
        name: "",
        area: "",
      });
      customer = created.toObject() as CustomerDoc;
    }

    // A blocked customer is refused at sign-in rather than allowed in to find
    // every action failing one at a time.
    if (customer.blocked) {
      throw forbidden(
        "This account has been suspended. Please contact support.",
      );
    }

    const actor: Actor = {
      id: customer._id,
      name: customer.name,
      role: "customer",
    };

    res.json({ token: signToken(actor), isNewUser });
  },
);

/**
 * The signed-in customer's own profile. Customer 33.
 *
 * `walletPaise` and `totalBookings` are **computed**, not stored: the wallet
 * balance is a sum of the ledger (see models/wallet.ts) and the booking count
 * is a count. A stored copy of either is a second source that drifts.
 */
consumerAuthRouter.get("/me", requireAuth, async (req, res) => {
  const actor = customerActor(req);
  res.json(await projectProfile(await loadCustomer(actor.id)));
});

/**
 * Customer 34 — saving edited details.
 *
 * **The phone number is deliberately absent.** It is the login identity, and
 * changing it is an OTP flow of its own rather than a text field on a profile
 * form — otherwise anyone with a borrowed session takes the account.
 */
consumerAuthRouter.patch("/me", requireAuth, async (req, res) => {
  const actor = customerActor(req);
  const customer = await loadCustomer(actor.id);

  const body = (req.body ?? {}) as { name?: unknown; area?: unknown };
  const patch: Record<string, unknown> = {};

  if (typeof body.name === "string" && body.name.trim() !== "") {
    patch["name"] = body.name.trim();
  }
  if (typeof body.area === "string" && body.area.trim() !== "") {
    patch["area"] = body.area.trim();
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest("Nothing to update.", "EMPTY_PATCH");
  }

  await Customer.updateOne({ _id: customer._id }, { $set: patch });
  res.json(await projectProfile(await loadCustomer(customer._id)));
});

/**
 * The `ConsumerProfile` shape, from a record.
 *
 * One projection used by both the read and the update, so the two responses are
 * interchangeable and a screen never has to merge two shapes of the same thing.
 */
export async function projectProfile(customer: CustomerDoc) {
  const [walletPaise, totalBookings, { servicePincodes }] = await Promise.all([
    walletBalance(customer._id),
    Booking.countDocuments({ customerId: customer._id }),
    getSettings(),
  ]);

  return {
    id: customer._id,
    name: customer.name,
    phone: customer.phone,
    area: customer.area,
    avatarUrl: customer.avatarPath
      ? `${PUBLIC_PREFIX}/${customer.avatarPath}`
      : undefined,
    walletPaise,
    totalBookings,
    joinedAt: customer.createdAt.toISOString(),
    addresses: customer.addresses.map((a) => projectAddress(a, servicePincodes)),
  };
}

/**
 * One address, as a customer's app sees it.
 *
 * `servicePincodes` is passed in rather than read here, so a list of addresses
 * costs one settings read instead of one per address. Omitted leaves
 * `serviceable` undefined, which the screens read as "not known" rather than
 * as `false` — reporting an address unserviceable because nobody looked is the
 * one wrong answer available.
 */
export function projectAddress(a: AddressSub, servicePincodes?: string[]) {
  return {
    id: a.id,
    label: a.label,
    labelName: a.labelName,
    flatNumber: a.flatNumber,
    line1: a.line1,
    line2: a.line2,
    landmark: a.landmark,
    area: a.area,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    contactName: a.contactName,
    contactPhone: a.contactPhone,
    point: { lat: a.lat, lng: a.lng },
    locationVerified: a.locationVerified,
    /**
     * Whether CFC operates here — **by pincode, not by area name.**
     *
     * The name test was wrong in a way that only shows up with a real
     * geocoder: OSM returns the area CFC calls "Thillai Nagar" as "Trichy Zone
     * IV", so an address inside a serviced area read as unserviceable. A
     * pincode is official, fixed, and comes back identically from every
     * provider.
     */
    ...(servicePincodes
      ? { serviceable: servicePincodes.includes(a.pincode.trim()) }
      : {}),
    isDefault: a.isDefault,
  };
}
