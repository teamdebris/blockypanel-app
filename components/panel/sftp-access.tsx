"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, KeyRound, LoaderCircle, Plug, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PasswordField } from "@/components/auth/auth-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field } from "./common";
import { api, ApiError, errorMessage, formatRelative } from "./lib";
import { useNow, usePanel } from "./panel-context";
import type { MinecraftServer } from "./types";

type Credential = { id: string; kind: "key" | "password"; label: string; keyType: string | null; fingerprint: string | null; createdAt: number; lastUsedAt: number | null };
type SftpInfo = { enabled: boolean; port?: number; fingerprint?: string };

/** The machine's name as the browser reached it; SFTP runs on the same machine as the panel. */
function sftpHost() {
  return typeof window === "undefined" ? "localhost" : window.location.hostname;
}

function CopyValue({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { toast.error("Couldn't copy. Select it and copy it manually."); }
  }
  return <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
    <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
    <dd className="flex min-w-0 items-center gap-1"><span className={cn("truncate text-sm", mono && "font-mono text-xs")} title={value}>{value}</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button></dd>
  </div>;
}

/** Host, port, username, and host key for one server (or, without a server, the pattern). */
function ConnectionDetails({ info, username, serverId }: { info: SftpInfo; username: string; serverId?: string }) {
  return <dl className="rounded-lg border border-border px-3">
    <CopyValue label="Host" value={sftpHost()} />
    <CopyValue label="Port" value={String(info.port)} />
    <CopyValue label="Username" value={serverId ? `${username}.${serverId.slice(0, 8)}` : `${username}.<server ID>`} />
    {info.fingerprint && <CopyValue label="Host key" value={info.fingerprint} />}
  </dl>;
}

function NewPassword({ password, onDone }: { password: string; onDone: () => void }) {
  return <div className="space-y-3 rounded-lg border border-warning/30 bg-warning-soft p-3">
    <p className="text-sm font-medium">Your new SFTP password</p>
    <p className="text-xs text-muted-foreground">Copy it into your SFTP client now. It isn&apos;t shown again; if you lose it, remove it and make another.</p>
    <dl className="rounded-lg border border-border bg-background px-3"><CopyValue label="Password" value={password} /></dl>
    <Button size="sm" onClick={onDone}>Done</Button>
  </div>;
}

function AddCredential({ onAdded }: { onAdded: (password?: string) => void }) {
  const [kind, setKind] = useState<"key" | "password">("key");
  const [label, setLabel] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await api<{ password?: string }>("/api/auth/sftp", { method: "POST", body: JSON.stringify(kind === "key" ? { action: "key", label, publicKey, password } : { action: "password", label, password }) });
      toast.success(kind === "key" ? "SSH key added." : "SFTP password created.");
      setLabel(""); setPublicKey(""); setPassword("");
      onAdded(result.password);
    } catch (reason) {
      setError({ message: errorMessage(reason, "Couldn't add it."), field: reason instanceof ApiError ? reason.field : undefined });
    } finally { setBusy(false); }
  }
  const fieldError = (field: string) => error?.field === field ? error.message : undefined;
  return <form onSubmit={(event) => void submit(event)} className="max-w-xl space-y-1">
    <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1 sm:max-w-xs" role="radiogroup" aria-label="Sign in with">
      {(["key", "password"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => { setKind(value); setError(null); }}
        className={cn("min-h-8 rounded-md text-xs", kind === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>{value === "key" ? "SSH key" : "Password"}</button>)}
    </div>
    <Field label="Name" id="sftp-label" error={fieldError("label")} hint={kind === "key" ? "Which computer this key is on." : "Which app will use it."}>{(props) => <Input {...props} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} placeholder={kind === "key" ? "Laptop" : "FileZilla"} />}</Field>
    {kind === "key" && <Field label="Public key" id="sftp-key" error={fieldError("publicKey")} hint={<>The contents of your <code className="font-mono">.pub</code> file, like <code className="font-mono">~/.ssh/id_ed25519.pub</code>. No key yet? Run <code className="font-mono">ssh-keygen -t ed25519</code>.</>}>
      {(props) => <Textarea {...props} value={publicKey} onChange={(event) => setPublicKey(event.target.value)} rows={3} className="font-mono text-xs" placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} autoCapitalize="off" />}
    </Field>}
    {kind === "password" && <p className="pt-1 text-xs text-muted-foreground">The panel makes a long random password for SFTP only. Your account password never works for SFTP, because an SFTP app can&apos;t ask for a two-factor code.</p>}
    <PasswordField id="sftp-confirm" label="Your account password" autoComplete="current-password" value={password} onChange={setPassword} error={fieldError("password")} hint="Confirms it's you: a key keeps working after you sign out." />
    {error && !error.field && <p role="alert" className="pt-2 text-sm text-destructive">{error.message}</p>}
    <Button className="mt-3" disabled={busy || !label.trim() || !password || (kind === "key" && !publicKey.trim())}>{busy && <LoaderCircle className="animate-spin" />}{kind === "key" ? "Add key" : "Create password"}</Button>
  </form>;
}

