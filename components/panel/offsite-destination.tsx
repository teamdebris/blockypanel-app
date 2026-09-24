"use client";

import { useState } from "react";
import { Check, CheckCircle2, Cloud, Copy, FolderClosed, HardDrive, KeyRound, PlugZap, Server, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { S3_PROVIDERS, type S3Provider } from "@/lib/offsite-core";
import { cn } from "@/lib/utils";
import { Field } from "./common";
import { api, ApiError, errorMessage } from "./lib";

/** The destination form shared by setup, moving, and disaster recovery. Secrets are never prefilled. */

export type DestinationDraft = {
  kind: "s3" | "folder" | "sftp";
  provider: S3Provider; endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string; hasSecret?: boolean;
  path: string;
  host: string; port: string; user: string; remotePath: string; auth: "password" | "key"; password: string; hasPassword?: boolean;
  hostKey?: string; hostFingerprints?: string[];
};

export type PublicDestination =
  | { kind: "s3"; provider: S3Provider; endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; hasSecret?: boolean }
  | { kind: "folder"; path: string }
  | { kind: "sftp"; host: string; port: number; user: string; path: string; auth: "password" | "key"; hasPassword?: boolean; publicKey?: string; hostFingerprints?: string[] };

export const emptyDraft: DestinationDraft = {
  kind: "s3", provider: "b2", endpoint: "", region: "", bucket: "", prefix: "blocky", accessKeyId: "", secretAccessKey: "",
  path: "/mnt/backup", host: "", port: "22", user: "", remotePath: "", auth: "key", password: "",
};

export function draftFrom(destination?: PublicDestination): DestinationDraft {
  if (!destination) return emptyDraft;
  if (destination.kind === "s3") return { ...emptyDraft, ...destination, secretAccessKey: "" };
  if (destination.kind === "folder") return { ...emptyDraft, kind: "folder", path: destination.path };
  // The host key stays on the server; leaving hostKey empty keeps the saved one for the same host.
  return { ...emptyDraft, kind: "sftp", host: destination.host, port: String(destination.port), user: destination.user, remotePath: destination.path, auth: destination.auth, hasPassword: destination.hasPassword, hostFingerprints: destination.hostFingerprints };
}

/** What the API expects. Blank secrets are left out, so the saved ones are kept. */
export function destinationPayload(draft: DestinationDraft) {
  if (draft.kind === "s3") return { kind: "s3", provider: draft.provider, endpoint: draft.endpoint, region: draft.region, bucket: draft.bucket, prefix: draft.prefix, accessKeyId: draft.accessKeyId, ...(draft.secretAccessKey ? { secretAccessKey: draft.secretAccessKey } : {}) };
  if (draft.kind === "folder") return { kind: "folder", path: draft.path };
  return { kind: "sftp", host: draft.host, port: Number(draft.port) || 22, user: draft.user, path: draft.remotePath, auth: draft.auth, ...(draft.password ? { password: draft.password } : {}), ...(draft.hostKey ? { hostKey: draft.hostKey } : {}) };
}

type TestResult = { ok?: boolean; existing?: boolean; message?: string; needsHostKey?: boolean; hostKey?: string; fingerprints?: string[] };

const kinds = [
  { value: "s3", label: "Cloud storage", hint: "B2, R2, Wasabi, S3, MinIO", icon: Cloud },
  { value: "folder", label: "Another disk", hint: "A folder on this machine", icon: HardDrive },
  { value: "sftp", label: "SFTP / NAS", hint: "Over SSH", icon: Server },
] as const;

export function DestinationFields({ draft, onChange, errors, sshPublicKey, onSshKey }: {
  draft: DestinationDraft;
  onChange: (draft: DestinationDraft) => void;
  errors: Record<string, string>;
  sshPublicKey?: string;
  onSshKey: (key: string) => void;
}) {
  const set = (values: Partial<DestinationDraft>) => onChange({ ...draft, ...values });
  const provider = S3_PROVIDERS.find((item) => item.value === draft.provider) || S3_PROVIDERS[0];
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  async function generate(regenerate: boolean) {
    setGenerating(true);
    try { onSshKey((await api<{ publicKey: string }>("/api/offsite/ssh-key", { method: "POST", body: JSON.stringify({ regenerate }) })).publicKey); }
    catch (error) { toast.error(errorMessage(error, "Couldn't make an SSH key.")); }
    finally { setGenerating(false); }
  }
  async function copyKey() {
    try { await navigator.clipboard.writeText(sshPublicKey || ""); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { toast.error("Couldn't copy. Select the key and copy it manually."); }
  }
  return <div className="space-y-4">
    <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Where to keep copies">
      {kinds.map((item) => <button key={item.value} type="button" role="radio" aria-checked={draft.kind === item.value} onClick={() => set({ kind: item.value })}
        className={cn("flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", draft.kind === item.value ? "border-foreground/50 bg-accent" : "border-border hover:border-foreground/30")}>
        <item.icon className="mt-0.5 size-4 shrink-0" />
        <span><span className="block text-sm font-medium">{item.label}</span><span className="block text-xs text-muted-foreground">{item.hint}</span></span>
      </button>)}
      <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-border p-3 opacity-60" aria-disabled>
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <span><span className="block text-sm font-medium">Blocky Cloud</span><span className="block text-xs text-muted-foreground">Coming soon</span></span>
      </div>
    </div>

    {draft.kind === "s3" && <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Provider" id="offsite-provider">{(props) => <Select value={draft.provider} onValueChange={(value) => set({ provider: value as S3Provider, region: "" })}>
        <SelectTrigger {...props} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{S3_PROVIDERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>}</Field>
      {provider.needsEndpoint
        ? <Field label="Endpoint" id="offsite-endpoint" error={errors.endpoint} hint={draft.provider === "r2" ? "From the bucket's settings: https://<account>.r2.cloudflarestorage.com" : "Like https://s3.example.com or http://nas.local:9000"}>{(props) => <Input {...props} value={draft.endpoint} onChange={(event) => set({ endpoint: event.target.value })} placeholder="https://" autoComplete="off" />}</Field>
        : <Field label="Region" id="offsite-region" error={errors.region} hint={`Like ${provider.regionHint}, shown with the bucket.`}>{(props) => <Input {...props} value={draft.region} onChange={(event) => set({ region: event.target.value })} placeholder={provider.regionHint} autoComplete="off" />}</Field>}
      <Field label="Bucket" id="offsite-bucket" error={errors.bucket}>{(props) => <Input {...props} value={draft.bucket} onChange={(event) => set({ bucket: event.target.value })} autoComplete="off" spellCheck={false} />}</Field>
      <Field label="Folder in the bucket" id="offsite-prefix" error={errors.prefix} hint="Optional. Lets one bucket hold other things too.">{(props) => <Input {...props} value={draft.prefix} onChange={(event) => set({ prefix: event.target.value })} autoComplete="off" spellCheck={false} />}</Field>
      <Field label="Access key ID" id="offsite-key-id" error={errors.accessKeyId} hint={draft.provider === "b2" ? "An application key's keyID." : undefined}>{(props) => <Input {...props} value={draft.accessKeyId} onChange={(event) => set({ accessKeyId: event.target.value })} autoComplete="off" spellCheck={false} />}</Field>
      <Field label="Secret access key" id="offsite-secret" error={errors.secretAccessKey} hint={draft.hasSecret ? "Saved. Leave blank to keep it." : "Use a key that can only reach this bucket."}>{(props) => <Input {...props} type="password" value={draft.secretAccessKey} onChange={(event) => set({ secretAccessKey: event.target.value })} autoComplete="new-password" placeholder={draft.hasSecret ? "••••••••" : ""} />}</Field>
    </div>}

    {draft.kind === "folder" && <Field label="Folder on this machine" id="offsite-path" error={errors.path} hint="A second disk or a mounted network share, like /mnt/backup. It must already exist, outside Blocky's own folder.">
      {(props) => <Input {...props} value={draft.path} onChange={(event) => set({ path: event.target.value })} autoComplete="off" spellCheck={false} className="font-mono" />}
    </Field>}

    {draft.kind === "sftp" && <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Host" id="offsite-host" error={errors.host}>{(props) => <Input {...props} value={draft.host} onChange={(event) => set({ host: event.target.value, hostKey: undefined, hostFingerprints: undefined })} placeholder="nas.local" autoComplete="off" spellCheck={false} />}</Field>
      <Field label="Port" id="offsite-port" error={errors.port}>{(props) => <Input {...props} type="number" min={1} max={65535} value={draft.port} onChange={(event) => set({ port: event.target.value, hostKey: undefined, hostFingerprints: undefined })} />}</Field>
      <Field label="User" id="offsite-user" error={errors.user}>{(props) => <Input {...props} value={draft.user} onChange={(event) => set({ user: event.target.value })} autoComplete="off" spellCheck={false} />}</Field>
      <Field label="Folder on the server" id="offsite-remote-path" error={errors.path} hint="Like /volume1/backups/blocky.">{(props) => <Input {...props} value={draft.remotePath} onChange={(event) => set({ remotePath: event.target.value })} autoComplete="off" spellCheck={false} className="font-mono" />}</Field>
      <div className="sm:col-span-2">
        <div className="inline-flex rounded-lg border border-border p-1" role="radiogroup" aria-label="Sign in with">
          {(["key", "password"] as const).map((auth) => <button key={auth} type="button" role="radio" aria-checked={draft.auth === auth} onClick={() => set({ auth })} className={cn("rounded-md px-3 py-1.5 text-xs", draft.auth === auth ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>{auth === "key" ? "SSH key" : "Password"}</button>)}
        </div>
      </div>
      {draft.auth === "password"
        ? <Field label="Password" id="offsite-password" error={errors.password} hint={draft.hasPassword ? "Saved. Leave blank to keep it." : undefined}>{(props) => <Input {...props} type="password" value={draft.password} onChange={(event) => set({ password: event.target.value })} autoComplete="new-password" placeholder={draft.hasPassword ? "••••••••" : ""} />}</Field>
        : <div className="space-y-2 sm:col-span-2">
          {sshPublicKey ? <>
            <p className="text-xs text-muted-foreground">Add this line to <span className="font-mono">~/.ssh/authorized_keys</span> for {draft.user || "the user"} on {draft.host || "the server"} (on Synology: Control Panel → Terminal & SNMP, then the user&apos;s home folder).</p>
            <div className="flex gap-2"><Input readOnly value={sshPublicKey} aria-label="SSH public key" className="font-mono text-xs" onFocus={(event) => event.target.select()} /><Button type="button" variant="outline" onClick={() => void copyKey()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button></div>
            <Button type="button" size="sm" variant="ghost" onClick={() => void generate(true)} disabled={generating}>Make a new key</Button>
          </> : <Button type="button" variant="outline" onClick={() => void generate(false)} disabled={generating}><KeyRound />Generate an SSH key</Button>}
        </div>}
      {draft.hostFingerprints?.length ? <p className="flex items-start gap-1.5 text-xs text-muted-foreground sm:col-span-2"><ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />Trusted host key: <span className="break-all font-mono">{draft.hostFingerprints.join(", ")}</span></p> : null}
    </div>}
  </div>;
}

/** "Test connection", including confirming an SFTP server's host key the first time. */
export function TestConnection({ draft, onChange, onErrors }: { draft: DestinationDraft; onChange: (draft: DestinationDraft) => void; onErrors: (errors: Record<string, string>) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  async function test(current = draft) {
    setBusy(true); setResult(null); onErrors({});
    try {
      const next = await api<TestResult>("/api/offsite/test", { method: "POST", body: JSON.stringify({ destination: destinationPayload(current) }) });
      setResult(next);
    } catch (error) {
      if (error instanceof ApiError && error.field) onErrors({ [error.field.replace(/^destination\./, "")]: error.message });
      setResult({ ok: false, message: errorMessage(error, "The test failed.") });
    } finally { setBusy(false); }
  }
  function trust() {
    if (!result?.hostKey) return;
    const next = { ...draft, hostKey: result.hostKey, hostFingerprints: result.fingerprints };
    onChange(next);
    void test(next);
  }
  return <div className="space-y-2">
    <Button type="button" variant="outline" onClick={() => void test()} disabled={busy}><PlugZap />{busy ? "Testing…" : "Test connection"}</Button>
    {result?.needsHostKey && <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm">
      <p className="font-medium text-foreground">Is this your server?</p>
      <p className="mt-1 text-xs text-muted-foreground">First connection to {draft.host}. Its key fingerprint is below; if you can, compare it with the one on the server (<span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>). Blocky will refuse to connect if it ever changes.</p>
      <ul className="mt-2 space-y-0.5 break-all font-mono text-xs">{result.fingerprints?.map((line) => <li key={line}>{line}</li>)}</ul>
      <Button type="button" size="sm" className="mt-3" onClick={trust}>Trust and continue</Button>
    </div>}
    {result && !result.needsHostKey && <p role="status" className={cn("flex items-start gap-1.5 text-sm", result.ok ? "text-success" : "text-destructive")}>{result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <FolderClosed className="mt-0.5 size-4 shrink-0" />}{result.message}</p>}
  </div>;
}
