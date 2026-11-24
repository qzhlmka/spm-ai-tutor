import { supabase } from "./supabaseClient";
import { readFileAsBase64 } from "./fileUtils";

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export interface Material {
  id: string;
  filename: string;
  examBoard: string;
  subject: string;
  topic: string;
  chunkCount: number;
  status: string;
  error: string | null;
  createdAt: string;
  hasFile: boolean;
}

export async function fetchMaterials(): Promise<Material[]> {
  const res = await fetch("/api/materials", { headers: await authHeader() });
  if (!res.ok) throw new Error(`Failed to load materials (${res.status})`);
  const data = (await res.json()) as { materials: Material[] };
  return data.materials;
}

export interface UploadMaterialInput {
  file: File;
  /** Display filename shown everywhere this material appears (library, upload
   * history, chat "from your teacher's notes" references) — defaults to the
   * raw uploaded file's name if not overridden by the teacher. */
  filename: string;
  examBoard: string;
  subject: string;
  topic: string;
}

export async function uploadMaterial(input: UploadMaterialInput): Promise<{ materialId: string; chunkCount: number }> {
  const fileBase64 = await readFileAsBase64(input.file);
  const res = await fetch("/api/materials", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      filename: input.filename,
      mimeType: input.file.type,
      fileBase64,
      examBoard: input.examBoard,
      subject: input.subject,
      topic: input.topic,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Upload failed (${res.status})`);
  return body as { materialId: string; chunkCount: number };
}

export interface LibraryMaterial {
  id: string;
  filename: string;
  examBoard: string;
  subject: string;
  topic: string;
  createdAt: string;
  /** The uploading teacher's user id — compare against the signed-in user's own
   * id (from fetchProfile()) to decide whether to offer the rename/delete
   * actions. The server re-checks ownership itself on both. */
  uploadedById: string | null;
  /** null when the material was bulk-ingested, not uploaded by a person. */
  uploadedByName: string | null;
}

/** Student-facing browse list — every successfully-processed upload from any
 * teacher, unlike fetchMaterials() which is scoped to the current teacher's
 * own uploads. */
export async function fetchMaterialsLibrary(): Promise<LibraryMaterial[]> {
  const res = await fetch("/api/materials/library", { headers: await authHeader() });
  if (!res.ok) throw new Error(`Failed to load materials (${res.status})`);
  const data = (await res.json()) as { materials: LibraryMaterial[] };
  return data.materials;
}

/** Mints a 5-minute signed URL for the original PDF. "inline" keeps the PDF's
 * own content type so the URL can be rendered in an <iframe> without leaving the
 * app; "attachment" makes the browser save it instead. */
export async function getMaterialDownloadUrl(
  materialId: string,
  disposition: "inline" | "attachment" = "inline",
): Promise<string> {
  const res = await fetch(`/api/materials/${materialId}/download?disposition=${disposition}`, {
    headers: await authHeader(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Couldn't get download link (${res.status})`);
  return (body as { url: string }).url;
}

export interface UpdateMaterialInput {
  filename?: string;
  subject?: string;
  topic?: string;
}

export async function updateMaterial(
  materialId: string,
  input: UpdateMaterialInput,
): Promise<{ id: string; filename: string; subject: string; topic: string }> {
  const res = await fetch(`/api/materials/${materialId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Couldn't save changes (${res.status})`);
  return body as { id: string; filename: string; subject: string; topic: string };
}

/** Removes the material row, its stored PDF, and — importantly — every
 * content_chunk ingested from it, so the tutor stops retrieving from it. */
export async function deleteMaterial(materialId: string): Promise<{ id: string; deletedChunks: number }> {
  const res = await fetch(`/api/materials/${materialId}`, { method: "DELETE", headers: await authHeader() });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Couldn't delete material (${res.status})`);
  return body as { id: string; deletedChunks: number };
}