/** Your account page: how to connect, your SSH keys and SFTP passwords, and adding more. */
export function SftpSection() {
  const now = useNow(60_000);
  const [data, setData] = useState<{ username: string; info: SftpInfo; credentials: Credential[] } | null>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Credential | null>(null);
  const load = useCallback(async () => {
    try { setData(await api("/api/auth/sftp")); }
    catch (reason) { toast.error(errorMessage(reason, "Couldn't load your SFTP access.")); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function remove(credential: Credential) {
    try { await api(`/api/auth/sftp?id=${encodeURIComponent(credential.id)}`, { method: "DELETE" }); toast.success(`Removed ${credential.label}.`); await load(); }
    catch (reason) { toast.error(errorMessage(reason, "Couldn't remove it.")); }
  }
  if (!data) return <Skeleton className="h-32" />;
  if (!data.info.enabled) return <p className="text-sm text-muted-foreground">SFTP is turned off on this panel (<code className="font-mono text-xs">BLOCKY_SFTP=false</code>).</p>;
  return <div className="space-y-5">
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Use FileZilla, WinSCP, Cyberduck, or <code className="font-mono text-xs">sftp</code> to work with a server&apos;s files. Each server&apos;s Files tab shows its exact username. You land in its data folder and can&apos;t leave it.</p>
        <p className="text-xs text-muted-foreground">On first connect, check that the host key your app shows matches the one here.</p>
      </div>
      <ConnectionDetails info={data.info} username={data.username} />
    </div>
    {newPassword && <NewPassword password={newPassword} onDone={() => setNewPassword(null)} />}
    {data.credentials.length > 0 ? <ul className="divide-y divide-border rounded-lg border border-border">
      {data.credentials.map((credential) => <li key={credential.id} className="flex items-center gap-3 px-3 py-2.5">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{credential.label}<Badge variant="outline" className="text-[10px]">{credential.kind === "key" ? credential.keyType?.replace(/^ssh-|^ecdsa-sha2-/, "") || "key" : "password"}</Badge></p>
          <p className="truncate text-xs text-muted-foreground">{credential.fingerprint ? <span className="font-mono">{credential.fingerprint}</span> : "Generated password"} · {credential.lastUsedAt ? `used ${formatRelative(new Date(credential.lastUsedAt).toISOString(), now)}` : "never used"}</p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label={`Remove ${credential.label}`} onClick={() => setRemoving(credential)}><Trash2 /></Button>
      </li>)}
    </ul> : <p className="text-sm text-muted-foreground">No SSH keys or SFTP passwords yet. Add one below to connect.</p>}
    <AddCredential onAdded={(password) => { if (password) setNewPassword(password); void load(); }} />
    <ConfirmDialog open={Boolean(removing)} onOpenChange={(open) => { if (!open) setRemoving(null); }} title={`Remove ${removing?.label}?`} confirmLabel="Remove" destructive onConfirm={() => { if (removing) void remove(removing); setRemoving(null); }}>
      SFTP apps using it stop working within a few seconds, including ones connected right now.
    </ConfirmDialog>
  </div>;
}

/** The Files tab's "Connect with SFTP": this server's connection details. */
export function SftpConnectButton({ server }: { server: MinecraftServer }) {
  const { system, me } = usePanel();
  const [open, setOpen] = useState(false);
  const info = system?.sftp;
  if (!info?.enabled || !info.port || !me?.username || me.recovery) return null;
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plug />SFTP</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="border-border bg-popover text-foreground sm:max-w-md">
        <DialogHeader className="text-left"><DialogTitle>Connect with SFTP</DialogTitle><DialogDescription>Open {server.name}&apos;s files in FileZilla, WinSCP, or any SFTP app. You land in its data folder.</DialogDescription></DialogHeader>
        <ConnectionDetails info={info} username={me.username} serverId={server.id} />
        <p className="text-xs text-muted-foreground">Sign in with an SSH key or an SFTP password from <Link href="/account" className="underline underline-offset-2 hover:text-foreground">Your account</Link>. Your account password doesn&apos;t work for SFTP.</p>
      </DialogContent>
    </Dialog>
  </>;
}
