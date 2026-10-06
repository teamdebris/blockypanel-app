"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Archive, ArrowRight, CirclePlay, HardDrive, LoaderCircle, Plus, Server, Undo2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PageHeading } from "./common";
import { BlockArt } from "./server-icon";
import { activityHref, api, formatBytes, formatRelative, serverHref } from "./lib";
import { useNow, usePanel } from "./panel-context";
import { ServerCard } from "./server-card";
import type { MinecraftServer, OperationEvent } from "./types";

type Attention = { key: string; tone: "error" | "warning" | "busy"; title: string; detail: string; href: string; dismiss?: string; onDismiss?: () => Promise<void> };

/** A backup is overdue once it's missed two intervals, or the schedule is failing. */
function backupProblem(server: MinecraftServer, now: number) {
  const backup = server.backup;
  if (!backup?.enabled) return undefined;
  if (backup.consecutiveFailures > 0) return `Scheduled backups are failing (${backup.consecutiveFailures} in a row).`;
  const last = backup.lastRunAt ? new Date(backup.lastRunAt).getTime() : 0;
  if (last && now - last > backup.intervalHours * 2 * 3_600_000) return `No backup since ${formatRelative(backup.lastRunAt, now)}.`;
  return undefined;
}

function useAttention(now: number): Attention[] {
  const { servers, worlds, dismissedResults, refresh } = usePanel();
  const items: Attention[] = [];
  for (const server of servers) {
    if (server.operation) items.push({ key: `${server.id}:op`, tone: "busy", title: `${server.operation.label}: ${server.name}`, detail: `${server.operation.step || "Working"}… started ${formatRelative(server.operation.startedAt, now)}`, href: serverHref(server.id) });
    else if (server.status === "failed" || server.health === "unhealthy") items.push({ key: `${server.id}:failed`, tone: "error", title: `${server.name} is down`, detail: server.statusMessage, href: serverHref(server.id, "console") });
    const finished = server.lastOperation;
    if (finished && !finished.ok && !server.operation && !dismissedResults.has(finished.finishedAt)) items.push({ key: `${server.id}:last`, tone: "error", title: `${finished.label} failed on ${server.name}`, detail: finished.message, href: activityHref(server.id), dismiss: finished.finishedAt });
    const backup = backupProblem(server, now);
    if (backup) items.push({
      key: `${server.id}:backup`, tone: "warning", title: `${server.name}: backups need attention`, detail: backup, href: serverHref(server.id, "backups"),
      // A failure streak can be dismissed; an overdue backup can't (only a backup fixes that).
      ...(server.backup?.consecutiveFailures ? { onDismiss: async () => { await api(`/api/servers/${server.id}/backups/failures`, { method: "DELETE" }); await refresh(); } } : {}),
    });
  }
  if (worlds.length) items.push({ key: "worlds", tone: "warning", title: `${worlds.length} detached world${worlds.length === 1 ? "" : "s"}`, detail: "World data from removed servers is still on disk. Reattach or delete it.", href: "/servers#detached" });
  return items;
}

const chips = {
  green: "bg-success-soft text-success",
  blue: "bg-info-soft text-info",
  gold: "bg-warning-soft text-warning",
  purple: "bg-chart-4/15 text-chart-4",
  stone: "bg-muted text-muted-foreground",
} as const;

function Metric({ icon: Icon, label, value, color }: { icon: typeof Server; label: string; value: string; color: keyof typeof chips }) {
  return <div className="flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 shadow-card">
    <span className={cn("grid size-11 shrink-0 place-items-center rounded-[10px]", chips[color])}><Icon className="size-5" aria-hidden /></span>
    <div className="min-w-0">
      <p className="font-display text-xl font-bold leading-tight tracking-[-.02em]">{value}</p>
      <p className="truncate text-sm text-muted-foreground">{label}</p>
    </div>
  </div>;
}

type FeedEvent = OperationEvent & { serverId: string; serverName: string };

/** Green for starts, gold for backups and warnings, blue for changes, red for stops and errors. */
/** The dot shows how it went, so red and yellow always mean something worth a look. A stop or removal that worked is neutral, not good news. */
function eventDot(event: OperationEvent) {
  if (event.level === "error") return "bg-destructive";
  if (event.level === "warning") return "bg-warning";
  if (event.level === "success" && !["stop", "remove"].includes(event.type)) return "bg-success";
  return "bg-muted-foreground";
}

