"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, Globe, LoaderCircle, RefreshCcw, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { type CloudBackupStatus, type CloudName, type CloudNotice, nameStateLabels } from "@/lib/cloud-core";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Section } from "./common";
import { CloudMark } from "./logo";
import { ServerIconImage } from "./server-icon";
import { api, errorMessage, formatRelative } from "./lib";
import { useNow, usePanel } from "./panel-context";

type Linking = { userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string; error?: string };
type Overview =
  | { enabled: false; reason: string }
  | {
    enabled: true; cloudUrl: string; linked: boolean; unlinkedRemotely: boolean; linkUnreadable: boolean; linking?: Linking; account?: { email: string }; linkedAt?: string;
    lastCheckinAt?: string; lastAttemptAt?: string; nextCheckinAt?: string; lastError?: string; panelName: string; panelId: string; unpublished: string[]; outdated: boolean;
    entitlements?: { names: number; serversPerName: number; storageBytes: number };
    names: CloudName[]; backup?: CloudBackupStatus; notices: CloudNotice[];
  };
type Enabled = Extract<Overview, { enabled: true }>;

const tone = {
  ok: "border-success/30 bg-success-soft text-success",
  warn: "border-warning/30 bg-warning-soft text-warning",
  bad: "border-destructive/30 bg-danger-soft text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
};

