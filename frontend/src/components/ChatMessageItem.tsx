import { useEffect, useState } from "react";
import type { ChatMessage } from "../types";
import { MarkdownContent } from "./MarkdownContent";
import { TypingIndicator } from "./TypingIndicator";
import { VisualRenderer } from "./VisualRenderer";
import { CheckIcon, CopyIcon, FileIcon, RefreshIcon, XIcon } from "./Icons";

interface ChatMessageItemProps {
  message: ChatMessage;
  /** Only passed for the most recent assistant message — regenerating an older
   * one would orphan every turn that came after it. */
  onRegenerate?: () => void;
  /** Follow-up shortcuts under the most recent answer that presented a
   * past-year question ("Give me a hint", ...). */
  quickActions?: { label: string; onClick: () => void }[];
}

/** Full-size viewer for an attached image. Student testing flagged that tapping
 * an attachment did nothing ("cant open image box / view uploaded media") — the
 * thumbnails are 64px, which is unreadable for a photographed exam question. */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        title="Close image"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <XIcon className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard API needs a secure context and permission; if it's refused
      // there's nothing useful to show the student beyond leaving the button
      // un-ticked, so they know it didn't take.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy answer"}
      title={copied ? "Copied" : "Copy answer"}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/5 dark:hover:text-neutral-200"
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

export function ChatMessageItem({ message, onRegenerate, quickActions }: ChatMessageItemProps) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  if (message.role === "user") {
    return (
      <>
        <div className="message-enter flex justify-end">
          <div className="bubble-user max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-6 text-neutral-900 dark:text-neutral-100">
            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {message.attachments.map((a) =>
                  a.previewUrl ? (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setLightbox({ src: a.previewUrl!, alt: a.filename })}
                      aria-label={`View ${a.filename}`}
                      title={`View ${a.filename}`}
                      className="rounded-lg outline-none ring-offset-1 transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                    >
                      <img src={a.previewUrl} alt={a.filename} className="h-16 w-16 rounded-lg object-cover" />
                    </button>
                  ) : (
                    <span
                      key={a.id}
                      className="field flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-700 dark:text-neutral-200"
                    >
                      <FileIcon className="h-3.5 w-3.5 shrink-0" /> {a.filename}
                    </span>
                  ),
                )}
              </div>
            )}
            {message.content && <div className="whitespace-pre-wrap">{message.content}</div>}
          </div>
        </div>
        {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
      </>
    );
  }

  if (message.status === "error") {
    return (
      <div className="message-enter max-w-[95%] space-y-2">
        <p className="whitespace-pre-wrap text-[15px] text-red-600 dark:text-red-400">
          {message.content || "Something went wrong generating this response."}
        </p>
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-200"
          >
            <RefreshIcon className="h-3.5 w-3.5" /> Try again
          </button>
        )}
      </div>
    );
  }

  const showTyping = message.status === "streaming" && message.content.length === 0;
  const isDone = message.status === "done";

  return (
    <div className="message-enter flex gap-3">
      <div
        aria-hidden="true"
        className="font-display mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand)] text-sm font-bold text-[var(--color-on-brand)]"
      >
        T
      </div>
      <div className="min-w-0 flex-1 text-[15px] text-neutral-800 dark:text-neutral-200">
        {showTyping ? <TypingIndicator /> : <MarkdownContent content={message.content} />}
        {message.visual && <VisualRenderer visual={message.visual} />}

        {/* The real source page for a diagram-dependent past-year question —
            shown instead of a model-redrawn approximation (see examImageNote in
            chat-handler.ts), so the student sees exactly what the paper showed. */}
        {isDone && message.examPageImages && message.examPageImages.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              Diagram from the paper
            </p>
            {message.examPageImages.map((src, i) => {
              const label = message.examPageImageLabels?.[i];
              return (
                <figure key={i} className="exam-paper m-0 max-w-full self-start">
                  {label && <figcaption className="font-mono-label mb-2 uppercase text-[#5b4a1f]">{label}</figcaption>}
                  <img src={src} alt={label ? `Diagram from ${label}` : "Diagram from the original past-year question"} className="block max-w-full" />
                </figure>
              );
            })}
          </div>
        )}

        {isDone && quickActions && quickActions.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {quickActions.map((a, i) => (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                className={`min-h-[44px] rounded-full border px-4 text-sm font-medium transition-colors ${
                  i === 0
                    ? "border-[var(--color-brand)] text-[var(--color-brand)] hover:bg-[var(--color-brand)]/10"
                    : "border-[var(--color-line)] text-neutral-300 hover:bg-white/5"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        {isDone && message.content.length > 0 && (
          <div className="mt-1.5 flex items-center gap-1">
            <CopyButton text={message.content} />
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                aria-label="Regenerate answer"
                title="Regenerate answer"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/5 dark:hover:text-neutral-200"
              >
                <RefreshIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
