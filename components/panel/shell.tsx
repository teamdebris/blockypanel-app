"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Archive, House, ChevronLeft, ChevronRight, ChevronsUpDown, CircleAlert, LifeBuoy, LoaderCircle, LogOut, Menu, Monitor, Moon, Plus, RefreshCcw, Search, Server, Settings2, Sun, UserRound, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { CSRF_HEADER } from "@/lib/csrf";
import { ROLE_LABELS } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { BlockyMark, CloudMark } from "./logo";
import { ServerIconImage } from "./server-icon";
import { CreateServerDialog } from "./create-dialog";
import { api, formatRelative, serverHref, serverTabLabel } from "./lib";
import { useNow, usePanel } from "./panel-context";
import { SERVER_TABS, type ServerTab } from "./types";

function useRouteInfo() {
  const pathname = usePathname() || "/";
  const [, section, id, tab] = pathname.split("/");
  const serverId = section === "servers" && id ? decodeURIComponent(id) : undefined;
  const serverTab = (serverId ? (SERVER_TABS.includes(tab as ServerTab) ? tab : "overview") : undefined) as ServerTab | undefined;
  return { pathname, serverId, serverTab, onServers: section === "servers" };
}

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className="flex items-center gap-3 rounded-md px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Blocky home">
    <BlockyMark className="size-10 shrink-0" />
    {!compact && <span className="font-display text-xl font-extrabold tracking-[-.03em]">Blocky</span>}
    <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" title="Blocky is in beta. See Known issues in the docs.">Beta</span>
  </Link>;
}

function statusDot(status: string, busy: boolean) {
  if (busy) return "bg-warning animate-pulse";
  return status === "running" ? "bg-success" : status === "starting" ? "bg-warning animate-pulse" : status === "failed" ? "bg-destructive" : "bg-muted-foreground";
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { servers, can } = usePanel();
  const { pathname, serverId } = useRouteInfo();
  return <nav aria-label="Primary" className="space-y-1">
    <Link href="/" onClick={onNavigate} className="nav-item" aria-current={pathname === "/" ? "page" : undefined}><House />Overview</Link>
    <Link href="/servers" onClick={onNavigate} className="nav-item" aria-current={pathname === "/servers" ? "page" : undefined}><Server />Servers</Link>
    {can.offsite && <Link href="/backups" onClick={onNavigate} className="nav-item" aria-current={pathname === "/backups" ? "page" : undefined}><Archive />Backups</Link>}
    <Link href="/settings" onClick={onNavigate} className="nav-item" aria-current={pathname.startsWith("/settings") ? "page" : undefined}><Settings2 />Settings</Link>
    {servers.length > 0 && <div className="mt-4 border-t border-sidebar-border pt-4">
      <p className="mb-1 px-3 text-xs font-medium text-muted-foreground">My Servers</p>
      {servers.map((server) => <Link key={server.id} href={serverHref(server.id)} onClick={onNavigate} className="nav-item" aria-current={serverId === server.id ? "page" : undefined}>
        <span className="relative shrink-0" aria-hidden>
          <ServerIconImage server={server} className="size-6" />
          <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar", statusDot(server.status, Boolean(server.operation)))} />
        </span>
        <span className="min-w-0 flex-1 truncate">{server.name}</span>
        <span className="sr-only">({server.operation ? server.operation.label : server.status})</span>
      </Link>)}
    </div>}
  </nav>;
}

