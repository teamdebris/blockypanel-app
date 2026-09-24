"use client";

import Link from "next/link";
import { AlertTriangle, Archive, ArrowRight, CheckCircle2, HardDrive, LoaderCircle, Plus, Server, Undo2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PageHeading } from "./common";
import { formatBytes, formatRelative, serverHref } from "./lib";
import { useNow, usePanel } from "./panel-context";
import { ServerCard } from "./server-card";
import type { MinecraftServer } from "./types";

type Attention = { key: string; tone: "error" | "warning" | "busy"; title: string; detail: string; href: string; dismiss?: string };

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
  const { servers, worlds, dismissedResults } = usePanel();
  const items: Attention[] = [];
  for (const server of servers) {
    if (server.operation) items.push({ key: `${server.id}:op`, tone: "busy", title: `${server.operation.label}: ${server.name}`, detail: `${server.operation.step || "Working"}… started ${formatRelative(server.operation.startedAt, now)}`, href: serverHref(server.id) });
    else if (server.status === "failed" || server.health === "unhealthy") items.push({ key: `${server.id}:failed`, tone: "error", title: `${server.name} is down`, detail: server.statusMessage, href: serverHref(server.id, "console") });
    const finished = server.lastOperation;
    if (finished && !finished.ok && !server.operation && !dismissedResults.has(finished.finishedAt)) items.push({ key: `${server.id}:last`, tone: "error", title: `${finished.label} failed on ${server.name}`, detail: finished.message, href: serverHref(server.id, "activity"), dismiss: finished.finishedAt });
    const backup = backupProblem(server, now);
    if (backup) items.push({ key: `${server.id}:backup`, tone: "warning", title: `${server.name}: backups need attention`, detail: backup, href: serverHref(server.id, "backups") });
  }
  if (worlds.length) items.push({ key: "worlds", tone: "warning", title: `${worlds.length} detached world${worlds.length === 1 ? "" : "s"}`, detail: "World data from removed servers is still on disk. Reattach or delete it.", href: "/servers#detached" });
  return items;
}

function Metric({ icon: Icon, label, value, meta, tone }: { icon: typeof Server; label: string; value: string; meta?: string; tone?: "good" | "warn" }) {
  return <div className="rounded-xl border border-border bg-card p-4">
    <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground sm:text-sm">{label}</p><Icon className={cn("size-4", tone === "good" ? "text-success" : tone === "warn" ? "text-warning" : "text-muted-foreground")} aria-hidden /></div>
    <p className="font-display mt-2 text-xl font-bold tracking-[-.03em] sm:text-2xl">{value}</p>
    {meta && <p className={cn("mt-0.5 truncate text-xs", tone === "warn" ? "text-warning" : "text-muted-foreground")}>{meta}</p>}
  </div>;
}

export function OverviewPage() {
  const { servers, loaded, setCreateOpen, system, dismissResult } = usePanel();
  const now = useNow(15_000);
  const attention = useAttention(now);
  const online = servers.filter((server) => server.status === "running").length;
  const players = servers.reduce((sum, server) => sum + server.playersOnline, 0);
  const disk = servers.reduce((sum, server) => sum + server.diskUsageBytes, 0);
  const staleBackups = servers.filter((server) => backupProblem(server, now));
  const dockerDown = system?.dockerAvailable === false;

  return <>
    <PageHeading eyebrow="Control plane" title="Overview" description="Everything that needs you, and every server at a glance." />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric icon={Server} label="Online" value={`${online} / ${servers.length}`} meta={servers.length ? (online === servers.length ? "All servers up" : `${servers.length - online} not running`) : "No servers yet"} tone={servers.length && online === servers.length ? "good" : undefined} />
      <Metric icon={Users} label="Players" value={String(players)} meta={players ? "online right now" : "Nobody online"} />
      <Metric icon={Archive} label="Backups" value={staleBackups.length ? `${staleBackups.length} behind` : "Up to date"} meta={staleBackups.length ? staleBackups.map((server) => server.name).join(", ") : system?.offsiteBackups ? "Also copied offsite" : "Stored on this host"} tone={staleBackups.length ? "warn" : "good"} />
      <Metric icon={HardDrive} label="World data" value={formatBytes(disk)} meta={`across ${servers.length} server${servers.length === 1 ? "" : "s"}`} />
    </div>

    <section aria-labelledby="attention-title" className="mt-6">
      <h2 id="attention-title" className="sr-only">Needs attention</h2>
      {attention.length ? <ul className="space-y-2">
        {attention.map((item) => <li key={item.key} className={cn("flex items-start gap-3 rounded-xl border p-3.5", item.tone === "error" ? "border-destructive/30 bg-danger-soft" : item.tone === "warning" ? "border-warning/30 bg-warning-soft" : "border-border bg-card")}>
          {item.tone === "busy" ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" /> : item.tone === "error" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" /> : item.key === "worlds" ? <Undo2 className="mt-0.5 size-4 shrink-0 text-warning" /> : <Archive className="mt-0.5 size-4 shrink-0 text-warning" />}
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.title}</p><p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p></div>
          <Link href={item.href} className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium hover:bg-accent">View<ArrowRight className="size-3.5" /></Link>
          {item.dismiss && <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => dismissResult(item.dismiss!)}><X /></Button>}
        </li>)}
      </ul> : loaded && servers.length > 0 && <p className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"><CheckCircle2 className="size-4 text-success" />All clear. Nothing needs your attention.</p>}
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
  </>;
}

export function EmptyServers({ onCreate, dockerDown }: { onCreate: () => void; dockerDown: boolean }) {
  const { can } = usePanel();
  return <div className="empty-grid grid min-h-72 place-items-center rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
    <div>
      <div className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-card"><Server className="size-5" /></div>
      <h3 className="font-display mt-4 text-lg font-semibold">No servers yet</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">Create a Minecraft server with its own storage, automatic backups, and plugins or mods from Modrinth.</p>
      {can.manage ? <Button className="mt-4" onClick={onCreate} disabled={dockerDown}><Plus />Create your first server</Button> : <p className="mt-3 text-xs text-muted-foreground">An admin can create one.</p>}
      {dockerDown && can.manage && <p className="mt-2 text-xs text-destructive">Connect Docker to create servers.</p>}
    </div>
  </div>;
}
