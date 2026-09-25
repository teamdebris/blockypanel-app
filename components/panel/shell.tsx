"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Activity, Bell, BellOff, Box, ChevronLeft, ChevronRight, CircleAlert, CloudUpload, LifeBuoy, LoaderCircle, LogOut, Menu, Monitor, Moon, Plus, RefreshCcw, Search, Server, Sun, UserRound, Users, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { CSRF_HEADER } from "@/lib/csrf";
import { ROLE_LABELS } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { CreateServerDialog } from "./create-dialog";
import { formatRelative, serverHref, serverTabLabel } from "./lib";
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
    <span className="grid size-9 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-lg shadow-primary/10"><Box className="size-5" strokeWidth={2.3} /></span>
    {!compact && <span><span className="font-display block text-[1.05rem] font-bold tracking-[-.02em]">Blocky</span><span className="block text-xs text-muted-foreground">Minecraft server control</span></span>}
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
    <Link href="/" onClick={onNavigate} className="nav-item" aria-current={pathname === "/" ? "page" : undefined}><Activity />Overview</Link>
    <Link href="/servers" onClick={onNavigate} className="nav-item" aria-current={pathname === "/servers" ? "page" : undefined}><Server />All servers</Link>
    {can.offsite && <Link href="/backups" onClick={onNavigate} className="nav-item" aria-current={pathname === "/backups" ? "page" : undefined}><CloudUpload />Offsite backups</Link>}
    {can.users && <Link href="/users" onClick={onNavigate} className="nav-item" aria-current={pathname === "/users" ? "page" : undefined}><Users />Users</Link>}
    {servers.length > 0 && <div className="pt-4">
      <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[.12em] text-muted-foreground">Servers</p>
      {servers.map((server) => <Link key={server.id} href={serverHref(server.id)} onClick={onNavigate} className="nav-item" aria-current={serverId === server.id ? "page" : undefined}>
        <span className={cn("size-2 shrink-0 rounded-full", statusDot(server.status, Boolean(server.operation)))} aria-hidden />
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

function AccountLink({ onNavigate }: { onNavigate?: () => void }) {
  const { me } = usePanel();
  const pathname = usePathname();
  if (!me) return null;
  if (me.recovery) return <Link href="/users" onClick={onNavigate} className="nav-item"><LifeBuoy /><span className="min-w-0 flex-1 truncate">Recovery sign-in</span><RoleBadge role="admin" recovery /></Link>;
  return <Link href="/account" onClick={onNavigate} className="nav-item" aria-current={pathname === "/account" ? "page" : undefined}>
    <UserRound /><span className="min-w-0 flex-1 truncate">{me.username}</span><RoleBadge role={me.role} />
  </Link>;
}

function Preferences({ onNavigate }: { onNavigate?: () => void }) {
  const { theme, setTheme } = useTheme();
  const { notificationsEnabled, setNotificationsEnabled } = usePanel();
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", headers: { [CSRF_HEADER]: "1" } });
    router.push("/login"); router.refresh();
  }
  const themes = [{ value: "light", icon: Sun, label: "Light" }, { value: "dark", icon: Moon, label: "Dark" }, { value: "system", icon: Monitor, label: "System" }];
  return <div className="space-y-3">
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Theme</p>
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-border p-1" role="radiogroup" aria-label="Theme">
        {themes.map((item) => <button key={item.value} type="button" role="radio" aria-checked={theme === item.value} onClick={() => setTheme(item.value)} className={cn("flex min-h-8 items-center justify-center gap-1.5 rounded-md text-xs", theme === item.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}><item.icon className="size-3.5" />{item.label}</button>)}
      </div>
    </div>
    <button type="button" onClick={() => void setNotificationsEnabled(!notificationsEnabled)} className="nav-item" aria-pressed={notificationsEnabled}>
      {notificationsEnabled ? <Bell /> : <BellOff />}{notificationsEnabled ? "Browser alerts on" : "Browser alerts off"}
    </button>
    <AccountLink onNavigate={onNavigate} />
    <button type="button" onClick={() => void logout()} className="nav-item"><LogOut />Sign out</button>
  </div>;
}

/** "Blocky Panel 0.1.0 · a1b2c3d", so it's clear which build is running. */
function PanelVersion() {
  const { system } = usePanel();
  if (!system?.panel) return null;
  const { version, commit } = system.panel;
  return <p className="px-3 text-[11px] text-muted-foreground">
    Blocky Panel {version} · {commit
      ? <a href={`https://github.com/teamdebris/blockypanel-app/commit/${commit}`} target="_blank" rel="noreferrer" className="font-mono hover:text-foreground hover:underline" title="The commit this panel was built from">{commit}</a>
      : <span title="Built from source, not from a published image">local build</span>}
  </p>;
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
  if (pathname === "/users") crumbs.push({ href: "/users", label: "Users" });
  if (pathname === "/backups") crumbs.push({ href: "/backups", label: "Offsite backups" });
  if (pathname === "/account") crumbs.push({ href: "/account", label: "Your account" });
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
      <aside className="hidden border-r border-border bg-card lg:flex lg:flex-col">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto p-4">
          <Brand />
          <button type="button" onClick={() => setPaletteOpen(true)} className="mt-5 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent">
            <Search className="size-4" /><span className="flex-1 text-left">Search…</span><kbd className="rounded border border-border px-1.5 text-[10px]">Ctrl K</kbd>
          </button>
          <div className="mt-5 flex-1"><Navigation /></div>
          <div className="mt-6 space-y-4 border-t border-border pt-4">
            <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Docker</span>
              <span className={cn("flex items-center gap-1.5 font-medium", dockerDown ? "text-destructive" : "text-foreground")}><span className={cn("size-2 rounded-full", dockerDown ? "bg-destructive" : "bg-success")} />{dockerDown ? "Offline" : system?.dockerVersion ? `Engine ${system.dockerVersion}` : "Connecting…"}</span>
            </div>
            <Preferences />
            <PanelVersion />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/90 px-3 backdrop-blur-xl sm:px-6 lg:h-16 lg:px-8">
          <div className="flex min-w-0 items-center gap-2 lg:hidden"><MobileHeaderStart /></div>
          <Breadcrumbs />
          <div className="flex shrink-0 items-center gap-2">
            <OperationsBadge />
            <ConnectionStatus />
            {!serverId && can.manage && <Button className="hidden sm:inline-flex" onClick={() => setCreateOpen(true)} disabled={dockerDown}><Plus />New server</Button>}
            <Button aria-label="Search" variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setPaletteOpen(true)}><Search /></Button>
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild><Button aria-label="Open menu" variant="ghost" size="icon-sm" className="lg:hidden"><Menu /></Button></SheetTrigger>
              <SheetContent side="right" className="w-[86vw] max-w-sm overflow-y-auto bg-card p-4">
                <SheetHeader className="p-0"><SheetTitle className="sr-only">Menu</SheetTitle><SheetDescription className="sr-only">Navigation and preferences</SheetDescription><Brand /></SheetHeader>
                {!serverId && can.manage && <Button className="mt-3 w-full" onClick={() => { setMenuOpen(false); setCreateOpen(true); }} disabled={dockerDown}><Plus />New server</Button>}
                <div className="mt-4"><Navigation onNavigate={() => setMenuOpen(false)} /></div>
                <div className="mt-6 space-y-4 border-t border-border pt-4"><Preferences onNavigate={() => setMenuOpen(false)} /><PanelVersion /></div>
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
