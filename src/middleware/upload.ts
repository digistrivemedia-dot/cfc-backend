import path from "node:path";
import { randomBytes } from "node:crypto";
import multer from "multer";
import { badRequest } from "../error";
import { PRIVATE_ROOT, PUBLIC_PREFIX, PUBLIC_ROOT } from "../uploads";

/**
 * Image and document upload.
 *
 * Two configured uploaders, matching the two roots (§0.4): `imageUpload` writes
 * to the statically served `public/`, `documentUpload` writes to `private/`,
 * which nothing serves. A KYC document must never be one misrouted call away
 * from being public, so the destination is baked into the uploader rather than
 * passed in per request.
 */

/**
 * Extensions allowed for an image, and the magic bytes each must start with.
 *
 * The extension alone is not a check — anyone can rename `payload.svg` to
 * `photo.jpg`. SVG is deliberately absent from this list: it is a document
 * format that can carry script, and serving one from our own origin is a stored
 * XSS. There is no reason a service photo needs to be an SVG.
 */
const IMAGE_SIGNATURES: Record<string, readonly number[][]> = {
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".png": [[0x89, 0x50, 0x4e, 0x47]],
  ".webp": [[0x52, 0x49, 0x46, 0x46]], // "RIFF", then "WEBP" at offset 8.
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * A safe, unguessable filename.
 *
 * The uploaded name is **discarded entirely**, not sanitised. Sanitising means
 * guessing at every way a name can be hostile — path separators, null bytes,
 * unicode lookalikes, Windows reserved words like `CON` — and the original
 * filename is worth nothing to us anyway. Only the extension survives, and only
 * if it is on the allowlist.
 */
function safeName(originalName: string, allowed: readonly string[]): string {
  const ext = path.extname(originalName).toLowerCase();
  if (!allowed.includes(ext)) {
    throw badRequest(
      `Unsupported file type. Allowed: ${allowed.join(", ")}`,
      "BAD_FILE_TYPE",
    );
  }
  return `${Date.now()}-${randomBytes(6).toString("hex")}${ext}`;
}

function diskStorage(root: string, allowed: readonly string[]) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, root),
    filename: (_req, file, cb) => {
      try {
        cb(null, safeName(file.originalname, allowed));
      } catch (err) {
        cb(err as Error, "");
      }
    },
  });
}

const IMAGE_EXTENSIONS = Object.keys(IMAGE_SIGNATURES);

export const imageUpload = multer({
  storage: diskStorage(PUBLIC_ROOT, IMAGE_EXTENSIONS),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // A first pass on the declared type. The real check is the magic bytes
    // after the write — a client-sent mimetype is a claim, not evidence.
    if (!file.mimetype.startsWith("image/")) {
      cb(badRequest("That is not an image.", "BAD_FILE_TYPE"));
      return;
    }
    cb(null, true);
  },
});

export const documentUpload = multer({
  storage: diskStorage(PRIVATE_ROOT, [...IMAGE_EXTENSIONS, ".pdf"]),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
});

/**
 * Verifies the file really is the image type its extension claims.
 *
 * Called **after** multer has written it, so a rejection has to delete the
 * file. Reading the first bytes is cheap and is the only thing that
 * distinguishes a real PNG from an HTML page named `.png` — which, served from
 * our own origin, is a stored XSS rather than a broken image.
 */
export async function verifyImageBytes(filePath: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    if (bytesRead < 4) return false;

    const ext = path.extname(filePath).toLowerCase();
    const signatures = IMAGE_SIGNATURES[ext];
    if (!signatures) return false;

    const matches = signatures.some((sig) =>
      sig.every((byte, i) => buffer[i] === byte),
    );
    if (!matches) return false;

    // RIFF is a container; only the WEBP flavour of it is an image.
    if (ext === ".webp") return buffer.subarray(8, 12).toString() === "WEBP";

    return true;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** The path stored in Mongo for a file written to the public root. */
export function publicPathFor(filename: string): string {
  return `${PUBLIC_PREFIX}/${filename}`;
}
