/**
 * Lists the models an OpenAI-compatible provider actually serves, so a model id
 * is read off the account rather than guessed.
 *
 * This exists because "use the highest-end model" is not answerable from
 * outside: /v1/models returns an unordered set of ids with no capability or
 * tier field, so which one is "highest" is a judgment about that vendor's
 * lineup, not something the API states. Guessing an id produces a config that
 * looks right and 404s on the first student question. Run this, look at what
 * comes back, and set ILMUCHAT_MODEL.
 *
 * The same method was used to pin the OpenAI side: "terra" was matched against
 * a live models.list() and resolved to exactly one id.
 *
 *   npx tsx --env-file=.env src/scripts/list-ilmuchat-models.ts
 *   npx tsx --env-file=.env src/scripts/list-ilmuchat-models.ts --provider openai
 */
import OpenAI from "openai";
import { env } from "../lib/env.js";

async function main() {
  const which = process.argv.includes("--provider")
    ? process.argv[process.argv.indexOf("--provider") + 1]
    : "ilmuchat";

  let client: OpenAI;
  let label: string;
  if (which === "openai") {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    label = "OpenAI";
  } else {
    if (!env.ILMUCHAT_BASE_URL || !env.ILMUCHAT_API_KEY) {
      console.error(
        "ILMUCHAT_BASE_URL and ILMUCHAT_API_KEY must be set before this can ask IlmuChat what it serves.\n" +
          "(ILMUCHAT_MODEL is what you're trying to find, so it isn't needed yet.)",
      );
      process.exitCode = 1;
      return;
    }
    client = new OpenAI({ apiKey: env.ILMUCHAT_API_KEY, baseURL: env.ILMUCHAT_BASE_URL });
    label = `IlmuChat (${env.ILMUCHAT_BASE_URL})`;
  }

  console.log(`Models served by ${label}:\n`);
  try {
    const ids: string[] = [];
    for await (const model of await client.models.list()) ids.push(model.id);
    if (ids.length === 0) {
      console.log("  (none returned — the endpoint answered but listed nothing)");
      return;
    }
    for (const id of ids.sort()) console.log(`  ${id}`);
    console.log(`\n${ids.length} model(s). Set ILMUCHAT_MODEL to the one you want and restart.`);
  } catch (err) {
    // A provider can be OpenAI-compatible for /v1/chat/completions without
    // implementing /v1/models, so a failure here is not proof the config is
    // wrong — it just means the id has to come from their documentation.
    console.error("Couldn't list models:", err instanceof Error ? err.message : err);
    console.error(
      "\nIf this endpoint doesn't implement /v1/models, that's fine — chat completions may still work. " +
        "Take the model id from IlmuChat's own documentation instead.",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
