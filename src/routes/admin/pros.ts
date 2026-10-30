import { Router } from "express";
import type {
  DocumentType,
  Page,
  ProDetail,
  ProListItem,
  ProWarning as TypedProWarning,
} from "@cfc/types";
import { badRequest, conflict, notFound } from "../../error";
import {
  actorOf,
  requireAuth,
  requirePermission,
  requireSection,
  scopeArea,
} from "../../middleware/auth";
import { Pro, canReceiveOffers, ratingOf, type ProDoc } from "../../models/pro";
import { Service } from "../../models/catalog";
import { audit } from "../../models/audit";
import { notify } from "../../models/notification";
import { ProWarning, type ProWarningDoc } from "../../models/pro-warning";
import { ProLedger } from "../../models/pro-ledger";
import { newId } from "../../models/id";
import { param } from "../../params";
import { PRIVATE_ROOT, resolveWithin } from "../../uploads";

/**
 * Admin 11–18 — pro management, and Admin 13/14 — the KYC queue.
 *
 * The permission split here is the agreement's, not a preference:
 * `pros.approve_kyc` **is** delegated to a sub admin ("vendor approvals, as
 * delegated"), and `pros.block` is **not**. So onboarding someone is delegated
 * and stopping them working is not, and those are two different middlewares
 * rather than one role check.
 */
export const adminProsRouter = Router();

adminProsRouter.use(requireAuth, requireSection("pros"));

const REQUIRED_TYPES: DocumentType[] = [
  "aadhaar_front",
  "aadhaar_back",
  "pan",
  "selfie",
];

function reason(body: unknown, label: string): string {
  const value = (body as { reason?: unknown } | undefined)?.reason;
  if (typeof value !== "string" || value.trim().length < 3) {
    // Enforced server-side as well as in the form. A rejection with no reason
    // is one the pro cannot act on, and `PRO-OPEN-ITEMS.md` 4.7 records exactly
    // that outcome when the two were allowed to drift apart.
    throw badRequest(`${label} is required.`, "REASON_REQUIRED");
  }
  return value.trim();
}

/** Resolves service ids to the names every screen displays. */
async function serviceNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const docs = await Service.find({ _id: { $in: [...new Set(ids)] } })
    .select({ name: 1 })
    .lean<{ _id: string; name: string }[]>();
  return new Map(docs.map((d) => [d._id, d.name]));
}

function toListItem(pro: ProDoc, names: Map<string, string>): ProListItem {
  return {
    id: pro._id,
    name: pro.name,
    photoUrl: pro.photoPath ? `/uploads/${pro.photoPath}` : null,
    phone: pro.phone,
    services: pro.serviceIds.map((id) => names.get(id) ?? id),
    // `ProListItem.area` is one string; the record holds several (§4.4). The
    // first is shown, and dispatch matches against all of them.
    area: pro.areas[0] ?? "",
    // A blocked pro cannot be online whatever the flag says, so the projection
    // enforces it rather than leaving each screen to remember.
    online: pro.online && !pro.blocked,
    rating: ratingOf(pro),
    jobsCompleted: pro.jobsCompleted,
    approvalStatus: pro.approvalStatus,
    blocked: pro.blocked,
    joinedAt: pro.createdAt.toISOString(),
    // Payouts arrive in Phase 9; reported as a real zero until then.
    pendingPayoutPaise: 0,
  };
}

/**
 * Admin 11 — the pro list.
 *
 * Area-scoped **in the query**, not by filtering afterwards: an area admin's
 * `total` must not count rows they may not see, or the pagination itself leaks
 * what the rows do not.
 */
