"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { LoaderCircle, Monitor, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { PASSWORD_HINT, PasswordField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_DESCRIPTIONS } from "@/lib/roles";
import { PageHeading, Section } from "./common";
import { api, ApiError, errorMessage, formatRelative } from "./lib";
import { useNow, usePanel } from "./panel-context";
import { RoleBadge } from "./shell";

type SessionRow = { id: string; current: boolean; createdAt: number; lastSeenAt: number; expiresAt: number; userAgent: string; ip: string; persistent: boolean };

/** "Firefox on Windows" from a user-agent string; good enough to recognize your own devices. */
function describeAgent(agent: string) {
  const browser = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Windows/.test(agent) ? "Windows" : /Mac OS X/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "";
  return { label: system ? `${browser} on ${system}` : browser, mobile: /iPhone|iPad|Android|Mobile/.test(agent) };
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) { setError({ message: "The passwords don't match.", field: "confirm" }); return; }
    setBusy(true); setError(null);
    try {
      const result = await api<{ message: string }>("/api/auth/password", { method: "PUT", body: JSON.stringify({ current, password }) });
      toast.success(result.message);
      setCurrent(""); setPassword(""); setConfirm("");
    } catch (reason) {
      setError({ message: errorMessage(reason, "Couldn't change the password."), field: reason instanceof ApiError ? reason.field : undefined });
    } finally { setBusy(false); }
  }
  const fieldError = (field: string) => error?.field === field ? error.message : undefined;
  return <form onSubmit={(event) => void submit(event)} className="max-w-sm">
    <PasswordField id="current" label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} error={fieldError("current")} />
    <PasswordField id="new-password" label="New password" autoComplete="new-password" value={password} onChange={setPassword} error={fieldError("password")} hint={PASSWORD_HINT} />
    <PasswordField id="confirm" label="Confirm new password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={fieldError("confirm")} />
    {error && !error.field && <p role="alert" className="mt-3 text-sm text-destructive">{error.message}</p>}
    <Button className="mt-4" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}Change password</Button>
    <p className="mt-2 text-xs text-muted-foreground">Your other devices are signed out when you change it.</p>
  </form>;
}

function Sessions() {
  const now = useNow(30_000);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const load = useCallback(async () => {
    try { setSessions((await api<{ sessions: SessionRow[] }>("/api/auth/sessions")).sessions); }
    catch (reason) { toast.error(errorMessage(reason, "Couldn't load your sessions.")); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function signOut(id?: string) {
    try { await api(`/api/auth/sessions${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" }); toast.success(id ? "Signed out that device." : "Signed out everywhere else."); void load(); }
    catch (reason) { toast.error(errorMessage(reason, "Couldn't sign out.")); }
  }
  if (!sessions) return <Skeleton className="h-24" />;
  const others = sessions.filter((session) => !session.current);
  return <>
    <ul className="-mx-4 divide-y divide-border sm:-mx-5">
      {sessions.map((session) => {
        const agent = describeAgent(session.userAgent);
        const Icon = agent.mobile ? Smartphone : Monitor;
        return <li key={session.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
          <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{agent.label}{session.current && <span className="ml-2 text-xs font-normal text-success">This device</span>}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{session.ip ? `${session.ip} · ` : ""}Active {formatRelative(session.lastSeenAt, now)} · signed in {formatRelative(session.createdAt, now)}{session.persistent ? "" : " · ends when the browser closes"}</p>
          </div>
          {!session.current && <Button size="sm" variant="ghost" onClick={() => void signOut(session.id)}>Sign out</Button>}
        </li>;
      })}
    </ul>
    {others.length > 0 && <Button className="mt-3" variant="outline" size="sm" onClick={() => void signOut()}>Sign out everywhere else</Button>}
  </>;
}

export function AccountPage() {
  const { me } = usePanel();
  if (!me) return <Skeleton className="h-64" />;
  if (me.recovery) return <div className="space-y-6"><PageHeading eyebrow="Access" title="Recovery sign-in" description="This session isn't tied to an account and ends within an hour. Use Users to reset a password or re-enable an admin, then sign in normally." /></div>;
  return <div className="space-y-6">
    <PageHeading eyebrow="Access" title="Your account" description={<span className="flex flex-wrap items-center gap-2">Signed in as <span className="font-medium text-foreground">{me.username}</span><RoleBadge role={me.role} /></span>} />
    <Section title="What you can do"><p className="text-sm text-muted-foreground">{ROLE_DESCRIPTIONS[me.role]}{me.role !== "admin" ? " An admin can change your role." : ""}</p></Section>
    {!me.demo && <Section title="Password"><ChangePassword /></Section>}
    <Section title="Where you're signed in" description={"Sign out any device you don't recognize, then change your password."}><Sessions /></Section>
  </div>;
}
