import { Schema, model } from "mongoose";
import { newId } from "./id";

/**
 * Customer 39 and Pro 29 — the notification list behind the bell.
 *
 * **One collection for both audiences.** A customer notification and a pro
 * notification differ only in their `kind` vocabulary and where they link;
 * two collections would mean two queries, two mark-read endpoints and two
 * chances for the unread badge to disagree with the list under it.
 *
 * ## This is the record, not the delivery
 *
 * FCM, SMS and WhatsApp are *channels* that will read from here. They are not
 * replacements for it: a push that arrives while the phone is off is gone, and
 * the pro still has to be able to open the app and see what happened. So the
 * row is written first and always, and a channel failing later cannot lose it.
 *
 * ## Written where the event happens, never on read
 *
 * Every row is emitted by the thing that caused it — dispatch, completion, a
 * quotation decision, a payout, a warning. Deriving notifications at read time
 * from the current state is the alternative, and it cannot represent "your
 * quotation was approved **and then** the customer accepted it": state has one
 * value, a history has many.
 */

export type NotificationRole = "customer" | "pro";

export interface NotificationDoc {
  _id: string;
  recipientRole: NotificationRole;
  recipientId: string;

  /**
   * `booking | quotation | offer | reminder` for a customer;
   * `job | payout | quotation | announcement | warning` for a pro.
   *
   * Kept as a loose string rather than a union of both sets: the two
   * vocabularies belong to their own audiences, and the route that reads them
   * already knows which it is asking for.
   */
  kind: string;

  title: string;
  body: string;
  /** Where tapping it goes. Null only when there is genuinely nowhere. */
  href: string | null;
  read: boolean;
  at: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    _id: { type: String },
    recipientRole: { type: String, required: true, enum: ["customer", "pro"] },
    recipientId: { type: String, required: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    href: { type: String, default: null },
    read: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

/** The list query: one recipient, newest first, optionally one kind. */
notificationSchema.index({ recipientId: 1, at: -1 });
/** The badge: unread for one recipient, without scanning their history. */
notificationSchema.index({ recipientId: 1, read: 1 });

export const Notification = model<NotificationDoc>(
  "Notification",
  notificationSchema,
);

/**
 * Emit one notification.
 *
 * **Never throws into the caller.** A notification is a side effect of
 * something that already succeeded — a job was assigned, a payout approved —
 * and a failure to write the bell row must not roll back or 500 the thing
 * that actually mattered. It is logged and swallowed.
 *
 * That is a deliberate asymmetry with the rest of the system, where a failed
 * write is an error. Here the alternative is worse: a pro's completed job
 * failing because the notification collection hiccuped.
 */
export async function notify(input: {
  role: NotificationRole;
  to: string;
  kind: string;
  title: string;
  body?: string;
  href?: string | null;
}): Promise<void> {
  try {
    await Notification.create({
      _id: newId("ntf"),
      recipientRole: input.role,
      recipientId: input.to,
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      href: input.href ?? null,
      read: false,
      at: new Date(),
    });
  } catch (err) {
    console.error("[notify] could not write notification", {
      to: input.to,
      kind: input.kind,
      err,
    });
  }
}
