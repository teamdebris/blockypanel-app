"use client";

import { useState } from "react";
import { Box, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CSRF_HEADER } from "@/lib/csrf";

/** The centered card used by sign-in, setup, and invite pages. */
export function AuthShell({ icon: Icon, title, description, children, below }: { icon: typeof Box; title: string; description: React.ReactNode; children: React.ReactNode; below?: React.ReactNode }) {
  return <main className="grid min-h-screen place-items-center bg-background p-5 text-foreground">
    <div className="w-full max-w-sm">
      <div className="mb-8 flex items-center justify-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/10"><Box className="size-5" /></div><div><p className="font-display text-lg font-bold">Blocky</p><p className="text-xs text-muted-foreground">Minecraft server control</p></div></div>
      <div className="rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-2xl">
        <div className="grid size-11 place-items-center rounded-xl border border-border bg-muted/50"><Icon className="size-5" /></div>
        <h1 id="page-title" className="font-display mt-5 text-2xl font-bold">{title}</h1>
        <div className="mt-2 text-sm leading-6 text-muted-foreground">{description}</div>
        {children}
      </div>
      {below && <div className="mt-4 text-center text-sm text-muted-foreground">{below}</div>}
    </div>
  </main>;
}

export function TextField({ id, label, hint, error, ...props }: { id: string; label: React.ReactNode; hint?: React.ReactNode; error?: string } & React.ComponentProps<typeof Input>) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return <div className="mt-4 grid gap-2">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} autoCapitalize="off" autoCorrect="off" spellCheck={false} {...props} />
    {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
  </div>;
}

export function PasswordField({ id, label, hint, error, value, onChange, autoComplete, autoFocus }: { id: string; label: React.ReactNode; hint?: React.ReactNode; error?: string; value: string; onChange: (value: string) => void; autoComplete: string; autoFocus?: boolean }) {
  const [visible, setVisible] = useState(false);
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return <div className="mt-4 grid gap-2">
    <Label htmlFor={id}>{label}</Label>
    <div className="relative">
      <Input id={id} type={visible ? "text" : "password"} autoComplete={autoComplete} autoFocus={autoFocus} value={value} onChange={(event) => onChange(event.target.value)} required className="pr-11" aria-invalid={error ? true : undefined} aria-describedby={describedBy} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <Button type="button" variant="ghost" size="icon-sm" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setVisible(!visible)} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible}>{visible ? <EyeOff /> : <Eye />}</Button>
    </div>
    {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
  </div>;
}

type PostResult<T> = { ok: true; body: T } | { ok: false; status: number; error: string; field?: string; retryAfter?: number };

/** POST/GET JSON without the panel's 401 redirect (these pages are where 401s are expected). */
export async function authFetch<T>(url: string, body?: unknown): Promise<PostResult<T>> {
  try {
    const response = await fetch(url, body === undefined ? { headers: { [CSRF_HEADER]: "1" } } : { method: "POST", headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({})) as T & { error?: string; field?: string; retryAfter?: number };
    if (!response.ok) return { ok: false, status: response.status, error: json.error || "Something went wrong.", field: json.field, retryAfter: json.retryAfter };
    return { ok: true, body: json };
  } catch { return { ok: false, status: 0, error: "Can't reach the panel. Check your connection and try again." }; }
}

export const PASSWORD_HINT = "At least 10 characters. A few random words works well.";
