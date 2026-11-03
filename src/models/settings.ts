import { Schema, model } from "mongoose";

/**
 * Platform configuration — one document, ever.
 *
 * This is the collection §5 of BACKEND-PLAN.md calls for: the single source for
 * the 17 facts that different screens currently state differently. Stage C adds
 * the rest of those fields and the Admin 47 editor; Stage A creates the
 * document and `serviceAreas`, which is the first value to leave the fixtures.
 *
 * A singleton rather than key-value rows: the whole point is that one read
 * gives a screen every value it needs, and the fields are a fixed, known set
 * rather than anything a caller invents.
 */

export interface SettingsDoc {
  /** Always "platform". The singleton guard — a second document cannot exist. */
  _id: string;

  /**
   * Where CFC operates. Admin-editable, empty until an admin sets it.
   *
   * Deliberately starts empty rather than seeded with the fixtures' ten Trichy
   * localities. `PLATFORM-FACTS.md` forbids stating any city as the product's
   * scope, and an operating-area list is exactly that claim — so it is the
   * client's to make, through the admin panel, not ours to default.
   */
  serviceAreas: string[];

  /**
   * The pincodes CFC will accept a booking from. **The authority on coverage.**
   *
   * Area *names* were the test before this, and they were the wrong unit: the
   * name has to survive a round trip through a geocoder, and OSM returns the
   * area CFC calls "Thillai Nagar" as "Trichy Zone IV" — so an address in a
   * serviced area read as unserviceable. A pincode is a fixed, official
   * identifier that every geocoder returns the same way and every customer
   * already knows.
   *
   * `serviceAreas` stays, for labels, filters and the registration list. It is
   * no longer what decides whether a booking is allowed.
   */
  servicePincodes: string[];

  /**
   * How far ahead a customer may book, in days.
   *
   * §7.2 lists this as a guess — the agreement does not state it. Config rather
   * than a literal so the client's answer is a settings change, not a deploy.
   */
  bookingHorizonDays: number;

  /**
   * Arrival-window length in minutes, and the hours slots are offered between.
   *
   * Also §7.2 guesses: two-hour windows from 08:00 to 20:00 were assumed during
   * the frontend build. Same reasoning — configurable, not hardcoded.
   */
  slotMinutes: number;
  slotStartHour: number;
  slotEndHour: number;

  /**
   * How close a pro must be to mark a job complete, in metres.
   *
   * The agreement says 100 m. **Config, not a literal**, for a reason §7.2
   * records: browser GPS is materially less accurate than native, so the figure
   * that works on a phone app may be too tight in a PWA. The client can widen
   * it without a deploy once there is field evidence.
   */
  gpsLimitMetres: number;

  /**
   * The smallest payout a pro may request, in paise.
   *
   * **Zero, and that is deliberate.** The inventory asks for a "minimum
   * threshold" and the agreement never states one (§7.2, `PRO-OPEN-ITEMS` 1.2),
   * so no figure is invented: zero means no threshold is shown. A screen saying
   * "minimum ₹500" the client never agreed to is a commitment made by a
   * developer.
   */
  payoutMinimumPaise: number;

  /**
   * §5 — the facts that different screens currently state differently.
   *
   * `final/CONSUMER.md` §13 lists 17 of them, and a customer can see every
   * one: the support number is `+91 90000 12345` in one place and
   * `1800 XXX 4567` in another; hours are 9–9, 7–11 and 7–9 depending on the
   * screen. They recur because there is no single source, so each becomes a
   * field here and every screen reads it.
   *
   * **Every one defaults to empty.** The real values are §7.1 items the client
   * has not supplied, and a plausible-looking default is worse than a blank:
   * a wrong support number is one a customer actually rings. A screen with an
   * empty value hides the row; a screen with a fabricated one lies.
   */
  supportPhone: string;
  supportHours: string;
  supportEmail: string;

  /**
   * The legal name, used in invoices and the footer.
   *
   * Three spellings are currently in use — "City Family Care",
   * "CityFamilyCare", "CityFamilyCare Services Pvt Ltd". A tax invoice has to
   * carry exactly one.
   */
  brandName: string;

