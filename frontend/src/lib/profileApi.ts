import { supabase } from "./supabaseClient";

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/** One LLM the signed-in user may pick for the tutoring answer. The server
 * decides this list from the credentials it holds and the caller's role, so the
 * UI never has to know which providers exist or why one is missing. */
export interface ProviderInfo {
  id: string;
  label: string;
  model: string;
  configured: boolean;
  availableToStudents: boolean;
  /** Why a teacher is seeing a provider students can't use. Null when there's
   * nothing to explain. */
  note: string | null;
}

export interface Profile {
  id: string;
  email: string | null;
  role: "student" | "teacher";
  avatarUrl: string | null;
  displayName: string | null;
  usage: { usedUsd: number; limitUsd: number } | null;
  providers: ProviderInfo[];
  defaultProvider: string;
}

export async function fetchProfile(): Promise<Profile> {
  const res = await fetch("/api/profile", { headers: await authHeader() });
  if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
  return (await res.json()) as Profile;
}

export async function uploadAvatar(input: { mimeType: string; fileBase64: string }): Promise<{ avatarUrl: string }> {
  const res = await fetch("/api/profile/avatar", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to upload avatar (${res.status})`);
  }
  return (await res.json()) as { avatarUrl: string };
}

export async function updateDisplayName(displayName: string): Promise<{ displayName: string | null }> {
  const res = await fetch("/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to save name (${res.status})`);
  }
  return (await res.json()) as { displayName: string | null };
}
