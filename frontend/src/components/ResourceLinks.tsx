import { useEffect, useMemo, useState, type Ref } from "react";
import {
  deleteResource,
  fetchResources,
  updateResource,
  isSafeHttpUrl,
  type ResourceLink,
} from "../lib/resourcesApi";
import { fetchProfile } from "../lib/profileApi";
import {
  ExternalLinkIcon,
  LinkIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "./Icons";

interface ResourceLinksProps {
  onClose: () => void;
}

const ALL_SUBJECTS = "All subjects";
const NO_TOPIC = "General";

/** Students scan this list by eye, and a bare URL is long and unreadable —
 * "youtube.com" is the part that tells them what they're about to open. */
function displayHost(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

interface LinkDraft {
  title: string;
  url: string;
  subject: string;
  topic: string;
  description: string;
}

const EMPTY_DRAFT: LinkDraft = { title: "", url: "", subject: "", topic: "", description: "" };

export function ResourceLinks({ onClose }: ResourceLinksProps) {
  const [resources, setResources] = useState<ResourceLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState(ALL_SUBJECTS);
  const [error, setError] = useState<string | null>(null);
  // Fetched here rather than passed down, so this screen stays a single
  // self-contained prop (`onClose`) — it only needs the id/role to decide which
  // rows get owner-only actions, and the server re-checks ownership anyway.
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);
  const [viewerIsTeacher, setViewerIsTeacher] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<LinkDraft>(EMPTY_DRAFT);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchResources()
      .then(setResources)
      .catch((err) => console.error("failed to load resource links", err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchProfile()
      .then((profile) => {
        setViewerUserId(profile.id);
        setViewerIsTeacher(profile.role === "teacher");
      })
      .catch((err) => console.error("failed to load profile for resource links", err));
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Escape backs out one layer at a time rather than discarding a half-typed
      // edit and closing the whole panel in a single keystroke.
      if (editingId) setEditingId(null);
      else onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, editingId]);

  const subjects = useMemo(() => [...new Set(resources.map((r) => r.subject))].sort(), [resources]);

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = resources.filter((r) => {
      if (subjectFilter !== ALL_SUBJECTS && r.subject !== subjectFilter) return false;
      if (!query) return true;
      return [r.title, r.subject, r.topic ?? "", r.description ?? "", r.url]
        .some((field) => field.toLowerCase().includes(query));
    });
    const bySubject = new Map<string, ResourceLink[]>();
    for (const r of filtered) {
      const list = bySubject.get(r.subject) ?? [];
      list.push(r);
      bySubject.set(r.subject, list);
    }
    return [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [resources, search, subjectFilter]);

  function canManage(r: ResourceLink): boolean {
    return viewerIsTeacher && r.uploadedById !== null && r.uploadedById === viewerUserId;
  }

  function draftFrom(r: ResourceLink): LinkDraft {
    return {
      title: r.title,
      url: r.url,
      subject: r.subject,
      topic: r.topic ?? "",
      description: r.description ?? "",
    };
  }

  async function handleSaveEdit(id: string) {
    const title = editDraft.title.trim();
    const url = editDraft.url.trim();
    const subject = editDraft.subject.trim();
    if (!title || !url || !subject) {
      setError("Title, link and subject are required");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await updateResource(id, {
        title,
        url,
        subject,
        topic: editDraft.topic.trim() || null,
        description: editDraft.description.trim() || null,
      });
      setResources((prev) => prev.map((r) => (r.id === id ? saved : r)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save changes");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    setDeletingId(id);
    try {
      await deleteResource(id);
      setResources((prev) => prev.filter((r) => r.id !== id));
      setConfirmingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  function renderForm(draft: LinkDraft, setDraft: (d: LinkDraft) => void, onSave: () => void, onCancel: () => void, titleRef?: Ref<HTMLInputElement>) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">Title</span>
          <input
            ref={titleRef}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Differentiation crash course"
            className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">Link</span>
          <input
            inputMode="url"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://..."
            className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
          />
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">Subject</span>
            <input
              list="resource-subjects"
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="Add Maths"
              className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">Topic (optional)</span>
            <input
              value={draft.topic}
              onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
              placeholder="Differentiation"
              className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">Note for students (optional)</span>
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Watch before the Chapter 2 quiz"
            className="field rounded-lg px-2.5 py-1.5 text-sm outline-none"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] rounded-lg px-3 text-xs font-medium text-neutral-500 hover:bg-black/5 sm:min-h-0 sm:py-2 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="min-h-[44px] rounded-lg bg-[var(--color-brand)] px-3 text-xs font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-40 sm:min-h-0 sm:py-2"
          >
            {saving ? "Saving…" : "Save link"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="surface flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Links"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 sm:px-6">
          <h1 className="font-display text-lg font-semibold text-neutral-800 dark:text-neutral-100">Links</h1>
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
          {/* Existing subjects offered as a datalist rather than leaving subject
              free-text-only: teachers have repeatedly typed the same subject
              several ways across material uploads, which fragments the grouping
              students browse by. One shared list for every subject input on this
              screen (the add form and whichever row is being edited). */}
          <datalist id="resource-subjects">
            {subjects.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>

          {/* Adding a link lives in the upload panel (MaterialUpload), beside
              uploading a PDF: both are "give my students something", and having
              two entry points meant a teacher had to already know which of the
              two kinds they wanted before choosing a screen. Editing and
              deleting stay here, where the link is in front of you — the same
              split the materials library already uses. */}
          {resources.length > 0 && (
            <div className="mb-4 flex flex-col gap-2">
              <div className="field flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search links"
                  aria-label="Search links"
                  className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
              </div>
              <select
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
                aria-label="Filter by subject"
                className="field w-fit rounded-lg px-2.5 py-1.5 text-xs text-neutral-700 outline-none dark:text-neutral-200"
              >
                <option>{ALL_SUBJECTS}</option>
                {subjects.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

          {loading ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading…</p>
          ) : resources.length === 0 ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">
              {viewerIsTeacher
                ? "No links yet. Add a revision video or website and your students will see it here."
                : "Your teachers haven't shared any links yet."}
            </p>
          ) : grouped.length === 0 ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">No matching links.</p>
          ) : (
            <div className="flex flex-col gap-6">
              {grouped.map(([subject, items]) => (
                <div key={subject}>
                  <h2 className="font-display mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">{subject}</h2>
                  <ul className="flex flex-col gap-2">
                    {items.map((r) => {
                      if (editingId === r.id) {
                        return (
                          <li key={r.id} className="field rounded-lg px-3 py-2.5">
                            {renderForm(editDraft, setEditDraft, () => handleSaveEdit(r.id), () => setEditingId(null))}
                          </li>
                        );
                      }

                      const safe = isSafeHttpUrl(r.url);
                      return (
                        <li key={r.id} className="field flex flex-col gap-2 rounded-lg px-3 py-2.5">
                          <div className="flex items-start gap-3">
                            <LinkIcon className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
                            <div className="min-w-0 flex-1">
                              {safe ? (
                                <a
                                  href={r.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-sm font-medium text-neutral-800 hover:underline dark:text-neutral-200"
                                >
                                  <span className="truncate">{r.title}</span>
                                  <ExternalLinkIcon className="h-3 w-3 shrink-0 text-neutral-400" aria-hidden="true" />
                                </a>
                              ) : (
                                <p className="truncate text-sm font-medium text-neutral-500 dark:text-neutral-400">
                                  {r.title} (unsupported link)
                                </p>
                              )}
                              <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                                {r.topic ?? NO_TOPIC} · {displayHost(r.url)} · {r.uploadedByName}
                              </p>
                              {r.description && (
                                <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">{r.description}</p>
                              )}
                            </div>
                            {canManage(r) && (
                              <div className="flex shrink-0 items-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setError(null);
                                    setConfirmingId(null);
                                    setEditingId(r.id);
                                    setEditDraft(draftFrom(r));
                                  }}
                                  aria-label={`Edit ${r.title}`}
                                  title={`Edit ${r.title}`}
                                  className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
                                >
                                  <PencilIcon className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmingId(confirmingId === r.id ? null : r.id)}
                                  aria-label={`Delete ${r.title}`}
                                  title={`Delete ${r.title}`}
                                  className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-red-600/10 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
                                >
                                  <TrashIcon className="h-4 w-4" />
                                </button>
                              </div>
                            )}
                          </div>

                          {confirmingId === r.id && (
                            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-line)] pt-2">
                              <p className="mr-auto text-xs text-neutral-600 dark:text-neutral-300">
                                Remove this link for everyone?
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
                                disabled={deletingId === r.id}
                                onClick={() => handleDelete(r.id)}
                                className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                              >
                                {deletingId === r.id ? "Deleting…" : "Delete"}
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
    </div>
  );
}
