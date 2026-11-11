import { Router } from "express";
import type { QuotationDetail, QuotationListItem } from "@cfc/types";
import { badRequest, conflict, notFound } from "../../error";
import {
  actorOf,
  requireAuth,
  requirePermission,
  requireSection,
} from "../../middleware/auth";
import { Quotation, type MaterialLineSub, type QuotationDoc } from "../../models/quotation";
import { audit } from "../../models/audit";
import { cancelQuotation, editQuotation } from "../../services/quotation";
import { PUBLIC_PREFIX } from "../../uploads";
import { param } from "../../params";

/**
 * Admin 4, 5 — the quotation queue and its three outcomes.
 *
 * *"The panel's priority path."* The queue is ordered by **how little time is
 * left**, not by when it arrived: the thing that matters is which pro is
 * closest to standing in a house with no answer.
 */
export const adminQuotationsRouter = Router();

adminQuotationsRouter.use(requireAuth, requireSection("quotations"));

/** Minutes left in the window, or null once resolved. */
function minutesRemaining(q: QuotationDoc): number | null {
  if (q.status !== "pending") return null;
  return Math.max(
    0,
    Math.ceil((q.decisionBy.getTime() - Date.now()) / 60_000),
  );
}

function toListItem(q: QuotationDoc): QuotationListItem {
  return {
    id: q._id,
    jobRef: q.jobRef,
    proName: q.proName,
    customerName: q.customerName || q.jobRef,
    serviceName: q.serviceName,
    totalPaise: q.totalPaise,
    status: q.status,
    submittedAt: q.createdAt.toISOString(),
    minutesRemaining: minutesRemaining(q),
  };
}

function toDetail(q: QuotationDoc): QuotationDetail & {
  needsPhoneConfirmation: boolean;
  templatePricePaise: number;
  overTemplate: boolean;
  edited: boolean;
  submittedTotalPaise: number;
  submittedMaterials: MaterialLineSub[];
  submittedLabourPaise: number;
  workStarted: boolean;
} {
  return {
    ...toListItem(q),
    proNotes: q.proNotes,
    materials: q.materials,
    laborPaise: q.labourPaise,
    beforePhotoUrls: q.beforePhotoPaths.map((p) => `${PUBLIC_PREFIX}/${p}`),
    // Not tracked yet — reviews and history arrive in Phase 9. A real zero
    // rather than a fabricated number an operator might weigh a decision on.
    customerAreaHistory: 0,
    ...(q.rejectionReason !== undefined
      ? { rejectionReason: q.rejectionReason }
      : {}),

    // Above ₹5,000. A flag the admin acts on by phoning, not a gate.
    needsPhoneConfirmation: q.needsPhoneConfirmation,
    templatePricePaise: q.templatePricePaise,
    /** Admin 5, 28 — a quote over the template triggers review. */
    overTemplate:
      q.templatePricePaise > 0 && q.totalPaise > q.templatePricePaise,

    // Both figures, always. See the note on the model: an approved amount
    // differing from the submitted one with no history is an unsettleable
    // dispute.
    edited: q.edited,
    submittedTotalPaise: q.submittedTotalPaise,
    submittedMaterials: q.submittedMaterials,
    submittedLabourPaise: q.submittedLabourPaise,

    /**
     * Whether the customer's code has been entered and the quoted work began.
     *
     * An operator handling a dispute needs this: "approved" and "the customer
     * accepted" are both true of work that never started, and the money for it
     * is in the pro's settlement either way.
     */
    workStarted: q.workStartedAt !== undefined,
  };
}

adminQuotationsRouter.get("/", async (req, res) => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : "all";
  const search = typeof req.query["search"] === "string" ? req.query["search"].trim() : "";

  const filter: Record<string, unknown> = {};
  if (status !== "all") filter["status"] = status;
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["$or"] = [
      { jobRef: { $regex: escaped, $options: "i" } },
      { proName: { $regex: escaped, $options: "i" } },
      { customerName: { $regex: escaped, $options: "i" } },
    ];
  }

  // Pending first and tightest deadline at the top: the queue's whole job is
  // to say who to deal with next.
  const rows = await Quotation.find(filter)
    .sort({ status: 1, decisionBy: 1, createdAt: -1 })
    .lean<QuotationDoc[]>();

  /**
   * **Detail rows, not list rows.**
   *
   * The queue is not a table: Admin 4 puts Approve, Edit & Approve and Reject
   * *on the row*, so the row itself renders the material list and the
   * photo-count badge — an operator with four minutes left should not spend
   * forty seconds opening a record to use them.
   *
   * `toListItem` omitted `materials`, `laborPaise` and `beforePhotoUrls`,
   * which crashed that row on `beforePhotoUrls.length`. It only showed up
   * live: the fixtures were full `QuotationDetail` objects, and the client
   * already declares `fetchJson<QuotationDetail[]>` here — this endpoint was
   * the side that disagreed.
   *
   * Affordable because the queue is short **by design**: fifteen minutes each,
   * and deliberately unpaginated so the one about to expire cannot hide on
   * page two.
   */
  res.json(rows.map(toDetail));
});

