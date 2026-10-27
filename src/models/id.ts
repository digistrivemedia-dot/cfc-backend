import { randomBytes } from "node:crypto";

/**
 * Readable, prefixed ids — `cat_3f8a1c2d`, `svc_90ab17ff`.
 *
 * Mongo's ObjectId would do the job, but these ids appear in URLs, in support
 * conversations and in the fixtures the frontend was built against
 * (`cat_01`, `svc_01`). A prefix makes a stray id self-describing: an operator
 * pasting `svc_90ab17ff` into a ticket has said which collection it is in.
 *
 * Random rather than sequential. Sequential ids leak how many services or pros
 * exist, and `svc_000002` invites someone to try `svc_000003`.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}
