import { Schema, model } from "mongoose";
import type { AdminSection } from "@cfc/types";
import { ADMIN_SECTIONS } from "@cfc/types";

/**
 * Admin accounts — Admin 49, "sub admins and area admins delegated by a Super
 * Admin."
 *
 * **The Super Admin is not in here.** The agreement says there is only one, and
 * it has to exist before anyone can create anything, so it comes from `.env`
 * (§0.2). A chicken-and-egg bootstrap row in the database would be one more
 * thing that can be edited, deleted or have its role changed.
 *
 * Mirrors the `SubAdmin` type in `@cfc/types`, plus the two fields a type for
 * rendering has no business carrying: the email and the password hash.
 */

export interface AdminUserDoc {
  _id: string;
  /** Lowercased on write. The login identity, so it is unique. */
  email: string;
  passwordHash: string;
  name: string;
  role: "sub_admin" | "area_admin";
  /** Set for area_admin — the one area they operate in. */
  area?: string;
  /**
   * Sections this person may open. **Narrows the role's own list and can never
   * widen it** — `canOpen` in `@cfc/types` intersects the two, so a bad row
   * here cannot hand out access the role never had.
   */
  sections: AdminSection[];
  /** False once suspended. The record is kept — Admin 49 revokes, not deletes. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const adminUserSchema = new Schema<AdminUserDoc>(
  {
    _id: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      required: true,
      enum: ["sub_admin", "area_admin"],
    },
    area: { type: String },
    sections: {
      type: [String],
      // Constrained to the real section list, so a typo in a seed script or an
      // API payload cannot create a grant that matches no sidebar item and
      // silently grants nothing.
      enum: ADMIN_SECTIONS,
      default: [],
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

export const AdminUser = model<AdminUserDoc>("AdminUser", adminUserSchema);
