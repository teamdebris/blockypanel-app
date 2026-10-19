import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ChevronRight, CircleCheck, CirclePlay, Copy, Cpu, FolderOpen, Gauge, HardDrive, House, LoaderCircle, MemoryStick,
  Monitor, Moon, Play, Plus, RotateCcw, Send, Server as ServerIcon, Settings2, Square, SquareTerminal, Sun, Trash2, TriangleAlert, Undo2, Users, X,
} from "lucide-react";
import { api, type Backup, formatBytes, formatRelative, ICONS, type Line, MEMORY_OPTIONS, type Server, type State, uptime } from "./api";

const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/* ---------- Routing: #/ and #/servers/<id>/<tab> ---------- */
type Route = { page: "overview" } | { page: "server"; id: string; tab: "overview" | "console" | "backups" | "settings" };
function parseRoute(): Route {
  const [, section, id, tab] = window.location.hash.replace(/^#/, "").split("/");
  if (section === "servers" && id) return { page: "server", id, tab: (["console", "backups", "settings"].includes(tab) ? tab : "overview") as "overview" };
  return { page: "overview" };
}
function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => { const on = () => setRoute(parseRoute()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  return route;
}
const href = (id: string, tab = "overview") => `#/servers/${id}${tab === "overview" ? "" : `/${tab}`}`;

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; tone: "ok" | "error" };
let pushToast: (text: string, tone?: Toast["tone"]) => void = () => undefined;
function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (text, tone = "ok") => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { id, text, tone }]);
      setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), 4500);
    };
  }, []);
  return <div className="fixed right-6 top-6 z-50 grid w-80 gap-2" role="status" aria-live="polite">
    {toasts.map((toast) => <div key={toast.id} className={cn("rounded-xl border px-4 py-3 text-sm shadow-card", toast.tone === "error" ? "border-destructive/30 bg-danger-soft text-danger-soft-foreground" : "border-border bg-card")}>{toast.text}</div>)}
  </div>;
}
const run = async (work: () => Promise<unknown>, success?: string) => {
  try { await work(); if (success) pushToast(success); }
  catch (error) { pushToast(error instanceof Error ? error.message : "Something went wrong.", "error"); }
};

/* ---------- Shared pieces ---------- */
function BlockyMark({ className }: { className?: string }) {
  return <>
    <img src="/brand/blocky-panel-mark-light.svg" alt="" aria-hidden className={cn(className, "dark:hidden")} />
    <img src="/brand/blocky-panel-mark-dark.svg" alt="" aria-hidden className={cn(className, "hidden dark:block")} />
  </>;
}
function BlockArt({ name, className }: { name: string; className?: string }) {
  return <img src={`/blocks/${name}.svg`} alt="" aria-hidden draggable={false} className={cn("shrink-0 select-none", name === "enderman" || name === "chest-ender" || name === "obsidian" ? "dark:drop-shadow-[0_0_1.5px_rgba(255,255,255,0.45)]" : "", className)} />;
}

