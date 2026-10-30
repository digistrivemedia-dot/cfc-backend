import { Schema, model } from "mongoose";

/**
 * Admin 43–44, Customer 40–41, Pro 32 — support tickets.
 *
 * ## Internal notes live in the same thread
 *
 * `isInternal` marks a message only the office sees. Keeping those in the
 * same array as the customer's, rather than a separate collection, is what
 * makes the admin view a real conversation: an agent reads the complaint, the
 * internal note about what was found, and the reply, in the order they
 * happened. Two collections would have to be merged and sorted by every
 * caller, and the one that forgot would show an agent replying to nothing.
 *
 * **The cost is that stripping is mandatory on every customer-facing read.**
 * `publicMessages()` below is the only way messages should leave the server
 * toward a customer or a pro, and there is a self-check asserting an internal
 * note never appears in their response.
 */

export type TicketRole = "customer" | "pro";
export type TicketPriorityValue = "low" | "medium" | "high";
export type TicketStatusValue = "open" | "in_progress" | "resolved" | "closed";

export interface TicketMessageSub {
  id: string;
  author: string;
  /** True for an office-only note. Never leaves the server to the raiser. */
  isInternal: boolean;
  body: string;
  sentAt: Date;
}

export interface TicketDoc {
  _id: string;
  subject: string;

  /** Who raised it. The id is the token's, never a field in the request. */
  fromId: string;
  fromName: string;
  fromRole: TicketRole;

  priority: TicketPriorityValue;
  status: TicketStatusValue;

  /** The admin's display name, or null while unassigned. */
  assignedTo: string | null;
  assignedToId: string | null;

  messages: TicketMessageSub[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<TicketMessageSub>(
  {
    id: { type: String, required: true },
    author: { type: String, required: true },
    isInternal: { type: Boolean, default: false },
    body: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ticketSchema = new Schema<TicketDoc>(
  {
    _id: { type: String },
    subject: { type: String, required: true, trim: true },
    fromId: { type: String, required: true, index: true },
    fromName: { type: String, required: true },
    fromRole: { type: String, required: true, enum: ["customer", "pro"] },
    priority: {
      type: String,
      required: true,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    status: {
      type: String,
      required: true,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
    },
    assignedTo: { type: String, default: null },
    assignedToId: { type: String, default: null },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

/** The queue: newest activity first, filtered by status. */
ticketSchema.index({ status: 1, updatedAt: -1 });
/** One person's own tickets. */
ticketSchema.index({ fromId: 1, updatedAt: -1 });

export const Ticket = model<TicketDoc>("Ticket", ticketSchema);

/**
 * The messages a customer or pro may see.
 *
 * **Always use this on a non-admin read.** An internal note reaching the
 * person it is about is the one failure this whole model has to prevent —
 * agents write things like "this customer has disputed three bookings" in
 * them.
 */
export function publicMessages(doc: TicketDoc): TicketMessageSub[] {
  return doc.messages.filter((m) => !m.isInternal);
}
