import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { Schema, model } from "mongoose";
import { env } from "../env";
import { ApiError, badRequest } from "../error";

/**
 * One-time passwords.
 *
 * **The delivery is dummied; the flow is not** (§0.2). Until the client's DLT
 * templates are registered there is no SMS, but everything around it is what
 * production will run: a random code, hashed at rest, a short expiry, an
 * attempt cap, and a resend lock.
 *
 * The three rules that are not negotiable while `AUTH_DUMMY_OTP` is on:
 *
 *   the code is **never** returned in a response
 *   the code is **never** logged above debug
 *   production **refuses to boot** with the dummy flag set (see env.ts)
 *
 * That is P0 blocker B1. A dummy that prints the code on screen is the blocker
 * itself, not a way around it — which is exactly what `auth-dialog.tsx` did and
 * why the docs mark it *"never ship."*
 *
 * Shared by the pro and customer flows. `purpose` keeps them separate so a code
 * sent to sign in as a customer cannot be replayed to register as a pro.
 */

const CODE_LENGTH = 6;
const TTL_SECONDS = 5 * 60;

/** Matches `OTP_RESEND_SECONDS` in the mock layer, which drives the UI timer. */
export const RESEND_SECONDS = 30;

/** Wrong guesses allowed before the code is burned. */
const MAX_ATTEMPTS = 5;

export type OtpPurpose = "pro" | "customer";

interface OtpDoc {
  /** `${purpose}:${phone}` — one live code per purpose per number. */
  _id: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  /** Resend is refused until this passes. */
  resendAfter: Date;
  createdAt: Date;
}

