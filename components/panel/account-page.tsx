"use client";

import { FormEvent, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Bell, BellOff, LoaderCircle, Monitor, Moon, ShieldCheck, Smartphone, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { PASSWORD_HINT, PasswordField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ROLE_DESCRIPTIONS } from "@/lib/roles";
import { Section } from "./common";
import { TwoFactorSection } from "./two-factor";
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
    <p className="mt-2 text-xs text-muted-foreground">Your other devices are signed out when you change it, and your SFTP passwords are replaced.</p>
  </form>;
}

const SESSIONS_SHOWN = 5;

function Sessions() {
  const now = useNow(30_000);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [showAll, setShowAll] = useState(false);
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
  // This device first, then the most recently active; old ones stay one click away.
  const sorted = [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  const shown = showAll ? sorted : sorted.slice(0, SESSIONS_SHOWN);
  return <>
    <ul className="-mx-4 divide-y divide-border sm:-mx-5">
      {shown.map((session) => {
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
    <div className="mt-3 flex flex-wrap gap-2">
      {sorted.length > SESSIONS_SHOWN && <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${sorted.length}`}</Button>}
      {others.length > 0 && <Button variant="outline" size="sm" onClick={() => void signOut()}>Sign out everywhere else</Button>}
    </div>
  </>;
}

const subscribeNever = () => () => undefined;
const themes = [{ value: "light", icon: Sun, label: "Light" }, { value: "dark", icon: Moon, label: "Dark" }, { value: "system", icon: Monitor, label: "System" }];

/** Theme and browser alerts. Both are kept in this browser, not on the account. */
function Preferences() {
  const { theme: savedTheme, setTheme } = useTheme();
  // The saved theme is only known in the browser; until hydration, no option is marked as chosen.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const theme = mounted ? savedTheme : undefined;
  const { notificationsEnabled, setNotificationsEnabled } = usePanel();
  return <div className="space-y-5">
    <div>
      <p id="theme-label" className="text-sm font-medium">Theme</p>
      <div className="mt-2 inline-grid grid-cols-3 gap-1 rounded-lg border border-border p-1" role="radiogroup" aria-labelledby="theme-label">
        {themes.map((item) => <button key={item.value} type="button" role="radio" aria-checked={theme === item.value} onClick={() => setTheme(item.value)} className={cn("flex min-h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm", theme === item.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}><item.icon className="size-4" />{item.label}</button>)}
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><p className="text-sm font-medium">Browser alerts</p><p className="mt-0.5 text-xs text-muted-foreground">A notification when a server crashes or a task like a backup or update finishes, while the panel is open in a background tab.</p></div>
      <Button variant="outline" size="sm" onClick={() => void setNotificationsEnabled(!notificationsEnabled)} aria-pressed={notificationsEnabled}>{notificationsEnabled ? <><Bell />On</> : <><BellOff />Off</>}</Button>
    </div>
  </div>;
}

/** The demo's accounts are shared and reset on restart, so the section is shown but can't be used. */
function DemoTwoFactor() {
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Off. On a real install, turning it on asks for a code from an authenticator app (like Google Authenticator, 1Password, or Authy) after your password, and gives you ten single-use recovery codes. Not available in the demo, whose accounts are shared.</p>
    <Button disabled title="Not available in the demo"><ShieldCheck />Turn on two-factor sign-in</Button>
  </div>;
}

export function AccountPage() {
  const { me } = usePanel();
  if (!me) return <Skeleton className="h-64" />;
  if (me.recovery) return <Section title="Recovery sign-in" description="This session isn't tied to an account and ends within an hour. Use Users to reset a password or re-enable an admin, then sign in normally."><span /></Section>;
  return <div className="space-y-6">
    <div className="text-sm text-muted-foreground">
      <p className="flex flex-wrap items-center gap-2">Signed in as <span className="font-medium text-foreground">{me.username}</span><RoleBadge role={me.role} /></p>
      <p className="mt-1">{ROLE_DESCRIPTIONS[me.role]}{me.role !== "admin" ? " An admin can change your role." : ""}</p>
    </div>
    <div className="grid gap-6 lg:grid-cols-2">
      {!me.demo && <Section title="Password"><ChangePassword /></Section>}
      <Section title="Two-factor sign-in" description="A code from your phone, on top of your password.">
        {me.demo ? <DemoTwoFactor /> : <TwoFactorSection />}
      </Section>
    </div>
    <Section title="Preferences" description="Saved in this browser."><Preferences /></Section>
    <Section title="Where you're signed in" description={"Sign out any device you don't recognize, then change your password."}><Sessions /></Section>
  </div>;
}
