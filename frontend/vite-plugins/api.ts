import type { Plugin, Connect } from "vite";
import type { IncomingMessage } from "node:http";

// The backend modules are loaded LAZILY, inside the dev/preview server hooks,
// never at module scope. vite.config.ts imports this file, so a static import
// here would drag src/lib/env.ts into `vite build` — and env.ts throws on any
// missing backend secret. That made the production frontend build require
// SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY and ANTHROPIC_API_KEY, which a
// static build has no business knowing. Now `vite build` needs only the two
// VITE_* variables, and these modules load solely when a dev/preview server
// actually starts.
type Backend = {
  handleChatRequest: typeof import("../../src/lib/chat-handler.js")["handleChatRequest"];
  requireUser: typeof import("../../src/lib/auth.js")["requireUser"];
  listConversations: typeof import("../../src/lib/conversations.js")["listConversations"];
  getConversationMessages: typeof import("../../src/lib/conversations.js")["getConversationMessages"];
  updateConversation: typeof import("../../src/lib/conversations.js")["updateConversation"];
  deleteConversation: typeof import("../../src/lib/conversations.js")["deleteConversation"];
  uploadMaterial: typeof import("../../src/lib/materials.js")["uploadMaterial"];
  listMaterials: typeof import("../../src/lib/materials.js")["listMaterials"];
  listMaterialsLibrary: typeof import("../../src/lib/materials.js")["listMaterialsLibrary"];
  getMaterialDownloadUrl: typeof import("../../src/lib/materials.js")["getMaterialDownloadUrl"];
  updateMaterial: typeof import("../../src/lib/materials.js")["updateMaterial"];
  deleteMaterial: typeof import("../../src/lib/materials.js")["deleteMaterial"];
  createResource: typeof import("../../src/lib/resources.js")["createResource"];
  listResources: typeof import("../../src/lib/resources.js")["listResources"];
  updateResource: typeof import("../../src/lib/resources.js")["updateResource"];
  deleteResource: typeof import("../../src/lib/resources.js")["deleteResource"];
  getProfile: typeof import("../../src/lib/profile.js")["getProfile"];
  updateProfile: typeof import("../../src/lib/profile.js")["updateProfile"];
  uploadAvatar: typeof import("../../src/lib/profile.js")["uploadAvatar"];
};

let backendPromise: Promise<Backend> | null = null;
function loadBackend(): Promise<Backend> {
  backendPromise ??= (async () => {
    const [chat, auth, conversations, materials, resources, profile] = await Promise.all([
      import("../../src/lib/chat-handler.js"),
      import("../../src/lib/auth.js"),
      import("../../src/lib/conversations.js"),
      import("../../src/lib/materials.js"),
      import("../../src/lib/resources.js"),
      import("../../src/lib/profile.js"),
    ]);
    return { ...chat, ...auth, ...conversations, ...materials, ...resources, ...profile };
  })();
  return backendPromise;
}

// Runs the AI backend directly inside Vite's own dev server process, on the
// same port (5173) — no separate Fastify process/port for local dev. This
// hook (and its request handlers) only ever execute in Node, as part of
// Vite's own server, never bundled into the client-shipped React app, so
// backend secrets (OPENAI_API_KEY, SUPABASE_SERVICE_ROLE_KEY) loaded via
// src/lib/env.ts never reach the browser.
//
// A standalone Fastify backend (src/server.ts, `npm run dev` at the project
// root) still exists and still works unchanged — src/routes/chat.ts and this
// plugin both call the same handleChatRequest() in src/lib/chat-handler.ts,
// so there's one source of truth, not two copies to keep in sync. That
// standalone backend is what you'd deploy in production, where Vite's dev
// server doesn't run at all; this plugin is a local-dev convenience only.
// Matches src/server.ts's Fastify bodyLimit — base64-encoded image/PDF attachments
// (src/lib/attachments.ts) and teacher material uploads (src/lib/materials.ts) can
// be sizeable, but requests still need a ceiling.
const MAX_BODY_BYTES = 60 * 1024 * 1024;

