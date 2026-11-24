import { supabase } from "./supabase.js";

export interface AuthedUser {
  id: string;
  email: string | null;
  role: "student" | "teacher";
}

/** Verifies a Supabase Auth session token (sent by the frontend as `Authorization:
 * Bearer <token>`) and ensures a matching public.users row exists — that row's id
 * IS the auth user id, so it's also the user_id every conversation/message belongs
 * to. Returns null for a missing/invalid token; callers should respond 401. */
export async function requireUser(authHeader: string | undefined): Promise<AuthedUser | null> {
  const token = authHeader?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  // Idempotent — only needed so conversations.user_id has a row to reference.
  // Don't hard-fail the request over this write failing; the FK will surface
  // a clear error later if the row is genuinely missing. `role` is never
  // touched by the upsert (omitted from the payload) — it's set only via a
  // manual DB flip for now, so a returning student never re-upserts away an
  // account promoted to 'teacher'. Select it back since upsert alone doesn't
  // return the row.
  const { data: upserted, error: upsertError } = await supabase
    .from("users")
    .upsert({ id: data.user.id, email: data.user.email ?? null }, { onConflict: "id" })
    .select("role")
    .single();
  if (upsertError) {
    console.error("failed to upsert users row", upsertError);
  }

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    role: upserted?.role === "teacher" ? "teacher" : "student",
  };
}
