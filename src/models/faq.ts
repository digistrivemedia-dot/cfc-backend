import { Schema, model } from "mongoose";

/**
 * FAQs — Customer 12 (service detail), Customer 40 and Pro 31 (help screens).
 *
 * One collection with an **audience** and an optional service, rather than
 * three collections. The three screens ask slightly different questions of
 * the same content: "everything general plus this service's own", "everything
 * a customer might ask", "everything a pro might ask". That is a filter, not
 * three data sets.
 *
 * `serviceId: null` means the answer applies everywhere, which is most of
 * them — so a service with no questions of its own still shows a useful set
 * rather than an empty section.
 */

export type FaqAudience = "customer" | "pro";

export interface FaqDoc {
  _id: string;
  /** Who the question is written for. */
  audience: FaqAudience;
  /** Null means it applies to every service. */
  serviceId: string | null;
  question: string;
  answer: string;
  /** Lowest first, so the client controls the reading order. */
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const faqSchema = new Schema<FaqDoc>(
  {
    _id: { type: String },
    audience: {
      type: String,
      required: true,
      enum: ["customer", "pro"],
      default: "customer",
    },
    serviceId: { type: String, default: null, index: true },
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

faqSchema.index({ audience: 1, active: 1, sortOrder: 1 });

export const Faq = model<FaqDoc>("Faq", faqSchema);
