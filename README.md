# study-assistant

A retrieval-augmented tutor for Malaysian **SPM / KSSM** schoolwork, covering Additional
Mathematics, Physics, Chemistry, Sejarah and other subjects.

Textbook and past-year-question PDFs are ingested into a Supabase/pgvector store. A student
asks a question, relevant material is retrieved across the whole knowledge base, and the tutor
answers from its own knowledge grounded in that material and in the KSSM/SPM syllabus.
Teachers can upload their own class notes, which the tutor then teaches from as authoritative
material for their students.

The tutor is scoped to SPM schoolwork only — off-topic requests, jailbreaks, and
persona-override attempts are declined by the system prompt.

## Stack

| | |
|---|---|
| Backend | Fastify + TypeScript (JSON API only — serves no HTML) |
| Frontend | Vite + React + TypeScript + Tailwind, KaTeX for maths |
| Database | Supabase Postgres + `pgvector` |
| Auth | Supabase Auth (JWT bearer token) |
| Tutor model | Anthropic `claude-haiku-4-5` |
| Vision / OCR / chunking | OpenAI `gpt-4.1` |
| Embeddings | `multilingual-e5-base`, 768-dim, run **locally in-process** — no per-token cost |

## Quick start

Requires Node 22+ (developed on 24), and `pdftoppm` (poppler) if you plan to OCR scanned PDFs.

```bash
# 1. Install
npm install
cd frontend && npm install && cd ..

# 2. Configure — fill in both from the examples
cp .env.example .env                    # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
                                        # OPENAI_API_KEY, ANTHROPIC_API_KEY, PORT
cp frontend/.env.example frontend/.env  # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

# 3. Create the schema — run sql/schema.sql against your Supabase project,
#    then the sql/migrate_*.sql files.

# 4. Run everything on one port
cd frontend && npm run dev              # http://localhost:5173
```

That last command serves the **whole app** — UI, `/api/chat`, `/api/conversations`,
`/api/materials`, `/health` — from a single Vite process. A Vite plugin
(`frontend/vite-plugins/api.ts`) runs the backend logic directly inside Vite's dev server, so
no separate backend process is needed day to day. Backend secrets stay server-side; that
plugin never reaches the browser bundle.

The root `.env` is loaded explicitly by `frontend`'s `dev`/`preview` scripts
(`node --env-file=../.env ...`), because Vite's cwd is `frontend/`, not the project root.

## Commands

From `frontend/`:

```bash
npm run dev      # UI + API on :5173 (the normal way to develop)
npm run build    # tsc -b && vite build   (see gotcha below)
npm run lint     # oxlint
```

From the project root — the standalone Fastify server, used for production deployment (where
Vite's dev server doesn't exist) or to run the API on its own port:

```bash
npm run dev        # tsx watch src/server.ts
npm run build      # compile to dist/
npm run start      # node dist/server.js
npm run typecheck  # tsc --noEmit
npm run reembed    # re-embed all chunks after an embedding-model change

npm run ingest -- <file.pdf> --exam-board SPM --subject 'Add Maths' --topic Differentiation \
  [--dry-run] [--vision] [--start-page N] [--end-page N]
```

There is no automated test suite. Behaviour is verified by measuring against the real
knowledge base — see *Retrieval* below.

## Architecture

### Two entry points, one implementation

The chat logic lives once, in `src/lib/chat-handler.ts`, and is called from two places so it
can never drift into two copies:

1. **`src/server.ts`** → thin route wrappers in `src/routes/` — the production shape.
2. **`frontend/vite-plugins/api.ts`** — the same `src/lib/*` functions mounted as middleware
   on Vite's dev server. Local development only; production still needs the Fastify server
   deployed as its own process.

### Retrieval

Four parallel lanes, merged and deduped into a 12-chunk context block:

| Lane | What it searches | Why it exists |
|---|---|---|
| `match_content_chunks` ×2 | whole knowledge base | once on the bare question, once with the prior turn prepended, to resolve follow-ups like "sketch it" |
| `match_teacher_materials` | teacher uploads only | a few dozen teacher chunks otherwise lose the whole-KB search to thousands of textbook chunks on the same topic |
| `match_teacher_materials_lexical` | teacher uploads only | IDF-weighted keyword search — catches a student quoting their teacher's exact wording, which dense vectors structurally cannot match |

**The cutoffs in this path are empirically measured, not guessed.** Each constant in
`chat-handler.ts` carries the probe results that produced it *and* the approaches that were
built, measured and rejected — `ts_rank`, teacher-subset IDF, a topic-label gate, and running
the teacher lane on the prior-turn query. Re-measure before changing any of them; several
plausible-sounding alternatives are provably worse, and the notes exist so nobody has to
rediscover that.

Teacher PDFs are downloadable **only** from the Materials tab, never offered from a chat turn.
Retrieval still feeds their content to the tutor so it can teach from them — only the file
download lives elsewhere.

### Ingestion

`src/ingest/ingest.ts`: extract PDF text per page → batch pages → have `gpt-4.1` split each
batch into typed chunks (`concept`, `worked_example`, `past_year_question`, `formula`,
`common_mistake`) → embed → insert.

Chunking of every batch completes before any row is inserted, so a mid-run failure leaves zero
partial rows and re-running is always safe. `--dry-run` writes the chunks to a JSON file for
review instead of inserting. `--vision` renders pages with `pdftoppm` and transcribes them
with a vision model, for scanned PDFs with no usable text layer; results are cached per source
PDF and are resumable.

Teacher uploads (`src/lib/materials.ts`) run through the *same* `runIngestion()` the CLI uses,
and auto-detect a scanned PDF so a teacher never has to know about `--vision`.

### Database

`sql/schema.sql` plus the `sql/migrate_*.sql` files, applied in order. Key objects:
`content_chunks` (the knowledge base, HNSW cosine index), `users` / `conversations` /
`messages`, `materials`, `usage_daily`, and the three `match_*` retrieval functions.

Vectors from different embedding models are never comparable — mixing them breaks retrieval
silently, with no error. Model changes therefore go through an add-column → `npm run reembed`
→ drop-and-rename migration; `sql/migrate_e5_base*.sql` is the worked example.

### Roles and cost control

`users.role` is `'student'` or `'teacher'`, flipped only by a manual DB update. It gates the
material-upload endpoints and the per-student daily spend cap
(`STUDENT_DAILY_BUDGET_USD`, checked before any model call, computed from real token usage).

## Gotchas

- **`npm run build` in `frontend/` fails on missing env vars** unless you pass the env file:
  `node --env-file=../.env node_modules/.bin/vite build`. Only `dev` and `preview` load it.
- **A stale `OPENAI_API_KEY` can linger in an open shell** even after you change `.env`. If
  OpenAI calls hang or 401, `unset OPENAI_API_KEY` and restart the dev server.
- **`onnxruntime-node` is pinned to 1.23.0** via `overrides`; newer versions dropped prebuilt
  Intel Mac (`darwin-x64`) binaries.
- **E5 embeddings need asymmetric prefixes.** Use `embedQuery()` for questions and
  `embedPassage()` for stored chunks — there is deliberately no bare `embed()`, because the
  wrong one works silently and just retrieves worse.

## Further reading

`CLAUDE.md` carries the detailed architecture notes, the reasoning behind each design
decision, and the measurements behind the retrieval tuning.
