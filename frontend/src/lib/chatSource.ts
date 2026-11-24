import type { ChatMaterialRef, ChatMaterialsScope, ChatSourceRef, ComposerAttachment, Visual } from "../types";
import { supabase } from "./supabaseClient";

/**
 * Abstraction over "where assistant text comes from", so the message list and
 * input components never know whether a response is mocked or fetched from
 * the real API. Swap `mockChatSource` for `apiChatSource` (or a true SSE
 * stream later) and nothing else in the app needs to change.
 */
export interface ChatDoneMeta {
  sources?: ChatSourceRef[];
  /** Which provider actually answered — not necessarily the one asked for. */
  provider?: string;
  materials?: ChatMaterialRef[];
  materialsScope?: ChatMaterialsScope | null;
  /** The conversation this turn was saved under — the caller's own id for a brand
   * new conversation, or the server-assigned id it was just created with. */
  conversationId?: string;
  visual?: Visual | null;
  examPageImages?: string[];
  examPageImageLabels?: (string | null)[];
  presentsPastYearQuestion?: boolean;
}

export interface ChatSourceHandlers {
  /** Called with the accumulated text so far, once per chunk. */
  onToken: (textSoFar: string) => void;
  onDone: (finalText: string, meta?: ChatDoneMeta) => void;
  onError: (error: Error) => void;
}

export interface SendOptions {
  /** Which LLM should answer. Omitted means "whatever this conversation already
   * uses", which the server resolves — the client deliberately doesn't try to
   * remember that, since the server falls back when a choice stops being
   * available and only it knows that happened. */
  provider?: string;
  /** Replay the last question in this conversation, replacing its answer rather
   * than appending a new turn. The backend skips re-persisting the question and
   * deletes the answer being replaced. */
  regenerate?: boolean;
}

export interface ChatSource {
  /** Starts streaming a response to `question` in `conversationId` (undefined to
   * start a new conversation). Returns an abort function. */
  send(
    question: string,
    attachments: ComposerAttachment[],
    conversationId: string | undefined,
    handlers: ChatSourceHandlers,
    options?: SendOptions,
  ): () => void;
}

/**
 * Reveals `text` word-by-word via `onToken`, then calls `onDone`. Used both by the
 * mock source (which invents the text) and the API source (which already has the
 * full answer, since the backend isn't a real token stream yet — this keeps the
 * same "typing" feel until it is).
 */
function revealWords(
  text: string,
  onToken: (textSoFar: string) => void,
  onDone: (finalText: string, meta?: ChatDoneMeta) => void,
  isCancelled: () => boolean,
  meta?: ChatDoneMeta,
): void {
  const words = text.split(/(\s+)/); // keep whitespace tokens so words stay spaced
  // Cap the total number of reveal steps regardless of answer length — a fixed word-per-tick
  // count meant long, math-heavy answers took a while AND re-rendered (full markdown+KaTeX
  // re-parse) dozens of extra times, which is where the actual jank was coming from. Scaling
  // the chunk size keeps both the total reveal time and the render count bounded.
  const MAX_STEPS = 50;
  const wordsPerTick = Math.max(3, Math.ceil(words.length / MAX_STEPS));
  let index = 0;
  let soFar = "";

  const step = () => {
    if (isCancelled()) return;
    if (index >= words.length) {
      onDone(soFar, meta);
      return;
    }
    soFar += words.slice(index, index + wordsPerTick).join("");
    index += wordsPerTick;
    onToken(soFar);
    window.setTimeout(step, 10 + Math.random() * 25);
  };

  window.setTimeout(step, 150 + Math.random() * 150);
}

const MATH_KEYWORDS = ["solve", "quadratic", "equation", "differentiate", "integrate", "formula"];

const GENERIC_RESPONSE = `That's a good question. Let's break it down step by step.

First, identify what the problem is asking for, then figure out which formula or method from the syllabus applies here. Once you've matched the method, work through it carefully and check your final answer makes sense in context.

Want to try a specific example together?`;

const MATH_RESPONSE = `Sure — let's solve $x^2 - 5x + 6 = 0$ by factorisation.

We need two numbers that multiply to $6$ and add to $-5$: those are $-2$ and $-3$.

$$
x^2 - 5x + 6 = (x - 2)(x - 3) = 0
$$

So either $x - 2 = 0$ or $x - 3 = 0$, which gives:

$$
x = 2 \\quad \\text{or} \\quad x = 3
$$

**Check:** substituting back, $2^2 - 5(2) + 6 = 4 - 10 + 6 = 0$ ✓, and $3^2 - 5(3) + 6 = 9 - 15 + 6 = 0$ ✓.

A few things worth remembering for SPM:
- Always check your factorisation by expanding it back out.
- If it doesn't factorise nicely, fall back to the quadratic formula: $x = \\dfrac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$.
- Watch your signs — the most common mistake here is flipping the sign of the roots.`;

function pickMockResponse(question: string): string {
  const lower = question.toLowerCase();
  return MATH_KEYWORDS.some((kw) => lower.includes(kw)) ? MATH_RESPONSE : GENERIC_RESPONSE;
}

/** Simulates word-by-word streaming with invented sample answers — no network calls. */
export const mockChatSource: ChatSource = {
  send(question, _attachments, _conversationId, { onToken, onDone }) {
    let cancelled = false;
    revealWords(pickMockResponse(question), onToken, onDone, () => cancelled);
    return () => {
      cancelled = true;
    };
  },
};

interface ChatApiResponse {
  conversationId?: string;
  answer: string;
  sources?: { source: string | null; content_type: string }[];
  materials?: ChatMaterialRef[];
  materialsScope?: ChatMaterialsScope | null;
  provider?: string;
  visual?: Visual | null;
  examPageImages?: string[];
  examPageImageLabels?: (string | null)[];
  presentsPastYearQuestion?: boolean;
  error?: unknown;
}

/** Calls the real Fastify /api/chat endpoint, then reveals the answer word-by-word. */
export const apiChatSource: ChatSource = {
  send(question, attachments, conversationId, { onToken, onDone, onError }, options) {
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        if (!cancelled) onError(new Error("You've been logged out — please log in again."));
        return;
      }

      let res: Response;
      try {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            question,
            conversationId,
            regenerate: options?.regenerate ?? false,
            provider: options?.provider,
            attachments: attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              dataBase64: a.dataBase64,
            })),
          }),
          signal: controller.signal,
        });
      } catch {
        if (!cancelled) onError(new Error("Couldn't reach the tutor service. Is the server running?"));
        return;
      }

      const data = (await res.json().catch(() => ({}))) as ChatApiResponse;

      if (!res.ok) {
        if (!cancelled) {
          const message = typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
          onError(new Error(message));
        }
        return;
      }

      if (cancelled) return;
      revealWords(data.answer ?? "", onToken, onDone, () => cancelled, {
        sources: data.sources,
        materials: data.materials,
        materialsScope: data.materialsScope,
        provider: data.provider,
        conversationId: data.conversationId,
        visual: data.visual,
        examPageImages: data.examPageImages,
        examPageImageLabels: data.examPageImageLabels,
        presentsPastYearQuestion: data.presentsPastYearQuestion,
      });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  },
};
