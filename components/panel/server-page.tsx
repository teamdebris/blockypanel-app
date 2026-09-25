"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Archive, CheckCircle2, FolderOpen, Gauge, History, LoaderCircle, MoreHorizontal, Puzzle, Settings2, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CopyAddress, StatusPill } from "./common";
import { formatDuration, serverHref, serverKind, serverTabLabel, tabLabels } from "./lib";
import { useNow, usePanel } from "./panel-context";
import { PowerControls, ServerMenu } from "./server-actions";
import { ActivityTab } from "./tabs/activity-tab";
import { BackupsTab } from "./tabs/backups-tab";
import { ConsoleTab } from "./tabs/console-tab";
import { FilesTab } from "./tabs/files-tab";
import { OverviewTab } from "./tabs/overview-tab";
import { PluginsTab } from "./tabs/plugins-tab";
import { SettingsTab } from "./tabs/settings-tab";
import type { MinecraftServer, ServerTab } from "./types";

const tabIcons = { overview: Gauge, console: TerminalSquare, plugins: Puzzle, backups: Archive, files: FolderOpen, settings: Settings2, activity: History } as const;

function OperationBanner({ server }: { server: MinecraftServer }) {
  const { dismissedResults, dismissResult } = usePanel();
  const now = useNow(1000);
  if (server.operation) {
    return <div role="status" className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
      <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{server.operation.label}{server.operation.actor ? <span className="font-normal text-muted-foreground"> · started by {server.operation.actor}</span> : null}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{server.operation.step || "Working"}… · {formatDuration(now - new Date(server.operation.startedAt).getTime())} elapsed. Other actions are paused until this finishes.</p>
      </div>
      <Link href={serverHref(server.id, "activity")} className="shrink-0 text-xs font-medium underline-offset-2 hover:underline">Activity</Link>
    </div>;
  }
  const finished = server.lastOperation;
  // Failures stay until dismissed (up to 6 hours); successes were already announced, so they go after 5 minutes.
  const shownFor = finished?.ok ? 5 * 60_000 : 6 * 3_600_000;
  if (!finished || dismissedResults.has(finished.finishedAt) || now - new Date(finished.finishedAt).getTime() > shownFor) return null;
  return <div role={finished.ok ? "status" : "alert"} className={cn("flex items-start gap-3 rounded-xl border px-4 py-3", finished.ok ? "border-success/30 bg-success-soft" : "border-destructive/30 bg-danger-soft")}>
    {finished.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />}
    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{finished.ok ? `${finished.label} finished` : `${finished.label} failed`}</p><p className="mt-0.5 text-xs text-muted-foreground">{finished.message}</p></div>
    <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => dismissResult(finished.finishedAt)}><X /></Button>
  </div>;
}

/** The tabs this role can open: Files is admin-only, Settings needs Operator. */
function useVisibleTabs() {
  const { can } = usePanel();
  return (Object.keys(tabLabels) as ServerTab[]).filter((item) => (item !== "files" || can.files) && (item !== "settings" || can.viewSettings));
}

function TabBar({ server, tab }: { server: MinecraftServer; tab: ServerTab }) {
  const tabs = useVisibleTabs();
  return <nav aria-label={`${server.name} sections`} className="sticky top-14 z-20 -mx-4 hidden border-b border-border bg-background/95 px-4 backdrop-blur sm:-mx-6 sm:px-6 md:block lg:top-16 lg:-mx-8 lg:px-8">
    <div className="server-tabs">
      {tabs.map((item) => { const Icon = tabIcons[item]; return <Link key={item} href={serverHref(server.id, item)} className="server-tab" aria-current={item === tab ? "page" : undefined}><Icon className="size-4" />{serverTabLabel(server, item)}</Link>; })}
    </div>
  </nav>;
}

