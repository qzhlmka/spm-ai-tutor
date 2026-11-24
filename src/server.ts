import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./lib/env.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationsRoutes } from "./routes/conversations.js";
import { healthRoutes } from "./routes/health.js";
import { materialsRoutes } from "./routes/materials.js";
import { resourcesRoutes } from "./routes/resources.js";

// Default 1MB body limit is too small for base64-encoded image/PDF attachments —
// up to 3 attachments at 8MB raw each (see src/lib/attachments.ts), plus ~33% base64
// overhead — and for teacher material uploads (src/lib/materials.ts), capped at 40MB
// raw per file before the same base64 overhead. Large scanned documents should still
// go through `npm run ingest -- --vision` instead of this endpoint.
const app = Fastify({ logger: true, bodyLimit: 60 * 1024 * 1024 });

await app.register(cors);
await app.register(healthRoutes);
await app.register(chatRoutes);
await app.register(conversationsRoutes);
await app.register(materialsRoutes);
await app.register(resourcesRoutes);

// Serve the built React app from this same process, so the whole deployment is
// ONE origin. This is not a convenience: every call in frontend/src/lib/*Api.ts
// is a relative path (`fetch("/api/chat")`), which only resolves if the UI and
// the API share an origin. Split across two hosts, every request 404s against
// the static host.
//
// Registered last, and only when a build is actually present: running the API
// alone (`npm run dev` at the project root, with local dev served by Vite on
// :5173) is still supported, and there is no frontend/dist in that case.
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "dist");
if (existsSync(join(distDir, "index.html"))) {
  await app.register(fastifyStatic, { root: distDir });

  // SPA fallback. The app has no router (screens are conditional renders in
  // App.tsx), so this exists for deep links and reloads rather than for real
  // client-side routes. It deliberately does NOT swallow unmatched /api/*
  // requests — those must keep returning a JSON 404, or a typo'd endpoint would
  // silently hand the caller an HTML page and surface as a JSON parse error.
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.log.warn(
    { distDir },
    "no frontend build found — serving the API only. Run `npm run build` to include the UI.",
  );
}

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
