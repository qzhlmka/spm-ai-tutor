import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { deleteMaterial, fetchMaterials, uploadMaterial, type Material } from "../lib/materialsApi";
import { createResource, deleteResource, fetchResources, isSafeHttpUrl, type ResourceLink } from "../lib/resourcesApi";
import { fetchProfile } from "../lib/profileApi";
import { LinkIcon, TrashIcon, UploadIcon, XIcon } from "./Icons";

interface MaterialUploadProps {
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusLabel(status: string): string {
  if (status === "done") return "Ready";
  if (status === "failed") return "Failed";
  return "Processing…";
}

// The platform is SPM-only, so there's nothing to ask the teacher — every
// upload is tagged with this exam board without showing the field.
const EXAM_BOARD = "SPM";

function splitExtension(filename: string): { base: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? { base: filename.slice(0, dot), ext: filename.slice(dot) } : { base: filename, ext: "" };
}

type SortOrder = "newest" | "oldest";
const ALL_SUBJECTS = "All subjects";

/** The two things a teacher can contribute. They are asked for the same
 * describing fields — name, subject, topic — because from a student's side they
 * serve the same purpose, and a teacher shouldn't have to learn that one lives
 * behind "Upload" and the other behind a separate panel. What they do afterwards
 * is completely different, though: a PDF is OCR'd and chunked into the retrieval
 * knowledge base, a link is only ever a pointer (see sql/migrate_add_resources.sql
 * for why a link is deliberately not embedded). The copy under each form says so,
 * since "the tutor will teach from this" is true of exactly one of them. */
type UploadKind = "material" | "link";

interface LinkDraft {
  name: string;
  url: string;
  subject: string;
  topic: string;
  note: string;
}

const EMPTY_LINK: LinkDraft = { name: "", url: "", subject: "", topic: "", note: "" };

export function MaterialUpload({ onClose }: MaterialUploadProps) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [materialsLoading, setMaterialsLoading] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Deleting from here (rather than only from the Materials library) is what
  // reaches an upload whose ingestion or file storage failed — those never
  // appear in the library at all, yet a storage-failed upload still has live
  // chunks the tutor teaches from.
  async function handleDelete(materialId: string) {
    setDeletingId(materialId);
    setDeleteError(null);
    try {
      await deleteMaterial(materialId);
      setMaterials((prev) => prev.filter((m) => m.id !== materialId));
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete that material.");
    } finally {
      setDeletingId(null);
    }
  }
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subjectFilter, setSubjectFilter] = useState(ALL_SUBJECTS);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");

  const [kind, setKind] = useState<UploadKind>("material");
  const [link, setLink] = useState<LinkDraft>(EMPTY_LINK);
  const [links, setLinks] = useState<ResourceLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);
  const [confirmDeleteLinkId, setConfirmDeleteLinkId] = useState<string | null>(null);
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);

  // /api/resources returns the whole catalogue (it is the student-facing list),
  // so "your links" is filtered client-side the same way the materials library
  // decides which rows to show manage actions on. The server re-checks ownership
  // on delete regardless.
  const myLinks = useMemo(
    () =>
      links
        .filter((r) => viewerUserId !== null && r.uploadedById === viewerUserId)
        .sort((a, b) =>
          sortOrder === "newest"
            ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [links, viewerUserId, sortOrder],
  );

  const uploadSubjects = useMemo(() => [...new Set(materials.map((m) => m.subject))].sort(), [materials]);
  const visibleMaterials = useMemo(() => {
    const filtered = subjectFilter === ALL_SUBJECTS ? materials : materials.filter((m) => m.subject === subjectFilter);
    return [...filtered].sort((a, b) =>
      sortOrder === "newest"
        ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [materials, subjectFilter, sortOrder]);

  function loadMaterials() {
    setMaterialsLoading(true);
    fetchMaterials()
      .then(setMaterials)
      .catch((err) => console.error("failed to load materials", err))
      .finally(() => setMaterialsLoading(false));
  }

  function loadLinks() {
    setLinksLoading(true);
    fetchResources()
      .then(setLinks)
      .catch((err) => console.error("failed to load links", err))
      .finally(() => setLinksLoading(false));
  }

  useEffect(() => {
    loadMaterials();
    loadLinks();
    fetchProfile()
      .then((profile) => setViewerUserId(profile.id))
      .catch((err) => console.error("failed to load profile", err));
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (selected && selected.type !== "application/pdf") {
      setError("Only PDF files are supported right now.");
      return;
    }
    setError(null);
    setFile(selected);
    if (selected) setName((prev) => (prev.trim() ? prev : splitExtension(selected.name).base));
  }

  async function handleAddLink(e: FormEvent) {
    e.preventDefault();
    const name = link.name.trim();
    const url = link.url.trim();
    const subject = link.subject.trim();
    if (!name || !url || !subject || submitting) return;
    if (!isSafeHttpUrl(url)) {
      setError("That doesn't look like a web address — it needs to start with http:// or https://");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const saved = await createResource({
        title: name,
        url,
        subject,
        // Empty means "no topic", not an empty string: the column is nullable on
        // purpose (a general revision channel has no single topic), and storing
        // "" would put a blank heading in the student-facing grouping.
        topic: link.topic.trim() || null,
        description: link.note.trim() || null,
      });
      setLinks((prev) => [saved, ...prev]);
      setLink(EMPTY_LINK);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this link");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteLink(id: string) {
    setDeletingLinkId(id);
    setDeleteError(null);
    try {
      await deleteResource(id);
      setLinks((prev) => prev.filter((r) => r.id !== id));
      setConfirmDeleteLinkId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete that link.");
    } finally {
      setDeletingLinkId(null);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file || !name.trim() || !subject.trim() || !topic.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const { ext } = splitExtension(file.name);
      await uploadMaterial({
        file,
        filename: `${name.trim()}${ext}`,
        examBoard: EXAM_BOARD,
        subject: subject.trim(),
        topic: topic.trim(),
      });
      setFile(null);
      setName("");
      setSubject("");
      setTopic("");
      loadMaterials();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Add material or link">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 sm:px-6">
          <h1 className="font-display text-lg font-semibold text-neutral-800 dark:text-neutral-100">
            {kind === "material" ? "Upload Materials" : "Add a Link"}
          </h1>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="rounded-lg p-2 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          {/* The choice comes first, before any field, because the two paths
              diverge completely after this point and a teacher who fills in a
              name and subject before discovering they picked the wrong one has
              to start over. */}
          <div className="mb-4 flex gap-1 rounded-xl border border-[var(--color-line)] p-1" role="tablist" aria-label="What to add">
            {(["material", "link"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                onClick={() => {
                  setKind(k);
                  setError(null);
                }}
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors sm:min-h-0 sm:py-2 ${
                  kind === k
                    ? "bg-[var(--color-brand)] text-[var(--color-on-brand)]"
                    : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
                }`}
              >
                {k === "material" ? <UploadIcon className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
                {k === "material" ? "Material (PDF)" : "Link"}
              </button>
            ))}
          </div>

          {kind === "link" ? (
            <form onSubmit={handleAddLink} className="field flex flex-col gap-3 p-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">Name</span>
                <input
                  value={link.name}
                  onChange={(e) => setLink({ ...link, name: e.target.value })}
                  placeholder="e.g. Differentiation crash course"
                  className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
                <span className="text-xs text-neutral-400 dark:text-neutral-500">What students see instead of the raw address.</span>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">Link</span>
                <input
                  value={link.url}
                  onChange={(e) => setLink({ ...link, url: e.target.value })}
                  placeholder="https://..."
                  inputMode="url"
                  className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">Subject</span>
                <input
                  value={link.subject}
                  onChange={(e) => setLink({ ...link, subject: e.target.value })}
                  placeholder="e.g. Add Maths"
                  className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  Topic <span className="font-normal text-neutral-400 dark:text-neutral-500">(optional)</span>
                </span>
                <input
                  value={link.topic}
                  onChange={(e) => setLink({ ...link, topic: e.target.value })}
                  placeholder="e.g. Differentiation"
                  className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
                <span className="text-xs text-neutral-400 dark:text-neutral-500">
                  Leave blank for something that spans a whole subject — it files under General.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  Note <span className="font-normal text-neutral-400 dark:text-neutral-500">(optional)</span>
                </span>
                <input
                  value={link.note}
                  onChange={(e) => setLink({ ...link, note: e.target.value })}
                  placeholder="e.g. Watch before the Chapter 2 quiz"
                  className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
              </label>

              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={!link.name.trim() || !link.url.trim() || !link.subject.trim() || submitting}
                className="self-start rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-40"
              >
                {submitting ? "Saving…" : "Save link"}
              </button>
              {/* Stated plainly because it is the one real difference between the
                  two tabs, and a teacher would otherwise reasonably assume a link
                  they saved becomes something the tutor can teach from. */}
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Students find this under Links. The tutor can point them to it, but it doesn't read the page —
                only uploaded PDFs become material it teaches from.
              </p>
            </form>
          ) : (
          <form onSubmit={handleSubmit} className="field flex flex-col gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">PDF file</span>
              <input
                type="file"
                accept="application/pdf"
                onChange={handleFileSelected}
                className="text-sm text-neutral-600 file:mr-3 file:rounded-lg file:border file:border-[var(--color-line)] file:bg-[var(--color-surface)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-neutral-700 hover:file:bg-black/5 dark:text-neutral-300 dark:file:text-neutral-200 dark:hover:file:bg-white/5"
              />
              {file && <span className="text-xs text-neutral-500 dark:text-neutral-400">{file.name}</span>}
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Carbon Compounds Notes"
                className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
              <span className="text-xs text-neutral-400 dark:text-neutral-500">Shown to students instead of the raw file name.</span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Add Maths"
                className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">Topic</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Differentiation"
                className="field rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
            </label>

            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={!file || !name.trim() || !subject.trim() || !topic.trim() || submitting}
              className="self-start rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-40"
            >
              {submitting ? "Processing…" : "Upload"}
            </button>
            {submitting && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">This can take a few minutes for large files.</p>
            )}
          </form>
          )}

          <div className="mt-8 mb-2 flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              {kind === "material" ? "Your uploads" : "Your links"}
            </h2>
            {kind === "material" && materials.length > 0 && (
              <div className="flex gap-2">
                <select
                  value={subjectFilter}
                  onChange={(e) => setSubjectFilter(e.target.value)}
                  aria-label="Filter by subject"
                  className="field rounded-lg px-2 py-1 text-xs text-neutral-700 outline-none dark:text-neutral-200"
                >
                  <option>{ALL_SUBJECTS}</option>
                  {uploadSubjects.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                  aria-label="Sort by date"
                  className="field rounded-lg px-2 py-1 text-xs text-neutral-700 outline-none dark:text-neutral-200"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </div>
            )}
          </div>
          {deleteError && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{deleteError}</p>}

          {kind === "link" ? (
            linksLoading ? (
              <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading…</p>
            ) : myLinks.length === 0 ? (
              <p className="text-sm text-neutral-400 dark:text-neutral-500">No links saved yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {myLinks.map((r) => (
                  <li key={r.id} className="field flex flex-col gap-0.5 rounded-lg px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-neutral-800 dark:text-neutral-200">{r.title}</span>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteLinkId(r.id)}
                        aria-label={`Delete ${r.title}`}
                        title={`Delete ${r.title}`}
                        className="shrink-0 rounded-md p-1 text-neutral-400 transition-colors hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/5 dark:hover:text-red-400"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {r.subject} · {r.topic ?? "General"} · {formatDate(r.createdAt)}
                    </span>
                    {/* Shown as plain text when it isn't a real http(s) address,
                        so a bad stored value can never become a live href. */}
                    {isSafeHttpUrl(r.url) ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-xs text-[var(--color-brand)] hover:underline"
                      >
                        {r.url}
                      </a>
                    ) : (
                      <span className="truncate text-xs text-neutral-400 dark:text-neutral-500">{r.url}</span>
                    )}
                    {confirmDeleteLinkId === r.id && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] pt-1.5">
                        <span className="text-xs text-neutral-600 dark:text-neutral-300">
                          Delete this link? Students stop seeing it.
                        </span>
                        <div className="ml-auto flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteLinkId(null)}
                            className="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={deletingLinkId === r.id}
                            onClick={() => void handleDeleteLink(r.id)}
                            className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            {deletingLinkId === r.id ? "Deleting…" : "Delete"}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : materialsLoading ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading…</p>
          ) : materials.length === 0 ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">No materials uploaded yet.</p>
          ) : visibleMaterials.length === 0 ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">No matching uploads.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visibleMaterials.map((m) => (
                <li key={m.id} className="field flex flex-col gap-0.5 rounded-lg px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-neutral-800 dark:text-neutral-200">{m.filename}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={
                          m.status === "failed"
                            ? "text-xs text-red-600 dark:text-red-400"
                            : "text-xs text-neutral-500 dark:text-neutral-400"
                        }
                      >
                        {statusLabel(m.status)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(m.id)}
                        aria-label={`Delete ${m.filename}`}
                        title={`Delete ${m.filename}`}
                        className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/5 dark:hover:text-red-400"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {m.subject} · {m.topic} · {m.chunkCount} chunks · {formatDate(m.createdAt)}
                  </span>
                  {m.status === "failed" && m.error && (
                    <span className="text-xs text-red-600 dark:text-red-400">{m.error}</span>
                  )}
                  {m.status === "done" && !m.hasFile && (
                    <span className="text-xs text-amber-600 dark:text-amber-500">
                      The tutor can teach from this, but the original file wasn't saved — students can't open or
                      download it. Re-upload to fix.
                    </span>
                  )}
                  {confirmDeleteId === m.id && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] pt-1.5">
                      <span className="text-xs text-neutral-600 dark:text-neutral-300">
                        Delete this material? The tutor stops using it too.
                      </span>
                      <div className="ml-auto flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={deletingId === m.id}
                          onClick={() => void handleDelete(m.id)}
                          className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {deletingId === m.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
