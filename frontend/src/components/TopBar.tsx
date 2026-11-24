import { useEffect, useRef, useState } from "react";
import { BookIcon, EditIcon, FileIcon, HelpIcon, LinkIcon, MenuIcon, PlusIcon, UploadIcon, UserIcon } from "./Icons";

interface TopBarProps {
  title: string;
  onOpenSidebar: () => void;
  onRenameTitle: (title: string) => void;
  onNewConversation: () => void;
  onOpenMaterials: () => void;
  onOpenResources: () => void;
  onOpenGuide: () => void;
  isTeacher?: boolean;
  onOpenUpload?: () => void;
  onOpenProfile: () => void;
  avatarUrl: string | null;
  /** Files listed for the latest answer; null hides the button (no conversation yet). */
  filesCount: number | null;
  onOpenFiles: () => void;
}

const NAV_BUTTON =
  "flex min-h-[44px] items-center gap-2 rounded-full px-3.5 text-sm text-neutral-300 transition-colors hover:bg-white/5 hover:text-neutral-100";

/** The app's one header ("Night revision" layout): wordmark, the library
 * screens, and the current conversation's title. Chat history lives in the
 * drawer behind the menu button; on narrow screens the library links are in
 * there too. */
export function TopBar({
  title,
  onOpenSidebar,
  onRenameTitle,
  onNewConversation,
  onOpenMaterials,
  onOpenResources,
  onOpenGuide,
  isTeacher,
  onOpenUpload,
  onOpenProfile,
  avatarUrl,
  filesCount,
  onOpenFiles,
}: TopBarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(title), [title]);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  function commit() {
    const trimmed = draft.trim();
    onRenameTitle(trimmed || title);
    setIsEditing(false);
  }

  return (
    <header className="relative z-10 flex h-16 shrink-0 items-center gap-1 border-b border-[var(--color-line)] bg-[var(--color-paper)] px-2 sm:gap-2 sm:px-5">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Chat history"
        title="Chat history"
        className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-300 hover:bg-white/5"
      >
        <MenuIcon className="h-5 w-5" />
      </button>

      <span className="font-display mr-2 text-xl font-bold tracking-tight text-neutral-100">
        SPM<span className="text-[var(--color-brand)]">.</span>tutor
      </span>

      <nav aria-label="Library" className="hidden items-center gap-0.5 md:flex">
        <button type="button" onClick={onOpenMaterials} className={NAV_BUTTON}>
          <BookIcon className="h-4 w-4" /> Materials
        </button>
        <button type="button" onClick={onOpenResources} className={NAV_BUTTON}>
          <LinkIcon className="h-4 w-4" /> Links
        </button>
        <button type="button" onClick={onOpenGuide} className={NAV_BUTTON}>
          <HelpIcon className="h-4 w-4" /> How to use
        </button>
        {isTeacher && onOpenUpload && (
          <button type="button" onClick={onOpenUpload} className={NAV_BUTTON}>
            <UploadIcon className="h-4 w-4" /> Add material
          </button>
        )}
      </nav>

      <div className="mx-2 hidden min-w-0 flex-1 items-center border-l border-[var(--color-line)] pl-4 lg:flex">
        {isEditing ? (
          <input
            ref={inputRef}
            value={draft}
            aria-label="Conversation title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(title);
                setIsEditing(false);
              }
            }}
            className="field w-full max-w-xs rounded-md px-2 py-1 text-sm font-medium outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            title="Rename conversation"
            className="group flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 hover:bg-white/5"
          >
            <span className="truncate text-sm text-neutral-400">{title}</span>
            <EditIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500 opacity-0 group-hover:opacity-100" />
          </button>
        )}
      </div>
      <div className="flex-1 lg:hidden" />

      {/* Wide screens show the Files panel beside the chat instead. */}
      {filesCount !== null && (
        <button
          type="button"
          onClick={onOpenFiles}
          aria-label={`Files (${filesCount})`}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 text-sm text-neutral-300 hover:bg-white/5 hover:text-neutral-100 xl:hidden"
        >
          <FileIcon className="h-4 w-4" />
          <span>{filesCount}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onNewConversation}
        aria-label="New chat"
        className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-full border border-[var(--color-brand)] px-3 text-sm font-semibold text-[var(--color-brand)] transition-colors hover:bg-[var(--color-brand)]/10 sm:px-4"
      >
        <PlusIcon className="h-4 w-4" />
        <span className="hidden sm:inline">New chat</span>
      </button>
      <button
        type="button"
        onClick={onOpenProfile}
        aria-label="Profile"
        title="Profile"
        className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full text-neutral-300 hover:bg-white/5"
      >
        {avatarUrl ? <img src={avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" /> : <UserIcon className="h-5 w-5" />}
      </button>
    </header>
  );
}
