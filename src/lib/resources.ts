import { z } from "zod";
import { supabase } from "./supabase.js";
import type { AuthedUser } from "./auth.js";

// Framework-agnostic core for the teacher resource-link endpoints — same pattern
// as materials.ts/conversations.ts, called from both src/routes/resources.ts
// (standalone Fastify) and frontend/vite-plugins/api.ts (local dev), one source
// of truth.
//
// Resources are titled external links (revision videos, past-paper sites,
// simulations) that teachers curate per subject/topic. Unlike materials they are
// NOT ingested into content_chunks — see sql/migrate_add_resources.sql for why.

const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 500;

/** A stored URL is navigated to by *other* users' browsers, so it's treated as
 * untrusted input at the point of storage rather than trusted at the point of
 * render. Only absolute http/https URLs are accepted: `javascript:` and `data:`
 * both parse fine as URLs and would otherwise be a stored-XSS vector the moment
 * one lands in an href, and a relative path would silently resolve against our
 * own origin instead of the teacher's intended destination.
 *
 * Returns the normalised serialisation so the same link typed two ways stores
 * identically. */
function normalizeHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Teachers paste "youtube.com/watch?v=..." constantly, and rejecting that
  // would fail the exact users this feature exists for. Only input with NO
  // scheme at all is upgraded — anything that already declares one is passed
  // through untouched, so a "javascript:" payload still has to face the
  // protocol check below rather than being rewritten into something that
  // sneaks past it.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // A URL with no host ("http:///foo") parses but can't be navigated to.
  if (!parsed.hostname) return null;
  const href = parsed.toString();
  return href.length <= MAX_URL_LENGTH ? href : null;
}

const urlField = z
  .string()
  .min(1, "Link is required")
  .max(MAX_URL_LENGTH, "Link is too long")
  .refine((v) => normalizeHttpUrl(v) !== null, {
    message: "Enter a valid web link, e.g. https://youtube.com/watch?v=...",
  })
  .transform((v) => normalizeHttpUrl(v) as string);

/** Blank optional text arrives from the form as "" rather than undefined, and an
 * empty string stored in a nullable column reads back as a present-but-empty
 * value the UI then has to special-case. Collapse it to null once, here. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length > 0 ? v : null));

const createResourceSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(MAX_TITLE_LENGTH),
  url: urlField,
  subject: z.string().trim().min(1, "Subject is required"),
  // Nullable as well as optional. `ResourceInput` on the client declares
  // `topic?: string | null`, and a form with a blank optional field naturally
  // sends null rather than omitting the key — so a plain `.optional()` rejected
  // every link saved without a topic with a 400 that named no field. The column
  // is nullable by design (a general revision channel has no single topic), so
  // null is a valid value here, not a malformed one.
  topic: optionalText(MAX_TITLE_LENGTH).nullable().optional(),
  description: optionalText(MAX_DESCRIPTION_LENGTH).nullable().optional(),
});

export interface ResourceLink {
  id: string;
  title: string;
  url: string;
  subject: string;
  topic: string | null;
  description: string | null;
  createdAt: string;
  /** The adding teacher's user id — the client compares it against its own id to
   * decide whether to offer edit/delete. The server re-checks ownership on both
   * mutating calls regardless; this is display logic only. */
  uploadedById: string | null;
  uploadedByName: string;
}

const SELECT_COLUMNS = "id, title, url, subject, topic, description, created_at, uploaded_by, uploader:users(display_name, email)";

type ResourceRow = {
  id: string;
  title: string;
  url: string;
  subject: string;
  topic: string | null;
  description: string | null;
  created_at: string;
  uploaded_by: string | null;
  uploader?: { display_name: string | null; email: string | null } | { display_name: string | null; email: string | null }[] | null;
};

function toResourceLink(row: ResourceRow): ResourceLink {
  const uploader = (Array.isArray(row.uploader) ? row.uploader[0] : row.uploader) ?? null;
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    subject: row.subject,
    topic: row.topic,
    description: row.description,
    createdAt: row.created_at,
    uploadedById: row.uploaded_by,
    uploadedByName: uploader?.display_name || uploader?.email || "Unknown teacher",
  };
}