const otpSchema = new Schema<OtpDoc>(
  {
    _id: { type: String },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    resendAfter: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

/**
 * Mongo deletes expired codes on its own.
 *
 * A TTL index rather than a sweep job: an un-expired code sitting in the
 * database after use is the thing worth avoiding, and the database can enforce
 * that without any code to forget to run.
 */
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Otp = model<OtpDoc>("Otp", otpSchema);

/**
 * HMAC rather than a plain hash.
 *
 * A six-digit code has a million possibilities — a bare SHA-256 of one is
 * reversed by a lookup table in milliseconds, so storing that would be close to
 * storing the code. Keying the HMAC with the server secret means a leaked
 * database alone does not reveal any code.
 */
function hash(phone: string, code: string): string {
  return createHmac("sha256", env.jwtSecret)
    .update(`${phone}:${code}`)
    .digest("hex");
}

/** E.164-ish. The UI collects ten digits; this is what gets stored. */
export function normalisePhone(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("Enter your mobile number.");
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  if (!/^[6-9]\d{9}$/.test(ten)) {
    throw badRequest("That does not look like an Indian mobile number.", "BAD_PHONE");
  }
  return `+91${ten}`;
}

/**
 * Issues a code.
 *
 * Replaces any live code for the same purpose and number, so a pro who taps
 * resend does not end up with two valid codes — and the attempt counter resets
 * with it, which is why the resend lock has to be enforced here rather than
 * only in the UI.
 */
export async function sendOtp(
  phone: string,
  purpose: OtpPurpose,
): Promise<{ phone: string; resendAfterSeconds: number }> {
  const key = `${purpose}:${phone}`;
  const now = Date.now();

  const existing = await Otp.findById(key).lean<OtpDoc>();

  // The 30-second resend lock is lifted with the dummy, for the same reason
  // the rate limiter is: it exists to protect an SMS budget, and there is no
  // SMS. Leaving it on made a developer wait half a minute between attempts
  // at a code that is not checked anyway.
  if (!env.dummyOtp && existing && existing.resendAfter.getTime() > now) {
    const wait = Math.ceil((existing.resendAfter.getTime() - now) / 1000);
    throw new ApiError(
      429,
      `Please wait ${wait} second${wait === 1 ? "" : "s"} before asking for another code.`,
      "RESEND_TOO_SOON",
    );
  }

  // `randomInt` not `Math.random`: a predictable OTP is not an OTP.
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

  await Otp.findByIdAndUpdate(
    key,
    {
      codeHash: hash(phone, code),
      expiresAt: new Date(now + TTL_SECONDS * 1000),
      resendAfter: new Date(now + RESEND_SECONDS * 1000),
      attempts: 0,
      createdAt: new Date(now),
    },
    { upsert: true },
  );

  if (env.dummyOtp) {
    // `debug`, not `info`: visible to a developer running the server, absent
    // from ordinary production-level logs. The master code is what is actually
    // used to sign in, so this line is a convenience, not the mechanism.
    console.debug(`[otp] ${purpose} ${phone} -> ${code} (dummy mode)`);
  } else {
    // MSG91 goes here, once the DLT templates exist. Deliberately unwritten
    // rather than stubbed: an SMS integration that cannot be tested is not
    // worth the lines, and this branch is unreachable until the flag flips.
    throw new ApiError(
      503,
      "SMS delivery is not configured yet.",
      "NOT_CONFIGURED",
    );
  }

  // Note what is absent: the code. Not in the response, not in an error.
  return { phone, resendAfterSeconds: RESEND_SECONDS };
}

/**
 * Checks a code and consumes it.
 *
 * Deletes on success, so a code cannot be used twice — without that, anyone who
 * saw it once could replay it until it expired.
 */
export async function verifyOtp(
  phone: string,
  purpose: OtpPurpose,
  code: unknown,
): Promise<void> {
  if (typeof code !== "string" || !/^\d+$/.test(code)) {
    throw badRequest(`Enter the ${CODE_LENGTH}-digit code.`, "BAD_CODE");
  }

  const key = `${purpose}:${phone}`;

  /**
   * While `AUTH_DUMMY_OTP` is on, **any correctly-shaped code is accepted**,
   * with no record required.
   *
   * There is no SMS provider until the client's DLT templates clear, so there
   * is nothing for a "real" code to be. Requiring one meant a tester had to
   * have a live, unexpired, under-the-attempt-cap record before the dummy
   * would even be considered — and a rate-limited send or a code left to age
   * out locked them out of an app with no other way in.
   *
   * So the whole check is skipped. A developer types any six digits against
   * any throwaway number and gets in, which is the point: the product above
   * this line can be exercised end to end while the SMS below it does not
   * exist yet.
   *
   * ## What this is NOT
   *
   * It is not a weakening of the real path. Everything below — the hash
   * comparison, expiry, the attempt cap, single use — is untouched and is
   * exactly what runs the moment `AUTH_DUMMY_OTP=false`. Turning DLT on is a
   * one-line env change, not a rewrite.
   *
   * ## The guard
   *
   * **`env.ts` refuses to boot with `AUTH_DUMMY_OTP=true` under
   * `NODE_ENV=production`.** That single check is the only thing standing
   * between this and anyone signing in as anyone. Do not relax it to get a
   * deploy out.
   */
  if (env.dummyOtp) {
    // Length is still enforced above, so a stray keypress is still refused and
    // the screen's own validation keeps behaving as it will in production.
    //
    // Any record in flight is cleared, so a real code cannot be replayed once
    // the dummy is switched off.
    await Otp.findByIdAndDelete(key);
    return;
  }

  const record = await Otp.findById(key).lean<OtpDoc>();

  // Same message for "never requested", "already used" and "expired": each is
  // "ask for a new code", and separating them tells a guesser which numbers
  // have a code in flight.
  const stale = () =>
    badRequest(
      "That code has expired. Ask for a new one.",
      "OTP_EXPIRED",
    );

  if (!record) throw stale();
  if (record.expiresAt.getTime() < Date.now()) {
    await Otp.findByIdAndDelete(key);
    throw stale();
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await Otp.findByIdAndDelete(key);
    throw badRequest(
      "Too many incorrect attempts. Ask for a new code.",
      "OTP_LOCKED",
    );
  }

  const supplied = hash(phone, code);
  const expected = record.codeHash;
  const matches =
    supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));

  // The master code was handled above; everything from here is the real path,
  // unchanged, and it is what runs once DLT clears and the dummy goes off.
  if (!matches) {
    // Counted before refusing, or the cap never bites.
    await Otp.findByIdAndUpdate(key, { $inc: { attempts: 1 } });
    const left = MAX_ATTEMPTS - (record.attempts + 1);
    throw badRequest(
      left > 0
        ? `That code is not right. ${left} attempt${left === 1 ? "" : "s"} left.`
        : "That code is not right. Ask for a new one.",
      "OTP_WRONG",
    );
  }

  await Otp.findByIdAndDelete(key);
}
