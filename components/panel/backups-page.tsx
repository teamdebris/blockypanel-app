"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { OffsiteSection } from "./offsite-page";
import { BlockArt, ServerIconImage } from "./server-icon";
import { PageHeading, Section } from "./common";
import { api, errorMessage, formatRelative, lastBackupAt, serverHref } from "./lib";
import { useNow, usePanel } from "./panel-context";
import type { MinecraftServer } from "./types";

/** A server's two backup switches, local and off-site, with how each is doing. */
function ServerBackupRow({ server, now }: { server: MinecraftServer; now: number }) {
  const { can, track, isPending, refresh } = usePanel();
  const local = Boolean(server.backup?.enabled);
  const failing = (server.backup?.consecutiveFailures ?? 0) > 0;
  const last = lastBackupAt(server);
  const offsite = server.offsite;
  async function change(kind: "local" | "offsite", on: boolean) {
    await track(`${server.id}:${kind}-toggle`, async () => {
      try {
        if (kind === "local") await api(`/api/servers/${server.id}/backups/policy`, { method: "PATCH", body: JSON.stringify({ enabled: on }) });
        else await api(`/api/servers/${server.id}/offsite`, { method: "PATCH", body: JSON.stringify({ included: on }) });
        toast.success(`${kind === "local" ? "Local backups" : "Off-site copies"} ${on ? "on" : "off"} for ${server.name}.`);
      } catch (reason) { toast.error(errorMessage(reason, "Couldn't change that.")); }
      await refresh();
    });
  }
  return <li className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm sm:px-5">
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <ServerIconImage server={server} className="size-9" />
      <div className="min-w-0 flex-1">
        <Link href={serverHref(server.id, "backups")} className="font-medium hover:underline">{server.name}</Link>
        <p className={failing ? "mt-0.5 flex items-center gap-1 text-xs text-destructive" : "mt-0.5 text-xs text-muted-foreground"}>
          {failing && <AlertTriangle className="size-3.5" />}
          {failing ? "Last scheduled backup failed" : last ? `Last backup ${formatRelative(last, now)}` : "Never backed up"}
          {!failing && <> · {server.backupCount} backup{server.backupCount === 1 ? "" : "s"}{local && server.backup ? ` · every ${server.backup.intervalHours} h` : ""}</>}
        </p>
        {/* This server's off-site status lives here only; the Off-site copies card is about the destination. */}
        {offsite?.included && <p title={offsite.lastError} className={offsite.lastError ? "mt-0.5 flex items-center gap-1 text-xs text-destructive" : "mt-0.5 text-xs text-muted-foreground"}>
          {offsite.lastError && <AlertTriangle className="size-3.5" />}
          {offsite.lastError ? "Last off-site copy failed" : offsite.lastCopyAt ? `Copied off-site ${formatRelative(offsite.lastCopyAt, now)}` : server.backupCount ? "Not copied off-site yet" : "Copied off-site after its first backup"}
        </p>}
      </div>
    </div>
    <label className="flex items-center gap-2 text-xs text-muted-foreground">Local
      <Switch checked={local} disabled={!can.restore || isPending(`${server.id}:local-toggle`)} onCheckedChange={(on) => void change("local", on)} aria-label={`Local backups for ${server.name}`} />
    </label>
    <label className="flex items-center gap-2 text-xs text-muted-foreground" title={offsite ? undefined : "Set up off-site copies below first."}>Off-site
      <Switch checked={Boolean(offsite?.included)} disabled={!offsite || !can.offsite || isPending(`${server.id}:offsite-toggle`)} onCheckedChange={(on) => void change("offsite", on)} aria-label={`Off-site copies for ${server.name}`} />
    </label>
  </li>;
}

/** Every backup in one place: each server's backup switches, then where off-site copies go. */
export function BackupsPage() {
  const { servers, system } = usePanel();
  const now = useNow(60_000);
  return <div className="space-y-6">
    <PageHeading title="Backups" description="Each server backs up on this machine on its own schedule. Off-site copies keep them safe somewhere else too." />
    <Section title={<span className="flex items-center gap-2"><BlockArt name="chest-storage" className="size-6" />Servers</span>} description={system?.offsiteBackups ? "Switch local backups and off-site copies on or off for each server. Open a server to change its schedule or restore." : "Switch local backups on or off for each server. Set up off-site copies below to protect them somewhere else."}>
      {servers.length === 0 ? <p className="text-sm text-muted-foreground">No servers yet.</p>
        : <ul className="-mx-4 -my-4 divide-y divide-border sm:-mx-5 sm:-my-5">{servers.map((server) => <ServerBackupRow key={server.id} server={server} now={now} />)}</ul>}
    </Section>
    <OffsiteSection />
  </div>;
}
