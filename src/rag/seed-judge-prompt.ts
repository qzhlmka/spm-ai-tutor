/**
 * Creates the "answer-judge" prompt in Langfuse prompt management (rag-stack
 * rule: judge prompts live in Langfuse, not in code). Re-running creates a new
 * version, labelled staging by default; promote it to production only after a
 * judge-agreement check.
 *
 *   npx tsx --env-file=.env src/rag/seed-judge-prompt.ts [--label staging]
 */
import { LangfuseClient } from "@langfuse/client";

// v3 (2026-10-13): claim by claim with evidence. v1 and v2 each graded the same
// Run A answers differently from run to run (v2 called the Daniell-cell and
// colour-blindness answers faithful; their claims are not in the material) — a
// single 0/1 verdict is too noisy to separate 0.88 from 0.90. v3 lists every
// factual claim and must quote the material for it; eval-answers.ts checks each
// quote is really there and computes faithfulness itself.
const PROMPT = `You grade answers from an SPM (Malaysian Form 4-5) tutoring app. The tutor is STRICTLY GROUNDED: it may
state only facts found in the retrieved material it was given, but it MUST apply a retrieved method to the
student's own numbers. Grade with the grade_answer_claims tool.

refused — true when the answer declines the request, or says its material does not cover it, instead of
  answering. Declining what is not held while pointing to what IS held ("no 2025 papers; I have Johor
  2021-2023") is a refusal. Teaching the topic and adding a caveat is NOT a refusal.

claims — go through the answer and list EVERY factual claim: facts, definitions, formulas, dates, values,
  named examples, mechanisms, causes, official answers, marking points. Do not list arithmetic or algebra
  steps, restatements of the question, encouragement or study advice. For each claim choose one kind:
  stated      the retrieved material says it. evidence = a VERBATIM quote of 8-30 words copied exactly from
              the RETRIEVED MATERIAL (not from the answer, not paraphrased). It will be checked by machine;
              a quote that is not in the material counts as unsupported.
  derived     not stated, but follows from the material or the question's own numbers by arithmetic or one
              obvious step (material: a 42 km race → speed × time = 42). evidence = what it follows from.
  unsupported neither — including anything true that you know but the material does not contain, and any
              new mechanism, cause, example or value the material does not give. evidence = "".
  Judge against the retrieved material ONLY, never your own knowledge. When unsure whether the material
  states something, search it and quote it; if you cannot quote it, it is not stated.

correctness — for answerable items only, against the REFERENCE ANSWER: 1 when the core agrees (wording,
  extra correct detail, a different valid method are fine); 0.5 partly right or missing a key part; 0 wrong,
  contradicting the reference, or refusing. For items marked not answerable give 0.

Be strict and consistent. Do not reward length or confidence.`;

const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "staging";
const langfuse = new LangfuseClient();
const p = await langfuse.prompt.create({ name: "answer-judge", type: "text", prompt: PROMPT, labels: [label], config: { model: "claude-sonnet-5", tool: "grade_answer_claims" } });
console.log(`answer-judge v${p.version} created with label ${label}`);
process.exit(0);
