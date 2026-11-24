import { useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatMessageList } from "./components/ChatMessageList";
import { FilesDrawer, FilesPanel } from "./components/FilesPanel";
import { ChatInput, type ChatInputHandle } from "./components/ChatInput";
import { AuthScreen } from "./components/AuthScreen";
import { MaterialUpload } from "./components/MaterialUpload";
import { MaterialsLibrary } from "./components/MaterialsLibrary";
import { ResourceLinks } from "./components/ResourceLinks";
import { GuidePanel } from "./components/GuidePanel";
import { ProfilePanel } from "./components/ProfilePanel";
import { SiriOrb } from "./components/SiriOrb";
import { AtomIcon, BookIcon, FunctionIcon, ScrollIcon, SparkleIcon } from "./components/Icons";
import { appConfig } from "./config";
import { apiChatSource } from "./lib/chatSource";
import { useSession } from "./lib/useSession";
import { supabase } from "./lib/supabaseClient";
import {
  fetchConversations,
  fetchConversationMessages,
  renameConversation as renameConversationApi,
  setConversationStarred as setConversationStarredApi,
  deleteConversation as deleteConversationApi,
} from "./lib/conversationsApi";
import { fetchProfile, type Profile } from "./lib/profileApi";
import type { ChatMaterialRef, ChatMessage, ComposerAttachment, Conversation } from "./types";

