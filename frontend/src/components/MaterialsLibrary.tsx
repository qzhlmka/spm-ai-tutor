import { useEffect, useMemo, useState, type SVGProps } from "react";
import {
  deleteMaterial,
  fetchMaterialsLibrary,
  getMaterialDownloadUrl,
  updateMaterial,
  type LibraryMaterial,
} from "../lib/materialsApi";
import { fetchProfile } from "../lib/profileApi";
import { BookIcon, DownloadIcon, SearchIcon, XIcon } from "./Icons";

// These three glyphs live here rather than in Icons.tsx purely to keep this
// feature self-contained; they follow the same base() conventions.
function iconBase(props: SVGProps<SVGSVGElement>) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

function EyeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconBase(props)}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconBase(props)}>
      <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" />
      <path d="M14.5 6.5 17.5 9.5" />
    </svg>
  );
}

function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconBase(props)}>
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
      <path d="M10.5 11v6M13.5 11v6" />
    </svg>
  );
}

interface MaterialsLibraryProps {
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

type SortOrder = "newest" | "oldest";
const ALL_SUBJECTS = "All subjects";
const ALL_TEACHERS = "All teachers";

interface EditDraft {
  filename: string;
  subject: string;
  topic: string;
}

export function MaterialsLibrary({ onClose }: MaterialsLibraryProps) {
  const [materials, setMaterials] = useState<LibraryMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState(ALL_SUBJECTS);
  const [teacherFilter, setTeacherFilter] = useState(ALL_TEACHERS);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fetched here rather than passed down, so this screen stays a single
  // self-contained prop (`onClose`) — it only needs the id/role to decide which
  // rows get owner-only actions, and the server re-checks ownership anyway.
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);
  const [viewerIsTeacher, setViewerIsTeacher] = useState(false);
  const [viewing, setViewing] = useState<{ material: LibraryMaterial; url: string } | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ filename: "", subject: "", topic: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchMaterialsLibrary()
      .then(setMaterials)
      .catch((err) => console.error("failed to load materials library", err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchProfile()
      .then((profile) => {
        setViewerUserId(profile.id);
        setViewerIsTeacher(profile.role === "teacher");
      })
      .catch((err) => console.error("failed to load profile for materials library", err));
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // The PDF viewer sits on top of this panel, so Escape dismisses it first
      // rather than closing the whole library out from under the student.
      if (viewing) setViewing(null);
      else onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, viewing]);