/** Phones get a thumb-reachable bottom bar; Settings and Activity live under "More". */
function BottomTabBar({ server, tab }: { server: MinecraftServer; tab: ServerTab }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs = useVisibleTabs();
  // Four tabs plus "More"; when a role has five or fewer, all fit without a "More" sheet.
  const primary = tabs.length <= 5 ? tabs : tabs.slice(0, 4);
  const more = tabs.length <= 5 ? [] : tabs.slice(4);
  const inMore = more.includes(tab);
  return <nav aria-label={`${server.name} sections`} className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur md:hidden">
    <div className="grid" style={{ gridTemplateColumns: `repeat(${primary.length + (more.length ? 1 : 0)}, minmax(0, 1fr))` }}>
      {primary.map((item) => { const Icon = tabIcons[item]; return <Link key={item} href={serverHref(server.id, item)} aria-current={item === tab ? "page" : undefined} className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]", item === tab ? "text-foreground" : "text-muted-foreground")}><Icon className="size-5" />{serverTabLabel(server, item)}</Link>; })}
      {more.length > 0 && <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetTrigger asChild><button type="button" className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]", inMore ? "text-foreground" : "text-muted-foreground")} aria-current={inMore ? "page" : undefined}><MoreHorizontal className="size-5" />{inMore ? serverTabLabel(server, tab) : "More"}</button></SheetTrigger>
        <SheetContent side="bottom" className="pb-safe rounded-t-2xl bg-card p-4">
          <SheetHeader className="p-0"><SheetTitle>{server.name}</SheetTitle><SheetDescription className="sr-only">More sections</SheetDescription></SheetHeader>
          <div className="mt-3 grid gap-1">
            {more.map((item) => { const Icon = tabIcons[item]; return <Link key={item} href={serverHref(server.id, item)} onClick={() => setMoreOpen(false)} className="nav-item min-h-12" aria-current={item === tab ? "page" : undefined}><Icon />{serverTabLabel(server, item)}</Link>; })}
          </div>
        </SheetContent>
      </Sheet>}
    </div>
  </nav>;
}

export function ServerPage({ serverId, tab }: { serverId: string; tab: ServerTab }) {
  const { servers, loaded, lastSeen, can, me, isPending } = usePanel();
  const server = servers.find((item) => item.id === serverId);
  const tabs = useVisibleTabs();
  const now = useNow(5000);
  // A server that was listed moments ago is only "not found" once it has been gone for a while; one
  // stale list response (e.g. right after creating it) shouldn't send you to an error page.
  const recentlySeen = lastSeen[serverId] !== undefined && now - lastSeen[serverId] < 15_000;

  // The browser tab doubles as a status indicator: "⚠ Console · Survival — Blocky".
  useEffect(() => {
    if (!server) return;
    const prefix = server.operation ? "⟳ " : server.status === "failed" ? "⚠ " : "";
    document.title = `${prefix}${tab === "overview" ? "" : `${serverTabLabel(server, tab)} · `}${server.name} — Blocky`;
    return () => { document.title = "Blocky Panel"; };
  }, [server, tab]);

  if (!server) {
    if (!loaded || recentlySeen) return <div className="space-y-4" role="status" aria-label="Loading server"><Skeleton className="h-24" /><Skeleton className="h-10" /><Skeleton className="h-72" /></div>;
    return <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-border p-8 text-center">
      <div><h1 id="page-title" tabIndex={-1} className="font-display text-xl font-semibold outline-none">Server not found</h1><p className="mt-1.5 text-sm text-muted-foreground">It may have been removed. Its world might still be listed under detached worlds.</p><Button asChild className="mt-4"><Link href="/servers">All servers</Link></Button></div>
    </div>;
  }

  // Removal waits for the container to stop, so show it instead of leaving a frozen page.
  const removing = isPending(`${server.id}:remove`);
  return <>
    <header className="mb-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 id="page-title" tabIndex={-1} className="font-display truncate text-2xl font-bold tracking-[-.035em] outline-none sm:text-3xl">{server.name}</h1>
            <StatusPill server={server} />
            {me && !can.control && <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">View only</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <CopyAddress port={server.port} />
            <span>{serverKind(server)} · {server.memory.replace("G", " GB")} · {server.playersOnline}/{server.maxPlayers} players</span>
          </div>
        </div>
        {!removing && <div className="flex shrink-0 flex-wrap items-center gap-2"><PowerControls server={server} /><ServerMenu server={server} inHeader /></div>}
      </div>
      <div className="mt-4 empty:hidden">{removing
        ? <div role="status" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-danger-soft px-4 py-3">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Removing {server.name}…</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{server.status === "running" || server.status === "starting" ? "Saving the world and stopping the server, then deleting the container. This can take up to 30 seconds." : "Deleting the container."} You&apos;ll go back to All servers when it&apos;s done.</p>
          </div>
        </div>
        : <OperationBanner server={server} />}</div>
    </header>
    <TabBar server={server} tab={tab} />
    <div className={cn("pt-5", removing && "pointer-events-none opacity-50")} aria-busy={removing || undefined}>
      {me && !tabs.includes(tab) ? <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Your role can&apos;t open {serverTabLabel(server, tab)}. Ask an admin if you need it.</div> : <>
      {tab === "overview" && <OverviewTab server={server} />}
      {tab === "console" && <ConsoleTab server={server} />}
      {tab === "plugins" && <PluginsTab server={server} />}
      {tab === "backups" && <BackupsTab server={server} />}
      {tab === "files" && <FilesTab server={server} />}
      {tab === "settings" && <SettingsTab server={server} />}
      {tab === "activity" && <ActivityTab server={server} />}
      </>}
    </div>
    <BottomTabBar server={server} tab={tab} />
  </>;
}
