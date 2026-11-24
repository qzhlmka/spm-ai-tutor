import { supabase } from "./supabaseClient";
import type { ChatMessage, MessageAttachment, MessageRole } from "../types";

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  starred: boolean;
  updatedAt: string;
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const res = await fetch("/api/conversations", { headers: await authHeader() });
  if (!res.ok) throw new Error(`Failed to load conversations (${res.status})`);
  const data = (await res.json()) as { conversations: ConversationSummary[] };
  return data.conversations;
}

interface ConversationMessageRow {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  attachments?: MessageAttachment[];
}

export async function fetchConversationMessages(conversationId: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`Failed to load messages (${res.status})`);
  const data = (await res.json()) as { messages: ConversationMessageRow[] };
  return data.messages.map((m) => ({
    id: m.id,
    role: m.role as MessageRole,
    content: m.content,
    createdAt: new Date(m.createdAt).getTime(),
    status: "done" as const,
    attachments: m.attachments,
  }));
}

export async function renameConversation(conversationId: string, title: string): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to rename conversation (${res.status})`);
}

export async function setConversationStarred(conversationId: string, starred: boolean): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ starred }),
  });
  if (!res.ok) throw new Error(`Failed to update conversation (${res.status})`);
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`Failed to delete conversation (${res.status})`);
}