  const subjects = useMemo(() => [...new Set(materials.map((m) => m.subject))].sort(), [materials]);
  // Only real uploaders belong in the filter — bulk-ingested material has no
  // author, and a "no author" entry in a teacher dropdown reads as a person.
  const teachers = useMemo(
    () => [...new Set(materials.map((m) => m.uploadedByName).filter((n): n is string => n !== null))].sort(),
    [materials],
  );

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = materials.filter((m) => {
      if (subjectFilter !== ALL_SUBJECTS && m.subject !== subjectFilter) return false;
      if (teacherFilter !== ALL_TEACHERS && m.uploadedByName !== teacherFilter) return false;
      if (query && !m.filename.toLowerCase().includes(query) && !m.subject.toLowerCase().includes(query) && !m.topic.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
    const bySubject = new Map<string, LibraryMaterial[]>();
    for (const m of filtered) {
      const list = bySubject.get(m.subject) ?? [];
      list.push(m);
      bySubject.set(m.subject, list);
    }
    for (const list of bySubject.values()) {
      list.sort((a, b) =>
        sortOrder === "newest"
          ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    }
    return [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [materials, search, subjectFilter, teacherFilter, sortOrder]);

  function canManage(m: LibraryMaterial): boolean {
    // Bulk-ingested rows have no owner, so no teacher can claim edit/delete on
    // them from the library. Removing them is a deliberate command-line job.
    return viewerIsTeacher && m.uploadedById !== null && m.uploadedById === viewerUserId;
  }

  async function handleView(material: LibraryMaterial) {
    setError(null);
    setOpeningId(material.id);
    try {
      const url = await getMaterialDownloadUrl(material.id, "inline");
      setViewing({ material, url });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open this file");
    } finally {
      setOpeningId(null);
    }
  }

  async function handleDownload(id: string) {
    setError(null);
    setDownloadingId(id);
    try {
      const url = await getMaterialDownloadUrl(id, "attachment");
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloadingId(null);
    }
  }

  function startEdit(m: LibraryMaterial) {
    setConfirmingId(null);
    setEditingId(m.id);
    setEditDraft({ filename: m.filename, subject: m.subject, topic: m.topic });
  }

  async function handleSaveEdit(id: string) {
    const patch = {
      filename: editDraft.filename.trim(),
      subject: editDraft.subject.trim(),
      topic: editDraft.topic.trim(),
    };
    if (!patch.filename || !patch.subject || !patch.topic) {
      setError("Name, subject and topic can't be empty");
      return;
    }
    setError(null);
    setSavingEdit(true);
    try {
      const saved = await updateMaterial(id, patch);
      setMaterials((prev) =>
        prev.map((m) => (m.id === id ? { ...m, filename: saved.filename, subject: saved.subject, topic: saved.topic } : m)),
      );
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save changes");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    setDeletingId(id);
    try {
      await deleteMaterial(id);
      setMaterials((prev) => prev.filter((m) => m.id !== id));
      setConfirmingId(null);
      if (viewing?.material.id === id) setViewing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Materials">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 sm:px-6">
          <h1 className="font-display text-lg font-semibold text-neutral-800 dark:text-neutral-100">Materials</h1>
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
        {materials.length > 0 && (
          <div className="mb-4 flex flex-col gap-2">
            <div className="field flex items-center gap-2 rounded-lg px-2.5 py-1.5">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search materials"
                aria-label="Search materials"
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
                aria-label="Filter by subject"
                className="field rounded-lg px-2.5 py-1.5 text-xs text-neutral-700 outline-none dark:text-neutral-200"
              >
                <option>{ALL_SUBJECTS}</option>
                {subjects.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select
                value={teacherFilter}
                onChange={(e) => setTeacherFilter(e.target.value)}
                aria-label="Filter by teacher"
                className="field rounded-lg px-2.5 py-1.5 text-xs text-neutral-700 outline-none dark:text-neutral-200"
              >
                <option>{ALL_TEACHERS}</option>
                {teachers.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                aria-label="Sort by date"
                className="field rounded-lg px-2.5 py-1.5 text-xs text-neutral-700 outline-none dark:text-neutral-200"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </div>
          </div>
        )}

        {error && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

        {loading ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading…</p>
        ) : materials.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">No materials uploaded yet.</p>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">No matching materials.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map(([subject, items]) => (
              <div key={subject}>
                <h2 className="font-display mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">{subject}</h2>
                <ul className="flex flex-col gap-2">
                  {items.map((m) => {
                    if (editingId === m.id) {
                      return (
                        <li key={m.id} className="field flex flex-col gap-2 rounded-lg px-3 py-2.5">
                          <label className="flex flex-col gap-1 text-xs">
                            <span className="font-medium text-neutral-600 dark:text-neutral-300">Name</span>
                            <input
                              autoFocus
                              value={editDraft.filename}
                              onChange={(e) => setEditDraft({ ...editDraft, filename: e.target.value })}
                              className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
                            />
                          </label>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <label className="flex flex-1 flex-col gap-1 text-xs">
                              <span className="font-medium text-neutral-600 dark:text-neutral-300">Subject</span>
                              <input
                                value={editDraft.subject}
                                onChange={(e) => setEditDraft({ ...editDraft, subject: e.target.value })}
                                className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
                              />
                            </label>
                            <label className="flex flex-1 flex-col gap-1 text-xs">
                              <span className="font-medium text-neutral-600 dark:text-neutral-300">Topic</span>
                              <input
                                value={editDraft.topic}
                                onChange={(e) => setEditDraft({ ...editDraft, topic: e.target.value })}
                                className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
                              />
                            </label>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="min-h-[44px] rounded-lg px-3 text-xs font-medium text-neutral-500 hover:bg-black/5 sm:min-h-0 sm:py-2 dark:text-neutral-400 dark:hover:bg-white/5"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={savingEdit}
                              onClick={() => handleSaveEdit(m.id)}
                              className="min-h-[44px] rounded-lg bg-[var(--color-brand)] px-3 text-xs font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-40 sm:min-h-0 sm:py-2"
                            >
                              {savingEdit ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </li>
                      );
                    }

                    return (
                      <li key={m.id} className="field flex flex-col gap-2 rounded-lg px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <BookIcon className="h-4 w-4 shrink-0 text-neutral-400" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">{m.filename}</p>
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">
                              {m.topic}
                              {m.uploadedByName ? ` · ${m.uploadedByName}` : ""} · {formatDate(m.createdAt)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => handleView(m)}
                              disabled={openingId === m.id}
                              aria-label={`View ${m.filename}`}
                              title={`View ${m.filename}`}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/5"
                            >
                              <EyeIcon className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDownload(m.id)}
                              disabled={downloadingId === m.id}
                              aria-label={`Download ${m.filename}`}
                              title={`Download ${m.filename}`}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/5"
                            >
                              <DownloadIcon className="h-4 w-4" />
                            </button>
                            {canManage(m) && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => startEdit(m)}
                                  aria-label={`Edit ${m.filename}`}
                                  title={`Edit ${m.filename}`}
                                  className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
                                >
                                  <PencilIcon className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmingId(confirmingId === m.id ? null : m.id)}
                                  aria-label={`Delete ${m.filename}`}
                                  title={`Delete ${m.filename}`}
                                  className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-red-600/10 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
                                >
                                  <TrashIcon className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {confirmingId === m.id && (
                          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-line)] pt-2">
                            <p className="mr-auto text-xs text-neutral-600 dark:text-neutral-300">
                              Delete this material? The tutor stops using it too.
                            </p>
                            <button
                              type="button"
                              onClick={() => setConfirmingId(null)}
                              className="rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={deletingId === m.id}
                              onClick={() => handleDelete(m.id)}
                              className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                            >
                              {deletingId === m.id ? "Deleting…" : "Delete"}
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

      {viewing && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-2 sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setViewing(null);
          }}
        >
          <div
            className="surface flex h-full max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-label={viewing.material.filename}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">{viewing.material.filename}</p>
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                  {viewing.material.subject} · {viewing.material.topic}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleDownload(viewing.material.id)}
                  disabled={downloadingId === viewing.material.id}
                  aria-label="Download"
                  title="Download"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/5"
                >
                  <DownloadIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewing(null)}
                  aria-label="Close preview"
                  title="Close preview"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            {/* The signed URL expires in 5 minutes, but the browser's PDF viewer
                has the whole file by then — expiry only bites on a reload, which
                is what the "open in a new tab" fallback below is for. */}
            <iframe src={viewing.url} title={viewing.material.filename} className="min-h-0 flex-1 w-full border-0 bg-neutral-100 dark:bg-neutral-900" />
            <p className="shrink-0 border-t border-[var(--color-line)] px-4 py-2 text-xs text-neutral-500 dark:text-neutral-400">
              Can't see the PDF?{" "}
              <a href={viewing.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-700 dark:hover:text-neutral-200">
                Open it in a new tab
              </a>
              .
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
