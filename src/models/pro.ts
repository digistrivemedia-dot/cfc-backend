import { Schema, model } from "mongoose";
import type { DocumentStatus, DocumentType, ProApprovalStatus } from "@cfc/types";
import { DOCUMENT_STATUSES, PRO_APPROVAL_STATUSES } from "@cfc/types";

/**
 * A service professional. Pro 2–9 (onboarding) and Admin 11–18 (management).
 *
 * The shape of this flow comes from one fact: **a pro signs up and then waits
 * for a human to approve them.** A customer signs in and is immediately usable;
 * a pro is not. That gap is why `approvalStatus` exists and why nothing here
 * issues a session that reaches the working screens before it is `approved`.
 */

export interface ProDocumentSub {
  type: DocumentType;
  /**
   * Path under the **private** upload root (§0.4). Never served statically and
   * never returned to a client as a URL — an Aadhaar on a guessable public URL
   * is a data-protection incident.
   */
  filePath: string;
  status: DocumentStatus;
  /**
   * Set only when `status` is `rejected`, and **derived from the status** rather
   * than stored independently.
   *
   * `PRO-OPEN-ITEMS.md` 4.7 records what independent fields produced: the
   * fixture drew two separate randoms, so some documents were rejected with no
   * reason and others approved while still carrying one. A pro reading either
   * has no idea what to do next.
   */
  rejectionReason?: string;
  uploadedAt: Date;
  reviewedAt?: Date;
}

const proDocumentSchema = new Schema<ProDocumentSub>(
  {
    type: {
      type: String,
      required: true,
      enum: ["aadhaar_front", "aadhaar_back", "pan", "selfie"],
    },
    filePath: { type: String, required: true },
    status: { type: String, required: true, enum: DOCUMENT_STATUSES, default: "pending" },
    rejectionReason: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
  },
  { _id: false },
);

export interface ProDoc {
  _id: string;
  /** E.164. The login identity, so it is unique. */
  phone: string;
  name: string;

  /**
   * Service **ids** from the catalogue, never free text.
   *
   * A pro typing "AC repair" against a catalogue entry named "AC service &
   * repair" matches zero jobs, and nobody finds out for a week. Ids make the
   * mismatch impossible.
   */
  serviceIds: string[];

  /**
   * Every area this pro will travel to.
   *
   * An **array**, which `ProListItem.area` in `@cfc/types` is not — the
   * registration form collects several and the old shape discarded all but the
   * first (`PRO-OPEN-ITEMS.md` 1.5). Dispatch in Phase 6 matches against all of
   * them. The single `area` the admin list shows is projected as the first.
   */
  areas: string[];

  bio: string;
  experienceYears: number;
  photoPath?: string;

  // -- onboarding progress ---------------------------------------------------
  /**
   * How far through Pro 3–8 this pro has got.
   *
   * `getApprovalState` drives which screen the `(auth)` group lands on, so this
   * is the authority on where someone resumes. A pro who abandoned at the bank
   * step should return to the bank step, not start again.
   */
  documents: ProDocumentSub[];
  bank?: {
    accountName: string;
    /** AES-256-GCM, see auth/secret-box.ts. Opened only to make a payout. */
    accountNumberSealed: string;
    /** The only part any screen shows. */
    accountLast4: string;
    ifsc: string;
    upiId?: string;
  };
  /** Pro 8 — with the exact wording version signed, not just a timestamp. */
  conduct?: { acceptedAt: Date; version: string };

  // -- review ----------------------------------------------------------------
  approvalStatus: ProApprovalStatus;
  /** Why the registration as a whole was rejected. Shown to the pro. */
  rejectionReason?: string;
  reviewedBy?: string;
  reviewedAt?: Date;

  /**
   * Blocked is separate from rejected, and deliberately so.
   *
   * Rejected means "we did not take you on"; blocked means "we did, and then
   * stopped you". Collapsing them would lose the distinction an operator needs
   * when a pro asks why they cannot work, and `pros.block` is a permission the
   * agreement does **not** delegate to a sub-admin while `pros.approve_kyc` is.
   */
  blocked: boolean;
  blockedReason?: string;

  // -- operational -----------------------------------------------------------
  /**
   * Offline is the default and it is not a UI preference.
   *
   * An online pro is in the dispatch pool. A pro who has not said they are
   * ready should not be alerted for a job they cannot take — which costs them a
   * penalty, not just an annoyance.
   */
  online: boolean;
  /** For the `2dsphere` dispatch query in Phase 6. GeoJSON order: [lng, lat]. */
  location?: { type: "Point"; coordinates: [number, number] };

  jobsCompleted: number;
  ratingSum: number;
  ratingCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const proSchema = new Schema<ProDoc>(
  {
    _id: { type: String },
    phone: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    serviceIds: { type: [String], default: [] },
    areas: { type: [String], default: [] },
    bio: { type: String, default: "", trim: true },
    experienceYears: { type: Number, default: 0 },
    photoPath: { type: String },

    documents: { type: [proDocumentSchema], default: [] },
    bank: {
      type: new Schema(
        {
          accountName: { type: String, required: true },
          accountNumberSealed: { type: String, required: true },
          accountLast4: { type: String, required: true },
          ifsc: { type: String, required: true },
          upiId: { type: String },
        },
        { _id: false },
      ),
      required: false,
    },
    conduct: {
      type: new Schema(
        {
          acceptedAt: { type: Date, required: true },
          version: { type: String, required: true },
        },
        { _id: false },
      ),
      required: false,
    },

    approvalStatus: {
      type: String,
      required: true,
      enum: PRO_APPROVAL_STATUSES,
      default: "pending",
      index: true,
    },
    rejectionReason: { type: String, trim: true },
    reviewedBy: { type: String },
    reviewedAt: { type: Date },

    blocked: { type: Boolean, default: false },
    blockedReason: { type: String, trim: true },

    online: { type: Boolean, default: false },
    location: {
      type: new Schema(
        {
          type: { type: String, enum: ["Point"], required: true },
          coordinates: { type: [Number], required: true },
        },
        { _id: false },
      ),
      required: false,
    },

    jobsCompleted: { type: Number, default: 0 },
    // Sum and count rather than a stored average: an average cannot be updated
    // without one of these, and a rating that disagrees with its own
    // distribution is the first thing anyone notices.
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

/** Dispatch: nearest matching pro. Phase 6 queries this with `$near`. */
proSchema.index({ location: "2dsphere" });

/** The admin list filters on these together. */
proSchema.index({ approvalStatus: 1, blocked: 1 });

export const Pro = model<ProDoc>("Pro", proSchema);

/** Average rating, or 0 when there are none. Never a stored field. */
export function ratingOf(pro: Pick<ProDoc, "ratingSum" | "ratingCount">): number {
  if (pro.ratingCount === 0) return 0;
  return Math.round((pro.ratingSum / pro.ratingCount) * 10) / 10;
}

/**
 * Is this pro allowed to receive job offers?
 *
 * One function, so the dispatch engine and the admin list cannot disagree.
 * `nextOffer` in the mock layer already refuses a blocked pro; the server has
 * to apply the same rule and this is where it lives.
 */
export function canReceiveOffers(pro: ProDoc): boolean {
  return pro.approvalStatus === "approved" && !pro.blocked;
}
