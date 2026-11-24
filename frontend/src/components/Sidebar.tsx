import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "../types";
import {
  BookIcon,
  EditIcon,
  HelpIcon,
  LinkIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
  UploadIcon,
  UserIcon,
} from "./Icons";

interface SidebarProps {
  conversations: Conversation[];
  conversationsLoading: boolean;
  activeConversationId: string | null;
  isOpen: boolean;
  onClose: () => void;
  /** Desktop-only collapse (persisted): unlike `isOpen`, which drives the mobile
   * overlay drawer, this shrinks the docked sidebar to a slim icon rail instead
   * of hiding it as a modal. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onRenameConversation: (id: string, title: string) => Promise<void>;
  onToggleStarConversation: (id: string, starred: boolean) => Promise<void>;
  onDeleteConversation: (id: string) => Promise<void>;
  userEmail: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  onOpenProfile: () => void;
  onLogout: () => void;
  /** Only teachers see the "Add Material" entry (PDF upload or a link) — undefined/false hides it entirely. */
  isTeacher?: boolean;
  onOpenUpload?: () => void;
  /** "Materials" (browse/download) is visible to every signed-in user, students included. */
  onOpenMaterials: () => void;
  /** "Links" (teacher-curated videos/websites) is visible to every signed-in user too. */
  onOpenResources: () => void;
  onOpenGuide: () => void;
}

interface ContextMenuState {
  id: string;
  x: number;
  y: number;
}

const MENU_WIDTH_PX = 176;
const MENU_HEIGHT_PX = 132;

