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
 * Video, for job-completion proof.
 *
 * Only the container formats a phone actually produces and a browser can play
 * back without a transcode step: MP4 from iOS and most Android, WebM from some
 * Android browsers, QuickTime from older iPhones.
 *
 * As with images the extension is not the check — the magic bytes are. An MP4
 * and a QuickTime file both begin with a four-byte length then `ftyp`, so the
 * signature is checked at offset 4 rather than 0.
 */
const VIDEO_SIGNATURES: Record<string, readonly number[][]> = {
  // "ftyp" at offset 4.
  ".mp4": [[0x66, 0x74, 0x79, 0x70]],
  ".mov": [[0x66, 0x74, 0x79, 0x70]],
  // EBML header.
  ".webm": [[0x1a, 0x45, 0xdf, 0xa3]],
};

/** 60 MB. Roughly a minute of phone video; enough to show a repair working. */
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

/**
 * **Total** bytes of images on one booking, not per file.
 *
 * Per-file was the obvious rule and the wrong one: eight 4 MB photos pass it
 * individually and leave 32 MB on a VPS disk for one job. A budget for the
 * whole job is what actually bounds storage, and it is the number the pro can
 * be told — "your photos come to 23 MB of the 20 MB allowed" is actionable in
 * a way that a per-file limit is not when they are nine files in.
 */
export const MAX_JOB_IMAGE_BYTES = 20 * 1024 * 1024;

/** Human bytes, for an error a pro can act on. */
export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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

/**
 * Job-completion media: an image or a video.
 *
 * One uploader rather than two because the pro's screen offers one control —
 * "add proof" — and which of the two they picked is the file's business, not
 * a different endpoint's. The size cap is the video one; images are checked
 * against their own, tighter budget after the write.
 */
export const mediaUpload = multer({
  storage: diskStorage(PUBLIC_ROOT, [
    ...IMAGE_EXTENSIONS,
    ...Object.keys(VIDEO_SIGNATURES),
  ]),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (
      !file.mimetype.startsWith("image/") &&
      !file.mimetype.startsWith("video/")
    ) {
      cb(badRequest("That is not an image or a video.", "BAD_FILE_TYPE"));
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

/** True when the extension is one of the video containers we accept. */
export function isVideoPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() in VIDEO_SIGNATURES;
}

/**
 * Verifies a video really is the container its extension claims.
 *
 * The counterpart to `verifyImageBytes`, and the reason it is separate: MP4
 * and QuickTime carry their signature at **offset 4**, after a box-length
 * prefix, so a check that reads from zero finds nothing and rejects a valid
 * file.
 */
export async function verifyVideoBytes(filePath: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    if (bytesRead < 8) return false;

    const ext = path.extname(filePath).toLowerCase();
    const signatures = VIDEO_SIGNATURES[ext];
    if (!signatures) return false;

    // WebM matches at 0; the MP4 family at 4.
    const offset = ext === ".webm" ? 0 : 4;
    return signatures.some((sig) =>
      sig.every((byte, i) => buffer[offset + i] === byte),
    );
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
