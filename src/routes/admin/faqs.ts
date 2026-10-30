import { Router } from "express";
import type { ServiceFaq } from "@cfc/types";
import { badRequest, notFound } from "../../error";
import { actorOf, requireAuth, requireSection } from "../../middleware/auth";
import { Faq, type FaqDoc } from "../../models/faq";
import { Service } from "../../models/catalog";
import { audit } from "../../models/audit";
import { newId } from "../../models/id";
import { param } from "../../params";

/**
 * FAQ management.
 *
 * Under the `services` section rather than `support`: an FAQ about a service
 * is catalogue content, written by whoever writes the service description,
 * and the support team answers tickets rather than maintaining copy.
 */
export const adminFaqRouter = Router();

adminFaqRouter.use(requireAuth, requireSection("services"));

function toFaq(doc: FaqDoc): ServiceFaq {
  return {
    id: doc._id,
    serviceId: doc.serviceId,
    question: doc.question,
    answer: doc.answer,
  };
}

adminFaqRouter.get("/", async (req, res) => {
  const audience = req.query["audience"] === "pro" ? "pro" : "customer";
  const rows = await Faq.find({ audience })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean<FaqDoc[]>();
  // The admin list carries the inactive ones too — that is the difference
  // between this and the public route, and the reason switching one off is
  // reversible rather than a delete.
  res.json(
    rows.map((f) => ({ ...toFaq(f), active: f.active, sortOrder: f.sortOrder })),
  );
});

async function readInput(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;

  const question = typeof b["question"] === "string" ? b["question"].trim() : "";
  const answer = typeof b["answer"] === "string" ? b["answer"].trim() : "";
  if (question === "") throw badRequest("A question is required.", "MISSING_FIELD");
  if (answer === "") throw badRequest("An answer is required.", "MISSING_FIELD");

  const serviceId =
    typeof b["serviceId"] === "string" && b["serviceId"].trim() !== ""
      ? b["serviceId"].trim()
      : null;
  if (serviceId !== null) {
    // Validated, so an FAQ cannot be attached to a service that does not
    // exist and then never appear anywhere.
    const exists = await Service.exists({ _id: serviceId });
    if (!exists) throw badRequest("No such service.", "BAD_SERVICE");
  }

  return {
    audience: b["audience"] === "pro" ? ("pro" as const) : ("customer" as const),
    serviceId,
    question,
    answer,
    sortOrder: typeof b["sortOrder"] === "number" ? b["sortOrder"] : 0,
    active: b["active"] !== false,
  };
}

adminFaqRouter.post("/", async (req, res) => {
  const input = await readInput(req.body);
  const doc = await Faq.create({ _id: newId("faq"), ...input });
  await audit(actorOf(req), "faq.created", { subject: doc._id });
  res.status(201).json(toFaq(doc.toObject() as FaqDoc));
});

adminFaqRouter.patch("/:id", async (req, res) => {
  const input = await readInput(req.body);
  const doc = await Faq.findOneAndUpdate(
    { _id: param(req, "id") },
    { $set: input },
    { new: true },
  ).lean<FaqDoc>();
  if (!doc) throw notFound("FAQ not found.");
  await audit(actorOf(req), "faq.updated", { subject: doc._id });
  res.json(toFaq(doc));
});

adminFaqRouter.delete("/:id", async (req, res) => {
  const id = param(req, "id");
  const result = await Faq.deleteOne({ _id: id });
  if (result.deletedCount === 0) throw notFound("FAQ not found.");
  await audit(actorOf(req), "faq.deleted", { subject: id });
  res.json({ ok: true });
});