/** Your name and role, linking to your account page. */
export function RoleBadge({ role, recovery = false, className }: { role: keyof typeof ROLE_LABELS; recovery?: boolean; className?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide", recovery ? "border-warning/40 bg-warning-soft text-warning" : role === "admin" ? "border-primary/30 bg-primary/10 text-foreground" : "border-border bg-muted text-muted-foreground", className)}>{recovery ? "Recovery" : ROLE_LABELS[role]}</span>;
}

const subscribeNever = () => () => undefined;
const THEMES = [{ value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }, { value: "system", label: "System", icon: Monitor }] as const;

/** Light, dark, or follow the device, one click from anywhere. Also in Settings > Your account. */
type CloudSummary = { enabled: boolean; linked?: boolean; lastError?: string; names?: { fqdn: string; published: boolean }[] };

/** Blocky Cloud's way in: a free address when not linked, the server's address or a problem once it is. Admins only. */
function CloudButton({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = usePanel();
  const pathname = usePathname();
  const [cloud, setCloud] = useState<CloudSummary | null>(null);
  // Re-read on navigation, so linking or unlinking in Settings shows here straight away.
  useEffect(() => { if (can.cloud) void api<CloudSummary>("/api/cloud").then(setCloud).catch(() => undefined); }, [can.cloud, pathname]);
  if (!can.cloud || !cloud?.enabled) return null;
  const published = (cloud.names ?? []).filter((name) => name.published).map((name) => name.fqdn);
  const detail = !cloud.linked ? "Get a free address" : cloud.lastError ? "Needs attention" : published[0] ?? "Linked";
  const active = pathname === "/settings/cloud";
  return <Link href="/settings/cloud" onClick={onNavigate} aria-current={active ? "page" : undefined}
    className={cn("mt-6 flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors hover:bg-accent", cloud.lastError ? "border-warning/40 bg-warning-soft" : "border-border bg-card", active && "border-primary/40")}>
    <CloudMark className="size-8 shrink-0" />
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-semibold">Blocky Cloud</span>
      <span title={detail} className={cn("block truncate text-xs", cloud.lastError ? "text-warning-soft-foreground" : "text-muted-foreground")}>{detail}</span>
    </span>
    {cloud.lastError ? <CircleAlert className="size-4 shrink-0 text-warning" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
  </Link>;
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  // The saved theme is only known in the browser; until hydration, nothing is marked as chosen.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  return <div className="mb-2 grid grid-cols-3 gap-1 rounded-[10px] bg-muted p-1" role="radiogroup" aria-label="Theme">
    {THEMES.map((item) => <button key={item.value} type="button" role="radio" aria-checked={mounted && theme === item.value} title={item.label} onClick={() => setTheme(item.value)}
      className={cn("flex min-h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground", mounted && theme === item.value && "bg-card text-foreground shadow-card")}>
      <item.icon className="size-3.5" aria-hidden />{item.label}
    </button>)}
  </div>;
}

/** You, in the sidebar: your account, sign out, and which build is running. */
function AccountMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { me, system } = usePanel();
  const router = useRouter();
  if (!me) return null;
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", headers: { [CSRF_HEADER]: "1" } });
    router.push("/login"); router.refresh();
  }
  const panel = system?.panel;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-sidebar-accent/60">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold uppercase text-muted-foreground" aria-hidden>{me.recovery ? <LifeBuoy className="size-4" /> : me.username.charAt(0)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{me.recovery ? "Recovery sign-in" : me.username}</span>
          <span className="block truncate text-xs text-muted-foreground">{me.recovery ? "Ends within an hour" : ROLE_LABELS[me.role]}</span>
        </span>
        <ChevronsUpDown className="size-4 text-muted-foreground" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
      <DropdownMenuItem asChild><Link href={me.recovery ? "/settings/users" : "/settings"} onClick={onNavigate}>{me.recovery ? <LifeBuoy /> : <UserRound />}{me.recovery ? "Users" : "Your account"}</Link></DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void logout()}><LogOut />Sign out</DropdownMenuItem>
      {panel && <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          Blocky Panel {panel.version} beta · {panel.commit
            ? <a href={`https://github.com/teamdebris/blockypanel-app/commit/${panel.commit}`} target="_blank" rel="noreferrer" className="font-mono hover:text-foreground hover:underline" title="The commit this panel was built from">{panel.commit}</a>
            : <span title="Built from source, not from a published image">local build</span>}
          {system?.dockerVersion && <span className="block">Docker Engine {system.dockerVersion}</span>}
        </DropdownMenuLabel>
      </>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function ConnectionStatus({ className }: { className?: string }) {
  const { lastUpdatedAt, failures, refreshing, refresh, system } = usePanel();
  const now = useNow(1000);
  const offline = failures >= 2;
  return <div className={cn("flex items-center gap-2", className)}>
    <span className={cn("hidden items-center gap-1.5 text-xs sm:flex", offline ? "text-warning" : "text-muted-foreground")}>
      {offline ? <><WifiOff className="size-3.5" />Can&apos;t reach the panel, retrying…</> : lastUpdatedAt ? <>Updated {formatRelative(lastUpdatedAt, now)}</> : "Loading…"}
      {system?.dockerAvailable === false && !offline && <span className="text-destructive">· Docker offline</span>}
    </span>
    <Button aria-label="Refresh now" variant="outline" size="icon-sm" className="bg-transparent" onClick={() => void refresh()} disabled={refreshing}><RefreshCcw className={cn("size-4", refreshing && "animate-spin")} /></Button>
  </div>;
}

function OperationsBadge() {
  const { servers } = usePanel();
  const running = servers.filter((server) => server.operation);
  if (!running.length) return null;
  return <Link href={serverHref(running[0].id)} className="hidden items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning sm:inline-flex">
    <LoaderCircle className="size-3.5 animate-spin" />{running.length === 1 ? `${running[0].operation!.label} · ${running[0].name}` : `${running.length} operations running`}
  </Link>;
}

function Breadcrumbs() {
  const { servers } = usePanel();
  const { pathname, serverId, serverTab } = useRouteInfo();
  const server = servers.find((item) => item.id === serverId);
  const crumbs: { href: string; label: string }[] = [{ href: "/", label: "Overview" }];
  if (pathname.startsWith("/servers")) crumbs.push({ href: "/servers", label: "Servers" });
  if (pathname === "/backups") crumbs.push({ href: "/backups", label: "Backups" });
  if (pathname.startsWith("/settings")) crumbs.push({ href: "/settings", label: "Settings" });
  if (pathname === "/settings/users") crumbs.push({ href: "/settings/users", label: "Users" });
  if (pathname === "/settings/cloud") crumbs.push({ href: "/settings/cloud", label: "Blocky Cloud" });
  if (serverId) crumbs.push({ href: serverHref(serverId), label: server?.name || "Server" });
  if (serverId && serverTab && serverTab !== "overview") crumbs.push({ href: serverHref(serverId, serverTab), label: serverTabLabel(server, serverTab) });
  return <nav aria-label="Breadcrumb" className="hidden min-w-0 lg:block">
    <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return <li key={crumb.href} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && <ChevronRight className="size-4 shrink-0" aria-hidden />}
          {last ? <span aria-current="page" className="truncate text-foreground">{crumb.label}</span> : <Link href={crumb.href} className="truncate hover:text-foreground">{crumb.label}</Link>}
        </li>;
      })}
    </ol>
  </nav>;
}