adminProsRouter.get("/", async (req, res) => {
  const q = req.query;
  const filter: Record<string, unknown> = {};

  const status = typeof q["approvalStatus"] === "string" ? q["approvalStatus"] : "all";
  if (status !== "all") filter["approvalStatus"] = status;

  const area = scopeArea(req) ?? (typeof q["area"] === "string" ? q["area"] : undefined);
  if (area) filter["areas"] = area;

  const online = typeof q["online"] === "string" ? q["online"] : "all";
  if (online === "online") filter["online"] = true;
  if (online === "offline") filter["online"] = false;

  const search = typeof q["search"] === "string" ? q["search"].trim() : "";
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["$or"] = [
      { name: { $regex: escaped, $options: "i" } },
      { phone: { $regex: escaped } },
    ];
  }

  const page = Math.max(1, Number(q["page"]) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q["pageSize"]) || 20));

  const [docs, total] = await Promise.all([
    Pro.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<ProDoc[]>(),
    Pro.countDocuments(filter),
  ]);

  const names = await serviceNames(docs.flatMap((d) => d.serviceIds));

  const result: Page<ProListItem> = {
    items: docs.map((d) => toListItem(d, names)),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
  res.json(result);
});

/**
 * Admin 17 — the discipline record, across every pro or filtered to one.
 *
 * **Registered before `/:id` on purpose.** Express matches in order, so with
 * these the other way round a request for `/warnings` is read as a request for
 * the pro whose id is "warnings" and answers 404.
 */
adminProsRouter.get("/warnings", async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  if (typeof q["proId"] === "string") filter["proId"] = q["proId"];

  // Area admins see their own area's pros only — the same scoping the list
  // above applies, because a discipline record is no less area-scoped than the
  // pro it belongs to.
  const area = scopeArea(req);
  if (area) {
    const ids = await Pro.find({ areas: area }).distinct("_id");
    filter["proId"] = { $in: ids };
  }

  const rows = await ProWarning.find(filter)
    .sort({ issuedAt: -1 })
    .limit(500)
    .lean<ProWarningDoc[]>();

  const result: TypedProWarning[] = rows.map((w) => ({
    id: w._id,
    proId: w.proId,
    proName: w.proName,
    reason: w.reason,
    penaltyPaise: w.penaltyPaise,
    issuedAt: w.issuedAt.toISOString(),
    issuedBy: w.issuedBy,
  }));
  res.json(result);
});

/**
 * Admin 17 — issue a warning, and optionally fine.
 *
 * Gated on `pros.block`, not `pros.approve_kyc`. A sub admin has onboarding
 * delegated to them and discipline not, and a warning that takes money is the
 * discipline half — fining a pro is nearer to stopping them working than to
 * letting them start.
 *
 * The penalty writes a **ledger row in the same request**, so the discipline
 * record and the pro's wallet cannot disagree about whether a fine was taken.
 * It is deliberately not deferred: a penalty that waits would let the pro
 * withdraw money they already owe back.
 */
adminProsRouter.post(
  "/:id/warnings",
  requirePermission("pros.block"),
  async (req, res) => {
    const proId = param(req, "id");
    const pro = await Pro.findById(proId).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");

    const why = reason(req.body, "A reason is required.");

    // Positive paise, whole. A negative "penalty" would be a credit wearing a
    // warning's label, and the ledger would pay someone for misconduct.
    const raw = (req.body as { penaltyPaise?: unknown })?.penaltyPaise ?? 0;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw badRequest(
        "A penalty is a whole number of paise, or zero.",
        "BAD_PENALTY",
      );
    }

    const actor = actorOf(req);
    const now = new Date();
    let ledgerId: string | undefined;

    if (raw > 0) {
      ledgerId = newId("ple");
      await ProLedger.create({
        _id: ledgerId,
        proId,
        kind: "penalty",
        label: why,
        // Negative in the ledger, positive on the warning: a balance there is
        // a sum, and a switch on `kind` is how the two come to disagree.
        amountPaise: -raw,
        availableAt: now,
        at: now,
      });
    }

    const doc = await ProWarning.create({
      _id: newId("warn"),
      proId,
      proName: pro.name,
      reason: why,
      penaltyPaise: raw,
      ...(ledgerId !== undefined ? { ledgerId } : {}),
      issuedBy: actor.name,
      issuedAt: now,
    });

    await notify({
      role: "pro",
      to: proId,
      kind: "warning",
      title: raw > 0 ? "A warning, with a penalty" : "A warning has been issued",
      body:
        raw > 0
          ? `${why} ₹${Math.round(raw / 100).toLocaleString("en-IN")} has been deducted.`
          : why,
      href: "/warnings",
    });

    await audit(actor, "pro.warning.issued", {
      subject: proId,
      detail: { reason: why, penaltyPaise: raw },
    });

    const result: TypedProWarning = {
      id: doc._id,
      proId: doc.proId,
      proName: doc.proName,
      reason: doc.reason,
      penaltyPaise: doc.penaltyPaise,
      issuedAt: doc.issuedAt.toISOString(),
      issuedBy: doc.issuedBy,
    };
    res.status(201).json(result);
  },
);

