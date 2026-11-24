import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see frontend/.env.example)");
}

// Client-side auth only (signup/login/session) — the anon key is safe to expose in the
// browser by design. All actual data (conversations/messages) goes through our own
// backend, which verifies the session token and uses the service-role key server-side.
export const supabase = createClient(url, anonKey);
