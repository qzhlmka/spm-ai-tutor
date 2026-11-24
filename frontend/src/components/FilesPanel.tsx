import { useEffect, useState, type SVGProps } from "react";
import type { ChatMaterialRef } from "../types";
import { getMaterialDownloadUrl } from "../lib/materialsApi";
import { BookIcon, DownloadIcon, FileIcon, XIcon } from "./Icons";

/** One teacher file. The signed URL is minted on click rather than sent with
 * the message: it lasts 5 minutes, and a message sits on screen far longer.
 * Opens in a new tab, not the library's in-app viewer, so the student keeps
 * their place in the conversation. */
function FileRow({ material }: { material: ChatMaterialRef }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(disposition: "inline" | "attachment") {
    setError(null);
    setBusy(true);
    try {
      const url = await getMaterialDownloadUrl(material.id, disposition);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open this file");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-2 border-b border-[var(--color-line)] py-2">
      <FileIcon className="h-4 w-4 shrink-0 text-neutral-400" />
      <button
        type="button"
        onClick={() => open("inline")}
        disabled={busy}
        title={material.filename}
        className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center text-left disabled:opacity-50"
      >
        <span className="line-clamp-2 w-full break-words text-sm text-neutral-200 hover:underline">{material.filename}</span>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </button>
      <button
        type="button"
        onClick={() => open("attachment")}
        disabled={busy}
        aria-label={`Download ${material.filename}`}
        title="Download"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-100 disabled:opacity-50"
      >
        <DownloadIcon className="h-4 w-4" />
      </button>
    </li>
  );
}

interface FilesListProps {
  materials: ChatMaterialRef[];
  onOpenMaterials: () => void;
}

/** Every file this conversation's answers listed, grouped by topic, newest topic first. */
function FilesList({ materials, onOpenMaterials }: FilesListProps) {
  const topics = [...new Set(materials.map((m) => m.topic))];
  const caption = `${materials.length} ${materials.length === 1 ? "file" : "files"} from this chat`;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-neutral-400">{materials.length > 0 ? caption : "Nothing yet"}</p>
      {materials.length === 0 ? (
        <p className="text-sm leading-6 text-neutral-400">
          Your teachers' files show up here when an answer uses them. Ask for notes on a topic, like "nota termokimia", to see every file on it.
        </p>
      ) : (
        topics.map((topic) => (
          <section key={topic} aria-label={topic}>
            <h3 className="font-mono-label uppercase text-[var(--color-brand)]">{topic}</h3>
            <ul className="mt-1 flex flex-col">
              {materials
                .filter((m) => m.topic === topic)
                .map((m) => (
                  <FileRow key={m.id} material={m} />
                ))}
            </ul>
          </section>
        ))
      )}
      <button
        type="button"
        onClick={onOpenMaterials}
        className="flex min-h-[44px] items-center gap-2 self-start rounded-full px-1 text-sm text-neutral-300 hover:text-neutral-100"
      >
        <BookIcon className="h-4 w-4" /> Browse all materials
      </button>
    </div>
  );
}

// The panel's open/closed choice is a per-viewer convenience, so browser
// storage is fine; it can throw in a private window, hence the guards.
const COLLAPSED_KEY = "filesPanelCollapsed";
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function PanelToggleIcon({ collapsed, ...props }: SVGProps<SVGSVGElement> & { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d={collapsed ? "M10 10l-2 2 2 2" : "M8 10l2 2-2 2"} />
    </svg>
  );
}

/** Beside the chat on wide screens, collapsible to a slim strip that keeps the
 * file count in view. Narrower screens open the same list as a drawer from the
 * top bar's Files button (FilesDrawer). */
export function FilesPanel(props: FilesListProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  function toggle() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // Not remembered this time; the panel still toggles.
      }
      return !c;
    });
  }

  const toggleButton = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Show files (${props.materials.length})` : "Hide files"}
      title={collapsed ? "Show files" : "Hide files"}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/5 hover:text-neutral-100"
    >
      <PanelToggleIcon collapsed={collapsed} className="h-5 w-5" />
    </button>
  );

  if (collapsed) {
    return (
      <aside aria-label="Files from this chat" className="hidden w-16 shrink-0 flex-col items-center gap-2 border-l border-[var(--color-line)] py-6 xl:flex">
        {toggleButton}
        <button
          type="button"
          onClick={toggle}
          tabIndex={-1}
          aria-hidden="true"
          className="flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
        >
          <FileIcon className="h-4 w-4" />
          <span className={`text-xs ${props.materials.length > 0 ? "text-[var(--color-brand)]" : ""}`}>{props.materials.length}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Files from this chat"
      className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-[var(--color-line)] py-6 pl-6 pr-3 xl:flex"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[15px] font-semibold text-neutral-100">Files</h2>
        {toggleButton}
      </div>
      <div id="files-panel-list" className="pr-3">
        <FilesList {...props} />
      </div>
    </aside>
  );
}

export function FilesDrawer({ open, onClose, ...props }: FilesListProps & { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 xl:hidden">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Files from this chat"
        className="absolute inset-y-0 right-0 flex w-[min(22rem,100%)] flex-col gap-4 overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-paper)] px-5 py-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[15px] font-semibold text-neutral-100">Files</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close files"
            className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-300 hover:bg-white/5"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>
        <FilesList
          {...props}
          onOpenMaterials={() => {
            onClose();
            props.onOpenMaterials();
          }}
        />
      </aside>
    </div>
  );
}
