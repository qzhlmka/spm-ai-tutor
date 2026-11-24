import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// service_role key required for ingestion writes — the anon key plus RLS
// with no policies defined will silently block inserts (see project notes).
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