function Pill({ kind, children }: { kind: keyof typeof tone; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", tone[kind])}>{children}</span>;
}

const nameTone: Record<CloudName["state"], keyof typeof tone> = { active: "ok", frozen: "warn", reserved: "bad", suspended: "bad" };

function LinkCard({ overview, onChanged }: { overview: Enabled; onChanged: () => void }) {
  const { track, isPending } = usePanel();
  const now = useNow(1000);
  const linking = overview.linking;
  const expired = linking ? new Date(linking.expiresAt).getTime() <= now : false;
  const start = () => void track("cloud:link", async () => {
    try { await api("/api/cloud/link", { method: "POST" }); onChanged(); }
    catch (error) { toast.error(errorMessage(error, "Couldn't reach Blocky Cloud.")); }
  });
  if (linking && !linking.error && !expired) {
    const seconds = Math.max(0, Math.round((new Date(linking.expiresAt).getTime() - now) / 1000));
    return <Section title="Approve this panel on Blocky Cloud" description="Sign in to Blocky Cloud and enter this code. This page updates by itself once it's approved.">
      <div className="space-y-5">
        <p className="font-mono text-4xl font-bold tracking-[0.2em]" aria-label={`Code ${linking.userCode.split("").join(" ")}`}>{linking.userCode}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild><a href={linking.verificationUriComplete} target="_blank" rel="noreferrer"><ExternalLink />Open Blocky Cloud</a></Button>
          <Button variant="ghost" onClick={() => void track("cloud:cancel", async () => { await api("/api/cloud/link", { method: "DELETE" }); onChanged(); })}>Cancel</Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Waiting for approval at {linking.verificationUri}. The code works for {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} more.</p>
      </div>
    </Section>;
  }
  return <Section title="Link this panel" description="Blocky Cloud gives your servers a friendly address under blockylink.net that follows this machine's IP, and keeps encrypted backups off-site.">
    <div className="space-y-4 text-sm">
      {overview.unlinkedRemotely && <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">This panel was unlinked from Blocky Cloud. Link it again to keep using Blocky Cloud.</p>}
      {overview.linkUnreadable && <p role="alert" className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">The saved Blocky Cloud link can&apos;t be decrypted, because panel/secret.key is missing or was replaced. Link this panel again.</p>}
      {linking?.error && <p role="alert" className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">{linking.error}</p>}
      {expired && !linking?.error && <p role="alert" className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">The code expired before it was approved. Start again.</p>}
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>Create an account at <a className="text-foreground underline" href={overview.cloudUrl} target="_blank" rel="noreferrer">{overview.cloudUrl.replace(/^https?:\/\//, "")}</a>, and turn on two-factor sign-in.</li>
        <li>Choose <span className="font-medium text-foreground">Link</span> below. The panel shows a short code.</li>
        <li>Enter the code on Blocky Cloud to approve this panel.</li>
      </ol>
      {/* Styled like the sidebar's Blocky Cloud button: the blue cube clashes with a green button. */}
      <button type="button" onClick={start} disabled={isPending("cloud:link")}
        className="flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70">
        <CloudMark className="size-8 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Link to Blocky Cloud</span>
          <span className="block text-xs text-muted-foreground">Free address and Obsidian backups</span>
        </span>
        {isPending("cloud:link") ? <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
      </button>
      <p className="text-xs text-muted-foreground">Linking sends this panel&apos;s name ({overview.panelName}), version, and its servers&apos; names and game ports. It never sends worlds, files, or passwords.</p>
    </div>
  </Section>;
}

function AccountCard({ overview, onChanged }: { overview: Enabled; onChanged: () => void }) {
  const { track, isPending } = usePanel();
  const now = useNow(30_000);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  return <>
    <Section title="Account" description={overview.account?.email}
      actions={<>
        <Button size="sm" variant="outline" disabled={isPending("cloud:checkin")} onClick={() => void track("cloud:checkin", async () => {
          try { await api("/api/cloud", { method: "POST" }); toast.success("Checked in."); }
          catch (error) { toast.error(errorMessage(error, "Check-in failed.")); }
          onChanged();
        })}>{isPending("cloud:checkin") ? <LoaderCircle className="animate-spin" /> : <RefreshCcw />}Check in now</Button>
        <Button size="sm" variant="outline" asChild><a href={overview.cloudUrl} target="_blank" rel="noreferrer"><ExternalLink />Open Blocky Cloud</a></Button>
        <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmUnlink(true)}><Unlink />Unlink this panel</Button>
      </>}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {overview.lastCheckinAt ? <Pill kind="ok">Linked</Pill> : <Pill kind="muted">Waiting for the first check-in</Pill>}
        </div>
        <p className="flex items-center gap-1.5 text-muted-foreground">
          {overview.lastError ? <AlertTriangle className="size-4 text-destructive" /> : <CheckCircle2 className="size-4 text-success" />}
          {overview.lastCheckinAt ? <>Last check-in {formatRelative(overview.lastCheckinAt, now)}</> : "No check-in yet."}
          {overview.nextCheckinAt && <span>· next {formatRelative(overview.nextCheckinAt, now)}</span>}
        </p>
        {overview.lastError && <p className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">{overview.lastError}</p>}
        {overview.outdated && <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">This panel is older than Blocky Cloud supports. Update it to keep your names and backups working.</p>}
        {overview.notices.map((notice, index) => <p key={index} className={cn("rounded-lg border px-3 py-2 text-xs", notice.level === "error" ? tone.bad : notice.level === "warning" ? tone.warn : tone.muted)}>{notice.message}</p>)}
      </div>
    </Section>
    <ConfirmDialog open={confirmUnlink} onOpenChange={setConfirmUnlink} title="Unlink from Blocky Cloud?" confirmLabel="Unlink" destructive
      onConfirm={() => void track("cloud:unlink", async () => { await api("/api/cloud", { method: "DELETE" }); toast.success("Unlinked from Blocky Cloud."); onChanged(); })}>
      <p>Your blockylink.net names stop pointing at this machine, and this panel can no longer upload to Blocky Cloud. Your names stay on your account, and backups already in Blocky Cloud are kept.</p>
    </ConfirmDialog>
  </>;
}

function NamesCard({ overview }: { overview: Enabled }) {
  const names = overview.names;
  return <Section title="blockylink.net names" description="Players join with these addresses. No port needed: each server has its own SRV record."
    actions={<Button size="sm" variant="outline" asChild><a href={`${overview.cloudUrl}/names`} target="_blank" rel="noreferrer"><Globe />Manage names</a></Button>}>
    {names.length === 0 ? <p className="text-sm text-muted-foreground">No name points at this panel yet. Claim one on Blocky Cloud and point it at <span className="font-medium text-foreground">{overview.panelName}</span>. Servers appear here after the next check-in.</p>
      : <div className="space-y-4">{names.map((name) => <div key={name.fqdn} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold">{name.fqdn}</span>
          <Pill kind={nameTone[name.state]}>{nameStateLabels[name.state]}</Pill>
          {name.ip && <span className="text-xs text-muted-foreground">points at {name.ip}</span>}
        </div>
        {!name.published && name.servers.length > 0 && name.state === "active" && <p className="text-xs text-muted-foreground">Not published yet: Blocky Cloud publishes a name once one of its servers answers from the internet.</p>}
        {name.servers.length > 0 ? <ul className="divide-y divide-border rounded-xl border border-border">
          {name.servers.map((server) => <li key={server.id} className="space-y-1 px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono">{server.fqdn}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">port {server.port}
                {server.published ? <Pill kind="ok">Reachable</Pill> : server.checkedAt ? <Pill kind="warn">Not answering</Pill> : <Pill kind="muted">Checking</Pill>}
              </span>
            </div>
            {server.bedrockPort && <p className="text-xs text-muted-foreground">Bedrock: <span className="font-mono text-foreground">{name.fqdn}</span>{server.bedrockPort === 19132 ? "" : <> port <span className="font-mono text-foreground">{server.bedrockPort}</span></>}{server.bedrockReachable ? "" : " (not answering yet)"}</p>}
            {!server.published && server.checkedAt && <p className="text-xs text-warning">Blocky Cloud couldn&apos;t reach this server from the internet. Check that it&apos;s running and that port {server.port} is forwarded on your router.</p>}
          </li>)}
        </ul> : <p className="text-xs text-muted-foreground">{overview.unpublished.length ? "No published servers. Turn one on below." : "No servers yet. They're added at the next check-in."}</p>}
        {name.state === "frozen" && <p className="text-xs text-warning">Frozen: this name is beyond what the account includes, so it stays at its last address and won&apos;t follow IP changes.</p>}
      </div>)}</div>}
    <p className="mt-4 text-xs text-muted-foreground">Game ports still need to be forwarded on your router. The name only finds this machine, and Blocky Cloud only publishes servers it can reach. Bedrock players need the server&apos;s Geyser port open too.</p>
  </Section>;
}

function PublishCard({ overview, onChanged }: { overview: Enabled; onChanged: () => void }) {
  const { servers, system, track, isPending } = usePanel();
  const hidden = new Set(overview.unpublished);
  const addresses = system?.cloudAddresses ?? {};
  const pointed = overview.names.some((name) => name.state === "active" || name.state === "frozen");
  const records = new Map(overview.names.flatMap((name) => name.servers).map((record) => [record.id, record]));
  return <Section title="Servers on blockylink.net" description="Turn a server off to leave it without an address: a backend behind a Velocity or BungeeCord proxy, or an archived world. Changes reach DNS within a minute.">
    {servers.length === 0 ? <p className="text-sm text-muted-foreground">No servers yet.</p>
      : <ul className="divide-y divide-border rounded-xl border border-border">
        {servers.map((server) => {
          const published = !hidden.has(server.id);
          const key = `cloud:publish:${server.id}`;
          return <li key={server.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <ServerIconImage server={server} className="size-8" />
            <label htmlFor={`publish-${server.id}`} className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{server.name}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {!published ? "Not published" : addresses[server.id] || (records.get(server.id)?.checkedAt ? "Not answering from the internet yet" : pointed ? "Gets an address at the next check-in" : "Published once a name points at this panel")}
              </span>
            </label>
            <Switch id={`publish-${server.id}`} checked={published} disabled={isPending(key)} aria-label={`Publish ${server.name} on blockylink.net`}
              onCheckedChange={(checked) => void track(key, async () => {
                try { await api("/api/cloud/servers", { method: "PATCH", body: JSON.stringify({ serverId: server.id, publish: checked }) }); toast.success(checked ? `${server.name} is published.` : `${server.name} is off blockylink.net.`); }
                catch (error) { toast.error(errorMessage(error, "Couldn't change that.")); }
                onChanged();
              })} />
          </li>;
        })}
      </ul>}
  </Section>;
}


export function CloudPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setOverview(await api<Overview>("/api/cloud")); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Couldn't load Blocky Cloud.")); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  // While a code waits for approval, follow it so the page switches to "linked" on its own.
  const waiting = overview?.enabled && overview.linking && !overview.linking.error;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);
  const [wasLinked, setWasLinked] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!overview?.enabled) return;
    if (wasLinked === false && overview.linked) toast.success("Linked to Blocky Cloud.");
    const timer = window.setTimeout(() => setWasLinked(overview.linked), 0);
    return () => window.clearTimeout(timer);
  }, [overview, wasLinked]);

  return <div className="space-y-6">
    <p className="text-sm text-muted-foreground">A blockylink.net address for your servers, and Obsidian backups (encrypted off-site backup space), from a Blocky Cloud account.</p>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>}
    {!overview ? <Skeleton className="h-64" />
      : !overview.enabled ? <Section title="Not available"><p className="text-sm text-muted-foreground">{overview.reason}</p></Section>
        : !overview.linked ? <LinkCard overview={overview} onChanged={() => void load()} />
          : <>
            <AccountCard overview={overview} onChanged={() => void load()} />
            <NamesCard overview={overview} />
            <PublishCard overview={overview} onChanged={() => void load()} />
          </>}
    {overview?.enabled && <p className="text-xs leading-5 text-muted-foreground">
      Don&apos;t want Blocky Cloud? {overview.linked ? "Unlink this panel first, then set " : "Set "}<code className="rounded bg-muted px-1 py-0.5 font-mono">BLOCKY_CLOUD=false</code> in the panel&apos;s <code className="rounded bg-muted px-1 py-0.5 font-mono">.env</code> file, next to <code className="rounded bg-muted px-1 py-0.5 font-mono">compose.yaml</code>, and restart the panel with <code className="rounded bg-muted px-1 py-0.5 font-mono">docker compose up -d</code>. This page and the sidebar button go away, and nothing is sent to Blocky Cloud.
    </p>}
  </div>;
}
