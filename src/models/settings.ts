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

  updatedAt: Date;
}

const settingsSchema = new Schema<SettingsDoc>(
  {
    _id: { type: String, default: "platform" },
    serviceAreas: { type: [String], default: [] },
    bookingHorizonDays: { type: Number, default: 30 },
    slotMinutes: { type: Number, default: 120 },
    slotStartHour: { type: Number, default: 8 },
    slotEndHour: { type: Number, default: 20 },
    gpsLimitMetres: { type: Number, default: 100 },
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
    bookingHorizonDays: doc?.bookingHorizonDays ?? 30,
    slotMinutes: doc?.slotMinutes ?? 120,
    slotStartHour: doc?.slotStartHour ?? 8,
    slotEndHour: doc?.slotEndHour ?? 20,
    gpsLimitMetres: doc?.gpsLimitMetres ?? 100,
    updatedAt: doc?.updatedAt ?? new Date(),
  };
}
