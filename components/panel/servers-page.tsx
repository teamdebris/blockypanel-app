"use client";

import { useState } from "react";
import { Archive, Plus, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog, PageHeading } from "./common";
import { api, formatBytes } from "./lib";
import { EmptyServers } from "./overview-page";
import { usePanel } from "./panel-context";
import { ServerCard } from "./server-card";
import type { DetachedWorld } from "./types";

function DetachedWorldCard({ world }: { world: DetachedWorld }) {
  const { track, isPending } = usePanel();
  const [confirming, setConfirming] = useState(false);
  const busy = isPending(`${world.id}:reattach`) || isPending(`${world.id}:delete-world`);
  return <li className="rounded-xl border border-dashed border-border bg-muted/30 p-4">
    <div className="flex items-center gap-3">
      <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-card"><Archive className="size-4 text-muted-foreground" /></div>
      <div className="min-w-0"><p className="truncate font-medium">{world.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{world.hasData ? `${formatBytes(world.diskUsageBytes)} world` : "No world data"} · {world.hasBackups ? "backups kept" : "no backups"}</p></div>
    </div>
    {!world.canReattach && <p className="mt-3 text-xs text-muted-foreground">{world.hasData ? "No saved settings exist for this world, so it can't be reattached automatically. Create a new server and upload the world through Files." : "Only backups remain. Create a new server and restore one of them."}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {world.canReattach && <Button size="sm" variant="outline" disabled={busy} onClick={() => void track(`${world.id}:reattach`, async () => { const result = await api<{ message: string }>(`/api/worlds/${world.id}`, { method: "POST" }); toast.success(result.message); })}><Undo2 />Reattach</Button>}
      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => setConfirming(true)}><Trash2 />Delete permanently</Button>
    </div>
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} destructive typeToConfirm={world.name} title={`Delete ${world.name} permanently?`} confirmLabel="Delete world and backups"
      onConfirm={() => void track(`${world.id}:delete-world`, async () => { await api(`/api/worlds/${world.id}`, { method: "DELETE" }); toast.success(`${world.name} was deleted.`); })}>
      <p>This removes {world.hasData ? <span className="font-medium text-foreground">the {formatBytes(world.diskUsageBytes)} world</span> : "the world directory"}{world.hasBackups ? <> and <span className="font-medium text-foreground">every backup</span></> : null} from disk. It can&apos;t be undone.</p>
    </ConfirmDialog>
  </li>;
}

export function ServersPage() {
  const { servers, worlds, loaded, setCreateOpen, system, can } = usePanel();
  const dockerDown = system?.dockerAvailable === false;
  return <>
    <PageHeading eyebrow="Control plane" title="All servers" description="Every server on this host, plus data left behind by removed servers."
      actions={can.manage && <Button className="sm:hidden" onClick={() => setCreateOpen(true)} disabled={dockerDown}><Plus />New server</Button>} />
    {!loaded ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-44" /><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
      : servers.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{servers.map((server) => <ServerCard key={server.id} server={server} />)}</div>
        : <EmptyServers onCreate={() => setCreateOpen(true)} dockerDown={dockerDown} />}
    {worlds.length > 0 && <section id="detached" aria-labelledby="detached-title" className="mt-10 scroll-mt-20">
      <h2 id="detached-title" className="font-display text-lg font-semibold">Detached worlds</h2>
      <p className="mt-1 text-sm text-muted-foreground">Data from removed servers. Reattach to recreate the server with its saved settings.</p>
      <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{worlds.map((world) => <DetachedWorldCard key={world.id} world={world} />)}</ul>
    </section>}
  </>;
}
