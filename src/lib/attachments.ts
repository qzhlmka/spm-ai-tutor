import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

const execFileAsync = promisify(execFile);

export const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// A student attaches one question/page, not a whole paper — cap render+vision cost.
const MAX_PDF_PAGES = 3;
const RENDER_DPI = 150;

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

/** Thrown for problems with the attachment itself (bad type, too large) — the caller
 * maps this to a 400, distinct from unexpected/internal failures (500). */
export class AttachmentError extends Error {}

async function pdfToImageParts(buffer: Buffer, filename: string): Promise<Anthropic.ImageBlockParam[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-attachment-"));
  try {
    const pdfPath = path.join(dir, "input.pdf");
    await writeFile(pdfPath, buffer);
    try {
      await execFileAsync("pdftoppm", [
        "-png",
        "-r",
        String(RENDER_DPI),
        "-l",
        String(MAX_PDF_PAGES),
        pdfPath,
        path.join(dir, "p"),
      ]);
    } catch (err) {
      // Raw execFile failures read like "spawn pdftoppm ENOENT" or a bare exit
      // code, which reached users as an unexplained upload failure (a reported
      // finding). Anything wrong here means we could not read the PDF, so say
      // that instead — a missing poppler binary is a deploy problem (see
      // nixpacks.toml) that the logged cause below is for, not the user.
      console.error("pdftoppm failed while rendering an attached PDF", err);
      throw new AttachmentError(
        `Couldn't read "${filename}". It may be password-protected, corrupted, or an unusual PDF — try exporting it again, or send a photo/screenshot of the page instead.`,
      );
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    if (files.length === 0) {
      throw new AttachmentError(`Couldn't read any pages from "${filename}". Try a different export of the file.`);
    }
    const parts: Anthropic.ImageBlockParam[] = [];
    for (const file of files) {
      const b64 = (await readFile(path.join(dir, file))).toString("base64");
      parts.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
    }
    return parts;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Converts student-attached images/PDFs into Anthropic image content blocks. PDFs are
 * rendered to page images (same poppler/pdftoppm approach as the ingestion OCR
 * pipeline) since the Messages API takes images, not raw PDF bytes. */
export async function attachmentsToImageParts(
  attachments: AttachmentInput[],
): Promise<{ parts: Anthropic.ImageBlockParam[]; notices: string[] }> {
  const parts: Anthropic.ImageBlockParam[] = [];
  // Things the tutor needs to know about what it was actually given, so it can
  // say so rather than confidently answering about a page it never saw. Teachers
  // reported being "unable to guide the AI with uploaded PDFs"; a silent
  // truncation to the first few pages is one way that happens.
  const notices: string[] = [];
  for (const attachment of attachments) {
    const buffer = Buffer.from(attachment.dataBase64, "base64");
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`"${attachment.filename}" is too large (max 8MB).`);
    }
    if (ALLOWED_IMAGE_TYPES.has(attachment.mimeType)) {
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType as "image/png" | "image/jpeg" | "image/webp",
          data: attachment.dataBase64,
        },
      });
    } else if (attachment.mimeType === "application/pdf") {
      const pdfParts = await pdfToImageParts(buffer, attachment.filename);
      if (pdfParts.length >= MAX_PDF_PAGES) {
        notices.push(
          `Only the first ${MAX_PDF_PAGES} page(s) of "${attachment.filename}" were read. If the part they mean isn't in those pages, say so and ask them to send that page directly.`,
        );
      }
      parts.push(...pdfParts);
    } else {
      throw new AttachmentError(`"${attachment.filename}" isn't a supported file type (only images and PDFs).`);
    }
  }
  return { parts, notices };
}
