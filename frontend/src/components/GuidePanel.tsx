import { useEffect } from "react";
import { AtomIcon, BookIcon, PaperclipIcon, SparkleIcon, StopIcon, XIcon } from "./Icons";

interface GuidePanelProps {
  onClose: () => void;
  isTeacher: boolean;
}

interface GuideItem {
  icon: typeof BookIcon;
  title: string;
  body: string;
}

// Shown automatically on a student's first visit and reopenable from the
// sidebar. Testing found students had no idea what the tutor could do, that
// they could write in Malay, or what the Materials tab had to do with the
// chat at all — none of which is discoverable from an empty composer.
const STUDENT_ITEMS: GuideItem[] = [
  {
    icon: SparkleIcon,
    title: "Ask in Malay or English",
    body: "Tulis soalan anda dalam Bahasa Melayu atau English — jawapan akan mengikut bahasa yang anda guna. Ask about any SPM subject: Add Maths, Physics, Chemistry, Sejarah and more.",
  },
  {
    icon: AtomIcon,
    title: "Ask for full working, not just answers",
    body: "Say \"step by step\" or \"tunjuk langkah\" and you'll get the working the way an SPM marking scheme expects it. You can ask follow-up questions about any step you don't follow.",
  },
  {
    icon: PaperclipIcon,
    title: "Send a photo of a question",
    body: "Stuck on a question in a book or worksheet? Attach a photo or PDF — paste it with Ctrl+V, drag it onto the box, or use the clip button. Tap any image you've sent to see it full size.",
  },
  {
    icon: BookIcon,
    title: "Your teacher's materials are already in here",
    body: "Anything your teacher uploads is searched automatically every time you ask something — you don't need to attach it or mention it. When an answer uses your class material, the tutor says so. The Materials tab is for reading or downloading the original files yourself.",
  },
  {
    icon: StopIcon,
    title: "Stop, regenerate, and copy",
    body: "You can stop a reply while it's being written, ask for another attempt with the regenerate button, and copy any answer. You can keep typing your next question while one is still generating.",
  },
];

const TEACHER_ITEMS: GuideItem[] = [
  {
    icon: BookIcon,
    title: "Upload your class material",
    body: "Upload a PDF and it's read page by page — including diagrams, which are described in words so the tutor can teach from them. Once it finishes, your students' questions search it automatically.",
  },
  {
    icon: SparkleIcon,
    title: "Fix mistakes at the source",
    body: "The tutor only teaches from what's actually in your uploaded file. Typing a formula into this chat does not add it to your students' material — rename, replace or re-upload the file in the Materials tab instead.",
  },
];

export function GuidePanel({ onClose, isTeacher }: GuidePanelProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const items = isTeacher ? [...TEACHER_ITEMS, ...STUDENT_ITEMS] : STUDENT_ITEMS;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="How to use this tutor"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="surface message-enter flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-neutral-800 dark:text-neutral-100">
              How to use your tutor
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
              A quick tour — you can reopen this any time from the sidebar.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close guide"
            title="Close guide"
            className="shrink-0 rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/5 dark:hover:text-neutral-200"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {items.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-3">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-brand)]" />
              <div>
                <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{title}</h3>
                <p className="mt-0.5 text-sm leading-6 text-neutral-600 dark:text-neutral-400">{body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-[var(--color-line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)]"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