function formatTimestamp(ms: number): string {
  const diffMs = Date.now() - ms;
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${Math.round(diffHours)}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Sidebar({
  conversations,
  conversationsLoading,
  activeConversationId,
  isOpen,
  onClose,
  onSelectConversation,
  onNewConversation,
  onRenameConversation,
  onToggleStarConversation,
  onDeleteConversation,
  userEmail,
  displayName,
  avatarUrl,
  onOpenProfile,
  onLogout,
  isTeacher,
  onOpenUpload,
  onOpenMaterials,
  onOpenResources,
  onOpenGuide,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const [showStarredOnly, setShowStarredOnly] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    function close() {
      setContextMenu(null);
    }
    function closeOnEscape(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("click", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  function openContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - MENU_WIDTH_PX - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_HEIGHT_PX - 8);
    setContextMenu({ id, x, y });
  }

  function startRename(conversation: Conversation) {
    setRenamingId(conversation.id);
    setRenameDraft(conversation.title);
    setContextMenu(null);
  }

  async function commitRename(conversation: Conversation) {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === conversation.title) return;
    try {
      await onRenameConversation(conversation.id, trimmed);
    } catch (err) {
      console.error("failed to rename conversation", err);
    }
  }

  async function toggleStar(conversation: Conversation) {
    setContextMenu(null);
    try {
      await onToggleStarConversation(conversation.id, !conversation.starred);
    } catch (err) {
      console.error("failed to star conversation", err);
    }
  }

  function startDelete(id: string) {
    setContextMenu(null);
    setConfirmingId(id);
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await onDeleteConversation(id);
    } catch (err) {
      console.error("failed to delete conversation", err);
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  }

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    return conversations
      .filter((c) => !showStarredOnly || c.starred)
      .filter((c) => !query || c.title.toLowerCase().includes(query));
  }, [conversations, search, showStarredOnly]);

  const menuConversation = contextMenu ? conversations.find((c) => c.id === contextMenu.id) : undefined;

  return (
    <>
      {/* Chat history is a drawer at every width (the "Night revision" layout
          moved navigation to the top bar), so the scrim is too. */}
      {isOpen && <div className="fixed inset-0 z-20 bg-black/50" onClick={onClose} aria-hidden="true" />}

      <aside
        aria-label="Chat history"
        aria-hidden={!isOpen}
        inert={!isOpen}
        className={`surface fixed inset-y-0 left-0 z-30 flex w-80 max-w-[85vw] shrink-0 flex-col rounded-none border-y-0 border-l-0 transition-transform duration-200 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
        <div className="px-3 pt-3">
          <span className="font-display text-lg font-bold tracking-tight">SPM<span className="text-[var(--color-brand)]">.</span>tutor</span>
        </div>
        <div className="flex items-center justify-between gap-2 p-3">
          <button
            type="button"
            onClick={() => {
              setSearch("");
              onNewConversation();
            }}
            className="flex flex-1 items-center gap-2 rounded-lg bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)]"
          >
            <PlusIcon className="h-4 w-4" />
            New conversation
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat history"
            title="Close chat history"
            className="rounded-lg p-2 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            <PanelLeftCloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-1 px-3 pb-1">
          {isTeacher && (
            <button
              type="button"
              onClick={onOpenUpload}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
            >
              <UploadIcon className="h-4 w-4" />
              Add Material
            </button>
          )}
          <button
            type="button"
            onClick={onOpenMaterials}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            <BookIcon className="h-4 w-4" />
            Materials
          </button>
          <button
            type="button"
            onClick={onOpenResources}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            <LinkIcon className="h-4 w-4" />
            Links
          </button>
          <button
            type="button"
            onClick={onOpenGuide}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            <HelpIcon className="h-4 w-4" />
            How to use
          </button>
        </div>

        {!conversationsLoading && conversations.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 pb-2">
            <div className="field flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search threads"
                aria-label="Search conversations"
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowStarredOnly((v) => !v)}
              aria-label={showStarredOnly ? "Show all conversations" : "Show starred conversations"}
              aria-pressed={showStarredOnly}
              title={showStarredOnly ? "Show all conversations" : "Show starred conversations"}
              className={`field flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                showStarredOnly
                  ? "border-[var(--color-brand)] text-[var(--color-brand)]"
                  : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              }`}
            >
              <StarIcon className="h-3.5 w-3.5" fill={showStarredOnly ? "currentColor" : "none"} />
            </button>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-2 pb-3" onScroll={() => setContextMenu(null)}>
          {conversationsLoading ? (
            <ul className="flex flex-col gap-0.5 px-1 py-1">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="px-2 py-1.5">
                  <div
                    className="h-3.5 w-3/4 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800"
                    style={{ animationDelay: `${i * 80}ms` }}
                  />
                  <div
                    className="mt-1.5 h-2.5 w-1/3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800"
                    style={{ animationDelay: `${i * 80}ms` }}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filteredConversations.length === 0 && (
                <li className="px-3 py-2 text-sm text-neutral-400 dark:text-neutral-500">
                  {showStarredOnly ? "No starred conversations yet." : "No matching threads."}
                </li>
              )}
              {filteredConversations.map((conversation) => {
                const isActive = conversation.id === activeConversationId;

                if (confirmingId === conversation.id) {
                  return (
                    <li key={conversation.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2">
                      <span className="text-xs text-neutral-600 dark:text-neutral-300">Delete this thread?</span>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => setConfirmingId(null)}
                          className="rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={deletingId === conversation.id}
                          onClick={() => handleDelete(conversation.id)}
                          className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                        >
                          {deletingId === conversation.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </li>
                  );
                }

                if (renamingId === conversation.id) {
                  return (
                    <li key={conversation.id} className="px-1">
                      <input
                        ref={renameInputRef}
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitRename(conversation)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(conversation);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="field w-full rounded-lg px-2 py-1.5 text-sm outline-none"
                      />
                    </li>
                  );
                }

                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        onSelectConversation(conversation.id);
                      }}
                      onContextMenu={(e) => openContextMenu(e, conversation.id)}
                      className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${
                        isActive ? "bg-black/5 dark:bg-white/10" : "hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        {conversation.starred && (
                          <StarIcon
                            className="h-3 w-3 shrink-0 text-[var(--color-accent-text)]"
                            fill="currentColor"
                            stroke="none"
                          />
                        )}
                        <span className="truncate text-sm text-neutral-800 dark:text-neutral-200">
                          {conversation.title}
                        </span>
                      </span>
                      <span className="text-xs text-neutral-400 dark:text-neutral-500">
                        {formatTimestamp(conversation.updatedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-line)] p-3">
          <button
            type="button"
            onClick={onOpenProfile}
            className="flex min-w-0 items-center gap-2 rounded-lg py-1 pr-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-brand)] text-[var(--color-on-brand)]">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <UserIcon className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="min-w-0 truncate text-xs text-neutral-500 dark:text-neutral-400">
              {displayName ?? userEmail}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setLogoutConfirmOpen(true)}
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            Log out
          </button>
        </div>
        </div>
        </div>
      </aside>

      {contextMenu && menuConversation && (
        <div
          className="surface fixed z-40 flex w-44 flex-col gap-0.5 p-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => startRename(menuConversation)}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            <EditIcon className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            type="button"
            onClick={() => toggleStar(menuConversation)}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            <StarIcon
              className="h-3.5 w-3.5"
              fill={menuConversation.starred ? "currentColor" : "none"}
            />
            {menuConversation.starred ? "Unstar" : "Star"}
          </button>
          <button
            type="button"
            onClick={() => startDelete(menuConversation.id)}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}

      {logoutConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLogoutConfirmOpen(false);
          }}
        >
          <div className="surface flex w-full max-w-sm flex-col gap-4 p-5" role="alertdialog" aria-modal="true" aria-label="Confirm logout">
            <div>
              <h2 className="font-display text-base font-semibold text-neutral-800 dark:text-neutral-100">Log out?</h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                You'll need to sign in again to access your conversations.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setLogoutConfirmOpen(false)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setLogoutConfirmOpen(false);
                  onLogout();
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
