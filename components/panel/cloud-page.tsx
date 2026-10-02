"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, CloudUpload, ExternalLink, Globe, Link2, LoaderCircle, RefreshCcw, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { type CloudBackupStatus, type CloudName, type CloudNotice, nameStateLabels, type SubscriptionState, subscriptionLabels } from "@/lib/cloud-core";
import { cn } from "@/lib/utils";
import { ConfirmDialog, PageHeading, Section, UsageBar } from "./common";
import { api, errorMessage, formatBytes, formatDate, formatRelative } from "./lib";
import { useNow, usePanel } from "./panel-context";

type Linking = { userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string; error?: string };
type Overview =
  | { enabled: false; reason: string }
  | {
    enabled: true; cloudUrl: string; linked: boolean; unlinkedRemotely: boolean; linking?: Linking; account?: { email: string }; linkedAt?: string;
    lastCheckinAt?: string; lastAttemptAt?: string; nextCheckinAt?: string; lastError?: string; panelName: string; panelId: string; unpublished: string[]; outdated: boolean;
    subscription?: { state: SubscriptionState; plan: string | null; graceEndsAt: string | null; lapsedAt: string | null };
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

const subscriptionTone: Record<SubscriptionState, keyof typeof tone> = { active: "ok", grace: "warn", lapsed: "bad", none: "muted" };
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
      {linking?.error && <p role="alert" className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">{linking.error}</p>}
      {expired && !linking?.error && <p role="alert" className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">The code expired before it was approved. Start again.</p>}
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>Create an account at <a className="text-foreground underline" href={overview.cloudUrl} target="_blank" rel="noreferrer">{overview.cloudUrl.replace(/^https?:\/\//, "")}</a>, and turn on two-factor sign-in.</li>
        <li>Choose <span className="font-medium text-foreground">Link</span> below. The panel shows a short code.</li>
        <li>Enter the code on Blocky Cloud to approve this panel.</li>
      </ol>
      <Button onClick={start} disabled={isPending("cloud:link")}>{isPending("cloud:link") ? <LoaderCircle className="animate-spin" /> : <Link2 />}Link to Blocky Cloud</Button>
      <p className="text-xs text-muted-foreground">Linking sends this panel&apos;s name ({overview.panelName}), version, and its servers&apos; names and game ports. It never sends worlds, files, or passwords.</p>
    </div>
  </Section>;
}

function AccountCard({ overview, onChanged }: { overview: Enabled; onChanged: () => void }) {
  const { track, isPending } = usePanel();
  const now = useNow(30_000);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const subscription = overview.subscription;
  return <>
    <Section title="Account" description={overview.account?.email}
      actions={<>
        <Button size="sm" variant="outline" disabled={isPending("cloud:checkin")} onClick={() => void track("cloud:checkin", async () => {
          try { await api("/api/cloud", { method: "POST" }); toast.success("Checked in."); }
          catch (error) { toast.error(errorMessage(error, "Check-in failed.")); }
          onChanged();
        })}>{isPending("cloud:checkin") ? <LoaderCircle className="animate-spin" /> : <RefreshCcw />}Check in now</Button>
        <Button size="sm" variant="outline" asChild><a href={overview.cloudUrl} target="_blank" rel="noreferrer"><ExternalLink />Open Blocky Cloud</a></Button>
      </>}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {subscription ? <Pill kind={subscriptionTone[subscription.state]}>{subscriptionLabels[subscription.state]}</Pill> : <Pill kind="muted">Waiting for the first check-in</Pill>}
          {subscription?.plan && <span className="text-muted-foreground">Plan: {subscription.plan}</span>}
        </div>
        <p className="flex items-center gap-1.5 text-muted-foreground">
          {overview.lastError ? <AlertTriangle className="size-4 text-destructive" /> : <CheckCircle2 className="size-4 text-success" />}
          {overview.lastCheckinAt ? <>Last check-in {formatRelative(overview.lastCheckinAt, now)}</> : "No check-in yet."}
          {overview.nextCheckinAt && <span>· next {formatRelative(overview.nextCheckinAt, now)}</span>}
        </p>
        {overview.lastError && <p className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">{overview.lastError}</p>}
        {overview.outdated && <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">This panel is older than Blocky Cloud supports. Update it to keep your names and backups working.</p>}
        {overview.notices.map((notice, index) => <p key={index} className={cn("rounded-lg border px-3 py-2 text-xs", notice.level === "error" ? tone.bad : notice.level === "warning" ? tone.warn : tone.muted)}>{notice.message}</p>)}
        {subscription && subscription.state !== "active" && subscription.state !== "grace" ? <p className="text-xs text-muted-foreground">The free plan includes one name with one server address, and a little backup space copied once a day. Standard adds more server addresses and much more room. <a className="underline" href={`${overview.cloudUrl}/billing`} target="_blank" rel="noreferrer">See plans</a>.</p> : null}
        <div className="border-t border-border pt-3">
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmUnlink(true)}><Unlink />Unlink this panel</Button>
        </div>
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
        {name.servers.length > 0 ? <ul className="divide-y divide-border rounded-xl border border-border">
          {name.servers.map((server) => <li key={server.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="font-mono">{server.fqdn}</span>
            <span className="text-xs text-muted-foreground">port {server.port}</span>
          </li>)}
        </ul> : <p className="text-xs text-muted-foreground">{overview.unpublished.length ? "No published servers. Turn one on below." : "No servers yet. They're added at the next check-in."}</p>}
        {name.state === "frozen" && <p className="text-xs text-warning">Frozen: the subscription ended and the free plan covers one name, so this one stays at its last address and won&apos;t follow IP changes.</p>}
      </div>)}</div>}
    <p className="mt-4 text-xs text-muted-foreground">Game ports still need to be forwarded on your router. The name only finds this machine.</p>
  </Section>;
}

function PublishCard({ overview, onChanged }: { overview: Enabled; onChanged: () => void }) {
  const { servers, system, track, isPending } = usePanel();
  const hidden = new Set(overview.unpublished);
  const addresses = system?.cloudAddresses ?? {};
  const pointed = overview.names.some((name) => name.state === "active" || name.state === "frozen");
  return <Section title="Servers on blockylink.net" description="Turn a server off to leave it without an address: a backend behind a Velocity or BungeeCord proxy, or an archived world. Changes reach DNS within a minute.">
    {servers.length === 0 ? <p className="text-sm text-muted-foreground">No servers yet.</p>
      : <ul className="divide-y divide-border rounded-xl border border-border">
        {servers.map((server) => {
          const published = !hidden.has(server.id);
          const key = `cloud:publish:${server.id}`;
          return <li key={server.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <label htmlFor={`publish-${server.id}`} className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{server.name}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {!published ? "Not published" : addresses[server.id] || (pointed ? "Gets an address at the next check-in" : "Published once a name points at this panel")}
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

function BackupCard({ overview }: { overview: Enabled }) {
  const { system } = usePanel();
  const backup = overview.backup;
  return <Section title="Blocky Cloud backup" description="Off-site copies, encrypted on this machine before upload."
    actions={<Button size="sm" variant="outline" asChild><Link href="/backups"><CloudUpload />Offsite backups</Link></Button>}>
    {!backup?.available ? <p className="text-sm text-muted-foreground">This account&apos;s plan has no cloud backup space. <a className="underline" href={`${overview.cloudUrl}/billing`} target="_blank" rel="noreferrer">See plans</a>.</p> : <div className="space-y-3 text-sm">
      <div className="flex items-baseline justify-between gap-2"><span className="font-medium">{formatBytes(backup.usedBytes)} used</span><span className="text-xs text-muted-foreground">of {formatBytes(backup.quotaBytes)}</span></div>
      <UsageBar value={backup.usedBytes} max={backup.quotaBytes} label="Blocky Cloud storage used" />
      {backup.copiesPerDay ? <p className="text-xs text-muted-foreground">The free plan copies once a day. Standard copies after every backup and has more room. <a className="underline" href={`${overview.cloudUrl}/billing`} target="_blank" rel="noreferrer">See plans</a>.</p> : null}
      {backup.readOnly && <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">Read-only: restores work, but new copies can&apos;t upload until there&apos;s room or the subscription is active again.</p>}
      {backup.deleteAfter && <p className="text-xs text-destructive">These backups will be deleted on {formatDate(backup.deleteAfter)} unless the subscription is renewed.</p>}
      {!system?.offsiteBackups && <p className="text-xs text-muted-foreground">To use it, open <Link className="underline" href="/backups">Offsite backups</Link> and choose Blocky Cloud as the destination.</p>}
    </div>}
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
    <PageHeading eyebrow="Blocky Cloud" title="Blocky Cloud" description="A friendly address for your servers and off-site backups, from a Blocky Cloud account." />
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>}
    {!overview ? <Skeleton className="h-64" />
      : !overview.enabled ? <Section title="Not available"><p className="text-sm text-muted-foreground">{overview.reason}</p></Section>
        : !overview.linked ? <LinkCard overview={overview} onChanged={() => void load()} />
          : <>
            <AccountCard overview={overview} onChanged={() => void load()} />
            <div className="grid gap-6 lg:grid-cols-2">
              <NamesCard overview={overview} />
              <BackupCard overview={overview} />
            </div>
            <PublishCard overview={overview} onChanged={() => void load()} />
          </>}
  </div>;
}
