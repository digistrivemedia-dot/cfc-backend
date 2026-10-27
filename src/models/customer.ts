import { Schema, model } from "mongoose";

/**
 * A customer. Customer 16, 17, 33, 34.
 *
 * Addresses are **embedded**, not their own collection: they are only ever read
 * with their owner, there are a handful per customer, and a booking takes a
 * frozen copy rather than a reference. A separate collection would buy a join
 * and nothing else.
 */

export interface AddressSub {
  id: string;
  label: "home" | "work" | "other";
  line1: string;
  line2?: string;
  landmark?: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  lat: number;
  lng: number;
  /**
   * Whether `lat`/`lng` came from a real geocode.
   *
   * **False for everything today.** Geocoding needs the Google Maps key, which
   * is outstanding (§7.1), and the address form currently sends a hardcoded
   * `{ lat: 12.9716, lng: 77.5946 }` — Bengaluru — for every address on a
   * Trichy platform.
   *
   * This flag exists so Phase 6 dispatch can tell the difference. Matching
   * "3 nearest pros" against coordinates that are identical and wrong for every
   * customer would produce a confident, meaningless ordering; with this, it
   * falls back to area matching until the coordinates are real.
   *
   * `ponytail:` area-based dispatch while this is false. Set it true at the
   * point a geocode succeeds, and distance ordering starts working with no
   * other change.
   */
  locationVerified: boolean;
  isDefault: boolean;
}

const addressSchema = new Schema<AddressSub>(
  {
    id: { type: String, required: true },
    label: { type: String, required: true, enum: ["home", "work", "other"] },
    line1: { type: String, required: true, trim: true },
    line2: { type: String, trim: true },
    landmark: { type: String, trim: true },
    area: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    locationVerified: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

export interface CustomerDoc {
  _id: string;
  /** E.164. The login identity, so it is unique. */
  phone: string;
  name: string;
  /** Where they mostly are. Shown in the app shell as their chosen area. */
  area: string;
  avatarPath?: string;
  addresses: AddressSub[];
  blocked: boolean;
  blockedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<CustomerDoc>(
  {
    _id: { type: String },
    phone: { type: String, required: true, unique: true },
    name: { type: String, default: "", trim: true },
    area: { type: String, default: "", trim: true },
    avatarPath: { type: String },
    addresses: { type: [addressSchema], default: [] },
    blocked: { type: Boolean, default: false },
    blockedReason: { type: String, trim: true },
  },
  { timestamps: true, versionKey: false },
);

export const Customer = model<CustomerDoc>("Customer", customerSchema);

/**
 * Exactly one address is the default.
 *
 * Returns the list with that enforced. Zero defaults means the booking flow
 * pre-selects nothing and the customer sees an empty address field; two means
 * which one wins depends on array order. Applied on write rather than trusted,
 * because the UI maintains the invariant and a direct API caller will not.
 */
export function normaliseDefaults(addresses: AddressSub[]): AddressSub[] {
  if (addresses.length === 0) return addresses;

  const defaults = addresses.filter((a) => a.isDefault);
  if (defaults.length === 1) return addresses;

  const chosen = defaults[0] ?? addresses[0];
  return addresses.map((a) => ({ ...a, isDefault: a.id === chosen?.id }));
}
