import { z } from "zod";
import { listProviders, DEFAULT_PROVIDER, type ProviderInfo, type ProviderId } from "./providers.js";
import { supabase } from "./supabase.js";
import { getTodayUsageUsd, STUDENT_DAILY_BUDGET_USD } from "./usage.js";
import type { AuthedUser } from "./auth.js";

// Framework-agnostic core for the profile endpoints — same pattern as
// chat-handler.ts/conversations.ts, called from both src/routes/materials.ts
// (standalone Fastify) and frontend/vite-plugins/api.ts (local dev).

export type GetProfileResult =
  | {
      status: 200;
      body: {
        id: string;
        email: string | null;
        role: "student" | "teacher";
        avatarUrl: string | null;
        displayName: string | null;
        // Only present for students — teachers are exempt from the usage cap
        // (see src/lib/usage.ts), so there's nothing meaningful to show them.
        usage: { usedUsd: number; limitUsd: number } | null;
        // Which LLMs this user may pick between for the tutoring answer, and
        // which one answers when they haven't picked. Carried here rather than
        // on its own endpoint because the list is role-dependent (an unpriced
        // provider is teacher-only, see providers.ts) and the client already
        // fetches this to learn the role — a separate call would need the same
        // auth for the same answer.
        providers: ProviderInfo[];
        defaultProvider: ProviderId;
      };
    }
  | { status: 401; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function getProfile(user: AuthedUser | null): Promise<GetProfileResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  // AuthedUser (from requireUser) intentionally only carries id/email/role —
  // fields every request needs for auth-gating. Profile-only fields like the
  // avatar/name are fetched here instead, so the auth check itself stays cheap.
  const { data, error } = await supabase
    .from("users")
    .select("avatar_url, display_name")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    console.error("failed to load profile", error);
    return { status: 500, body: { error: "Couldn't load profile" } };
  }

  const usage =
    // No cap, no usage bar: a bar with no limit has nothing to fill towards.
    user.role === "student" && STUDENT_DAILY_BUDGET_USD !== null ? { usedUsd: await getTodayUsageUsd(user.id), limitUsd: STUDENT_DAILY_BUDGET_USD } : null;

  return {
    status: 200,
    body: {
      id: user.id,
      email: user.email,
      role: user.role,
      avatarUrl: data?.avatar_url ?? null,
      displayName: data?.display_name ?? null,
      usage,
      providers: listProviders(user.role),
      defaultProvider: DEFAULT_PROVIDER,
    },
  };
}

// Base64-inflated image cap — see the MAX_BODY_BYTES comment in src/server.ts /
// frontend/vite-plugins/api.ts for the matching request-body ceiling.
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

const ALLOWED_AVATAR_MIME_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const uploadAvatarSchema = z.object({
  mimeType: z.string().min(1),
  fileBase64: z.string().min(1),
});

export type UploadAvatarResult =
  | { status: 200; body: { avatarUrl: string } }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function uploadAvatar(user: AuthedUser | null, input: unknown): Promise<UploadAvatarResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const parsed = uploadAvatarSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid request" } };
  }
  const { mimeType, fileBase64 } = parsed.data;

  const ext = ALLOWED_AVATAR_MIME_TYPES[mimeType];
  if (!ext) {
    return { status: 400, body: { error: "Only PNG, JPEG, or WebP images are supported" } };
  }

  const buffer = Buffer.from(fileBase64, "base64");
  if (buffer.byteLength > MAX_AVATAR_BYTES) {
    return { status: 400, body: { error: `Image too large — max ${Math.floor(MAX_AVATAR_BYTES / (1024 * 1024))}MB` } };
  }

  // Fixed filename per user (not the original filename) so re-uploading
  // overwrites in place instead of accumulating orphaned files in the bucket.
  const path = `${user.id}/avatar.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (uploadError) {
    console.error("failed to upload avatar", uploadError);
    return { status: 500, body: { error: "Couldn't upload image" } };
  }

  const { data: publicUrlData } = supabase.storage.from("avatars").getPublicUrl(path);
  // Cache-bust: the storage path is stable across re-uploads, so without this
  // the browser (and any CDN) would keep serving the previous cached image.
  const avatarUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

  const { error: updateError } = await supabase.from("users").update({ avatar_url: avatarUrl }).eq("id", user.id);
  if (updateError) {
    console.error("failed to save avatar url", updateError);
    return { status: 500, body: { error: "Couldn't save profile" } };
  }

  return { status: 200, body: { avatarUrl } };
}

// Display names are shown to the student in the greeting and profile panel, and
// are the only user-authored text in this app that isn't a chat message. Kept
// deliberately narrow: a trimmed, single-line, length-capped string, or null to
// fall back to the email-derived name the UI already uses.
const MAX_DISPLAY_NAME_LENGTH = 60;

const updateProfileSchema = z.object({
  displayName: z
    .string()
    .max(MAX_DISPLAY_NAME_LENGTH, `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`)
    // Collapse any internal whitespace (including a pasted newline) to single
    // spaces so a name can't break the layout it's rendered into.
    .transform((v) => v.replace(/\s+/g, " ").trim()),
});

export type UpdateProfileResult =
  | { status: 200; body: { displayName: string | null } }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function updateProfile(user: AuthedUser | null, input: unknown): Promise<UpdateProfileResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid request" } };
  }

  // An emptied field clears the name rather than storing "", so getProfile's
  // `displayName ?? fallback` keeps working instead of rendering a blank line.
  const displayName = parsed.data.displayName.length > 0 ? parsed.data.displayName : null;

  // Scoped to the caller's own row — `role` and `email` are untouched, so this
  // endpoint can never be used to self-promote to 'teacher'.
  const { error } = await supabase.from("users").update({ display_name: displayName }).eq("id", user.id);
  if (error) {
    console.error("failed to update profile", error);
    return { status: 500, body: { error: "Couldn't save your name" } };
  }

  return { status: 200, body: { displayName } };
}
