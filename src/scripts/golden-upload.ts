/**
 * Uploads a checked golden set to Langfuse as a dataset (rag-stack Phase 1).
 *
 *   npx tsx --env-file=.env src/scripts/golden-upload.ts golden/<file>.jsonl <dataset-name>
 *
 * Only approved/fixed items go up. Item ids are a hash of dataset + question,
 * so re-running upserts instead of duplicating. Run golden-check first.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";

const [file, name] = process.argv.slice(2);
if (!file || !name) throw new Error("usage: golden-upload <file.jsonl> <dataset-name>");

const langfuse = new LangfuseClient();
const items = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const ready = items.filter((i) => ["approved", "fixed"].includes(i.metadata?.review));
if (ready.length !== items.filter((i) => i.metadata?.review !== "rejected").length) {
  throw new Error("some items are still pending review — run golden-check without --draft first");
}

await langfuse.api.datasets.create({ name, description: "SPM tutor golden set — see golden/ and RAG_STATUS.md" }).catch(() => undefined);
let done = 0;
for (const item of ready) {
  const id = `${name}-${createHash("sha256").update(name + "\n" + item.input.question).digest("hex").slice(0, 16)}`;
  await langfuse.api.datasetItems.create({ datasetName: name, id, input: item.input, expectedOutput: item.expectedOutput, metadata: item.metadata });
  done++;
}
console.log(`uploaded ${done} items to dataset ${name}`);
