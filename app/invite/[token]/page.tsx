"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { KeyRound, LoaderCircle, UserPlus } from "lucide-react";
import { AuthShell, authFetch, PASSWORD_HINT, PasswordField, TextField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

type InviteInfo = { kind: "invite" | "reset"; roleLabel?: string; invitedBy: string; username?: string };

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void authFetch<InviteInfo>(`/api/auth/invite/${encodeURIComponent(token)}`).then((result) => {
      if (result.ok) setInfo(result.body); else setLoadError(result.error);
    });
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) { setError({ message: "The passwords don't match.", field: "confirm" }); return; }
    setBusy(true); setError(null);
    const result = await authFetch(`/api/auth/invite/${encodeURIComponent(token)}`, { username: info?.kind === "invite" ? username.trim() : undefined, password });
    if (!result.ok) { setError({ message: result.error, field: result.field }); setBusy(false); return; }
    window.location.replace("/");
  }

  const fieldError = (field: string) => error?.field === field ? error.message : undefined;
  if (loadError) return <AuthShell icon={KeyRound} title="Link not valid" description={loadError}><Button asChild className="mt-5 w-full" variant="outline"><Link href="/login">Go to sign in</Link></Button></AuthShell>;
  const reset = info?.kind === "reset";
  return <AuthShell icon={reset ? KeyRound : UserPlus} title={reset ? "Choose a new password" : "Join Blocky"}
    description={!info ? "Checking your link…" : reset ? <>Set a new password for <span className="font-medium text-foreground">{info.username}</span>. You&apos;ll be signed out everywhere else.</> : <><span className="font-medium text-foreground">{info.invitedBy}</span> invited you as {/^[AEIOU]/.test(info.roleLabel || "") ? "an" : "a"} <span className="font-medium text-foreground">{info.roleLabel}</span>. Choose a username and password.</>}>
    {info && <form onSubmit={(event) => void submit(event)}>
      {!reset && <TextField id="username" label="Username" autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={32} error={fieldError("username")} hint="3 to 32 letters, numbers, dots, dashes, or underscores. Shown in the activity log." />}
      <PasswordField id="password" label="Password" autoComplete="new-password" autoFocus={reset} value={password} onChange={setPassword} error={fieldError("password")} hint={PASSWORD_HINT} />
      <PasswordField id="confirm" label="Confirm password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={fieldError("confirm")} />
      {error && !error.field && <p role="alert" className="mt-4 text-sm text-destructive">{error.message}</p>}
      <Button className="mt-5 w-full" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}{reset ? "Set password and sign in" : "Create account"}</Button>
    </form>}
  </AuthShell>;
}
