import { Router } from "express";
import type { DocumentType, Page, ProDetail, ProListItem } from "@cfc/types";
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
 * Admin 12 — one pro, in full.
 *
 * Carries the bank **last four only**. The full account number is encrypted at
 * rest and read by nothing but a payout; an operations screen has no business
 * with it, and returning it would put it in every browser's network tab.
 */
adminProsRouter.get("/:id", async (req, res) => {
  const pro = await Pro.findById(param(req, "id")).lean<ProDoc>();
  if (!pro) throw notFound("Pro not found.");

  const names = await serviceNames(pro.serviceIds);

  const detail: ProDetail = {
    ...toListItem(pro, names),
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
    warningCount: 0,
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
