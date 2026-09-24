"use client";

import { FormEvent, useEffect, useState } from "react";
import { LifeBuoy, LoaderCircle, LockKeyhole } from "lucide-react";
import { AuthShell, authFetch, PasswordField, TextField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { safeReturnPath } from "@/lib/return-path";

type Status = { needsSetup: boolean; recoveryAvailable: boolean; demo: boolean };
const DEMO_USERS = ["admin", "operator", "viewer"];

function goNext() {
  window.location.replace(safeReturnPath(new URLSearchParams(window.location.search).get("next")));
}

export default function LoginPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(0);

  useEffect(() => {
    void authFetch<Status>("/api/auth/setup").then((result) => {
      if (!result.ok) return;
      if (result.body.needsSetup) window.location.replace("/setup");
      else setStatus(result.body);
    });
  }, []);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = window.setInterval(() => { setNow(Date.now()); if (Date.now() >= retryUntil) setRetryUntil(0); }, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);

  async function submit(event?: FormEvent, override?: { username: string; password: string }) {
    event?.preventDefault(); setBusy(true); setError("");
    const result = recovery
      ? await authFetch<{ setup?: boolean }>("/api/auth/recovery", { password })
      : await authFetch<object>("/api/auth/login", { username: override?.username ?? username, password: override?.password ?? password, remember });
    if (!result.ok) {
      if (result.status === 429 && result.retryAfter) { setRetryUntil(Date.now() + result.retryAfter * 1000); setNow(Date.now()); }
      setError(result.error); setBusy(false); return;
    }
    if ("setup" in result.body && result.body.setup) { window.location.replace("/setup"); return; }
    goNext();
  }

  const waitSeconds = retryUntil ? Math.max(0, Math.ceil((retryUntil - now) / 1000)) : 0;
  const errorText = waitSeconds ? `Too many attempts. Try again in ${waitSeconds >= 60 ? `${Math.ceil(waitSeconds / 60)} min` : `${waitSeconds}s`}.` : error;
  const switchMode = () => { setRecovery(!recovery); setError(""); setPassword(""); };

  return <AuthShell icon={recovery ? LifeBuoy : LockKeyhole} title={recovery ? "Recovery sign-in" : "Sign in"}
    description={recovery ? <>Enter <code className="rounded bg-muted px-1 font-mono text-xs">BLOCKY_ADMIN_PASSWORD</code> from the panel&apos;s <code className="rounded bg-muted px-1 font-mono text-xs">.env</code>. You get admin access for one hour, to reset a password or re-enable an account. Every use is logged.</> : "Sign in with your Blocky account."}
    below={status?.recoveryAvailable && <button type="button" onClick={switchMode} className="underline-offset-2 hover:text-foreground hover:underline">{recovery ? "Back to normal sign-in" : "Locked out? Use recovery sign-in"}</button>}>
    <form onSubmit={(event) => void submit(event)}>
      {!recovery && <TextField id="username" label="Username" autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={64} />}
      <PasswordField id="password" label={recovery ? "Recovery password" : "Password"} autoComplete={recovery ? "off" : "current-password"} autoFocus={recovery} value={password} onChange={setPassword} />
      {!recovery && <div className="mt-4 flex items-center gap-2"><Checkbox id="remember" checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} /><Label htmlFor="remember" className="font-normal">Keep me signed in for 14 days</Label></div>}
      {errorText && <p role="alert" className="mt-4 text-sm text-destructive">{errorText}</p>}
      <Button className="mt-5 w-full" disabled={busy || waitSeconds > 0}>{busy && <LoaderCircle className="animate-spin" />}{recovery ? "Sign in for one hour" : "Sign in"}</Button>
    </form>
    {status?.demo && !recovery && <div className="mt-5 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">Demo: sign in as a sample user to see what each role can do.</p>
      <div className="mt-2 grid grid-cols-3 gap-2">{DEMO_USERS.map((name) => <Button key={name} type="button" size="sm" variant="outline" disabled={busy} onClick={() => void submit(undefined, { username: name, password: "blocky-demo" })} className="capitalize">{name}</Button>)}</div>
    </div>}
  </AuthShell>;
}