export type CreateResourceResult =
  | { status: 200; body: { resource: ResourceLink } }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 409; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function createResource(user: AuthedUser | null, input: unknown): Promise<CreateResourceResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }
  if (user.role !== "teacher") {
    return { status: 403, body: { error: "Teacher account required" } };
  }

  const parsed = createResourceSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid request" } };
  }
  const { title, url, subject, topic, description } = parsed.data;

  // Same reasoning as the materials content-hash guard: a teacher pasting a
  // batch of links re-submits the same one often enough (a double-click, or the
  // same video genuinely fitting two topics) that silent duplicates pile up in
  // a list students have to scan. Scoped to the same teacher and the same
  // subject, so the same link CAN legitimately be filed under two subjects.
  const { data: existing } = await supabase
    .from("resources")
    .select("id, title")
    .eq("uploaded_by", user.id)
    .eq("subject", subject)
    .eq("url", url)
    .maybeSingle();
  if (existing) {
    return { status: 409, body: { error: `You've already saved this link under ${subject} as "${existing.title}".` } };
  }

  const { data, error } = await supabase
    .from("resources")
    .insert({ uploaded_by: user.id, title, url, subject, topic: topic ?? null, description: description ?? null })
    .select(SELECT_COLUMNS)
    .single();

  if (error || !data) {
    console.error("failed to create resource", error);
    return { status: 500, body: { error: "Couldn't save this link" } };
  }

  return { status: 200, body: { resource: toResourceLink(data as ResourceRow) } };
}

export type ListResourcesResult =
  | { status: 200; body: { resources: ResourceLink[] } }
  | { status: 401; body: { error: string } }
  | { status: 500; body: { error: string } };

/** Every teacher's links, visible to any signed-in user — the point of the
 * feature is that a student finds the right video without knowing which teacher
 * saved it. Ordered to match how the panel groups them (subject → topic →
 * newest) so the UI doesn't have to re-sort the common case. */
export async function listResources(user: AuthedUser | null): Promise<ListResourcesResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const { data, error } = await supabase
    .from("resources")
    .select(SELECT_COLUMNS)
    .order("subject")
    .order("topic", { nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("failed to list resources", error);
    return { status: 500, body: { error: "Couldn't load links" } };
  }

  return { status: 200, body: { resources: (data ?? []).map((row) => toResourceLink(row as ResourceRow)) } };
}

const updateResourceSchema = z
  .object({
    title: z.string().trim().min(1, "Title can't be empty").max(MAX_TITLE_LENGTH).optional(),
    url: urlField.optional(),
    subject: z.string().trim().min(1, "Subject can't be empty").optional(),
    // Explicitly nullable, unlike the create schema's plain optional: clearing a
    // topic back to "no topic" has to be expressible, and `undefined` already
    // means "leave it alone" in a PATCH.
    topic: optionalText(MAX_TITLE_LENGTH).nullable().optional(),
    description: optionalText(MAX_DESCRIPTION_LENGTH).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

export type UpdateResourceResult =
  | { status: 200; body: { resource: ResourceLink } }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function updateResource(
  user: AuthedUser | null,
  resourceId: string,
  input: unknown,
): Promise<UpdateResourceResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }
  if (user.role !== "teacher") {
    return { status: 403, body: { error: "Teacher account required" } };
  }

  const parsed = updateResourceSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid request" } };
  }

  // Scoped to the caller's own links — a teacher can't edit another teacher's
  // link even though the panel shows them everyone's.
  const { data, error } = await supabase
    .from("resources")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", resourceId)
    .eq("uploaded_by", user.id)
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error("failed to update resource", error);
    return { status: 500, body: { error: "Couldn't save changes" } };
  }
  if (!data) {
    // Covers both "no such row" and "not yours" on purpose — a 403 here would
    // confirm to a teacher that some other teacher's link id exists.
    return { status: 404, body: { error: "Link not found" } };
  }

  return { status: 200, body: { resource: toResourceLink(data as ResourceRow) } };
}

export type DeleteResourceResult =
  | { status: 200; body: { id: string } }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function deleteResource(user: AuthedUser | null, resourceId: string): Promise<DeleteResourceResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }
  if (user.role !== "teacher") {
    return { status: 403, body: { error: "Teacher account required" } };
  }

  const { data, error } = await supabase
    .from("resources")
    .delete()
    .eq("id", resourceId)
    .eq("uploaded_by", user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("failed to delete resource", error);
    return { status: 500, body: { error: "Couldn't delete this link" } };
  }
  if (!data) {
    return { status: 404, body: { error: "Link not found" } };
  }

  return { status: 200, body: { id: data.id } };
}
