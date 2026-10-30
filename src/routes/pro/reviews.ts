import { Router } from "express";
import type { RatingBreakdown, Review as TypedReview } from "@cfc/types";
import { badRequest, forbidden, notFound } from "../../error";
import { actorOf, requireAuth } from "../../middleware/auth";
import { Review, type ReviewDoc } from "../../models/review";
import { param } from "../../params";

/**
 * Pro 30 — a professional's own reviews, and their reply.
 *
 * Scoped to the token throughout. The mock signatures take a `proId` and the
 * live path ignores it, so no screen changes — but a pro cannot read or
 * answer somebody else's reviews by passing a different id.
 */
export const proReviewRouter = Router();

proReviewRouter.use(requireAuth, (req, _res, next) => {
  if (actorOf(req).role !== "pro") {
    next(forbidden());
    return;
  }
  next();
});

proReviewRouter.get("/", async (req, res) => {
  const raw = Number(req.query["limit"]);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 20;

  const rows = await Review.find({ proId: actorOf(req).id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<ReviewDoc[]>();

  const result: TypedReview[] = rows.map((r) => ({
    id: r._id,
    authorName: r.authorName,
    area: r.area,
    rating: r.rating,
    body: r.body,
    serviceName: r.serviceName,
    proId: r.proId,
    createdAt: r.createdAt.toISOString(),
    verified: true,
  }));
  res.json(result);
});

/**
 * The star distribution behind the average.
 *
 * Reported as counts rather than percentages: four 5s and one 1 averages 4.2,
 * and so does a spread of middling scores. The shape is the information.
 */
proReviewRouter.get("/breakdown", async (req, res) => {
  const rows = await Review.aggregate<{ _id: number; count: number }>([
    { $match: { proId: actorOf(req).id } },
    { $group: { _id: "$rating", count: { $sum: 1 } } },
  ]);

  const counts: RatingBreakdown["counts"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let sum = 0;
  for (const r of rows) {
    const star = r._id as 1 | 2 | 3 | 4 | 5;
    if (star >= 1 && star <= 5) counts[star] = r.count;
    total += r.count;
    sum += star * r.count;
  }

  const result: RatingBreakdown = {
    average: total === 0 ? 0 : Math.round((sum / total) * 10) / 10,
    total,
    counts,
  };
  res.json(result);
});

proReviewRouter.post("/:id/reply", async (req, res) => {
  const raw = (req.body as { body?: unknown })?.body;
  const body = typeof raw === "string" ? raw.trim() : "";
  if (body === "") throw badRequest("A reply cannot be empty.", "MISSING_FIELD");

  // Matched on the pro as well as the id, so a leaked review id is not enough
  // to put words under someone else's name.
  const result = await Review.updateOne(
    { _id: param(req, "id"), proId: actorOf(req).id },
    { $set: { proReply: { body: body.slice(0, 2000), at: new Date() } } },
  );
  if (result.matchedCount === 0) throw notFound("Review not found.");

  res.status(201).json({ body: body.slice(0, 2000), at: new Date().toISOString() });
});