class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_BODY_BYTES) throw new PayloadTooLargeError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function apiMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = req.url ?? "";

    if (req.method === "GET" && url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Anything past this point touches the backend, so resolve the lazily
    // imported modules first (cached after the first call — see loadBackend).
    if (!url.startsWith("/api/")) {
      next();
      return;
    }
    const {
      handleChatRequest,
      requireUser,
      listConversations,
      getConversationMessages,
      updateConversation,
      deleteConversation,
      uploadMaterial,
      listMaterials,
      listMaterialsLibrary,
      updateMaterial,
      deleteMaterial,
      getMaterialDownloadUrl,
      createResource,
      listResources,
      updateResource,
      deleteResource,
      getProfile,
      updateProfile,
      uploadAvatar,
    } = await loadBackend();

    if (req.method === "POST" && url === "/api/chat") {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = await readJsonBody(req);
        const result = await handleChatRequest(body, user, console);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "GET" && url === "/api/conversations") {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await listConversations(user);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const conversationMessagesMatch = req.method === "GET" && url.match(/^\/api\/conversations\/([^/?]+)\/messages/);
    if (conversationMessagesMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await getConversationMessages(user, conversationMessagesMatch[1]);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const conversationMatch = req.method === "PATCH" && url.match(/^\/api\/conversations\/([^/?]+)$/);
    if (conversationMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = (await readJsonBody(req)) as { title?: unknown; starred?: unknown };
        const result = await updateConversation(user, conversationMatch[1], body ?? {});
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const conversationDeleteMatch = req.method === "DELETE" && url.match(/^\/api\/conversations\/([^/?]+)$/);
    if (conversationDeleteMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await deleteConversation(user, conversationDeleteMatch[1]);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "POST" && url === "/api/materials") {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = await readJsonBody(req);
        const result = await uploadMaterial(user, body);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "GET" && url === "/api/materials") {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await listMaterials(user);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "GET" && url === "/api/materials/library") {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await listMaterialsLibrary(user);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const materialDownloadMatch = req.method === "GET" && url.match(/^\/api\/materials\/([^/?]+)\/download(?:\?(.*))?$/);
    if (materialDownloadMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        // ?disposition=attachment forces a save-to-disk; the default inline URL
        // is what the library's in-app PDF viewer drops into its <iframe>.
        const disposition = new URLSearchParams(materialDownloadMatch[2] ?? "").get("disposition");
        const result = await getMaterialDownloadUrl(
          user,
          materialDownloadMatch[1],
          disposition === "attachment" ? "attachment" : "inline",
        );
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const materialUpdateMatch = req.method === "PATCH" && url.match(/^\/api\/materials\/([^/?]+)$/);
    if (materialUpdateMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = await readJsonBody(req);
        const result = await updateMaterial(user, materialUpdateMatch[1], body);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const materialDeleteMatch = req.method === "DELETE" && url.match(/^\/api\/materials\/([^/?]+)$/);
    if (materialDeleteMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await deleteMaterial(user, materialDeleteMatch[1]);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "POST" && url === "/api/resources") {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = await readJsonBody(req);
        const result = await createResource(user, body);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "GET" && url === "/api/resources") {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await listResources(user);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const resourceUpdateMatch = req.method === "PATCH" && url.match(/^\/api\/resources\/([^/?]+)$/);
    if (resourceUpdateMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = await readJsonBody(req);
        const result = await updateResource(user, resourceUpdateMatch[1], body);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    const resourceDeleteMatch = req.method === "DELETE" && url.match(/^\/api\/resources\/([^/?]+)$/);
    if (resourceDeleteMatch) {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await deleteResource(user, resourceDeleteMatch[1]);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "PATCH" && url === "/api/profile") {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = await readJsonBody(req);
        const result = await updateProfile(user, body);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "GET" && url === "/api/profile") {
      try {
        const user = await requireUser(req.headers.authorization);
        const result = await getProfile(user);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    if (req.method === "POST" && url === "/api/profile/avatar") {
      try {
        const user = await requireUser(req.headers.authorization);
        const body = await readJsonBody(req);
        const result = await uploadAvatar(user, body);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        console.error("api middleware error", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    next();
  };
}

export function apiPlugin(): Plugin {
  return {
    name: "study-assistant-api",
    configureServer(server) {
      server.middlewares.use(apiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware());
    },
  };
}