/**
 * Admin 12 — one pro, in full.
 *
 * Carries the bank **last four only**. The full account number is encrypted at
 * rest and read by nothing but a payout; an operations screen has no business
 * with it, and returning it would put it in every browser's network tab.
 */
adminProsRouter.get("/:id", async (req, res) => {
  const pro = await Pro.findById(param(req, "id")).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");

  const [names, warningCount] = await Promise.all([
    serviceNames(pro.serviceIds),
    ProWarning.countDocuments({ proId: pro._id }),
  ]);

  const detail: ProDetail = {
    ...toListItem(pro, names),
    areas: pro.areas,
    bio: pro.bio,
    experienceYears: pro.experienceYears,
    bankAccountLast4: pro.bank?.accountLast4 ?? "",
    ifsc: pro.bank?.ifsc ?? "",
    upiId: pro.bank?.upiId ?? null,
    documents: REQUIRED_TYPES.map((type) => {
      const found = pro.documents.find((d) => d.type === type);
      return {
        type,
        // Points at the authenticated read route below, not at a static file.
        imageUrl: found ? `/api/admin/pros/${pro._id}/documents/${type}` : "",
        status: found?.status ?? "pending",
        // Derived from the status, never stored beside a mismatching one.
        rejectionReason:
          found?.status === "rejected" ? found.rejectionReason : undefined,
      };
    }),
    totalEarnedPaise: 0,
    pendingPayoutPaise: 0,
    warningCount,
  };

  res.json(detail);
});

/**
 * Admin 14 — a KYC document, streamed through an authenticated route.
 *
 * The private upload root is not served statically, so this is the only path to
 * the file and it requires an admin token plus the `pros` section. An Aadhaar
 * must never be reachable by guessing a URL.
 *
 * `no-store`, so a shared or kiosk browser does not keep someone's Aadhaar in
 * its disk cache after the operator closes the tab.
 */
adminProsRouter.get("/:id/documents/:type", async (req, res) => {
  const pro = await Pro.findById(param(req, "id")).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");

  const found = pro.documents.find((d) => d.type === param(req, "type"));
  if (!found) throw notFound("No such document.");

  await audit(actorOf(req), "pro.document.viewed", {
    subject: pro._id,
    detail: { type: found.type },
  });

  res.setHeader("Cache-Control", "no-store, private");
  res.sendFile(resolveWithin(PRIVATE_ROOT, found.filePath));
});

// -- KYC decisions (Admin 13, 14) --------------------------------------------

/**
 * Admin 14 — approve or reject **one document**.
 *
 * Per-document rather than all-or-nothing, because that is what lets a
 * rejection say which document to re-upload. A blanket rejection sends the pro
 * back to photograph all four.
 */