adminQuotationsRouter.get("/:id", async (req, res) => {
  const q = await Quotation.findById(req.params.id).lean<QuotationDoc>();
  if (!q) throw notFound("That quotation could not be found.");
  res.json(toDetail(q));
});

/**
 * Admin 5 — change a quotation, or cancel it.
 *
 * **Not an approval any more.** A quotation reaches the customer the moment the
 * pro raises it; this endpoint is the office's 15-minute right to adjust what
 * the customer is looking at, or to stop it entirely.
 *
 * One endpoint for both, because the screen presents them as one decision with
 * two outcomes. Still gated on `quotations.approve` — the permission that used
 * to mean "may approve a price" now means "may change one", which is the same
 * authority over the same money.
 *
 * Both are refused once the customer has accepted. That rule lives in the
 * service so this route cannot forget it.
 */
adminQuotationsRouter.post(
  "/:id/decide",
  requirePermission("quotations.approve"),
  async (req, res) => {
    const body = (req.body ?? {}) as {
      outcome?: unknown;
      materials?: unknown;
      labourPaise?: unknown;
      reason?: unknown;
    };

    /**
     * `outcome` keeps its old vocabulary on the wire.
     *
     * `"approved"` now means "keep it, with these figures" and `"rejected"`
     * means "cancel it". Renaming the field would break every caller for a
     * word, and the screen's own labels say what actually happens.
     */
    if (body.outcome !== "approved" && body.outcome !== "rejected") {
      throw badRequest("Outcome must be approved or rejected.", "BAD_OUTCOME");
    }

    let materials: MaterialLineSub[] | undefined;
    if (Array.isArray(body.materials)) {
      materials = body.materials.map((m, i) => {
        const line = m as { description?: unknown; costPaise?: unknown };
        if (typeof line.description !== "string" || line.description.trim() === "") {
          throw badRequest(`Material ${i + 1} needs a description.`, "BAD_MATERIAL");
        }
        if (typeof line.costPaise !== "number" || !Number.isInteger(line.costPaise)) {
          throw badRequest(
            `Material ${i + 1} cost must be a whole number of paise.`,
            "BAD_AMOUNT",
          );
        }
        return { description: line.description.trim(), costPaise: line.costPaise };
      });
    }

    if (
      body.labourPaise !== undefined &&
      (typeof body.labourPaise !== "number" || !Number.isInteger(body.labourPaise))
    ) {
      throw badRequest("Labour must be a whole number of paise.", "BAD_AMOUNT");
    }

    const actor = actorOf(req);
    const result =
      body.outcome === "rejected"
        ? await cancelQuotation({
            quotationId: param(req, "id"),
            by: actor.name,
            reason: typeof body.reason === "string" ? body.reason : "",
          })
        : await editQuotation({
            quotationId: param(req, "id"),
            by: actor.name,
            ...(materials !== undefined ? { materials } : {}),
            ...(typeof body.labourPaise === "number"
              ? { labourPaise: body.labourPaise }
              : {}),
          });

    if (!result.ok) throw conflict(result.reason, "DECISION_FAILED");

    await audit(actor, body.outcome === "rejected" ? "quotation.cancelled" : "quotation.edited", {
      subject: param(req, "id"),
      detail: {
        jobRef: result.quotation.jobRef,
        // Both figures recorded. This is the row someone reads in a dispute.
        submittedTotalPaise: result.quotation.submittedTotalPaise,
        approvedTotalPaise: result.quotation.totalPaise,
        edited: result.quotation.edited,
        ...(result.quotation.rejectionReason !== undefined
          ? { reason: result.quotation.rejectionReason }
          : {}),
      },
    });

    res.json(toDetail(result.quotation));
  },
);
