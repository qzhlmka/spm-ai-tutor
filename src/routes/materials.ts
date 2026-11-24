import type { FastifyInstance } from "fastify";
import {
  uploadMaterial,
  listMaterials,
  listMaterialsLibrary,
  getMaterialDownloadUrl,
  updateMaterial,
  deleteMaterial,
} from "../lib/materials.js";
import { getProfile, updateProfile, uploadAvatar } from "../lib/profile.js";
import { requireUser } from "../lib/auth.js";

export async function materialsRoutes(app: FastifyInstance) {
  app.post("/api/materials", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await uploadMaterial(user, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.get("/api/materials", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await listMaterials(user);
    return reply.status(result.status).send(result.body);
  });

  app.get("/api/materials/library", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await listMaterialsLibrary(user);
    return reply.status(result.status).send(result.body);
  });

  app.get("/api/materials/:id/download", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const { id } = request.params as { id: string };
    // ?disposition=attachment forces a save-to-disk; the default inline URL is
    // what the library's in-app PDF viewer drops into its <iframe>.
    const { disposition } = request.query as { disposition?: string };
    const result = await getMaterialDownloadUrl(user, id, disposition === "attachment" ? "attachment" : "inline");
    return reply.status(result.status).send(result.body);
  });

  app.patch("/api/materials/:id", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const { id } = request.params as { id: string };
    const result = await updateMaterial(user, id, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.delete("/api/materials/:id", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const { id } = request.params as { id: string };
    const result = await deleteMaterial(user, id);
    return reply.status(result.status).send(result.body);
  });

  app.get("/api/profile", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await getProfile(user);
    return reply.status(result.status).send(result.body);
  });

  app.patch("/api/profile", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await updateProfile(user, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.post("/api/profile/avatar", async (request, reply) => {
    const user = await requireUser(request.headers.authorization);
    const result = await uploadAvatar(user, request.body);
    return reply.status(result.status).send(result.body);
  });
}
