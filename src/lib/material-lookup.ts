/**
 * "Give me the notes on X" answered from the file list itself.
 *
 * WHY THIS EXISTS. Before this, a file request got whichever teacher files had
 * a passage that scored close to the message (the judge-gated teacher lane).
 * That is the right way to find something to TEACH from, and the wrong way to
 * answer "send me the file": measured on the real library (2026-10-19),
 * "nak nota kimia konsumer" came back with a combined-class note and missed
 * "Nota Kimia Konsumer.pdf" and "CONSUMER & INDUSTRIAL CHEMISTRY.pdf"; "where
 * can i download the thermochemistry notes" showed 3 of the 12 Thermochemistry
 * files; "give me all the chemistry notes" showed 3 arbitrary ones. Every file
 * already carries the subject and topic its teacher gave it, so the request is
 * a lookup: decide which topic is meant, then list that topic's files.
 *
 * Deciding the topic is a model call over the library's own topic list, not a
 * keyword table: requests arrive in Malay and English and in short forms
 * ("KTB", "kimia konsumer", "bab redoks"). A chapter number alone is refused
 * rather than guessed — "chapter 5" is a different topic in Form 4 and Form 5,
 * and the passage-similarity path matched it to a Chapter 4 file.
 *
 * WHETHER the message asks for files is decided by the same call, from the
 * conversation, never by keywords (2026-10-19). A phrase list was the gate
 * first and missed "can you retrieve me the latest materials on this topic";
 * widening it only moved the miss to the next wording. So this runs on every
 * turn except a bare greeting, in the `route` node beside the router and the
 * standalone rewrite, and reads the last few messages itself so "this topic"
 * resolves without waiting for the rewrite. A request the router filed as
 * catalogue/app_help ("ada nota redox tak") still reaches the file step: the
 * handler treats a file request as schoolwork.
 *
 * A request that names no topic in the library lists nothing (scope null), so
 * the tutor asks what they mean rather than the panel showing passage-matched
 * files for a guess. A request for a subject nobody has uploaded files for
 * ("physics notes on waves" while every upload is Chemistry) sets
 * `missingSubject` instead: asking "which topic?" there was a question with no
 * good answer, so the tutor says plainly that there are none yet (2026-10-20). A failed call, or a message that is not a file request,
 * returns null, which leaves the passage-matched files in place.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { TUTOR_MODEL } from "./anthropic.js";
import { supabase } from "./supabase.js";
import { tracedMessage } from "./tracing.js";
import { recordUsage } from "./usage.js";

export interface LibraryFile {
  id: string;
  filename: string;
  subject: string;
  topic: string;
}

export interface MaterialLookup {
  /** Every downloadable file of the topics (or subject) the student asked for, newest first. */
  files: LibraryFile[];
  /** What was listed, for the panel heading and the prompt note; null when the request matched no topic. */
  scope: { subject: string; topics: string[] | null } | null;
  /** The subject asked for when no teacher has uploaded a file for it; null otherwise. */
  missingSubject?: string | null;
}

const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; files: LibraryFile[] } | null = null;

/** Files a student can open — the same filter as the Materials tab. Cached
 * per process like catalogue.ts: a new upload appearing a few minutes late is
 * harmless here. */