const STATUS: Record<Server["status"], { label: string; tone: string; dot: string }> = {
  running: { label: "Running", tone: "border-success/30 bg-success-soft text-success-soft-foreground", dot: "bg-success" },
  starting: { label: "Starting", tone: "border-warning/30 bg-warning-soft text-warning-soft-foreground", dot: "bg-warning animate-pulse" },
  installing: { label: "Installing", tone: "border-warning/30 bg-warning-soft text-warning-soft-foreground", dot: "bg-warning animate-pulse" },
  stopping: { label: "Stopping", tone: "border-warning/30 bg-warning-soft text-warning-soft-foreground", dot: "bg-warning animate-pulse" },
  stopped: { label: "Stopped", tone: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  crashed: { label: "Crashed", tone: "border-destructive/30 bg-danger-soft text-danger-soft-foreground", dot: "bg-destructive" },
};
function StatusPill({ server }: { server: Server }) {
  const status = STATUS[server.status];
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", status.tone)}>
    {server.status === "running" ? <CircleCheck className="size-3.5" /> : ["starting", "installing", "stopping"].includes(server.status) ? <LoaderCircle className="size-3.5 animate-spin" /> : server.status === "crashed" ? <TriangleAlert className="size-3.5" /> : <Square className="size-3" />}
    {status.label}
  </span>;
}
function CopyAddress({ address }: { address: string }) {
  return <button type="button" onClick={() => void navigator.clipboard.writeText(address).then(() => pushToast(`Copied ${address}`))} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1 font-mono text-xs font-semibold hover:bg-muted" title="Copy the address players join with">
    {address}<Copy className="size-3.5 text-muted-foreground" />
  </button>;
}
function Section({ title, description, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-xl border border-border bg-card shadow-card", className)}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3.5">
      <div className="min-w-0"><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    <div className="p-5">{children}</div>
  </section>;
}
function PowerButtons({ server, compact }: { server: Server; compact?: boolean }) {
  const active = ["installing", "starting", "running", "stopping"].includes(server.status);
  const busy = ["installing", "starting", "stopping"].includes(server.status);
  const act = (action: string) => run(() => api(`/api/servers/${server.id}/${action}`, { method: "POST" }));
  return <div className="flex items-center gap-2">
    {!active && <button className={cn("btn btn-start", compact && "btn-sm")} onClick={() => void act("start")}><Play />Start</button>}
    {active && <button className={cn("btn btn-stop", compact && "btn-sm")} disabled={server.status === "stopping"} onClick={() => void act("stop")}><Square />Stop</button>}
    {active && !compact && <button className="btn btn-restart" disabled={busy} onClick={() => void act("restart")}><RotateCcw />Restart</button>}
  </div>;
}

/* ---------- Theme ---------- */
type Theme = "light" | "dark" | "system";
function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem("blocky-theme") as Theme) || "system"; } catch { return "system"; } });
  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
    apply();
    try { localStorage.setItem("blocky-theme", theme); } catch { /* private mode */ }
    const query = matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme];
}
function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const options: [Theme, typeof Sun, string][] = [["light", Sun, "Light"], ["dark", Moon, "Dark"], ["system", Monitor, "System"]];
  return <div className="grid grid-cols-3 rounded-xl border border-border bg-muted/60 p-1" role="radiogroup" aria-label="Theme">
    {options.map(([value, Icon, label]) => <button key={value} role="radio" aria-checked={theme === value} onClick={() => setTheme(value)} className={cn("flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium", theme === value ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground")}><Icon className="size-3.5" />{label}</button>)}
  </div>;
}

/* ---------- Shell ---------- */
function Shell({ state, route, onCreate, children }: { state: State | null; route: Route; onCreate: () => void; children: React.ReactNode }) {
  const statusDot = (server: Server) => STATUS[server.status].dot;
  return <div className="grid min-h-screen grid-cols-[256px_1fr]">
    <aside className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="sticky top-0 flex h-screen flex-col overflow-y-auto p-4">
        <a href="#/" className="flex items-center gap-2.5 px-1.5 py-1">
          <BlockyMark className="size-9" />
          <span className="text-xl font-extrabold tracking-[-.03em]">Blocky</span>
          <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-semibold tracking-wide text-muted-foreground">WINDOWS</span>
        </a>
        <button className="btn btn-primary mt-5 w-full" onClick={onCreate}><Plus />New server</button>
        <nav className="mt-5 flex-1 space-y-1" aria-label="Primary">
          <a href="#/" className="nav-item" aria-current={route.page === "overview" ? "page" : undefined}><House />Overview</a>
          {state && state.servers.length > 0 && <div className="mt-4 border-t border-sidebar-border pt-4">
            <p className="mb-1 px-3 text-xs font-medium text-muted-foreground">My Servers</p>
            {state.servers.map((server) => <a key={server.id} href={href(server.id)} className="nav-item" aria-current={route.page === "server" && route.id === server.id ? "page" : undefined}>
              <span className="relative shrink-0" aria-hidden><BlockArt name={server.icon} className="size-6" /><span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar", statusDot(server))} /></span>
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
            </a>)}
          </div>}
        </nav>
        <div className="mt-6 border-t border-border pt-4"><ThemeSwitch /><p className="mt-3 px-1 text-[11px] text-muted-foreground">Blocky Panel {state?.version ?? ""} · runs on this PC</p></div>
      </div>
    </aside>
    <div className="min-w-0">
      <header className="sticky top-0 z-30 flex h-16 items-center border-b border-border bg-background/90 px-8 backdrop-blur-xl">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted-foreground">
          <a href="#/" className={cn("hover:text-foreground", route.page === "overview" && "text-foreground")}>Overview</a>
          {route.page === "server" && <><ChevronRight className="size-4" /><span className="text-foreground">{state?.servers.find((server) => server.id === route.id)?.name ?? "Server"}</span></>}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-8 py-8">{children}</main>
    </div>
  </div>;
}

/* ---------- Overview ---------- */
function Metric({ icon: Icon, label, value, tone }: { icon: typeof House; label: string; value: string; tone: string }) {
  return <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-card">
    <span className={cn("grid size-11 place-items-center rounded-xl", tone)}><Icon className="size-5" /></span>
    <div><p className="text-xl font-bold leading-tight">{value}</p><p className="text-sm text-muted-foreground">{label}</p></div>
  </div>;
}
function ServerCard({ server }: { server: Server }) {
  return <article className={cn("flex flex-col rounded-xl border bg-card shadow-card transition-colors", server.status === "crashed" ? "border-destructive/40" : "border-border hover:border-foreground/20")}>
    <div className="flex items-start justify-between gap-3 p-4 pb-3">
      <BlockArt name={server.icon} className="size-10" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-semibold"><a href={href(server.id)} className="hover:underline">{server.name}</a></h3>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{server.software === "paper" ? "Paper" : "Vanilla"} {server.version}</p>
      </div>
      <StatusPill server={server} />
    </div>
    <div className="space-y-2 px-4 pb-3">
      <CopyAddress address={server.address} />
      {server.status === "installing" && <p className="flex items-center gap-1.5 text-xs text-warning"><LoaderCircle className="size-3.5 animate-spin" />{server.step}{server.progress !== undefined ? ` · ${Math.round(server.progress * 100)}%` : ""}</p>}
    </div>
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Users className="size-4" /><span><span className="font-medium text-foreground">{server.players.length}</span> / {server.maxPlayers}</span></span>
      <PowerButtons server={server} compact />
    </div>
  </article>;
}
function OverviewPage({ state, onCreate }: { state: State; onCreate: () => void }) {
  const running = state.servers.filter((server) => server.status === "running").length;
  const players = state.servers.reduce((sum, server) => sum + server.players.length, 0);
  return <>
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-3xl font-bold tracking-[-.035em]">Overview</h1><p className="mt-1 text-sm text-muted-foreground">Minecraft servers running on this PC</p></div>
      <button className="btn btn-primary" onClick={onCreate}><Plus />Create server</button>
    </div>
    <div className="grid gap-4 sm:grid-cols-3">
      <Metric icon={ServerIcon} label={state.servers.length === 1 ? "Server" : "Servers"} value={String(state.servers.length)} tone="bg-muted text-muted-foreground" />
      <Metric icon={CirclePlay} label="Running" value={String(running)} tone="bg-success-soft text-success" />
      <Metric icon={Users} label={players === 1 ? "Player online" : "Players online"} value={String(players)} tone="bg-info-soft text-info" />
    </div>
    <section className="mt-8">
      <h2 className="mb-3 text-lg font-semibold">Servers</h2>
      {state.servers.length
        ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{state.servers.map((server) => <ServerCard key={server.id} server={server} />)}</div>
        : <div className="empty-grid grid min-h-72 place-items-center rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
          <div>
            <BlockArt name="grass" className="mx-auto size-16" />
            <h3 className="mt-4 text-lg font-semibold">No servers yet</h3>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">Create a Paper or Vanilla server. Blocky downloads Java and the server for you; nothing else to install.</p>
            <button className="btn btn-primary mt-4" onClick={onCreate}><Plus />Create your first server</button>
          </div>
        </div>}
    </section>
  </>;
}

/* ---------- Server page ---------- */
function ServerOverview({ server }: { server: Server }) {
  const memory = server.memoryUsedMb ? `${(server.memoryUsedMb / 1024).toFixed(1)} GB / ${server.memoryMb / 1024} GB` : `${server.memoryMb / 1024} GB limit`;
  return <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {[[MemoryStick, "Memory", memory], [Users, "Players", `${server.players.length} / ${server.maxPlayers}`], [Gauge, "Uptime", server.startedAt && server.status === "running" ? uptime(server.startedAt) : "Not running"]].map(([Icon, label, value]) => {
          const I = Icon as typeof Cpu;
          return <div key={label as string} className="rounded-xl border border-border bg-card p-4 shadow-card"><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><I className="size-4" />{label as string}</p><p className="mt-2 font-semibold">{value as string}</p></div>;
        })}
      </div>
      {server.status === "crashed" && server.lastError && <p className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-danger-soft-foreground"><TriangleAlert className="mt-0.5 size-4 shrink-0" />The server stopped unexpectedly: {server.lastError}. The console shows what happened.</p>}
      <Section title="Details">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          {[["Software", `${server.software === "paper" ? "Paper" : "Vanilla"} ${server.version}`], ["Players join with", server.address], ["Difficulty", server.difficulty[0].toUpperCase() + server.difficulty.slice(1)], ["Created", new Date(server.createdAt).toLocaleString()], ["Message of the day", server.motd], ["Server ID", server.id]].map(([label, value]) =>
            <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className={cn("mt-0.5", label === "Server ID" && "font-mono text-xs")}>{value}</dd></div>)}
        </dl>
        <p className="mt-5 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">Players on your network join at {server.address}; on this PC, localhost:{server.port} works too. Friends outside your home need port {server.port} forwarded on your router to this PC, and Windows may ask to let Java through the firewall the first time.</p>
      </Section>
    </div>
    <Section title="Online now" description={`${server.players.length} of ${server.maxPlayers} slots in use`}>
      {server.players.length ? <ul className="divide-y divide-border">{server.players.map((name) => <li key={name} className="flex items-center gap-3 py-2 text-sm font-medium"><span className="grid size-7 place-items-center rounded bg-muted text-xs font-bold text-muted-foreground">{name[0]}</span>{name}</li>)}</ul>
        : <p className="text-sm text-muted-foreground">{server.status === "running" ? "Nobody's on right now." : "Start the server to see who's playing."}</p>}
    </Section>
  </div>;
}

function ConsoleTab({ server }: { server: Server }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    setLines([]);
    const source = new EventSource(`/api/servers/${server.id}/console`);
    source.onmessage = (event) => setLines((list) => [...list.slice(-999), JSON.parse(event.data) as Line]);
    return () => source.close();
  }, [server.id]);
  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);
  const canSend = ["starting", "running"].includes(server.status);
  const send = () => {
    const text = command.trim();
    if (!text) return;
    setHistory((list) => [text, ...list.filter((item) => item !== text)].slice(0, 50));
    setCursor(-1);
    setCommand("");
    void run(() => api(`/api/servers/${server.id}/command`, { method: "POST", body: { command: text } }));
  };
  const kind = (line: Line) => line.kind === "command" ? "log-command" : line.kind === "panel" ? "log-panel" : /\bWARN\b/.test(line.text) ? "log-warn" : /\b(ERROR|SEVERE|FATAL)\b|Exception/.test(line.text) ? "log-error" : "";
  return <div className="space-y-3">
    <div ref={box} onScroll={(event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
      className="console h-[460px] overflow-y-auto rounded-xl border border-[var(--console-border)] p-4 text-[13px] leading-6" role="log" aria-label="Server console">
      {lines.length ? lines.map((line, index) => <div key={index} className={cn("whitespace-pre-wrap break-words", kind(line))}>{line.text}</div>)
        : <p className="text-[var(--console-muted)]">{server.status === "stopped" ? "The server is stopped. Start it to see its console here." : "Waiting for output…"}</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      {["list", "save-all", "time set day", "weather clear", "say "].map((quick) => <button key={quick} disabled={!canSend} onClick={() => quick.endsWith(" ") ? setCommand(quick) : void run(() => api(`/api/servers/${server.id}/command`, { method: "POST", body: { command: quick } }))} className="rounded-full border border-border px-3 py-1 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">{quick.trim()}{quick.endsWith(" ") ? "…" : ""}</button>)}
    </div>
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="relative flex-1">
        <SquareTerminal className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input className="input pl-9 font-mono" value={command} disabled={!canSend} placeholder={canSend ? "Type a command…" : "Start the server to send commands"} aria-label="Console command"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" && history.length) { event.preventDefault(); const next = Math.min(cursor + 1, history.length - 1); setCursor(next); setCommand(history[next]); }
            if (event.key === "ArrowDown") { event.preventDefault(); const next = cursor - 1; setCursor(next); setCommand(next >= 0 ? history[next] : ""); }
          }} />
      </div>
      <button className="btn btn-primary" disabled={!canSend || !command.trim()}><Send />Send</button>
    </form>
    <p className="text-xs text-muted-foreground">Enter sends · ↑/↓ recall earlier commands · a leading / is optional</p>
  </div>;
}

function BackupsTab({ server }: { server: Server }) {
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: "restore" | "delete"; backup: Backup } | null>(null);
  const load = useCallback(() => api<{ backups: Backup[] }>(`/api/servers/${server.id}/backups`).then((data) => setBackups(data.backups)).catch(() => setBackups([])), [server.id]);
  useEffect(() => { void load(); }, [load]);
  const create = () => { setBusy(true); void run(() => api(`/api/servers/${server.id}/backups`, { method: "POST" }), "Backup created.").finally(() => { setBusy(false); void load(); }); };
  const active = ["installing", "starting", "running", "stopping"].includes(server.status);
  return <>
    <Section title={<span className="flex items-center gap-2"><BlockArt name="chest-storage" className="size-6" />Backups</span>} description="Each backup is a full copy of the world and settings, kept on this PC."
      actions={<button className="btn btn-primary btn-sm" disabled={busy} onClick={create}>{busy ? <LoaderCircle className="animate-spin" /> : <Archive />}Back up now</button>}>
      {backups === null ? <p className="text-sm text-muted-foreground">Loading…</p>
        : backups.length === 0 ? <div className="grid place-items-center rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground"><BlockArt name="chest-storage" className="mb-3 size-14" />No backups yet. Back up now to keep a copy of this world.</div>
          : <ul className="-mx-5 -my-5 divide-y divide-border">{backups.map((backup) => <li key={backup.name} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{new Date(backup.createdAt).toLocaleString()} <span className="ml-1 rounded-full border border-border px-2 py-px text-xs font-normal text-muted-foreground">{backup.kind === "safety" ? "Safety" : "Manual"}</span></p>
              <p className="mt-0.5 text-xs text-muted-foreground">{formatRelative(backup.createdAt)} · {formatBytes(backup.sizeBytes)}</p>
            </div>
            <button className="btn btn-outline btn-sm" disabled={active} title={active ? "Stop the server first" : undefined} onClick={() => setConfirm({ action: "restore", backup })}><Undo2 />Restore</button>
            <button className="btn btn-ghost btn-sm" aria-label="Delete backup" onClick={() => setConfirm({ action: "delete", backup })}><Trash2 /></button>
          </li>)}</ul>}
      {active && backups && backups.length > 0 && <p className="mt-6 text-xs text-muted-foreground">Stop the server to restore a backup.</p>}
    </Section>
    {confirm && <Dialog title={confirm.action === "restore" ? "Restore this backup?" : "Delete this backup?"} onClose={() => setConfirm(null)}
      footer={<><button className="btn btn-outline" onClick={() => setConfirm(null)}>Cancel</button>
        <button className={cn("btn", confirm.action === "delete" ? "btn-danger" : "btn-primary")} onClick={() => { const { action, backup } = confirm; setConfirm(null); void run(() => action === "restore" ? api(`/api/servers/${server.id}/backups/${backup.name}/restore`, { method: "POST" }) : api(`/api/servers/${server.id}/backups/${backup.name}`, { method: "DELETE" }), action === "restore" ? "Backup restored." : "Backup deleted.").then(load); }}>
          {confirm.action === "restore" ? "Restore" : "Delete"}</button></>}>
      <p className="text-sm text-muted-foreground">{confirm.action === "restore" ? `The world goes back to ${new Date(confirm.backup.createdAt).toLocaleString()}. A safety backup of the current world is made first, so you can undo this.` : "This copy is removed from this PC. It can't be undone."}</p>
    </Dialog>}
  </>;
}

function SettingsTab({ server, onDeleted }: { server: Server; onDeleted: () => void }) {
  const [form, setForm] = useState({ name: server.name, memoryMb: server.memoryMb, port: server.port, motd: server.motd, maxPlayers: server.maxPlayers, difficulty: server.difficulty, icon: server.icon });
  const [deleting, setDeleting] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify({ name: server.name, memoryMb: server.memoryMb, port: server.port, motd: server.motd, maxPlayers: server.maxPlayers, difficulty: server.difficulty, icon: server.icon });
  const set = (changes: Partial<typeof form>) => setForm((value) => ({ ...value, ...changes }));
  const save = () => run(async () => {
    const result = await api<{ restartNeeded?: boolean }>(`/api/servers/${server.id}`, { method: "PATCH", body: form });
    pushToast(result.restartNeeded ? "Saved. Restart the server to apply." : "Saved.");
  });
  const active = ["installing", "starting", "running", "stopping"].includes(server.status);
  return <div className="space-y-6">
    <Section title="General" actions={<button className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => void save()}>Save</button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={form.name} maxLength={40} onChange={(event) => set({ name: event.target.value })} /></Field>
        <Field label="Message of the day" hint="Shown in the Minecraft server list."><input className="input" value={form.motd} maxLength={120} onChange={(event) => set({ motd: event.target.value })} /></Field>
        <Field label="Memory"><select className="input" value={form.memoryMb} onChange={(event) => set({ memoryMb: Number(event.target.value) })}>{MEMORY_OPTIONS.map((mb) => <option key={mb} value={mb}>{mb / 1024} GB</option>)}</select></Field>
        <Field label="Port" hint="Players join on this port."><input className="input" type="number" min={1024} max={65535} value={form.port} onChange={(event) => set({ port: Number(event.target.value) })} /></Field>
        <Field label="Max players"><input className="input" type="number" min={1} max={500} value={form.maxPlayers} onChange={(event) => set({ maxPlayers: Number(event.target.value) })} /></Field>
        <Field label="Difficulty"><select className="input" value={form.difficulty} onChange={(event) => set({ difficulty: event.target.value as Server["difficulty"] })}>{["peaceful", "easy", "normal", "hard"].map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></Field>
      </div>
      <p className="mt-5 mb-2 text-xs font-medium text-muted-foreground">Icon</p>
      <div className="grid grid-cols-8 gap-2" role="radiogroup" aria-label="Icon">
        {ICONS.map((icon) => <button key={icon} role="radio" aria-checked={form.icon === icon} onClick={() => set({ icon })} className={cn("grid place-items-center rounded-xl border p-2 hover:bg-muted", form.icon === icon ? "border-primary bg-primary/10" : "border-border")} title={icon.replace("-", " ")}><BlockArt name={icon} className="size-9" /></button>)}
      </div>
    </Section>
    <Section title="Files" description="The server's folder: worlds, plugins, and server.properties.">
      <button className="btn btn-outline" onClick={() => void run(() => api(`/api/servers/${server.id}/open-folder`, { method: "POST" }))}><FolderOpen />Open folder</button>
    </Section>
    <Section title="Delete server" description="Removes the server, its world, and its backups from this PC.">
      <button className="btn btn-stop" disabled={active} title={active ? "Stop the server first" : undefined} onClick={() => setDeleting(true)}><Trash2 />Delete server</button>
    </Section>
    {deleting && <Dialog title={`Delete ${server.name}?`} onClose={() => setDeleting(false)}
      footer={<><button className="btn btn-outline" onClick={() => setDeleting(false)}>Cancel</button><button className="btn btn-danger" onClick={() => void run(() => api(`/api/servers/${server.id}`, { method: "DELETE" }), `${server.name} was deleted.`).then(onDeleted)}>Delete</button></>}>
      <p className="text-sm text-muted-foreground">The world, its settings, and every backup are removed from this PC. This can't be undone.</p>
    </Dialog>}
  </div>;
}

function ServerPage({ server, tab }: { server: Server; tab: "overview" | "console" | "backups" | "settings" }) {
  const tabs: [typeof tab, typeof House, string][] = [["overview", Gauge, "Overview"], ["console", SquareTerminal, "Console"], ["backups", Archive, "Backups"], ["settings", Settings2, "Settings"]];
  return <>
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-4">
        <BlockArt name={server.icon} className="size-14" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-3xl font-bold tracking-[-.035em]">{server.name}</h1><StatusPill server={server} /></div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><CopyAddress address={server.address} /><span>{server.software === "paper" ? "Paper" : "Vanilla"} {server.version} · {server.memoryMb / 1024} GB · {server.players.length}/{server.maxPlayers} players</span></div>
        </div>
      </div>
      <PowerButtons server={server} />
    </header>
    {server.status === "installing" && <div className="mb-4 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm text-warning-soft-foreground">
      <p className="flex items-center gap-2 font-medium"><LoaderCircle className="size-4 animate-spin" />{server.step}…</p>
      {server.progress !== undefined && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/60"><div className="h-full bg-warning transition-all" style={{ width: `${Math.round(server.progress * 100)}%` }} /></div>}
      <p className="mt-2 text-xs opacity-80">The first start downloads Java and the server software. Later starts skip this.</p>
    </div>}
    <nav className="server-tabs mb-6 border-b border-border" aria-label="Server sections">
      {tabs.map(([key, Icon, label]) => <a key={key} href={href(server.id, key)} className="server-tab" aria-current={tab === key ? "page" : undefined}><Icon className="size-4" />{label}</a>)}
    </nav>
    {tab === "overview" && <ServerOverview server={server} />}
    {tab === "console" && <ConsoleTab server={server} />}
    {tab === "backups" && <BackupsTab server={server} />}
    {tab === "settings" && <SettingsTab key={server.id} server={server} onDeleted={() => { window.location.hash = "#/"; }} />}
  </>;
}

/* ---------- Dialogs ---------- */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid content-start gap-1.5 text-sm font-medium">{label}{children}{hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}</label>;
}
function Dialog({ title, children, footer, onClose }: { title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void }) {
  useEffect(() => { const on = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on); }, [onClose]);
  return <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-2xl border border-border bg-popover p-6 shadow-2xl">
      <div className="mb-4 flex items-start justify-between gap-3"><h2 className="text-lg font-semibold">{title}</h2><button className="btn btn-ghost btn-sm -mr-2 -mt-1" aria-label="Close" onClick={onClose}><X /></button></div>
      {children}
      <div className="mt-6 flex justify-end gap-2">{footer}</div>
    </div>
  </div>;
}
function CreateDialog({ state, onClose }: { state: State; onClose: () => void }) {
  const nextPort = useMemo(() => { let port = 25565; while (state.servers.some((server) => server.port === port)) port += 1; return port; }, [state.servers]);
  const [form, setForm] = useState({ name: "", software: "paper" as "paper" | "vanilla", version: "", memoryMb: 4096, port: nextPort, eula: false });
  const [versions, setVersions] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setVersions(null);
    api<{ versions: string[] }>(`/api/versions?software=${form.software}`).then((data) => { setVersions(data.versions); setForm((value) => ({ ...value, version: data.versions.includes(value.version) ? value.version : data.versions[0] ?? "" })); })
      .catch((error) => { setVersions([]); pushToast(`Couldn't load versions: ${error.message}`, "error"); });
  }, [form.software]);
  const valid = form.name.trim().length >= 2 && form.version && form.eula;
  const create = () => { setSaving(true); void run(async () => { const server = await api<Server>("/api/servers", { method: "POST", body: form }); onClose(); window.location.hash = href(server.id); }).finally(() => setSaving(false)); };
  return <Dialog title="Create a server" onClose={onClose}
    footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid || saving} onClick={create}>{saving ? <LoaderCircle className="animate-spin" /> : <Plus />}Create server</button></>}>
    <div className="grid gap-4">
      <Field label="Name"><input className="input" autoFocus value={form.name} maxLength={40} placeholder="Survival with friends" onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <div className="grid gap-2">
        <span className="text-sm font-medium">Server software</span>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Server software">
          {([["paper", "Paper", "Faster, and runs plugins"], ["vanilla", "Vanilla", "The official Minecraft server"]] as const).map(([value, label, hint]) =>
            <button key={value} role="radio" aria-checked={form.software === value} onClick={() => setForm({ ...form, software: value })} className={cn("rounded-xl border p-3 text-left", form.software === value ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>
              <span className="block text-sm font-semibold">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span>
            </button>)}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Version"><select className="input" value={form.version} disabled={!versions?.length} onChange={(event) => setForm({ ...form, version: event.target.value })}>{versions === null ? <option>Loading…</option> : versions.map((version) => <option key={version}>{version}</option>)}</select></Field>
        <Field label="Memory"><select className="input" value={form.memoryMb} onChange={(event) => setForm({ ...form, memoryMb: Number(event.target.value) })}>{MEMORY_OPTIONS.map((mb) => <option key={mb} value={mb}>{mb / 1024} GB</option>)}</select></Field>
        <Field label="Port"><input className="input" type="number" min={1024} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></Field>
      </div>
      <label className="flex items-start gap-2.5 rounded-xl border border-border p-3 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={form.eula} onChange={(event) => setForm({ ...form, eula: event.target.checked })} />
        <span>I accept the <a className="font-medium underline" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>. Every Minecraft server has to.</span>
      </label>
    </div>
  </Dialog>;
}

/* ---------- App ---------- */
function App() {
  const route = useRoute();
  const [state, setState] = useState<State | null>(null);
  const [creating, setCreating] = useState(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = () => api<State>("/api/state").then((data) => { if (!stop) { setState(data); setOffline(false); } }).catch(() => { if (!stop) setOffline(true); });
    void tick();
    const timer = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(timer); };
  }, []);
  const server = route.page === "server" ? state?.servers.find((item) => item.id === route.id) : undefined;
  return <Shell state={state} route={route} onCreate={() => setCreating(true)}>
    {offline && <p className="mb-4 rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-danger-soft-foreground">Can't reach Blocky Panel. Is its window still open?</p>}
    {!state ? <p className="text-sm text-muted-foreground">Loading…</p>
      : route.page === "overview" ? <OverviewPage state={state} onCreate={() => setCreating(true)} />
        : server ? <ServerPage server={server} tab={route.tab} />
          : <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-border p-8 text-center"><div><BlockArt name="zombie" className="mx-auto mb-3 size-14" /><h1 className="text-xl font-semibold">Server not found</h1><a className="btn btn-primary mt-4" href="#/">Back to the overview</a></div></div>}
    {creating && state && <CreateDialog state={state} onClose={() => setCreating(false)} />}
    <Toasts />
  </Shell>;
}

createRoot(document.getElementById("root")!).render(<App />);
