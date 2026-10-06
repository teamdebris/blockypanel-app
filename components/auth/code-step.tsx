"use client";

import { FormEvent, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { AuthShell, authFetch, TextField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

/**
 * The two-factor code step, after a correct password at sign-in or a new password from a reset
 * link. `onExpired` gets the message when the sign-in timed out or ran out of tries.
 */
export function CodeStep({ challenge, back, onExpired, onSignedIn }: { challenge: string; back: React.ReactNode; onExpired: (message: string) => void; onSignedIn: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const result = await authFetch<{ recoveryCodesLeft?: number }>("/api/auth/login/code", { challenge, code });
    if (!result.ok) {
      if (result.status === 410) { onExpired(result.error); return; }
      setError(result.error); setBusy(false); return;
    }
    // Signing in with a recovery code while few are left: go where new ones are made.
    if (result.body.recoveryCodesLeft !== undefined && result.body.recoveryCodesLeft <= 3) { window.location.replace("/settings"); return; }
    onSignedIn();
  }

  return <AuthShell icon={ShieldCheck} title="Enter your code" description="Open your authenticator app and enter the 6-digit code for Blocky Panel. Lost your phone? Enter one of your recovery codes instead." below={back}>
    <form onSubmit={(event) => void submit(event)}>
      <TextField id="code" label="Code" autoComplete="one-time-code" inputMode="numeric" autoFocus value={code} onChange={(event) => setCode(event.target.value)} required maxLength={32} className="font-mono tracking-widest" />
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      <Button className="mt-5 w-full" disabled={busy || !code.trim()}>{busy && <LoaderCircle className="animate-spin" />}Sign in</Button>
    </form>
  </AuthShell>;
}