async function downloadableFiles(): Promise<LibraryFile[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.files;
  const { data, error } = await supabase
    .from("materials")
    .select("id, filename, subject, topic")
    .eq("status", "done")
    .not("file_path", "is", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const files = (data ?? []).map((m) => ({ id: m.id as string, filename: m.filename as string, subject: m.subject as string, topic: m.topic as string }));
  cached = { at: Date.now(), files };
  return files;
}

function lookupTool(topicsBySubject: Map<string, string[]>): Anthropic.Tool {
  const subjects = [...topicsBySubject.keys()];
  const topics = [...new Set([...topicsBySubject.values()].flat())];
  return {
    name: "report_requested_files",
    description: "Report which of the library's topics the student wants files for.",
    input_schema: {
      type: "object",
      properties: {
        asks_for_files: {
          type: "boolean",
          description:
            "True only when the latest message wants their teachers' files themselves — notes, slides, modules, " +
            "worksheets, materials — to see, open, download or be pointed to, however it is worded and in any language " +
            "(\"can you retrieve me the latest materials on this topic\", \"ada nota tak\", \"where can I study this from\" " +
            "when it means the class notes). False for everything else: a question to be taught or answered, a request to " +
            "practise past-year questions, checking their answer, or a subject question that merely contains such a word " +
            "(\"what is a composite material\"). Also false when they ask what the tutor holds or covers — which chapters, " +
            "topics or forms it has, or how many questions (\"which Form 2 maths chapters do you have?\", \"kimia tingkatan 4 " +
            "ada bab apa\", \"how many past year questions do you have for sejarah?\"): \"do you have\" about chapters or " +
            "topics is about the syllabus, not about files. A short reply (\"yes\", \"ok\") is a request only if the tutor's last " +
            "message offered files.",
        },
        topics: {
          type: "array",
          items: { type: "string", enum: topics },
          description:
            "The topics whose files the student asked for, from the list, using the conversation for \"this topic\" / \"it\". Match by meaning across Malay and English " +
            "(\"kimia konsumer\" = Chemical Consumer, \"KTB\"/\"kadar tindak balas\" = Rate of Reaction, \"termokimia\" = " +
            "Thermochemistry, \"redoks\"/electrochemistry/electrolysis = Redox Equilibrium, \"amali\" = practical). Empty " +
            "when no listed topic is meant, or when the student only gave a chapter number.",
        },
        subject: {
          type: ["string", "null"],
          description:
            `The school subject whose files the student wants, from the message or the conversation, as its English name (${subjects.join(", ")}, Physics, Mathematics, Additional Mathematics, Sejarah, Biology…; "fizik" = Physics, "matematik tambahan"/"add maths" = Additional Mathematics). Use the library's spelling when it is one of: ${subjects.join(", ")}. Infer it from the topic when the subject isn't named: "this" in a conversation about transformers or waves is Physics, about differentiation Additional Mathematics, about the Malayan Union Sejarah. Null only when neither the message nor the conversation points to a subject.`,
        },
        whole_subject: {
          type: ["string", "null"],
          enum: [...subjects, null],
          description:
            "Set only when the student asks for every file of a subject (\"all the chemistry notes\", \"semua nota kimia\"); " +
            "topics is then empty. Null otherwise.",
        },
      },
      required: ["asks_for_files", "topics", "subject", "whole_subject"],
    },
  };
}

// The same window as the standalone rewrite: enough to carry the topic.
const USER_CHARS = 400;
const TUTOR_CHARS = 1200;
const MESSAGES = 6;

export async function detectFileRequest(args: {
  userId: string;
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
  warn: (message: string, err: unknown) => void;
}): Promise<MaterialLookup | null> {
  const { userId, question, history, warn } = args;
  if (question.trim().length === 0) return null;
  const transcript = history
    .slice(-MESSAGES)
    .map((m) => (m.role === "user" ? `Student: ${m.content.slice(0, USER_CHARS)}` : `Tutor: ${m.content.slice(0, TUTOR_CHARS)}`))
    .join("\n\n");
  try {
    const files = await downloadableFiles();
    if (files.length === 0) return null;
    const topicsBySubject = new Map<string, string[]>();
    for (const f of files) {
      const list = topicsBySubject.get(f.subject) ?? [];
      if (!list.includes(f.topic)) list.push(f.topic);
      topicsBySubject.set(f.subject, list);
    }
    const tool = lookupTool(topicsBySubject);
    const library = [...topicsBySubject]
      .map(([subject, topics]) => `${subject}: ${topics.map((t) => `${t} (${files.filter((f) => f.subject === subject && f.topic === t).length} files)`).join("; ")}`)
      .join("\n");

    const message = await tracedMessage("material-topic", {
      model: TUTOR_MODEL,
      max_tokens: 200,
      // Off for the same reason as every forced tool call here: thinking would
      // spend max_tokens before the tool call is emitted.
      thinking: { type: "disabled" as const },
      system:
        "You work for a Malaysian SPM tutoring app whose teachers upload class files. Decide whether the student's latest message asks for those files, and if so which topics of the library they mean. Call report_requested_files exactly once.",
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [
        {
          role: "user",
          content: `Library:\n${library}\n\n${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}Latest student message:\n${question}`,
        },
      ],
    });
    await recordUsage(
      userId,
      TUTOR_MODEL,
      message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
      message.usage.cache_read_input_tokens ?? 0,
      message.usage.output_tokens,
    );

    const input = message.content.find((b) => b.type === "tool_use")?.input as
      | { asks_for_files?: unknown; topics?: unknown; subject?: unknown; whole_subject?: unknown }
      | undefined;
    // Anything but an explicit yes is an ordinary question.
    if (input?.asks_for_files !== true) return null;
    const topics = Array.isArray(input?.topics) ? input.topics.filter((t): t is string => typeof t === "string") : [];
    const wholeSubject = typeof input?.whole_subject === "string" && topicsBySubject.has(input.whole_subject) ? input.whole_subject : null;
    // A subject with no uploads is answered as such, whatever topics came back:
    // the topic enum only holds subjects that HAVE files, so a "waves" request
    // can only ever map to nothing (or to a Chemistry topic by mistake).
    const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
    const hasFiles = (name: string) => [...topicsBySubject.keys()].some((s) => s.toLowerCase() === name.toLowerCase());
    if (subject && !hasFiles(subject)) return { files: [], scope: null, missingSubject: subject };

    if (topics.length > 0) {
      const listed = files.filter((f) => topics.includes(f.topic));
      if (listed.length === 0) return { files: [], scope: null };
      return { files: listed, scope: { subject: listed[0].subject, topics: [...new Set(listed.map((f) => f.topic))] } };
    }
    if (wholeSubject) return { files: files.filter((f) => f.subject === wholeSubject), scope: { subject: wholeSubject, topics: null } };
    return { files: [], scope: null };
  } catch (err) {
    warn("material topic lookup failed; using passage-matched files", err);
    return null;
  }
}
