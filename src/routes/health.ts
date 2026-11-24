import type { FastifyInstance } from "fastify";

// Which commit is running, from the variable Railway sets on every deploy, so a
// stalled deploy shows up at /health instead of as old behaviour in the app.
// Null when not deployed by Railway (local dev).
const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok", commit }));
}
