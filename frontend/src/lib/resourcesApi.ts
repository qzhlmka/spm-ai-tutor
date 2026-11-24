import { supabase } from "./supabaseClient";

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/** A titled external link a teacher saved for their students (revision video,
 * past-paper site, simulation). Unlike a material this has no file and no
 * ingested content — it's a pointer, nothing more. */
export interface ResourceLink {
  id: string;
  title: string;
  url: string;
  subject: string;
  topic: string | null;
  description: string | null;
  createdAt: string;
  /** The saving teacher's user id — compare against the signed-in user's own id
   * (from fetchProfile()) to decide whether to offer edit/delete. The server
   * re-checks ownership itself on both. Null once that teacher's account is
   * deleted. */
  uploadedById: string | null;
  uploadedByName: string;
}


/** The backend rejects anything that isn't http/https before storing it, so this
 * is belt-and-braces for rows predating that check — an href is the one place a
 * bad value becomes executable. Shared by the add form (to catch a typo before a
 * round trip) and the list (which renders a failing link as plain text). */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchResources(): Promise<ResourceLink[]> {
  const res = await fetch("/api/resources", { headers: await authHeader() });
  if (!res.ok) throw new Error(`Failed to load links (${res.status})`);
  const data = (await res.json()) as { resources: ResourceLink[] };
  return data.resources;
}

export interface ResourceInput {
  title: string;
  url: string;
  subject: string;
  topic?: string | null;
  description?: string | null;
}

export async function createResource(input: ResourceInput): Promise<ResourceLink> {
  const res = await fetch("/api/resources", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Couldn't save this link (${res.status})`);
  return (body as { resource: ResourceLink }).resource;
}

/** Fields left out are untouched; `topic`/`description` sent as null clear them. */
export async function updateResource(resourceId: string, input: Partial<ResourceInput>): Promise<ResourceLink> {
  const res = await fetch(`/api/resources/${resourceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Couldn't save changes (${res.status})`);
  return (body as { resource: ResourceLink }).resource;
}

export async function deleteResource(resourceId: string): Promise<void> {
  const res = await fetch(`/api/resources/${resourceId}`, { method: "DELETE", headers: await authHeader() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Couldn't delete this link (${res.status})`);
  }
}
