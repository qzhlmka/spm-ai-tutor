export type MessageRole = "user" | "assistant";

export type MessageStatus = "streaming" | "done" | "error";

export interface ChatSourceRef {
  source: string | null;
  content_type: string;
}

/** A teacher's original PDF, listed in the Files panel beside an answer. Mirrors
 * AttachedMaterial in src/lib/chat-handler.ts. `id` is a materials row id — the
 * row mints its own short-lived signed URL on click via getMaterialDownloadUrl,
 * rather than the backend embedding a URL that would expire while the message
 * sits on screen. */
export interface ChatMaterialRef {
  id: string;
  filename: string;
  subject: string;
  topic: string;
}

/** Set when the files are a listing the student asked for ("nota termokimia"):
 * which subject and topics it covers. Null topics = the whole subject. */
export interface ChatMaterialsScope {
  subject: string;
  topics: string[] | null;
}

// Mirrors src/lib/visual.ts's visualSchema on the backend — the three diagram
// shapes the tutor can ask to have drawn.
export interface FunctionVisual {
  type: "function";
  curves: { expr: string; label?: string }[];
  domain?: [number, number];
  yRange?: [number, number];
  angleUnit?: "radians" | "degrees";
  shade?: { from: number; to: number; curve?: number; between?: number };
  points?: { x: number; curve?: number; label?: string }[];
  label?: string;
}

export interface TriangleVisual {
  type: "triangle";
  sides?: { a?: number | null; b?: number | null; c?: number | null };
  angles?: { A?: number | null; B?: number | null; C?: number | null };
  label?: string;
}

export interface VectorVisual {
  type: "vector";
  vectors: { label: string; x: number; y: number }[];
  label?: string;
}

export type Visual = FunctionVisual | TriangleVisual | VectorVisual;

/** An attachment produced by the composer, ready to send and/or display. `previewUrl`
 * (an object URL) is only set for images — PDFs show as a filename chip instead. */
export interface ComposerAttachment {
  id: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUrl?: string;
}

/** What a sent message keeps around for display — the base64 payload is dropped
 * once sent, since only previewUrl/filename are needed to render the bubble. */
export type MessageAttachment = Omit<ComposerAttachment, "dataBase64">;

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  status: MessageStatus;
  /** Only set (and only shown) when the student explicitly asked for sources. */
  sources?: ChatSourceRef[];
  /** Teacher PDFs this answer was taught from. Not persisted with the message —
   * a reloaded conversation shows the text without the cards, same as sources. */
  materials?: ChatMaterialRef[];
  materialsScope?: ChatMaterialsScope | null;
  attachments?: MessageAttachment[];
  visual?: Visual | null;
  /** Real source page image(s) for a diagram-dependent past-year question, as
   * data URLs — not persisted with the message, same as visual/materials. */
  examPageImages?: string[];
  /** examPageImages' source labels ("KELANTAN 2023 (10)"), same order. */
  examPageImageLabels?: (string | null)[];
  /** The answer gave a past-year question — decides the follow-up buttons. Not persisted. */
  presentsPastYearQuestion?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  starred: boolean;
  updatedAt: number;
  messages: ChatMessage[];
  /** Whether this conversation's message history has been fetched from the server yet —
   * distinct from `messages.length === 0`, which is also true for a genuinely-new,
   * not-yet-sent conversation. */
  messagesLoaded: boolean;
}

export interface AppConfig {
  /** Composer placeholder, e.g. "Ask me anything...". */
  inputPlaceholder: string;
}