function MobileHeaderStart() {
  const { servers } = usePanel();
  const { serverId, serverTab } = useRouteInfo();
  if (!serverId) return <Brand compact />;
  const server = servers.find((item) => item.id === serverId);
  // On a sub-tab, back goes to the server's overview; on the overview, back to the list.
  const back = serverTab && serverTab !== "overview" ? { href: serverHref(serverId), label: server?.name || "Server" } : { href: "/servers", label: "Servers" };
  return <Link href={back.href} className="flex min-h-10 min-w-0 items-center gap-1 rounded-md pr-2 text-sm font-medium text-foreground"><ChevronLeft className="size-5 shrink-0" /><span className="truncate">{back.label}</span></Link>;
}

export function PanelShell({ children }: { children: React.ReactNode }) {
  const { system, failures, loaded, setCreateOpen, setPaletteOpen, can, me } = usePanel();
  const { pathname, serverId } = useRouteInfo();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobile = useIsMobile();
  const dockerDown = system?.dockerAvailable === false;
  const offline = failures >= 2;
  const canCreate = can.manage && (pathname === "/" || pathname === "/servers");

  // Move focus to the new page's heading after client-side navigation, for keyboard and screen-reader users.
  useEffect(() => {
    const timer = window.setTimeout(() => document.getElementById("page-title")?.focus({ preventScroll: true }), 50);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  // Ctrl/Cmd+K opens the command palette.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen]);

  return <div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
    <a href="#main" className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
    {/* Toasts sit under the header so they never cover sticky action bars at the bottom. */}
    <Toaster position={mobile ? "top-center" : "top-right"} offset={{ top: 72, right: 24 }} mobileOffset={{ top: 64 }} richColors closeButton />
    <CommandPalette />
    {can.manage && <CreateServerDialog />}
    <div className="grid min-h-screen lg:grid-cols-[256px_1fr]">
      <aside className="hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex lg:flex-col">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto p-4">
          <Brand />
          <button type="button" onClick={() => setPaletteOpen(true)} className="mt-5 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent">
            <Search className="size-4" /><span className="flex-1 text-left">Search…</span><kbd className="rounded border border-border px-1.5 text-[10px]">Ctrl K</kbd>
          </button>
          <div className="mt-5 flex-1"><Navigation /></div>
          <CloudButton />
          <div className="mt-4 border-t border-border pt-4"><ThemeSwitch /><AccountMenu /></div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/90 px-3 backdrop-blur-xl sm:px-6 lg:h-16 lg:px-8">
          <div className="flex min-w-0 items-center gap-2 lg:hidden"><MobileHeaderStart /></div>
          <Breadcrumbs />
          <div className="flex shrink-0 items-center gap-2">
            <OperationsBadge />
            <ConnectionStatus />
            <Button aria-label="Search" variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setPaletteOpen(true)}><Search /></Button>
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild><Button aria-label="Open menu" variant="ghost" size="icon-sm" className="lg:hidden"><Menu /></Button></SheetTrigger>
              <SheetContent side="right" className="w-[86vw] max-w-sm overflow-y-auto bg-card p-4">
                <SheetHeader className="p-0"><SheetTitle className="sr-only">Menu</SheetTitle><SheetDescription className="sr-only">Navigation and preferences</SheetDescription><Brand /></SheetHeader>
                {canCreate && <Button className="mt-3 w-full" onClick={() => { setMenuOpen(false); setCreateOpen(true); }} disabled={dockerDown}><Plus />New server</Button>}
                <div className="mt-4"><Navigation onNavigate={() => setMenuOpen(false)} /></div>
                <CloudButton onNavigate={() => setMenuOpen(false)} />
                <div className="mt-4 border-t border-border pt-4"><ThemeSwitch /><AccountMenu onNavigate={() => setMenuOpen(false)} /></div>
              </SheetContent>
            </Sheet>
          </div>
        </header>

        {me?.demo && <div role="note" className="border-b border-border bg-muted/60 px-4 py-2 text-center text-xs text-muted-foreground sm:px-8"><span className="font-medium text-foreground">Demo.</span> The servers here are simulated and nothing runs; changes reset when the demo restarts.</div>}
        {offline && <div role="status" className="flex items-start gap-3 border-b border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning sm:px-8"><WifiOff className="mt-0.5 size-4 shrink-0" /><p><span className="font-semibold">Can&apos;t reach the panel.</span> Showing the last known state; it will update when the connection returns.</p></div>}
        {dockerDown && !offline && <div role="alert" className="flex items-start gap-3 border-b border-destructive/30 bg-danger-soft px-4 py-3 text-sm text-destructive sm:px-8"><CircleAlert className="mt-0.5 size-4 shrink-0" /><div><p className="font-semibold">Docker is not connected</p><p className="mt-0.5">{system?.error || "Start Docker or give the panel access to its socket."} Servers can&apos;t be started or created until it&apos;s back.</p></div></div>}

        <main id="main" className={cn("mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8", serverId && "pb-24 lg:pb-8", offline && loaded && "opacity-75")}>{children}</main>
      </div>
    </div>
  </div>;
}
