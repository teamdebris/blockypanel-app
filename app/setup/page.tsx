"use client";

import { FormEvent, useEffect, useState } from "react";
import { LoaderCircle, Rocket } from "lucide-react";
import { AuthShell, authFetch, PASSWORD_HINT, PasswordField, TextField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

type Status = { needsSetup: boolean; setupPasswordRequired: boolean; setupPasswordConfigured: boolean; setupPasswordProblem: string | null };

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setupPassword, setSetupPassword] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void authFetch<Status>("/api/auth/setup").then((result) => {
      if (!result.ok) { setError({ message: result.error }); return; }
      if (!result.body.needsSetup) window.location.replace("/login");
      else setStatus(result.body);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) { setError({ message: "The passwords don't match.", field: "confirm" }); return; }
    setBusy(true); setError(null);
    const result = await authFetch("/api/auth/setup", { setupPassword, username: username.trim(), password });
    if (!result.ok) { setError({ message: result.error, field: result.field }); setBusy(false); return; }
    window.location.replace("/");
  }

  const fieldError = (field: string) => error?.field === field ? error.message : undefined;
  const missingEnv = status?.setupPasswordRequired && !status.setupPasswordConfigured;
  return <AuthShell icon={Rocket} title="Set up Blocky" description="Create the first admin account. You can invite everyone else once you're in.">
    {missingEnv ? <p role="alert" className="mt-5 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">{status?.setupPasswordProblem ? `${status.setupPasswordProblem} ` : ""}Set <code className="font-mono">BLOCKY_ADMIN_PASSWORD</code> in the panel&apos;s <code className="font-mono">.env</code> to a long random value (at least 16 characters, e.g. <code className="font-mono">openssl rand -base64 24</code>) and restart it. Setup asks for it to prove you own this machine.</p>
      : <form onSubmit={(event) => void submit(event)}>
        {status?.setupPasswordRequired && <PasswordField id="setupPassword" label="Setup password" autoComplete="off" autoFocus value={setupPassword} onChange={setSetupPassword} error={fieldError("setupPassword")}
          hint={<>The <code className="font-mono">BLOCKY_ADMIN_PASSWORD</code> from <code className="font-mono">.env</code>. It proves you own this machine, and later works as a recovery sign-in.</>} />}
        <TextField id="username" label="Your username" autoComplete="username" autoFocus={!status?.setupPasswordRequired} value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={32} error={fieldError("username")} hint="3 to 32 letters, numbers, dots, dashes, or underscores." />
        <PasswordField id="password" label="Your password" autoComplete="new-password" value={password} onChange={setPassword} error={fieldError("password")} hint={PASSWORD_HINT} />
        <PasswordField id="confirm" label="Confirm password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={fieldError("confirm")} />
        {error && !error.field && <p role="alert" className="mt-4 text-sm text-destructive">{error.message}</p>}
        <Button className="mt-5 w-full" disabled={busy || !status}>{busy && <LoaderCircle className="animate-spin" />}Create admin account</Button>
      </form>}
  </AuthShell>;
}
