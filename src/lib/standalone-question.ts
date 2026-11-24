/**
 * Rewrites a follow-up into a question that stands on its own, using the
 * conversation, for the steps that never see the conversation.
 *
 * The tutor's answer call gets the last 20 messages, but the steps before it
 * get fragments: retrieval prepends 300 characters of the last message, the
 * diagram locator sees the previous user message. That breaks as soon as the
 * last message itself has no topic. Reported (2026-10-14): after "show me the
 * transformer" → a Kelantan 2023 Diagram 10 question → "wheres the diagram" →
 * "I can't show it", the message "can you just give me the file for it" was
 * searched with nothing about transformers or Physics in reach, retrieval
 * returned a Chemistry "Rajah 10", and the locator showed it.
 *
 * The rewrite feeds retrieval (as an extra lane, never instead of the
 * student's own words) and the diagram step. The tutor still answers the
 * verbatim message with the full history. Any failure returns null, which is
 * exactly the behaviour before this existed.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { TUTOR_MODEL } from "./anthropic.js";
import { tracedMessage } from "./tracing.js";
import { recordUsage } from "./usage.js";

const STANDALONE_TOOL: Anthropic.Tool = {
  name: "report_standalone_question",
  description: "Report the student's latest message rewritten so it can be understood without the conversation.",
  input_schema: {
    type: "object",
    properties: {
      standalone: {
        type: "string",
        description:
          "The latest message as a self-contained request, in the student's language. Replace every reference to the " +
          "conversation (\"it\", \"that\", \"the first question\", \"the figure\", \"again\") with what it refers to: the subject, " +
          "the topic, and the exam and question number when one is meant (e.g. \"Show the diagram for Kelantan 2023 Physics " +
          "Question 10 (simple transformer)\"). Keep what the student is asking for (explain / show / solve / give a file). " +
          "If the message already stands on its own or starts a new topic, return it unchanged. Never answer it, and never " +
          "add a topic the conversation does not contain.",
      },
    },
    required: ["standalone"],
  },
};

// Enough of each message to carry the topic and any question the tutor quoted.
const USER_CHARS = 400;
const TUTOR_CHARS = 1200;
const MESSAGES = 6;

export async function standaloneQuestion(args: {
  userId: string;
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
  warn: (message: string, err: unknown) => void;
}): Promise<string | null> {
  const { userId, question, history, warn } = args;
  if (history.length === 0 || question.trim().length === 0) return null;
  const transcript = history
    .slice(-MESSAGES)
    .map((m) => (m.role === "user" ? `Student: ${m.content.slice(0, USER_CHARS)}` : `Tutor: ${m.content.slice(0, TUTOR_CHARS)}`))
    .join("\n\n");
  try {
    const message = await tracedMessage("standalone-question", {
      model: TUTOR_MODEL,
      max_tokens: 200,
      // Off for the same reason as every forced tool call here: thinking would
      // spend max_tokens before the tool call is emitted.
      thinking: { type: "disabled" as const },
      system:
        "You help a Malaysian SPM tutoring app search its knowledge base. Rewrite the student's latest message so it makes sense without the conversation. Call report_standalone_question exactly once.",
      tools: [STANDALONE_TOOL],
      tool_choice: { type: "tool", name: STANDALONE_TOOL.name },
      messages: [{ role: "user", content: `Conversation so far:\n${transcript}\n\nLatest student message:\n${question}` }],
    });
    await recordUsage(
      userId,
      TUTOR_MODEL,
      message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
      message.usage.cache_read_input_tokens ?? 0,
      message.usage.output_tokens,
    );
    const toolUse = message.content.find((b) => b.type === "tool_use");
    const standalone = (toolUse?.input as { standalone?: unknown } | undefined)?.standalone;
    if (typeof standalone !== "string") return null;
    const text = standalone.trim();
    const same = (a: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return text.length === 0 || same(text) === same(question) ? null : text;
  } catch (err) {
    warn("standalone-question rewrite failed; using the message as sent", err);
    return null;
  }
}