adminProsRouter.patch(
  "/:id/documents/:type",
  requirePermission("pros.approve_kyc"),
  async (req, res) => {
    const id = param(req, "id");
    const type = param(req, "type") as DocumentType;
    if (!REQUIRED_TYPES.includes(type)) {
      throw badRequest("Unknown document type.", "BAD_DOCUMENT_TYPE");
    }

    const status = (req.body as { status?: unknown })?.status;
    if (status !== "approved" && status !== "rejected") {
      throw badRequest("Status must be approved or rejected.", "BAD_STATUS");
    }

    const pro = await Pro.findById(id).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");
    if (!pro.documents.some((d) => d.type === type)) {
      throw conflict("That document has not been uploaded yet.", "NOT_UPLOADED");
    }

    // A rejection must carry a reason; an approval must *clear* any previous
    // one. Keeping a stale reason on an approved document is the exact
    // inconsistency PRO-OPEN-ITEMS 4.7 describes.
    const update: Record<string, unknown> = {
      $set: {
        "documents.$.status": status,
        "documents.$.reviewedAt": new Date(),
      },
    };
    if (status === "rejected") {
      (update["$set"] as Record<string, unknown>)["documents.$.rejectionReason"] =
        reason(req.body, "A reason");
    } else {
      update["$unset"] = { "documents.$.rejectionReason": "" };
    }

    await Pro.updateOne({ _id: id, "documents.type": type }, update);

    await audit(actorOf(req), `pro.document.${status}`, {
      subject: id,
      detail: { type },
    });

    res.json({ type, status });
  },
);

/**
 * Admin 13 — approve the registration.
 *
 * **Refused unless every document has been approved.** Approving a pro whose
 * PAN was never looked at is the precise failure this screen exists to prevent,
 * and the UI already disables the button — but a disabled button is not a
 * check.
 */
adminProsRouter.post(
  "/:id/approve",
  requirePermission("pros.approve_kyc"),
  async (req, res) => {
    const id = param(req, "id");
    const pro = await Pro.findById(id).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");

    if (pro.approvalStatus === "approved") {
      throw conflict("That pro is already approved.", "ALREADY_APPROVED");
    }

    const missing = REQUIRED_TYPES.filter(
      (t) => !pro.documents.some((d) => d.type === t),
    );
    if (missing.length > 0) {
      throw conflict(
        `Still waiting on ${missing.length} document${missing.length === 1 ? "" : "s"}.`,
        "DOCUMENTS_MISSING",
      );
    }

    const unapproved = pro.documents.filter((d) => d.status !== "approved");
    if (unapproved.length > 0) {
      throw conflict(
        `${unapproved.length} document${unapproved.length === 1 ? " has" : "s have"} not been verified yet.`,
        "DOCUMENTS_UNVERIFIED",
      );
    }

    if (!pro.bank) {
      throw conflict("That pro has not added bank details yet.", "NO_BANK");
    }
    if (!pro.conduct) {
      throw conflict("That pro has not accepted the code of conduct.", "NO_CONDUCT");
    }

    const actor = actorOf(req);
    await Pro.updateOne(
      { _id: id },
      {
        $set: {
          approvalStatus: "approved",
          reviewedBy: actor.id,
          reviewedAt: new Date(),
        },
        // Approval clears a previous rejection; leaving the old reason would
        // show "rejected because…" beside an approved badge.
        $unset: { rejectionReason: "" },
      },
    );

    // The one notification a pro is actually waiting for.
    await notify({
      role: "pro",
      to: id,
      kind: "announcement",
      title: "You are approved",
      body: "Your registration has been verified. Go online to start receiving jobs.",
      href: "/jobs",
    });

    await audit(actor, "pro.kyc.approved", {
      subject: id,
      detail: { name: pro.name },
    });

    res.json({ id, approvalStatus: "approved" });
  },
);

adminProsRouter.post(
  "/:id/reject",
  requirePermission("pros.approve_kyc"),
  async (req, res) => {
    const id = param(req, "id");
    const why = reason(req.body, "A reason for the rejection");

    const pro = await Pro.findById(id).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");

    const actor = actorOf(req);
    await Pro.updateOne(
      { _id: id },
      {
        $set: {
          approvalStatus: "rejected",
          rejectionReason: why,
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          // A rejected pro is out of the dispatch pool immediately.
          online: false,
        },
      },
    );

    await notify({
      role: "pro",
      to: id,
      kind: "announcement",
      title: "Registration not approved",
      body: why,
      href: "/onboarding",
    });

    await audit(actor, "pro.kyc.rejected", {
      subject: id,
      detail: { name: pro.name, reason: why },
    });

    res.json({ id, approvalStatus: "rejected" });
  },
);

