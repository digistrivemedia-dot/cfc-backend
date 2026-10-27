import { Router } from "express";
import { badRequest, conflict, forbidden, notFound } from "../../error";
import {
  Customer,
  normaliseDefaults,
  type AddressSub,
  type CustomerDoc,
} from "../../models/customer";
import { Booking } from "../../models/booking";
import { newId } from "../../models/id";
import { actorOf, requireAuth } from "../../middleware/auth";
import { projectAddress } from "./auth";

/**
 * Customer 16, 17 — saved addresses.
 *
 * Addresses are embedded on the customer, so every route here is a read or an
 * array update on one document. The customer id comes from the token on every
 * one of them: there is no `customerId` parameter to tamper with.
 */
export const consumerAddressRouter = Router();

consumerAddressRouter.use(requireAuth, (req, _res, next) => {
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

function str(body: unknown, field: string, label: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${label} is required.`, "MISSING_FIELD");
  }
  return value.trim();
}

function optionalStr(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Reads the address off a request.
 *
 * The pincode is checked for shape only — six digits beginning 1–9. Verifying
 * that a pincode actually exists, and that it matches the area, needs the Maps
 * geocoder which is still outstanding (§7.1). A format check is honest about
 * what it knows; claiming validation it cannot do would be worse.
 */
function readAddress(body: unknown, id: string): AddressSub {
  const label = (body as { label?: unknown })?.label;
  if (label !== "home" && label !== "work" && label !== "other") {
    throw badRequest("Choose a label for this address.", "BAD_LABEL");
  }

  const pincode = str(body, "pincode", "Pincode");
  if (!/^[1-9]\d{5}$/.test(pincode)) {
    throw badRequest("An Indian pincode is six digits.", "BAD_PINCODE");
  }

  const point = (body as { point?: unknown })?.point as
    | { lat?: unknown; lng?: unknown }
    | undefined;
  const lat = typeof point?.lat === "number" ? point.lat : 0;
  const lng = typeof point?.lng === "number" ? point.lng : 0;

  return {
    id,
    label,
    line1: str(body, "line1", "Address line 1"),
    ...(optionalStr(body, "line2") !== undefined
      ? { line2: optionalStr(body, "line2") as string }
      : {}),
    ...(optionalStr(body, "landmark") !== undefined
      ? { landmark: optionalStr(body, "landmark") as string }
      : {}),
    area: str(body, "area", "Area"),
    city: str(body, "city", "City"),
    state: str(body, "state", "State"),
    pincode,
    lat,
    lng,
    // Always false for now: nothing geocodes yet, and the address form sends a
    // hardcoded Bengaluru coordinate for every address. See the field's note on
    // the Customer model — Phase 6 dispatch reads this to decide whether
    // distance ordering means anything.
    locationVerified: false,
    isDefault: Boolean((body as { isDefault?: unknown })?.isDefault),
  };
}

consumerAddressRouter.get("/", async (req, res) => {
  const customer = await loadCustomer(actorOf(req).id);
  res.json(customer.addresses.map(projectAddress));
});

/**
 * Adds or replaces an address.
 *
 * One route for both, matching `saveAddress` in the mock layer: a caller
 * editing an existing address passes its id back. Keeping them as one endpoint
 * means the screen has one call and one error path.
 */
consumerAddressRouter.put("/", async (req, res) => {
  const customer = await loadCustomer(actorOf(req).id);

  const existingId = optionalStr(req.body, "id");
  const isEdit =
    existingId !== undefined &&
    customer.addresses.some((a) => a.id === existingId);

  if (existingId !== undefined && !isEdit) {
    // An id that matches nothing is a stale screen, not a new address — saving
    // it as new would quietly duplicate the record they thought they edited.
    throw notFound("That address no longer exists.");
  }

  const address = readAddress(req.body, existingId ?? newId("addr"));

  const next = isEdit
    ? customer.addresses.map((a) => (a.id === address.id ? address : a))
    : [...customer.addresses, address];

  // The first address a customer saves is their default whatever they ticked —
  // otherwise the booking flow has nothing pre-selected and shows a blank.
  const withDefault =
    next.length === 1 ? next.map((a) => ({ ...a, isDefault: true })) : next;

  await Customer.updateOne(
    { _id: customer._id },
    { $set: { addresses: normaliseDefaults(withDefault) } },
  );

  const updated = await loadCustomer(customer._id);
  const saved = updated.addresses.find((a) => a.id === address.id);
  res.status(isEdit ? 200 : 201).json(saved ? projectAddress(saved) : null);
});

/**
 * Deletes an address.
 *
 * **Refused while a live booking still points at it.** The address on a booking
 * is a frozen copy, so history survives either way — but a customer with a pro
 * arriving tomorrow who deletes the address would be left with no way to see
 * where they said the job was. Completed bookings are no obstacle.
 */
consumerAddressRouter.delete("/:id", async (req, res) => {
  const customer = await loadCustomer(actorOf(req).id);
  const { id } = req.params;

  const target = customer.addresses.find((a) => a.id === id);
  if (!target) throw notFound("That address no longer exists.");

  const live = await Booking.countDocuments({
    customerId: customer._id,
    "address.id": id,
    status: { $in: ["pending", "assigned", "in_progress"] },
  });
  if (live > 0) {
    throw conflict(
      `That address is used by ${live} booking${live === 1 ? "" : "s"} still to happen.`,
      "ADDRESS_IN_USE",
    );
  }

  const remaining = customer.addresses.filter((a) => a.id !== id);

  // Deleting the default promotes the first survivor, so the customer is never
  // left with addresses and none of them selected.
  const withDefault =
    target.isDefault && remaining.length > 0
      ? remaining.map((a, i) => ({ ...a, isDefault: i === 0 }))
      : remaining;

  await Customer.updateOne(
    { _id: customer._id },
    { $set: { addresses: normaliseDefaults(withDefault) } },
  );

  res.status(204).end();
});
