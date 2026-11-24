import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { FileIcon, PaperclipIcon, SendIcon, StopIcon, XIcon } from "./Icons";
import type { ComposerAttachment } from "../types";
import { readFileAsBase64 } from "../lib/fileUtils";

export interface ProviderChoice {
  id: string;
  label: string;
  availableToStudents: boolean;
  note: string | null;
}

interface ChatInputProps {
  placeholder: string;
  /** Whether a reply is currently generating. The composer stays fully usable
   * throughout — student testing flagged the old locked-out composer ("chat is
   * disabled when answer is generating") as a top annoyance, so this only
   * swaps the send button for a stop button rather than disabling anything. */
  isStreaming: boolean;
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  onStop: () => void;
  /** "docked" (default): sticky bar pinned to the bottom of the chat.
   *  "centered": borderless, for the middle-of-screen new-conversation composer. */
  variant?: "docked" | "centered";
  /** Empty or single-entry means there is nothing to choose, and the picker is
   * hidden entirely — a control with one option is noise. */
  providers?: ProviderChoice[];
  selectedProvider?: string;
  onSelectProvider?: (id: string) => void;
}

export interface ChatInputHandle {
  /** Fills the composer (e.g. from a suggested-prompt card) and focuses it. */
  setValue: (text: string) => void;
}

const MAX_HEIGHT_PX = 200;
// Mirrors src/lib/attachments.ts's MAX_ATTACHMENTS / per-file size cap on the backend.
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { placeholder, isStreaming, onSend, onStop, variant = "docked", providers = [], selectedProvider, onSelectProvider },
  ref,
) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every nested child too, so a plain boolean
  // flickers off the moment the pointer crosses the textarea inside the drop
  // zone. Counting enters against leaves is what actually tracks "is the
  // pointer still somewhere inside this element".
  const dragDepthRef = useRef(0);

  useImperativeHandle(ref, () => ({
    setValue: (text: string) => {
      setValue(text);
      textareaRef.current?.focus();
    },
  }));

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  // Object URLs must be revoked to free the underlying blob. Track the latest
  // attachments in a ref so the unmount cleanup below sees the current list, not
  // whatever was there when the effect first ran.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    };
  }, []);

  /** Single path for every way a file can arrive — the picker, a paste, or a
   * drop — so validation and the attachment cap can't drift between them. */
  async function addFiles(files: File[]) {
    if (files.length === 0) return;

    setError(null);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }

    const accepted: ComposerAttachment[] = [];
    for (const file of files.slice(0, room)) {
      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        setError(`"${file.name}" isn't a supported file type (only images and PDFs).`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is too large (max 8MB).`);
        continue;
      }
      const dataBase64 = await readFileAsBase64(file);
      accepted.push({
        id: crypto.randomUUID(),
        filename: file.name,
        mimeType: file.type,
        dataBase64,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      });
    }
    if (files.length > room) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
    }
    setAttachments((prev) => [...prev, ...accepted]);
  }

  async function handleFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await addFiles(files);
  }

  // A screenshot pasted straight into the composer is how students actually
  // share a question they're stuck on, so a paste carrying files is treated as
  // an attach. Pasting plain text must still behave completely normally, hence
  // the early return rather than an unconditional preventDefault.
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function handleDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    dragDepthRef.current += 1;
    setIsDraggingOver(true);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    // Without this the browser navigates away to the dropped file instead of
    // handing it to the drop handler.
    e.preventDefault();
  }

  function handleDragLeave() {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    // Reset first and unconditionally: dropping something that isn't a file
    // still ends the drag, and leaving the highlight stuck on would be worse
    // than doing nothing with the payload.
    dragDepthRef.current = 0;
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  function submit() {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || isStreaming) return;
    onSend(trimmed, attachments);
    setValue("");
    setAttachments([]);
    setError(null);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div
      className={
        variant === "centered"
          ? "px-4 sm:px-6"
          : "surface rounded-none border-x-0 border-b-0 px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 sm:px-6"
      }
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mx-auto max-w-3xl">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="field group relative flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-2 text-xs text-neutral-600 dark:text-neutral-300"
              >
                {a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.filename} className="h-8 w-8 rounded object-cover" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0" />
                )}
                <span className="max-w-[10rem] truncate">{a.filename}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.filename}`}
                  title={`Remove ${a.filename}`}
                  className="rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

        <div
          className={`field flex items-end gap-2 rounded-2xl px-3 py-2 transition-colors ${
            isDraggingOver ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5" : ""
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={Array.from(ALLOWED_MIME_TYPES).join(",")}
            multiple
            onChange={handleFilesSelected}
            className="hidden"
          />
          {/* Sits beside the paperclip rather than in Settings because the choice
              is per conversation: it belongs where the turn is composed, not
              behind a global preference screen. Hidden when there is nothing to
              choose, which is the normal case for a student on a deployment
              that has only configured one provider. */}
          {providers.length > 1 && (
            <select
              value={selectedProvider ?? providers[0]?.id}
              onChange={(e) => onSelectProvider?.(e.target.value)}
              aria-label="Choose which AI answers"
              title={
                providers.find((p) => p.id === (selectedProvider ?? providers[0]?.id))?.note ??
                "Choose which AI answers"
              }
              className="mb-0.5 h-8 shrink-0 rounded-full border border-[var(--color-line)] bg-transparent px-2 text-xs text-neutral-600 outline-none transition-colors hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.availableToStudents ? "" : " (teachers)"}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            aria-label="Attach photo or file"
            title="Attach a photo or PDF — you can also paste or drag one in"
            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-black/5 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            <PaperclipIcon className="h-4 w-4" />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white"
            >
              <StopIcon className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={value.trim().length === 0 && attachments.length === 0}
              aria-label="Send message"
              title="Send message"
              className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand)] text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-30"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-neutral-400 dark:text-neutral-500">
        {isDraggingOver
          ? "Drop your photo or PDF to attach it"
          : "AI answers can be wrong — always check against your textbook and teacher."}
      </p>
    </div>
  );
});