/**
 * Admin 14 — ask for documents again without rejecting the registration.
 *
 * The middle outcome the queue needs: a blurry Aadhaar is not grounds for
 * rejection, it is grounds for "send it again". Puts the registration back to
 * pending and clears the named documents so the pro is asked for exactly those.
 */
adminProsRouter.post(
  "/:id/request-documents",
  requirePermission("pros.approve_kyc"),
  async (req, res) => {
    const id = param(req, "id");
    const why = reason(req.body, "A note saying what is wrong");
    const types = (req.body as { types?: unknown })?.types;
    if (
      !Array.isArray(types) ||
      types.length === 0 ||
      types.some((t) => !REQUIRED_TYPES.includes(t as DocumentType))
    ) {
      throw badRequest("Name which documents to re-upload.", "BAD_TYPES");
    }

    const pro = await Pro.findById(id).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");

    await Pro.updateOne(
      { _id: id },
      { $set: { approvalStatus: "pending" } },
    );
    for (const type of types as DocumentType[]) {
      await Pro.updateOne(
        { _id: id, "documents.type": type },
        {
          $set: {
            "documents.$.status": "rejected",
            "documents.$.rejectionReason": why,
            "documents.$.reviewedAt": new Date(),
          },
        },
      );
    }

    await notify({
      role: "pro",
      to: id,
      kind: "announcement",
      title: "More documents needed",
      body: `${why} Please re-upload: ${types.join(", ")}.`,
      href: "/onboarding",
    });

    await audit(actorOf(req), "pro.documents.requested", {
      subject: id,
      detail: { types, reason: why },
    });

    res.json({ id, requested: types });
  },
);

// -- Block / unblock (Admin 15) ----------------------------------------------

/**
 * Blocking is **not delegated to a sub admin** — `pros.block` is super-admin
 * only, while `pros.approve_kyc` above is delegated. The agreement draws that
 * line and this is where it is enforced.
 */
adminProsRouter.post(
  "/:id/block",
  requirePermission("pros.block"),
  async (req, res) => {
    const id = param(req, "id");
    const why = reason(req.body, "A reason for blocking");

    const pro = await Pro.findById(id).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");

    await Pro.updateOne(
      { _id: id },
      {
        $set: {
          blocked: true,
          blockedReason: why,
          // Out of the dispatch pool at once, not at their next sign-in.
          online: false,
        },
      },
    );

    await audit(actorOf(req), "pro.blocked", {
      subject: id,
      detail: { name: pro.name, reason: why },
    });

    res.json({ id, blocked: true });
  },
);

adminProsRouter.post(
  "/:id/unblock",
  requirePermission("pros.block"),
  async (req, res) => {
    const id = param(req, "id");
    const pro = await Pro.findById(id).lean<ProDoc>();
    if (!pro) throw notFound("Pro not found.");

    await Pro.updateOne(
      { _id: id },
      // Unblocking does not put them back online — that is their own choice,
      // and forcing it would start sending jobs to someone who may not be ready.
      { $set: { blocked: false }, $unset: { blockedReason: "" } },
    );

    await audit(actorOf(req), "pro.unblocked", {
      subject: id,
      detail: { name: pro.name },
    });

    res.json({ id, blocked: false });
  },
);

/**
 * Whether this pro would currently receive offers, and why not.
 *
 * Exists so the admin list can explain an absence rather than leaving an
 * operator to infer it from two separate badges. Uses the same
 * `canReceiveOffers` the dispatch engine will, so the two cannot disagree.
 */
adminProsRouter.get("/:id/dispatch-status", async (req, res) => {
  const pro = await Pro.findById(param(req, "id")).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");

  res.json({
    eligible: canReceiveOffers(pro),
    reasons: [
      ...(pro.approvalStatus !== "approved" ? [`KYC is ${pro.approvalStatus}`] : []),
      ...(pro.blocked ? ["Blocked by an admin"] : []),
      ...(!pro.online ? ["Currently offline"] : []),
    ],
  });
});
