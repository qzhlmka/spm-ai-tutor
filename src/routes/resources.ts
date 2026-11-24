import type { FastifyInstance } from "fastify";
import { createResource, listResources, updateResource, deleteResource } from "../lib/resources.js";
import { requireUser } from "../lib/auth.js";

export async function resourcesRoutes(app: FastifyInstance) {
  app.post("/api/resources", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await createResource(user, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.get("/api/resources", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await listResources(user);
    return reply.status(result.status).send(result.body);
  });

  app.patch("/api/resources/:id", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const { id } = request.params as { id: string };
    const result = await updateResource(user, id, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.delete("/api/resources/:id", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const { id } = request.params as { id: string };
    const result = await deleteResource(user, id);
    return reply.status(result.status).send(result.body);
  });
}