function titleFor(question: string, attachments: ComposerAttachment[]): string {
  const trimmed = question.trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
  if (attachments.length > 0) return attachments.length === 1 ? attachments[0].filename : `${attachments.length} attachments`;
  return "New conversation";
}

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function firstNameFrom(email: string | null): string {
  if (!email) return "there";
  const local = email.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function greetingName(displayName: string | null, email: string | null): string {
  if (displayName) return displayName.split(" ")[0];
  return firstNameFrom(email);
}

// Starter prompts for the empty-conversation screen. Grouped by subject rather
// than kept as one flat list so the four on screen can be drawn from four
// DIFFERENT subjects — a flat random pick would regularly show four Chemistry
// prompts and read as if the tutor only knows one subject.
//
// Every topic named here is one the knowledge base actually has ingested
// content for (see the `subject`/`topic` columns on content_chunks), so a
// student tapping one lands on a question retrieval can genuinely support
// rather than a cold miss.
//
// Each group deliberately mixes Bahasa Melayu and English starters. Student
// testing flagged an English-only list as excluding students who'd naturally
// ask in Malay, and since one prompt is drawn per group, mixing within the
// groups is what actually makes both languages show up on screen together.
const PROMPT_GROUPS: { icon: typeof FunctionIcon; text: string }[][] = [
  [
    { icon: FunctionIcon, text: "Walk me through an Add Maths differentiation question step by step" },
    { icon: FunctionIcon, text: "How do I find the equation of a locus in Coordinate Geometry?" },
    { icon: FunctionIcon, text: "Explain the difference between arithmetic and geometric progressions" },
    { icon: FunctionIcon, text: "Show me how to use Linear Law to straighten a curve" },
    { icon: FunctionIcon, text: "Help me with integration to find the area under a curve" },
    { icon: FunctionIcon, text: "Explain how to solve a Linear Programming problem graphically" },
    { icon: FunctionIcon, text: "Terangkan cara membezakan fungsi dalam Add Maths langkah demi langkah" },
    { icon: FunctionIcon, text: "Macam mana nak cari persamaan lokus dalam Geometri Koordinat?" },
  ],
  [
    { icon: FunctionIcon, text: "How do I find the inverse of a 2x2 matrix?" },
    { icon: FunctionIcon, text: "Explain how to convert between number bases" },
    { icon: FunctionIcon, text: "Teach me how to calculate income tax for Consumer Mathematics" },
    { icon: FunctionIcon, text: "What's the difference between variance and standard deviation?" },
    { icon: FunctionIcon, text: "Help me understand combined transformations with an example" },
    { icon: FunctionIcon, text: "How do I solve probability of combined events questions?" },
    { icon: FunctionIcon, text: "Ajar saya cara mencari songsangan matriks 2x2" },
    { icon: FunctionIcon, text: "Apakah beza antara varians dan sisihan piawai?" },
  ],
  [
    { icon: AtomIcon, text: "Explain projectile motion with a worked example" },
    { icon: AtomIcon, text: "Help me understand Ohm's law and series vs parallel circuits" },
    { icon: AtomIcon, text: "What's the difference between transverse and longitudinal waves?" },
    { icon: AtomIcon, text: "Explain how a transformer works for Electromagnetism" },
    { icon: AtomIcon, text: "Teach me the gas laws and how pressure relates to volume" },
    { icon: AtomIcon, text: "How do I calculate refractive index in Light and Optics?" },
    { icon: AtomIcon, text: "Terangkan gerakan peluru dengan contoh pengiraan" },
    { icon: AtomIcon, text: "Apakah beza gelombang melintang dan gelombang membujur?" },
  ],
  [
    { icon: AtomIcon, text: "Give me 5 practice questions on chemical bonding" },
    { icon: AtomIcon, text: "Explain the mole concept and how to balance chemical equations" },
    { icon: AtomIcon, text: "What factors affect the rate of reaction?" },
    { icon: AtomIcon, text: "Help me name organic compounds in Carbon Compound" },
    { icon: AtomIcon, text: "Explain oxidation and reduction with a redox example" },
    { icon: AtomIcon, text: "How do I work out the concentration of an acid in a titration?" },
    { icon: AtomIcon, text: "Apakah faktor yang mempengaruhi kadar tindak balas?" },
    { icon: AtomIcon, text: "Terangkan konsep mol dan cara mengimbangkan persamaan kimia" },
  ],
  [
    { icon: ScrollIcon, text: "Summarise the causes of the Japanese Occupation for Sejarah" },
    { icon: ScrollIcon, text: "Explain the formation of Malaysia in 1963" },
    { icon: ScrollIcon, text: "What were the main terms of the Malayan Union?" },
    { icon: ScrollIcon, text: "Help me revise the Rukun Negara and its principles" },
    { icon: ScrollIcon, text: "Explain the significance of the Federal Constitution" },
    { icon: ScrollIcon, text: "Ringkaskan sebab-sebab Pendudukan Jepun untuk Sejarah" },
    { icon: ScrollIcon, text: "Terangkan pembentukan Malaysia pada tahun 1963" },
  ],
  [
    { icon: SparkleIcon, text: "Give me a real SPM past-year question to try" },
    { icon: BookIcon, text: "Help me build a study plan for my weakest subject" },
    { icon: SparkleIcon, text: "Quiz me with 5 quick questions to warm up" },
    { icon: BookIcon, text: "What are the most common mistakes students make in SPM?" },
    { icon: SparkleIcon, text: "Beri saya satu soalan SPM sebenar untuk dicuba" },
    { icon: BookIcon, text: "Bantu saya buat jadual ulang kaji untuk subjek paling lemah" },
  ],
];

/** Four starters from four different subjects, reshuffled each time the
 * new-conversation screen is opened. */
function pickSuggestedPrompts(): { icon: typeof FunctionIcon; text: string }[] {
  const groups = [...PROMPT_GROUPS];
  // Fisher-Yates over the groups, then one prompt from each of the first four.
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  return groups.slice(0, 4).map((group) => group[Math.floor(Math.random() * group.length)]);
}

/** Where a not-yet-created conversation parks its provider choice. A new chat
 * has no id until the server assigns one on the first turn, so the picker needs
 * somewhere to hold the selection until then. It deliberately survives after
 * that: the next new chat opens on the same choice, which is what someone who
 * just switched provider expects. */
const NEW_CONVERSATION_PROVIDER_KEY = "__new__";

export default function App() {
  const { session, loading } = useSession();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [loadingMessagesId, setLoadingMessagesId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop-only collapse preference (distinct from sidebarOpen, which drives
  // the mobile overlay drawer) — persisted so it survives a refresh.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sidebarCollapsed") === "1");
  const [isStreaming, setIsStreaming] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  // Keyed by conversation id rather than held as one value, because the choice
  // is per conversation: switching between two chats must not carry one's
  // provider into the other. The server is the real store (conversations.provider);
  // this only keeps the picker showing the right thing without a refetch.
  const [providerByConversation, setProviderByConversation] = useState<Record<string, string>>({});

  // The server decides this list from its own credentials and this user's role,
  // so the client never hardcodes which providers exist.
  const providerChoices = profile?.providers ?? [];
  // A brand-new conversation has no id yet, so its choice is parked under this
  // key and moved across when the server assigns the real id on the first turn.
  const providerKey = activeConversationId ?? NEW_CONVERSATION_PROVIDER_KEY;
  const activeProvider = providerByConversation[providerKey] ?? profile?.defaultProvider;

  // Also becomes the choice for the next new chat. Previously a pick made
  // inside an existing chat stayed with that chat, so clicking New chat went
  // back to the default provider without saying so — reported when the
  // default (Claude) was out of credit and a student who had picked IlmuChat
  // got an error on their next new chat.
  function handleSelectProvider(id: string) {
    setProviderByConversation((prev) => ({ ...prev, [providerKey]: id, [NEW_CONVERSATION_PROVIDER_KEY]: id }));
  }
  const isTeacher = profile?.role === "teacher";
  const [uploadOpen, setUploadOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  // Held in state (not derived per render) so the four starters stay put while
  // the student reads them or types — recomputing inline would reshuffle them
  // on every keystroke. Refreshed deliberately in handleNewConversation.
  const [suggestedPrompts, setSuggestedPrompts] = useState(pickSuggestedPrompts);
  const centeredChatInputRef = useRef<ChatInputHandle>(null);
  const dockedChatInputRef = useRef<ChatInputHandle>(null);
  // Returned by apiChatSource.send — previously discarded, which is why there
  // was no way to stop a reply once it started.
  const abortRef = useRef<(() => void) | null>(null);
  const lastTurnRef = useRef<{ question: string; attachments: ComposerAttachment[]; conversationId: string } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("sidebarCollapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // First-visit tour, deferred until the profile resolves — it branches on
  // teacher vs student, and opening it before the role is known would show a
  // teacher the student version.
  useEffect(() => {
    if (!profile) return;
    if (localStorage.getItem("guideSeen") === "1") return;
    setGuideOpen(true);
  }, [profile]);

  // Load this student's conversation list once they're authenticated — it's their
  // own persisted history, not local-only state, so it survives a refresh.
  //
  // Keyed on the user id, not the `session` object: Supabase silently re-validates
  // the session (and hands back a new object, same user) whenever the tab regains
  // focus/visibility, which would otherwise re-run this on every tab switch and
  // wipe out the active conversation's already-loaded messages mid-read.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    fetchProfile()
      .then(setProfile)
      .catch((err) => console.error("failed to load profile", err));
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setConversations([]);
      setActiveConversationId(null);
      return;
    }
    setConversationsLoading(true);
    fetchConversations()
      .then((list) => {
        setConversations((prev) => {
          const prevById = new Map(prev.map((c) => [c.id, c]));
          return list.map((c) => {
            const existing = prevById.get(c.id);
            return {
              id: c.id,
              title: c.title ?? "New conversation",
              starred: c.starred,
              updatedAt: new Date(c.updatedAt).getTime(),
              messages: existing?.messages ?? [],
              messagesLoaded: existing?.messagesLoaded ?? false,
            };
          });
        });
      })
      .catch((err) => console.error("failed to load conversations", err))
      .finally(() => setConversationsLoading(false));
  }, [userId]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  // Only switch to the centered new-conversation composer once we're sure there's
  // nothing to show — a conversation whose messages haven't loaded yet is not
  // "empty", it just hasn't rendered its history (messagesLoaded false routes to
  // ChatMessageList's own loading skeleton instead).
  // Derived from state (not the lastTurnRef, which a render can't react to) so
  // the control also appears on a conversation reopened from history.
  const canRegenerate =
    (activeConversation?.messages ?? []).some((m) => m.role === "user") &&
    (activeConversation?.messages ?? []).some((m) => m.role === "assistant");

  const isEmptyConversation =
    !activeConversation || (activeConversation.messagesLoaded && activeConversation.messages.length === 0);

  // The Files panel keeps every file this conversation's answers listed, newest
  // first, so asking something new doesn't wipe the files from earlier answers.
  const conversationFiles = useMemo(() => {
    const seen = new Set<string>();
    const files: ChatMaterialRef[] = [];
    for (const m of [...(activeConversation?.messages ?? [])].reverse()) {
      for (const f of m.materials ?? []) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        files.push(f);
      }
    }
    return files;
  }, [activeConversation?.messages]);

  // Lazily fetch a conversation's full message history the first time it's selected.
  useEffect(() => {
    if (!activeConversation || activeConversation.messagesLoaded) return;
    const id = activeConversation.id;
    setLoadingMessagesId(id);
    fetchConversationMessages(id)
      .then((messages) => {
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, messages, messagesLoaded: true } : c)));
      })
      .catch((err) => console.error("failed to load conversation messages", err))
      .finally(() => setLoadingMessagesId((current) => (current === id ? null : current)));
  }, [activeConversation]);

  function updateConversation(id: string, updater: (conversation: Conversation) => Conversation) {
    setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
  }

  function handleNewConversation() {
    setActiveConversationId(null);
    setSidebarOpen(false);
    setSuggestedPrompts(pickSuggestedPrompts());
  }

  function handleSelectConversation(id: string) {
    setActiveConversationId(id);
    setSidebarOpen(false);
  }

  function handleOpenUpload() {
    setSidebarOpen(false);
    setUploadOpen(true);
  }

  function handleOpenProfile() {
    setSidebarOpen(false);
    setProfileOpen(true);
  }

  function handleCloseGuide() {
    localStorage.setItem("guideSeen", "1");
    setGuideOpen(false);
  }

  function handleOpenGuide() {
    setSidebarOpen(false);
    setGuideOpen(true);
  }

  function handleOpenMaterials() {
    setSidebarOpen(false);
    setMaterialsOpen(true);
  }

  function handleOpenResources() {
    setSidebarOpen(false);
    setResourcesOpen(true);
  }

  function handleAvatarChange(avatarUrl: string) {
    setProfile((prev) => (prev ? { ...prev, avatarUrl } : prev));
  }

  function handleDisplayNameChange(displayName: string | null) {
    // Updated in place rather than refetching: the greeting on the empty state
    // reads the same profile object, so it renames the moment this returns.
    setProfile((prev) => (prev ? { ...prev, displayName } : prev));
  }

  function handleToggleSidebarCollapse() {
    setSidebarCollapsed((v) => !v);
  }

  async function handleRenameConversation(id: string, title: string) {
    updateConversation(id, (c) => ({ ...c, title }));
    // Best-effort — if the conversation hasn't been created server-side yet (its
    // first message is still in flight), this 404s and the rename just stays
    // local-only until the next conversations fetch overwrites it. Not worth
    // more complexity for that narrow a race window.
    await renameConversationApi(id, title).catch((err) => console.error("failed to rename conversation", err));
  }

  function handleRenameTitle(title: string) {
    if (!activeConversationId) return;
    void handleRenameConversation(activeConversationId, title);
  }

  async function handleToggleStarConversation(id: string, starred: boolean) {
    updateConversation(id, (c) => ({ ...c, starred }));
    try {
      await setConversationStarredApi(id, starred);
    } catch (err) {
      updateConversation(id, (c) => ({ ...c, starred: !starred }));
      throw err;
    }
  }

  async function handleDeleteConversation(id: string) {
    await deleteConversationApi(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversationId === id) {
      setActiveConversationId(null);
    }
  }

  function handleLogout() {
    void supabase.auth.signOut();
  }

  /** Fires the actual request and wires its callbacks onto `assistantMessageId`.
   * Shared by a normal send and by Regenerate so both behave identically. */
  function runTurn(opts: {
    clientConversationId: string;
    serverConversationId: string | undefined;
    question: string;
    attachments: ComposerAttachment[];
    assistantMessageId: string;
    regenerate?: boolean;
  }) {
    const { clientConversationId, serverConversationId, question, attachments, assistantMessageId } = opts;
    setIsStreaming(true);

    abortRef.current = apiChatSource.send(
      question,
      attachments,
      serverConversationId,
      {
        onToken: (textSoFar) => {
          updateConversation(clientConversationId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === assistantMessageId ? { ...m, content: textSoFar } : m)),
          }));
        },
        onDone: (finalText, meta) => {
          const resolvedConversationId = meta?.conversationId;
          // The server falls back when a choice isn't usable, so the picker is
          // corrected from what actually answered rather than from what was
          // asked for — otherwise it would keep displaying a provider that
          // never ran.
          if (meta?.provider) {
            setProviderByConversation((prev) => ({ ...prev, [clientConversationId]: meta.provider as string }));
          }
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== clientConversationId) return c;
              const messages = c.messages.map((m) =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      content: finalText,
                      status: "done" as const,
                      sources: meta?.sources,
                      materials: meta?.materials,
                      materialsScope: meta?.materialsScope,
                      visual: meta?.visual,
                      examPageImages: meta?.examPageImages,
                      examPageImageLabels: meta?.examPageImageLabels,
                      presentsPastYearQuestion: meta?.presentsPastYearQuestion,
                    }
                  : m,
              );
              return resolvedConversationId && resolvedConversationId !== c.id
                ? { ...c, id: resolvedConversationId, messages }
                : { ...c, messages };
            }),
          );
          if (resolvedConversationId && resolvedConversationId !== clientConversationId) {
            setActiveConversationId((current) =>
              current === clientConversationId ? resolvedConversationId : current,
            );
            if (lastTurnRef.current) lastTurnRef.current.conversationId = resolvedConversationId;
          }
          abortRef.current = null;
          setIsStreaming(false);
        },
        onError: (error) => {
          updateConversation(clientConversationId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantMessageId ? { ...m, content: error.message, status: "error" } : m,
            ),
          }));
          abortRef.current = null;
          setIsStreaming(false);
        },
      },
      // Sent only when this conversation has an explicit choice. Omitting it
      // lets the server use whatever the conversation already stores, which is
      // what keeps a reloaded chat answering the way it has been.
      {
        regenerate: opts.regenerate,
        // Falls back to the new-conversation slot because on the very first
        // turn the picker's selection is still parked there — the real id was
        // only just generated.
        // Only a brand-new chat (no server id yet) falls back to it. An existing
        // chat with no pick of its own sends nothing, so the server keeps what
        // that conversation already stores rather than being overridden by
        // whatever was last chosen elsewhere.
        provider:
          providerByConversation[clientConversationId] ??
          (serverConversationId ? undefined : providerByConversation[NEW_CONVERSATION_PROVIDER_KEY]),
      },
    );
  }

  function handleSend(question: string, attachments: ComposerAttachment[]) {
    if (isStreaming) return;
    const isBrandNew = !activeConversationId;
    // A stable id for this send: the existing conversation's id, or a freshly
    // generated client-side one that gets reconciled with the server's real id
    // (see onDone above) once the backend creates the row.
    const clientConversationId = activeConversationId ?? crypto.randomUUID();
    const knownServerConversationId = isBrandNew ? undefined : clientConversationId;

    if (isBrandNew) {
      const conversation: Conversation = {
        id: clientConversationId,
        title: titleFor(question, attachments),
        starred: false,
        updatedAt: Date.now(),
        messages: [],
        messagesLoaded: true,
      };
      setConversations((prev) => [conversation, ...prev]);
      setActiveConversationId(clientConversationId);
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      createdAt: Date.now(),
      status: "done",
      attachments: attachments.length > 0 ? attachments.map(({ dataBase64: _dataBase64, ...rest }) => rest) : undefined,
    };
    const assistantMessageId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      status: "streaming",
    };

    updateConversation(clientConversationId, (c) => ({
      ...c,
      updatedAt: Date.now(),
      messages: [...c.messages, userMessage, assistantMessage],
    }));

    // Kept verbatim so Regenerate can replay the exact same request. It can't be
    // rebuilt from the stored message, which strips attachment payloads.
    lastTurnRef.current = { question, attachments, conversationId: clientConversationId };

    runTurn({
      clientConversationId,
      serverConversationId: knownServerConversationId,
      question,
      attachments,
      assistantMessageId,
    });
  }

  function handleStop() {
    abortRef.current?.();
    abortRef.current = null;
    setIsStreaming(false);
    if (!activeConversationId) return;
    // Whatever text already arrived is kept and marked done. Leaving it as
    // "streaming" would render a typing indicator that never resolves.
    updateConversation(activeConversationId, (c) => ({
      ...c,
      messages: c.messages.map((m) =>
        m.status === "streaming"
          ? {
              ...m,
              status: "done" as const,
              content: m.content.length > 0 ? m.content : "_Stopped._",
            }
          : m,
      ),
    }));
  }

  function handleRegenerate() {
    if (isStreaming || !activeConversationId) return;
    // Prefer the in-memory record of the last send, which still has the
    // attachment payloads. Falling back to the stored message text covers a
    // conversation reopened from history, where those payloads are long gone —
    // the question can still be replayed, just without its attachments.
    const remembered = lastTurnRef.current;
    const last =
      remembered && remembered.conversationId === activeConversationId
        ? remembered
        : (() => {
            const lastUser = [...(activeConversation?.messages ?? [])].reverse().find((m) => m.role === "user");
            return lastUser ? { question: lastUser.content, attachments: [] as ComposerAttachment[] } : null;
          })();
    if (!last) return;

    const assistantMessageId = crypto.randomUUID();
    // The previous answer is replaced in place rather than appended to, so the
    // conversation doesn't grow a duplicate question/answer pair. The backend
    // does the matching thing to the persisted rows (see `regenerate` in
    // chat-handler.ts).
    updateConversation(activeConversationId, (c) => {
      const messages = [...c.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          messages[i] = {
            ...messages[i],
            id: assistantMessageId,
            content: "",
            status: "streaming",
            sources: undefined,
            materials: undefined,
            materialsScope: undefined,
            visual: undefined,
          };
          break;
        }
      }
      return { ...c, messages };
    });

    runTurn({
      clientConversationId: activeConversationId,
      serverConversationId: activeConversationId,
      question: last.question,
      attachments: last.attachments,
      assistantMessageId,
      regenerate: true,
    });
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-[var(--color-brand)] dark:border-neutral-700" />
      </div>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  return (
    <div className="message-enter flex h-full overflow-hidden">
      <Sidebar
        conversations={conversations}
        conversationsLoading={conversationsLoading}
        activeConversationId={activeConversationId}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebarCollapse}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onRenameConversation={handleRenameConversation}
        onToggleStarConversation={handleToggleStarConversation}
        onDeleteConversation={handleDeleteConversation}
        userEmail={session.user.email ?? null}
        displayName={profile?.displayName ?? null}
        avatarUrl={profile?.avatarUrl ?? null}
        onOpenProfile={handleOpenProfile}
        onLogout={handleLogout}
        isTeacher={isTeacher}
        onOpenUpload={handleOpenUpload}
        onOpenMaterials={handleOpenMaterials}
        onOpenResources={handleOpenResources}
        onOpenGuide={handleOpenGuide}
      />

      {uploadOpen && isTeacher && <MaterialUpload onClose={() => setUploadOpen(false)} />}
      {materialsOpen && <MaterialsLibrary onClose={() => setMaterialsOpen(false)} />}
      {resourcesOpen && <ResourceLinks onClose={() => setResourcesOpen(false)} />}
      {guideOpen && <GuidePanel onClose={handleCloseGuide} isTeacher={isTeacher} />}
      {profileOpen && (
        <ProfilePanel
          email={profile?.email ?? null}
          displayName={profile?.displayName ?? null}
          role={profile?.role ?? null}
          usage={profile?.usage ?? null}
          avatarUrl={profile?.avatarUrl ?? null}
          onAvatarChange={handleAvatarChange}
          onDisplayNameChange={handleDisplayNameChange}
          onClose={() => setProfileOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <>
            <TopBar
              title={activeConversation?.title ?? "New conversation"}
              onOpenSidebar={() => setSidebarOpen(true)}
              onRenameTitle={handleRenameTitle}
              onNewConversation={handleNewConversation}
              onOpenMaterials={handleOpenMaterials}
              onOpenResources={handleOpenResources}
              onOpenGuide={handleOpenGuide}
              isTeacher={isTeacher}
              onOpenUpload={handleOpenUpload}
              onOpenProfile={handleOpenProfile}
              avatarUrl={profile?.avatarUrl ?? null}
              filesCount={isEmptyConversation ? null : conversationFiles.length}
              onOpenFiles={() => setFilesOpen(true)}
            />
            <FilesDrawer
              open={filesOpen && !isEmptyConversation}
              onClose={() => setFilesOpen(false)}
              materials={conversationFiles}
              onOpenMaterials={handleOpenMaterials}
            />
            {isEmptyConversation ? (
              <div className="message-enter flex flex-1 flex-col items-center justify-center px-6">
                <div className="w-full max-w-3xl text-center">
                  <SiriOrb className="mx-auto mb-4" />
                  <h1 className="font-display text-xl font-semibold text-neutral-800 dark:text-neutral-100">
                    Good {timeOfDayGreeting()}, {greetingName(profile?.displayName ?? null, session.user.email ?? null)}
                    <br />
                    What's on <span className="text-[var(--color-brand)]">your mind</span>?
                  </h1>
                </div>
                <div className="mt-6 w-full max-w-3xl">
                  <ChatInput
                    ref={centeredChatInputRef}
                    placeholder={appConfig.inputPlaceholder}
                    isStreaming={isStreaming}
                    onSend={handleSend}
                    onStop={handleStop}
                    variant="centered"
                    providers={providerChoices}
                    selectedProvider={activeProvider}
                    onSelectProvider={handleSelectProvider}
                  />
                </div>
                <div className="mt-6 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
                  {suggestedPrompts.map(({ icon: Icon, text }) => (
                    <button
                      key={text}
                      type="button"
                      onClick={() => handleSend(text, [])}
                      className="field flex items-start gap-3 rounded-xl px-4 py-3 text-left text-sm text-neutral-700 transition-colors hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-brand)]" />
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                  <ChatMessageList
                    messages={activeConversation?.messages ?? []}
                    loading={loadingMessagesId !== null && loadingMessagesId === activeConversationId}
                    onRegenerate={canRegenerate ? handleRegenerate : undefined}
                    isStreaming={isStreaming}
                    quickActions={[
                      // Fills the composer rather than sending: the student still has to write the answer.
                      { label: "Check my answer", onClick: () => dockedChatInputRef.current?.setValue("My answer: ") },
                      { label: "Give me a hint", onClick: () => handleSend("Give me a hint for this question, without the full answer.", []) },
                      { label: "Another like this", onClick: () => handleSend("Give me another past-year question like this one.", []) },
                    ]}
                  />
                  <ChatInput
                    ref={dockedChatInputRef}
                    placeholder={appConfig.inputPlaceholder}
                    isStreaming={isStreaming}
                    onSend={handleSend}
                    onStop={handleStop}
                    providers={providerChoices}
                    selectedProvider={activeProvider}
                    onSelectProvider={handleSelectProvider}
                  />
                </div>
                <FilesPanel
                  materials={conversationFiles}
                  onOpenMaterials={handleOpenMaterials}
                />
              </div>
            )}
          </>
      </div>
    </div>
  );
}
