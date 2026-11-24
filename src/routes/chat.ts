import type { FastifyInstance } from "fastify";
import { handleChatRequest } from "../lib/chat-handler.js";
import { requireUser } from "../lib/auth.js";

export async function chatRoutes(app: FastifyInstance) {
  app.post("/api/chat", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await handleChatRequest(request.body, user, request.log);
    return reply.status(result.status).send(result.body);
  });
}
