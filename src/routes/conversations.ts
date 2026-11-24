import type { FastifyInstance } from "fastify";
import { listConversations, getConversationMessages, updateConversation, deleteConversation } from "../lib/conversations.js";
import { requireUser } from "../lib/auth.js";

export async function conversationsRoutes(app: FastifyInstance) {
  app.get("/api/conversations", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await listConversations(user);
    return reply.status(result.status).send(result.body);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await getConversationMessages(user, request.params.id);
    return reply.status(result.status).send(result.body);
  });

  app.patch<{ Params: { id: string }; Body: { title?: unknown; starred?: unknown } }>(
    "/api/conversations/:id",
    async (request, reply) => {
      const user = await requireUser(request.headers.authorization);
      const result = await updateConversation(user, request.params.id, request.body ?? {});
      return reply.status(result.status).send(result.body);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await deleteConversation(user, request.params.id);
    return reply.status(result.status).send(result.body);
  });
}