  /** GSTIN and registered address for the tax invoice. §7.1. */
  gstin: string;
  registeredAddress: string;

  /**
   * Fallback warranty when a service does not set its own.
   *
   * `warrantyDays` already exists per service. This is the default a new
   * service starts from, not an override — the screens claiming a flat
   * "30-day warranty" everywhere are the contradiction being fixed.
   */
  warrantyDefaultDays: number;

  /**
   * The cancellation policy, in the client's words, and its fee.
   *
   * **No policy exists anywhere today** (§7.2) — one screen says "free more
   * than 2 hours ahead", another says no policy is stated on purpose, and the
   * legal page has headings only. The fee stays at zero until the client sets
   * one: charging a cancellation fee nobody agreed to is money taken without
   * a basis.
   */
  cancellationPolicy: string;
  cancellationFeePaise: number;

  updatedAt: Date;
}

const settingsSchema = new Schema<SettingsDoc>(
  {
    _id: { type: String, default: "platform" },
    serviceAreas: { type: [String], default: [] },
    servicePincodes: { type: [String], default: [] },
    bookingHorizonDays: { type: Number, default: 30 },
    slotMinutes: { type: Number, default: 120 },
    slotStartHour: { type: Number, default: 8 },
    slotEndHour: { type: Number, default: 20 },
    gpsLimitMetres: { type: Number, default: 100 },
    payoutMinimumPaise: { type: Number, default: 0 },
    supportPhone: { type: String, default: "" },
    supportHours: { type: String, default: "" },
    supportEmail: { type: String, default: "" },
    brandName: { type: String, default: "" },
    gstin: { type: String, default: "" },
    registeredAddress: { type: String, default: "" },
    warrantyDefaultDays: { type: Number, default: 30 },
    cancellationPolicy: { type: String, default: "" },
    cancellationFeePaise: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
);

export const Settings = model<SettingsDoc>("Settings", settingsSchema);

export const SETTINGS_ID = "platform";

/**
 * Reads the singleton, creating it on first call.
 *
 * Upsert rather than a read that can return null, so no caller has to handle
 * "the platform has no configuration" — a state that is never meaningful and
 * would otherwise need a guard at every call site.
 */
export async function getSettings(): Promise<SettingsDoc> {
  const doc = await Settings.findOneAndUpdate(
    { _id: SETTINGS_ID },
    { $setOnInsert: { serviceAreas: [] } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<SettingsDoc>();

  // Defaults are filled in here, not relied on from the schema.
  //
  // `$setOnInsert` only applies to a document that did not exist, and `lean()`
  // returns the raw document without Mongoose applying schema defaults. So a
  // settings document written before a field was added comes back with that
  // field `undefined` — which is how `slotStartHour` arrived as undefined and
  // the slot grid rendered zero windows for every service.
  //
  // Merging defaults on read means an added field works immediately against an
  // existing database, with no migration step for anyone to forget.
  return {
    _id: SETTINGS_ID,
    serviceAreas: doc?.serviceAreas ?? [],
    servicePincodes: doc?.servicePincodes ?? [],
    bookingHorizonDays: doc?.bookingHorizonDays ?? 30,
    slotMinutes: doc?.slotMinutes ?? 120,
    supportPhone: doc?.supportPhone ?? "",
    supportHours: doc?.supportHours ?? "",
    supportEmail: doc?.supportEmail ?? "",
    brandName: doc?.brandName ?? "",
    gstin: doc?.gstin ?? "",
    registeredAddress: doc?.registeredAddress ?? "",
    warrantyDefaultDays: doc?.warrantyDefaultDays ?? 30,
    cancellationPolicy: doc?.cancellationPolicy ?? "",
    cancellationFeePaise: doc?.cancellationFeePaise ?? 0,
    slotStartHour: doc?.slotStartHour ?? 8,
    slotEndHour: doc?.slotEndHour ?? 20,
    gpsLimitMetres: doc?.gpsLimitMetres ?? 100,
    payoutMinimumPaise: doc?.payoutMinimumPaise ?? 0,
    updatedAt: doc?.updatedAt ?? new Date(),
  };
}
