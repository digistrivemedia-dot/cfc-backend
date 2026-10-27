import { Schema, model } from "mongoose";
import type { Actor } from "@cfc/types";

/**
 * The audit log — who did what, when.
 *
 * Written on **every privileged action** from Phase 2 onward: approving a KYC,
 * overriding a booking status, changing a price, approving a payout, creating
 * an admin. The reference plan asks for it from the auth phase precisely so it
 * is never retrofitted — an audit trail that starts late has a gap exactly
 * where the first disputed action sits.
 *
 * Append-only by convention and by absence: nothing in this codebase updates or
 * deletes a row here, and there is no function that could. A correction is a
 * new entry.
 */

export interface AuditDoc {
  /** What happened, as a stable machine name: "pro.kyc.approved". */
  action: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  /** What it was done to — a pro id, a booking reference, a category id. */
  subject?: string;
  /**
   * Anything needed to understand the entry later: the old and new value, the
   * reason given, the amount. Deliberately loose — the shape differs per
   * action and a rigid schema would mean dropping the detail that matters.
   *
   * **Never a password, token or OTP.** Nothing that is a secret elsewhere
   * becomes loggable by being put in here.
   */
  detail?: Record<string, unknown>;
  ip?: string;
  at: Date;
}

const auditSchema = new Schema<AuditDoc>(
  {
    action: { type: String, required: true, index: true },
    actorId: { type: String, required: true, index: true },
    actorName: { type: String, required: true },
    actorRole: { type: String, required: true },
    subject: { type: String, index: true },
    detail: { type: Schema.Types.Mixed },
    ip: { type: String },
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

export const Audit = model<AuditDoc>("Audit", auditSchema);

/**
 * Records an action.
 *
 * **Never throws.** An audit write that failed must not turn a successful
 * approval into a 500 — the operator would retry, and the action would happen
 * twice. A failure here is logged loudly and swallowed, which is the lesser of
 * two bad outcomes.
 *
 * `ponytail:` a dropped audit row on a Mongo hiccup is accepted. If the client
 * needs a guaranteed trail, the action and its audit row have to share a
 * transaction — which means a replica set and a real cost, so it waits for them
 * to ask.
 */
export async function audit(
  actor: Actor,
  action: string,
  extra: { subject?: string; detail?: Record<string, unknown>; ip?: string } = {},
): Promise<void> {
  try {
    await Audit.create({
      action,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      ...extra,
      at: new Date(),
    });
  } catch (err) {
    console.error(`[audit] failed to record ${action}`, err);
  }
}
