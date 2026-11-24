import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";
import { ChatMessageItem } from "./ChatMessageItem";
import { ArrowDownIcon } from "./Icons";

interface ChatMessageListProps {
  messages: ChatMessage[];
  loading?: boolean;
  /** Re-runs the most recent question. Only the last assistant message gets a
   * regenerate control — redoing an earlier one would orphan the turns after it. */
  onRegenerate?: () => void;
  isStreaming?: boolean;
  /** Shortcuts shown under the latest answer when it gave a past-year
   * question (decided by the server from the reply's own text). */
  quickActions?: { label: string; onClick: () => void }[];
}

// Don't yank the student back to the bottom if they've scrolled up to reread
// something while a response is still streaming in.
const NEAR_BOTTOM_THRESHOLD_PX = 150;

function isNearBottom(container: HTMLDivElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX;
}

export function ChatMessageList({ messages, loading, onRegenerate, isStreaming, quickActions }: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  // Whether we should keep following new content, as a persistent flag driven only
  // by genuine user scroll events — NOT recomputed from scrollTop/scrollHeight on
  // every content update. Several rapid token updates can batch into one React
  // render, growing scrollHeight by more than NEAR_BOTTOM_THRESHOLD_PX in a single
  // jump; comparing the (unmoved) scrollTop against that new, taller scrollHeight
  // would misread the jump itself as "the user scrolled away" and permanently stop
  // auto-following for the rest of that message.
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !stickToBottomRef.current) return;
    // Instant, not smooth: this fires on every streamed token, and repeatedly
    // interrupting an in-flight smooth-scroll animation can leave the view
    // stuck instead of following the growing text.
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [messages]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const near = isNearBottom(container);
    stickToBottomRef.current = near;
    setShowJumpButton(!near);
  }

  function jumpToBottom() {
    stickToBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    setShowJumpButton(false);
  }

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex justify-end">
              <div
                className="h-9 w-2/3 animate-pulse rounded-2xl bg-neutral-100 dark:bg-neutral-800"
                style={{ animationDelay: `${i * 80}ms` }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
          {messages.map((message, i) => (
            <ChatMessageItem
              key={message.id}
              message={message}
              onRegenerate={
                onRegenerate && !isStreaming && message.role === "assistant" && i === messages.length - 1
                  ? onRegenerate
                  : undefined
              }
              quickActions={
                quickActions &&
                !isStreaming &&
                message.role === "assistant" &&
                i === messages.length - 1 &&
                message.presentsPastYearQuestion
                  ? quickActions
                  : undefined
              }
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {showJumpButton && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Jump to most recent message"
          className="surface message-enter absolute bottom-4 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full text-neutral-600 transition-colors hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
        >
          <ArrowDownIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