/** The latest few events across every server. */
function RecentActivity() {
  const { servers } = usePanel();
  const now = useNow(30_000);
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const marker = servers.map((server) => `${server.id}:${server.lastOperation?.finishedAt}:${server.status}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(servers.slice(0, 12).map((server) => api<{ events: OperationEvent[] }>(`/api/servers/${server.id}/events`)
        .then((result) => result.events.slice(0, 8).map((event) => ({ ...event, serverId: server.id, serverName: server.name })))
        .catch(() => [] as FeedEvent[])))
        .then((lists) => { if (!cancelled) setEvents(lists.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6)); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // The marker changes when something happens on a server; the list itself is read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marker]);
  if (!servers.length) return null;
  return <section aria-labelledby="activity-title" className="mt-6 rounded-xl border border-border bg-card shadow-card">
    <h2 id="activity-title" className="border-b border-border px-5 py-3.5 text-sm font-semibold">Recent activity</h2>
    {!events ? <div className="space-y-2 p-5"><Skeleton className="h-5" /><Skeleton className="h-5" /><Skeleton className="h-5" /></div>
      : events.length ? <ul className="divide-y divide-border px-5">{events.map((event) => <li key={`${event.serverId}:${event.id}`} className="flex items-center gap-3 py-3 text-sm">
        <span className={cn("size-2.5 shrink-0 rounded-full", eventDot(event))} aria-hidden />
        <p className="min-w-0 flex-1 truncate"><Link href={activityHref(event.serverId)} className="font-semibold hover:underline">{event.serverName}</Link> <span className="text-muted-foreground">{event.message}</span></p>
        <time dateTime={event.at} className="shrink-0 text-xs text-muted-foreground">{formatRelative(event.at, now)}</time>
      </li>)}</ul>
        : <p className="px-5 py-4 text-sm text-muted-foreground">Nothing has happened yet.</p>}
  </section>;
}

export function OverviewPage() {
  const { servers, loaded, setCreateOpen, system, dismissResult, can } = usePanel();
  const now = useNow(15_000);
  const attention = useAttention(now);
  const online = servers.filter((server) => server.status === "running").length;
  const players = servers.reduce((sum, server) => sum + server.playersOnline, 0);
  const disk = servers.reduce((sum, server) => sum + server.diskUsageBytes, 0);
  const dockerDown = system?.dockerAvailable === false;

  return <>
    <PageHeading title="Overview" description="Manage your Minecraft servers"
      actions={can.manage && <Button onClick={() => setCreateOpen(true)} disabled={dockerDown}><Plus />Create server</Button>} />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric icon={Server} label={servers.length === 1 ? "Server" : "Servers"} value={String(servers.length)} color="stone" />
      <Metric icon={CirclePlay} label="Running" value={String(online)} color="green" />
      <Metric icon={Users} label={players === 1 ? "Player online" : "Players online"} value={String(players)} color="blue" />
      <Metric icon={HardDrive} label="Total size" value={formatBytes(disk)} color="stone" />
    </div>

    <section aria-labelledby="attention-title" className={attention.length ? "mt-6" : undefined}>
      <h2 id="attention-title" className="sr-only">Needs attention</h2>
      {attention.length ? <ul className="space-y-2">
        {attention.map((item) => <li key={item.key} className={cn("flex items-start gap-3 rounded-xl border p-3.5", item.tone === "error" ? "border-destructive/30 bg-danger-soft" : item.tone === "warning" ? "border-warning/30 bg-warning-soft" : "border-border bg-card")}>
          {item.tone === "busy" ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" /> : item.tone === "error" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" /> : item.key === "worlds" ? <Undo2 className="mt-0.5 size-4 shrink-0 text-warning" /> : <Archive className="mt-0.5 size-4 shrink-0 text-warning" />}
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.title}</p><p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p></div>
          <Link href={item.href} className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium hover:bg-accent">View<ArrowRight className="size-3.5" /></Link>
          {item.dismiss && <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => dismissResult(item.dismiss!)}><X /></Button>}
          {item.onDismiss && can.control && <Button variant="ghost" size="icon-xs" aria-label="Dismiss" title="Dismiss until the next failure" onClick={() => void item.onDismiss!().catch(() => undefined)}><X /></Button>}
        </li>)}
      </ul> : null}
    </section>

    <section aria-labelledby="servers-title" className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="servers-title" className="font-display text-lg font-semibold">Servers</h2>
        <Link href="/servers" className="text-sm text-muted-foreground hover:text-foreground">Manage all</Link>
      </div>
      {!loaded ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
        : servers.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{servers.map((server) => <ServerCard key={server.id} server={server} />)}</div>
          : <EmptyServers onCreate={() => setCreateOpen(true)} dockerDown={dockerDown} />}
    </section>

    <RecentActivity />
  </>;
}

export function EmptyServers({ onCreate, dockerDown }: { onCreate: () => void; dockerDown: boolean }) {
  const { can } = usePanel();
  return <div className="empty-grid grid min-h-72 place-items-center rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
    <div>
      <BlockArt name="grass" className="mx-auto size-16" />
      <h3 className="font-display mt-4 text-lg font-semibold">No servers yet</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">Create a Minecraft server with its own storage, automatic backups, and plugins or mods from Modrinth.</p>
      {can.manage ? <Button className="mt-4" onClick={onCreate} disabled={dockerDown}><Plus />Create your first server</Button> : <p className="mt-3 text-xs text-muted-foreground">An admin can create one.</p>}
      {can.offsite && <p className="mt-3 text-xs text-muted-foreground">Moving from another machine? <Link href="/backups?restore=1" className="font-medium text-foreground underline underline-offset-2">Restore from an off-site copy</Link></p>}
      {dockerDown && can.manage && <p className="mt-2 text-xs text-destructive">Connect Docker to create servers.</p>}
    </div>
  </div>;
}
