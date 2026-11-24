import { supabase } from "./supabase.js";
import type { AuthedUser } from "./auth.js";

// Framework-agnostic core for the conversation-list/history endpoints — same pattern
// as chat-handler.ts, called from both src/routes/conversations.ts (standalone
// Fastify) and frontend/vite-plugins/api.ts (local dev), one source of truth.

export type ListConversationsResult =
  | {
      status: 200;
      body: { conversations: { id: string; title: string | null; starred: boolean; updatedAt: string }[] };
    }
  | { status: 401; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function listConversations(user: AuthedUser | null): Promise<ListConversationsResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, starred, updated_at")
    .eq("user_id", user.id)
    .order("starred", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("failed to list conversations", error);
    return { status: 500, body: { error: "Couldn't load conversations" } };
  }

  return {
    status: 200,
    body: {
      conversations: (data ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        starred: c.starred,
        updatedAt: c.updated_at,
      })),
    },
  };
}

interface MessageAttachmentDto {
  id: string;
  filename: string;
  mimeType: string;
  /** Only set for image types — matches the live-send shape (frontend/src/types.ts's
   * MessageAttachment), where a PDF renders as a plain filename chip with no preview. */
  previewUrl?: string;
}

export type GetConversationMessagesResult =
  | {
      status: 200;
      body: {
        messages: { id: string; role: string; content: string; createdAt: string; attachments?: MessageAttachmentDto[] }[];
      };
    }
  | { status: 401; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

const ATTACHMENT_SIGNED_URL_EXPIRY_SECONDS = 60 * 60;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function getConversationMessages(
  user: AuthedUser | null,
  conversationId: string,
): Promise<GetConversationMessagesResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (conversationError) {
    console.error("failed to load conversation", conversationError);
    return { status: 500, body: { error: "Couldn't load conversation" } };
  }
  if (!conversation) {
    return { status: 404, body: { error: "Conversation not found" } };
  }

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (messagesError) {
    console.error("failed to load messages", messagesError);
    return { status: 500, body: { error: "Couldn't load messages" } };
  }

  const messageIds = (messages ?? []).map((m) => m.id);
  const attachmentsByMessageId = new Map<string, MessageAttachmentDto[]>();
  if (messageIds.length > 0) {
    const { data: attachmentRows, error: attachmentsError } = await supabase
      .from("message_attachments")
      .select("id, message_id, filename, mime_type, storage_path")
      .in("message_id", messageIds);
    if (attachmentsError) {
      console.error("failed to load message attachments", attachmentsError);
    } else if (attachmentRows && attachmentRows.length > 0) {
      const { data: signedUrls, error: signError } = await supabase.storage
        .from("chat-attachments")
        .createSignedUrls(
          attachmentRows.map((a) => a.storage_path),
          ATTACHMENT_SIGNED_URL_EXPIRY_SECONDS,
        );
      if (signError) {
        console.error("failed to sign attachment urls", signError);
      }
      attachmentRows.forEach((row, i) => {
        const list = attachmentsByMessageId.get(row.message_id) ?? [];
        list.push({
          id: row.id,
          filename: row.filename,
          mimeType: row.mime_type,
          previewUrl: IMAGE_MIME_TYPES.has(row.mime_type) ? (signedUrls?.[i]?.signedUrl ?? undefined) : undefined,
        });
        attachmentsByMessageId.set(row.message_id, list);
      });
    }
  }

  return {
    status: 200,
    body: {
      messages: (messages ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
        attachments: attachmentsByMessageId.get(m.id),
      })),
    },
  };
}

export type UpdateConversationResult =
  | { status: 200; body: { id: string; title: string | null; starred: boolean } }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

// Handles both rename ({ title }) and star/unstar ({ starred }) — a right-click
// context menu in the sidebar drives both, so one PATCH endpoint covers both
// rather than adding a second route for a single boolean flip.
export async function updateConversation(
  user: AuthedUser | null,
  conversationId: string,
  input: { title?: unknown; starred?: unknown },
): Promise<UpdateConversationResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const patch: { title?: string; starred?: boolean } = {};
  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      return { status: 400, body: { error: "title is required" } };
    }
    patch.title = title;
  }
  if (input.starred !== undefined) {
    if (typeof input.starred !== "boolean") {
      return { status: 400, body: { error: "starred must be a boolean" } };
    }
    patch.starred = input.starred;
  }
  if (Object.keys(patch).length === 0) {
    return { status: 400, body: { error: "Nothing to update" } };
  }

  const { data, error } = await supabase
    .from("conversations")
    .update(patch)
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .select("id, title, starred")
    .maybeSingle();

  if (error) {
    console.error("failed to update conversation", error);
    return { status: 500, body: { error: "Couldn't update conversation" } };
  }
  if (!data) {
    return { status: 404, body: { error: "Conversation not found" } };
  }

  return { status: 200, body: { id: data.id, title: data.title, starred: data.starred } };
}

export type DeleteConversationResult =
  | { status: 200; body: { id: string } }
  | { status: 401; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function deleteConversation(
  user: AuthedUser | null,
  conversationId: string,
): Promise<DeleteConversationResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  // messages.conversation_id has `on delete cascade`, so deleting the
  // conversation row is enough — no separate messages cleanup needed.
  const { data, error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("failed to delete conversation", error);
    return { status: 500, body: { error: "Couldn't delete conversation" } };
  }
  if (!data) {
    return { status: 404, body: { error: "Conversation not found" } };
  }

  return { status: 200, body: { id: data.id } };
}
