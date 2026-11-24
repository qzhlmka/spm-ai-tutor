import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { readFileAsBase64 } from "../lib/fileUtils";
import { updateDisplayName, uploadAvatar } from "../lib/profileApi";
import { supabase } from "../lib/supabaseClient";
import { CameraIcon, PencilIcon, UserIcon, XIcon } from "./Icons";

interface ProfilePanelProps {
  email: string | null;
  displayName: string | null;
  role: "student" | "teacher" | null;
  usage: { usedUsd: number; limitUsd: number } | null;
  avatarUrl: string | null;
  onAvatarChange: (avatarUrl: string) => void;
  onDisplayNameChange: (displayName: string | null) => void;
  onClose: () => void;
}

const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// No signup flow in this app collects a real name — fall back to a
// title-cased version of the email's local part, same convention as the
// chat empty-state greeting in App.tsx.
function nameFallbackFromEmail(email: string | null): string {
  if (!email) return "—";
  const local = email.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function ProfilePanel({ email, displayName, role, usage, avatarUrl, onAvatarChange, onDisplayNameChange, onClose }: ProfilePanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName ?? "");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  function startEditingName() {
    setNameDraft(displayName ?? "");
    setNameError(null);
    setEditingName(true);
  }

  async function handleNameSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = nameDraft.trim();
    // Nothing changed (including "still empty") — close without a pointless write.
    if (trimmed === (displayName ?? "")) {
      setEditingName(false);
      return;
    }
    setNameSaving(true);
    setNameError(null);
    try {
      const { displayName: saved } = await updateDisplayName(trimmed);
      onDisplayNameChange(saved);
      setEditingName(false);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Couldn't save your name.");
    } finally {
      setNameSaving(false);
    }
  }

  async function handleAvatarSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file) return;
    setAvatarError(null);

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      setAvatarError("Only PNG, JPEG, or WebP images are supported.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError("Image is too large (max 4MB).");
      return;
    }

    setUploading(true);
    try {
      const fileBase64 = await readFileAsBase64(file);
      const { avatarUrl: newUrl } = await uploadAvatar({ mimeType: file.type, fileBase64 });
      onAvatarChange(newUrl);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordNotice(null);

    if (newPassword.length < 6) {
      setPasswordError("Password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords don't match.");
      return;
    }

    setPasswordSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPasswordSubmitting(false);
    if (error) {
      setPasswordError(error.message);
      return;
    }
    setNewPassword("");
    setConfirmPassword("");
    setPasswordNotice("Password updated.");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Profile">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 sm:px-6">
          <h1 className="font-display text-lg font-semibold text-neutral-800 dark:text-neutral-100">Profile</h1>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="rounded-lg p-2 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="surface flex flex-col items-center gap-2 p-6">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="Change profile picture"
              title="Change profile picture"
              className="group relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-[var(--color-brand)] text-[var(--color-on-brand)] disabled:opacity-60"
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <UserIcon className="h-9 w-9" />
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <CameraIcon className="h-5 w-5" />
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleAvatarSelected}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="text-xs font-medium text-[var(--color-brand)] hover:underline disabled:opacity-60"
            >
              {uploading ? "Uploading…" : "Change photo"}
            </button>
            {avatarError && <p className="text-xs text-red-600 dark:text-red-400">{avatarError}</p>}

            <div className="mt-2 flex w-full flex-col items-center gap-0.5 text-center">
              {editingName ? (
                <form onSubmit={handleNameSubmit} className="flex w-full max-w-[16rem] flex-col gap-2">
                  <input
                    ref={nameInputRef}
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingName(false);
                      }
                    }}
                    maxLength={60}
                    disabled={nameSaving}
                    aria-label="Display name"
                    placeholder={nameFallbackFromEmail(email)}
                    className="field rounded-lg px-3 py-1.5 text-center text-sm outline-none disabled:opacity-60"
                  />
                  <div className="flex justify-center gap-2">
                    <button
                      type="submit"
                      disabled={nameSaving}
                      className="rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-[var(--color-on-brand)] disabled:opacity-60"
                    >
                      {nameSaving ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingName(false)}
                      disabled={nameSaving}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-black/5 disabled:opacity-60 dark:text-neutral-300 dark:hover:bg-white/5"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={startEditingName}
                  title="Edit name"
                  className="group flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="font-display text-base font-semibold text-neutral-800 dark:text-neutral-100">
                    {displayName ?? nameFallbackFromEmail(email)}
                  </span>
                  <PencilIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                </button>
              )}
              {nameError && <p className="text-xs text-red-600 dark:text-red-400">{nameError}</p>}
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{email ?? "—"}</p>
              {role && (
                <span className="mt-1 rounded-full bg-[var(--color-brand)]/10 px-2 py-0.5 text-xs font-medium capitalize text-[var(--color-brand)]">
                  {role}
                </span>
              )}
            </div>
          </div>

          {usage && (
            <div className="surface mt-6 flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between text-sm">
                <h2 className="font-display font-semibold text-neutral-700 dark:text-neutral-300">Today's usage</h2>
                <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
                  ${usage.usedUsd.toFixed(3)} / ${usage.limitUsd.toFixed(2)}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-line)]">
                <div
                  className="h-full rounded-full bg-[var(--color-brand)] transition-[width]"
                  style={{ width: `${Math.min(100, (usage.usedUsd / usage.limitUsd) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Resets at midnight.</p>
            </div>
          )}

          <form onSubmit={handlePasswordSubmit} className="mt-8 flex flex-col gap-3 border-t border-[var(--color-line)] pt-4">
            <h2 className="font-display text-sm font-semibold text-neutral-700 dark:text-neutral-300">Change password</h2>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">New password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={6}
                autoComplete="new-password"
                className="field rounded-lg px-3 py-1.5 text-sm outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">Confirm password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={6}
                autoComplete="new-password"
                className="field rounded-lg px-3 py-1.5 text-sm outline-none"
              />
            </label>
            {passwordError && <p className="text-xs text-red-600 dark:text-red-400">{passwordError}</p>}
            {passwordNotice && <p className="text-xs text-[var(--color-accent-text)]">{passwordNotice}</p>}
            <button
              type="submit"
              disabled={passwordSubmitting || !newPassword || !confirmPassword}
              className="self-start rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-hover)] disabled:opacity-40"
            >
              {passwordSubmitting ? "Updating…" : "Update password"}
            </button>
          </form>

          <div className="mt-8 border-t border-[var(--color-line)] pt-4">
            <h2 className="font-display text-sm font-semibold text-neutral-700 dark:text-neutral-300">Telegram</h2>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Linking your Telegram account isn't available yet — coming in a future update.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
