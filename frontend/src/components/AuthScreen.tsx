import { useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../lib/supabaseClient";

// Closed platform — enrolled students only. Accounts are provisioned by an
// admin/teacher, not self-service, so there's no signup mode here. This is
// a UI-level gate only; the actual boundary is disabling "Allow new users to
// sign up" in Supabase's Auth settings, since the signup API itself is
// public and reachable without this screen.
export function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) {
      setError(signInError.message);
    }
  }

  return (
    <div className="message-enter flex h-full items-center justify-center px-4">
      <div className="surface w-full max-w-sm px-6 py-8">
        <div className="font-display mb-6 text-center text-2xl font-bold tracking-tight">SPM<span className="text-[var(--color-brand)]">.</span>tutor</div>
        <h1 className="font-display text-center text-xl font-semibold">Log in</h1>
        <p className="mt-1 text-center text-sm text-neutral-500 dark:text-neutral-400">
          to start chatting with your tutor
        </p>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field rounded-lg px-3 py-2 text-[15px] outline-none"
          />
          <input
            type="password"
            required
            minLength={6}
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field rounded-lg px-3 py-2 text-[15px] outline-none"
          />

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-[var(--color-brand)] py-2 text-[15px] font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-50"
          >
            {busy ? "Please wait…" : "Log in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-neutral-400 dark:text-neutral-500">
          Accounts are provided by your school — contact your teacher if you don't have one.
        </p>
      </div>
    </div>
  );
}
