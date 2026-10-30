import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import type { Actor, DocumentType } from "@cfc/types";
import { badRequest, conflict, forbidden, notFound } from "../../error";
import { signToken } from "../../auth/token";
import { normalisePhone, sendOtp, verifyOtp, RESEND_SECONDS } from "../../auth/otp";
import { last4, seal } from "../../auth/secret-box";
import { Pro, type ProDoc } from "../../models/pro";
import { Service } from "../../models/catalog";
import { newId } from "../../models/id";
import { actorOf, requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import {
  documentUpload,
  imageUpload,
  verifyImageBytes,
} from "../../middleware/upload";
import { PRIVATE_ROOT, PUBLIC_PREFIX, PUBLIC_ROOT } from "../../uploads";

/**
 * Pro 2–9 — registration through KYC approval.
 *
 * The flow: OTP → register → profile → documents → bank → conduct → pending.
 *
 * Two shapes worth naming up front.
 *
 * **A token is issued at OTP, not at approval.** An unapproved pro still has to
 * upload documents and enter bank details, which means authenticated requests —
 * so the token exists from the start but carries `role: "pro"` with an
 * `approvalStatus` the working routes check. Phase 6's job routes refuse
 * anything but `approved`.
 *
 * **`getApprovalState` is the authority on which screen a pro lands on.** The
 * `(auth)` route group reads it to decide where to resume, so a pro who
 * abandoned at the bank step returns to the bank step rather than starting
 * again.
 */
export const proOnboardingRouter = Router();

/** The conduct wording version a pro signs. Bumped when the text changes. */
const CONDUCT_VERSION = "2026-10-27";

/**
 * Labels for the four required documents, matching `REQUIRED_DOCUMENTS` in the
 * mock layer so the pro sees the same words the screen was built with.
 */
const DOCUMENT_LABELS: Record<DocumentType, string> = {
  aadhaar_front: "Aadhaar — front",
  aadhaar_back: "Aadhaar — back",
  pan: "PAN card",
  selfie: "Selfie",
};

const REQUIRED_TYPES: DocumentType[] = [
  "aadhaar_front",
  "aadhaar_back",
  "pan",
  "selfie",
];

function str(body: unknown, field: string, label: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${label} is required.`, "MISSING_FIELD");
  }
  return value.trim();
}

function strList(body: unknown, field: string): string[] {
  const raw = (body as Record<string, unknown> | undefined)?.[field];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** The pro making the request, refused if the token is for anyone else. */
function proActor(req: Parameters<typeof actorOf>[0]): Actor {
  const actor = actorOf(req);
  if (actor.role !== "pro") throw forbidden();
  return actor;
}

async function loadPro(id: string): Promise<ProDoc> {
  const pro = await Pro.findById(id).lean<ProDoc>();
  if (!pro) throw notFound("That account no longer exists.");
  return pro;
}

// -- Auth (Pro 2) -------------------------------------------------------------

proOnboardingRouter.post(
  "/otp/send",
  rateLimit({
    windowSeconds: 15 * 60,
    max: 5,
    relaxedWhenDummyOtp: true,
    keyOf: (req) => {
      const phone = (req.body as { phone?: unknown } | undefined)?.phone;
      return `${req.ip ?? "unknown"}|${typeof phone === "string" ? phone : ""}`;
    },
    message: "Too many code requests. Please wait before trying again.",
  }),
  async (req, res) => {
    const phone = normalisePhone((req.body as { phone?: unknown })?.phone);
    res.json(await sendOtp(phone, "pro"));
  },
);

/**
 * Pro 2 — verify the code.
 *
 * `isNewPro` decides where the app goes next: a returning pro resumes
 * onboarding or enters the app, a new one starts registration. The token comes
 * back either way, because every subsequent onboarding step is authenticated.
 */
proOnboardingRouter.post(
  "/otp/verify",
  rateLimit({ windowSeconds: 15 * 60, max: 10, relaxedWhenDummyOtp: true }),
  async (req, res) => {
    const phone = normalisePhone((req.body as { phone?: unknown })?.phone);
    await verifyOtp(phone, "pro", (req.body as { code?: unknown })?.code);

    const existing = await Pro.findOne({ phone }).lean<ProDoc>();

    // A pro who has not registered yet still needs a token to register with,
    // so the id is minted now and the record is created by /register.
    const actor: Actor = existing
      ? { id: existing._id, name: existing.name, role: "pro" }
      : { id: `pending:${phone}`, name: "", role: "pro" };

    res.json({
      token: signToken(actor),
      isNewPro: existing === null,
      resendAfterSeconds: RESEND_SECONDS,
    });
  },
);

// -- Registration (Pro 3) -----------------------------------------------------

/**
 * The services a pro may register for — from the catalogue, active only.
 *
 * Public so the registration form can show the list before the OTP step. It is
 * the same data a customer browsing would see.
 */
proOnboardingRouter.get("/registerable-services", async (_req, res) => {
  const docs = await Service.find({ active: true })
    .select({ name: 1, subCategoryId: 1 })
    .sort({ name: 1 })
    .lean<{ _id: string; name: string; subCategoryId: string }[]>();

  const { listSubCategories } = await import("../../services/catalog-read");
  const subs = await listSubCategories();
  const byId = new Map(subs.map((s) => [s.id, s.categoryName]));

  res.json(
    docs.map((d) => ({
      id: d._id,
      name: d.name,
      categoryName: byId.get(d.subCategoryId) ?? "",
    })),
  );
});

proOnboardingRouter.post("/register", requireAuth, async (req, res) => {
  const actor = proActor(req);
  const name = str(req.body, "name", "Name");

  // The phone comes from the **token**, not the body. Taking it from the body
  // would let anyone with any token register an account against someone else's
  // number — the OTP would have proved nothing.
  const phone = actor.id.startsWith("pending:")
    ? actor.id.slice("pending:".length)
    : (await loadPro(actor.id)).phone;

  const existing = await Pro.findOne({ phone }).lean<ProDoc>();
  if (existing) {
    throw conflict("An account already exists for this number.", "DUPLICATE");
  }

  const serviceIds = strList(req.body, "serviceIds");
  if (serviceIds.length === 0) {
    throw badRequest("Choose at least one service you can do.", "NO_SERVICES");
  }

  // Validated against the catalogue, so a stale or invented id cannot be stored
  // — a pro registered for a service that does not exist matches no jobs.
  const known = await Service.countDocuments({ _id: { $in: serviceIds } });
  if (known !== serviceIds.length) {
    throw badRequest("One of those services is no longer offered.", "BAD_SERVICE");
  }

  const areas = strList(req.body, "areas");
  if (areas.length === 0) {
    throw badRequest("Choose at least one area you can work in.", "NO_AREAS");
  }

  const doc = await Pro.create({
    _id: newId("pro"),
    phone,
    name,
    serviceIds,
    areas,
    approvalStatus: "pending",
    // Offline until they say otherwise, and they cannot say otherwise until
    // they are approved.
    online: false,
  });

  res.status(201).json({
    proId: doc._id,
    approvalStatus: doc.approvalStatus,
    // A fresh token carrying the real id — the `pending:` placeholder is spent.
    token: signToken({ id: doc._id, name: doc.name, role: "pro" }),
  });
});

// -- Profile (Pro 5) ----------------------------------------------------------

proOnboardingRouter.patch("/profile", requireAuth, async (req, res) => {
  const actor = proActor(req);
  const pro = await loadPro(actor.id);

  const areas = strList(req.body, "areas");
  const experience = (req.body as { experienceYears?: unknown })?.experienceYears;

  await Pro.updateOne(
    { _id: pro._id },
    {
      $set: {
        bio: (req.body as { bio?: unknown })?.bio
          ? String((req.body as { bio: string }).bio).trim()
          : pro.bio,
        experienceYears:
          typeof experience === "number" && experience >= 0
            ? Math.floor(experience)
            : pro.experienceYears,
        ...(areas.length > 0 ? { areas } : {}),
      },
    },
  );

  const updated = await loadPro(pro._id);
  res.json({
    photo: updated.photoPath !== undefined,
    skills: updated.serviceIds,
    experienceYears: updated.experienceYears,
    areas: updated.areas,
    bio: updated.bio,
  });
});

/**
 * The profile photo, which is a different thing from a KYC selfie.
 *
 * `photoPath` was read in three places — the public pro page, the admin list and
 * `/profile`'s own response — and **written in none**, so every pro had a null
 * photo no matter what they uploaded. Pro 5 collected the image and sent only
 * `photo: true`, which the server had nowhere to put.
 *
 * **Public root, unlike `/documents`.** A customer has to see who is coming to
 * their house, so this one is servable; the selfie that proves identity stays
 * private. Two uploaders exist precisely so this choice is made once per route
 * rather than per request.
 *
 * Stores the bare filename, matching what both readers already expect — they
 * prepend `/uploads/` themselves.
 */
proOnboardingRouter.post(
  "/profile/photo",
  requireAuth,
  imageUpload.single("file"),
  async (req, res) => {
    const actor = proActor(req);
    const pro = await loadPro(actor.id);

    if (!req.file) throw badRequest("No file was uploaded.", "NO_FILE");

    // Multer streams to disk before handing over, so a rejection has to clean
    // up after itself.
    const ok = await verifyImageBytes(req.file.path);
    if (!ok) {
      await fs.unlink(req.file.path).catch(() => {});
      throw badRequest(
        "That file is not a valid image. JPG, PNG or WebP.",
        "BAD_FILE_TYPE",
      );
    }

    // Replacing a photo removes the old file rather than orphaning it on disk.
    if (pro.photoPath) {
      await fs.unlink(path.join(PUBLIC_ROOT, pro.photoPath)).catch(() => {});
    }

    const filename = path.basename(req.file.path);
    await Pro.updateOne({ _id: pro._id }, { $set: { photoPath: filename } });

    res.status(201).json({ photoUrl: `${PUBLIC_PREFIX}/${filename}` });
  },
);

// -- Documents (Pro 6) --------------------------------------------------------

/**
 * Uploads one KYC document.
 *
 * Written to the **private** root, which nothing serves statically. Read back
 * only through the authenticated route below.
 *
 * **Always returns `pending`.** A screen that ticked a document green on upload
 * would teach the pro that review is automatic and then contradict itself a day
 * later. A person reviews these.
 */
proOnboardingRouter.post(
  "/documents",
  requireAuth,
  documentUpload.single("file"),
  async (req, res) => {
    const actor = proActor(req);
    const pro = await loadPro(actor.id);

    const type = (req.body as { type?: unknown })?.type;
    if (typeof type !== "string" || !REQUIRED_TYPES.includes(type as DocumentType)) {
      // The file is already on disk by the time multer hands over, so a bad
      // request has to clean up after itself.
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
      throw badRequest("Unknown document type.", "BAD_DOCUMENT_TYPE");
    }
    if (!req.file) throw badRequest("No file was uploaded.", "NO_FILE");

    // PDFs are allowed for a PAN scan, so only images get the byte check.
    if (path.extname(req.file.path).toLowerCase() !== ".pdf") {
      const ok = await verifyImageBytes(req.file.path);
      if (!ok) {
        await fs.unlink(req.file.path).catch(() => {});
        throw badRequest(
          "That file is not a valid image. JPG, PNG, WebP or PDF.",
          "BAD_FILE_TYPE",
        );
      }
    }

    const filePath = path.basename(req.file.path);
    const docType = type as DocumentType;

    // Re-uploading replaces the previous file and **clears the review state**,
    // including any rejection reason: the old reason described the old file, and
    // leaving it would reject a document nobody has looked at yet.
    const previous = pro.documents.find((d) => d.type === docType);
    if (previous) {
      await fs
        .unlink(path.join(PRIVATE_ROOT, previous.filePath))
        .catch(() => {});
      await Pro.updateOne(
        { _id: pro._id, "documents.type": docType },
        {
          $set: {
            "documents.$.filePath": filePath,
            "documents.$.status": "pending",
            "documents.$.uploadedAt": new Date(),
          },
          $unset: {
            "documents.$.rejectionReason": "",
            "documents.$.reviewedAt": "",
          },
        },
      );
    } else {
      await Pro.updateOne(
        { _id: pro._id },
        {
          $push: {
            documents: {
              type: docType,
              filePath,
              status: "pending",
              uploadedAt: new Date(),
            },
          },
        },
      );
    }

    res.status(201).json({ type: docType, status: "pending" });
  },
);

// -- Bank (Pro 7) -------------------------------------------------------------

/** Ported from the mock layer, verified there against 17 cases. */
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{9,18}$/;
const UPI = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;

proOnboardingRouter.put("/bank", requireAuth, async (req, res) => {
  const actor = proActor(req);
  const pro = await loadPro(actor.id);

  const accountName = str(req.body, "accountName", "Account holder name");
  const accountNumber = str(req.body, "accountNumber", "Account number");
  const ifsc = str(req.body, "ifsc", "IFSC").toUpperCase();
  const upiRaw = (req.body as { upiId?: unknown })?.upiId;

  // Validated server-side as well as in the form. A wrong IFSC does not fail
  // now — it fails days later at the first payout, with the pro chasing it.
  if (!ACCOUNT.test(accountNumber)) {
    throw badRequest("An account number is 9 to 18 digits.", "BAD_ACCOUNT");
  }
  if (!IFSC.test(ifsc)) {
    throw badRequest("That IFSC is not in the right format.", "BAD_IFSC");
  }
  const upiId =
    typeof upiRaw === "string" && upiRaw.trim() !== "" ? upiRaw.trim() : undefined;
  if (upiId !== undefined && !UPI.test(upiId)) {
    throw badRequest("That UPI ID is not in the right format.", "BAD_UPI");
  }

  await Pro.updateOne(
    { _id: pro._id },
    {
      $set: {
        bank: {
          accountName,
          // Encrypted at rest. A payout needs the full number, so it cannot be
          // discarded — but nothing reads it back except a transfer.
          accountNumberSealed: seal(accountNumber),
          accountLast4: last4(accountNumber),
          ifsc,
          ...(upiId !== undefined ? { upiId } : {}),
        },
      },
    },
  );

  // The full number is never echoed, not even to the pro who just typed it.
  res.json({
    accountName,
    accountLast4: last4(accountNumber),
    ifsc,
    upiId: upiId ?? null,
  });
});

// -- Conduct (Pro 8) ----------------------------------------------------------

/**
 * Records acceptance of the Code of Conduct, **with the wording version**.
 *
 * A pro who signed one version and later read another has a legitimate
 * grievance, and a bare timestamp cannot answer which text they agreed to.
 */
proOnboardingRouter.post("/conduct", requireAuth, async (req, res) => {
  const actor = proActor(req);
  const pro = await loadPro(actor.id);
  const acceptedAt = new Date();

  await Pro.updateOne(
    { _id: pro._id },
    { $set: { conduct: { acceptedAt, version: CONDUCT_VERSION } } },
  );

  res.json({ acceptedAt: acceptedAt.toISOString(), version: CONDUCT_VERSION });
});

// -- Approval state (Pro 9) ---------------------------------------------------

/**
 * Where the review has got to, and what is still missing.
 *
 * Drives the whole `(auth)` group, so it reports **both** the review status and
 * the onboarding steps still outstanding — the screen needs to know whether to
 * ask for documents or to show a waiting state.
 *
 * No turnaround time is promised. The agreement gives none, and "within 24
 * hours" would be a developer inventing an SLA the business has not agreed to.
 */
proOnboardingRouter.get("/approval-state", requireAuth, async (req, res) => {
  const actor = proActor(req);

  // A token minted at OTP for someone who never registered.
  if (actor.id.startsWith("pending:")) {
    res.json(null);
    return;
  }

  const pro = await loadPro(actor.id);

  res.json({
    // Returned so the app knows who it is signed in as without a second call.
    // The id still comes from the token on every other route — this is a
    // report of it, not a parameter anything trusts.
    proId: pro._id,
    status: pro.approvalStatus,
    blocked: pro.blocked,
    ...(pro.blockedReason !== undefined ? { blockedReason: pro.blockedReason } : {}),
    ...(pro.rejectionReason !== undefined
      ? { rejectionReason: pro.rejectionReason }
      : {}),
    documents: REQUIRED_TYPES.map((type) => {
      const found = pro.documents.find((d) => d.type === type);
      return {
        type,
        label: DOCUMENT_LABELS[type],
        // A document never uploaded is reported as such rather than as pending
        // review — the pro needs to know which of those two it is.
        status: found?.status ?? "missing",
        uploaded: found !== undefined,
        rejectionReason: found?.rejectionReason ?? null,
      };
    }),
    steps: {
      registered: true,
      profile: pro.experienceYears > 0 || pro.bio !== "",
      documents: REQUIRED_TYPES.every((t) =>
        pro.documents.some((d) => d.type === t),
      ),
      bank: pro.bank !== undefined,
      conduct: pro.conduct !== undefined,
    },
    submittedAt: pro.createdAt.toISOString(),
  });
});

/**
 * Reads back one of the pro's own documents.
 *
 * The private root is not served statically, so this is the only way to see a
 * document — and it checks that the caller owns it. The admin equivalent lives
 * on the admin router with its own permission check.
 */
proOnboardingRouter.get("/documents/:type", requireAuth, async (req, res) => {
  const actor = proActor(req);
  const pro = await loadPro(actor.id);

  const found = pro.documents.find((d) => d.type === req.params.type);
  if (!found) throw notFound("No such document.");

  const { resolveWithin } = await import("../../uploads");
  res.sendFile(resolveWithin(PRIVATE_ROOT, found.filePath));
});
