"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, CornerDownLeft, FolderOpen, Gauge, History, Play, Plus, RotateCcw, Search, Server, Settings2, Square, TerminalSquare, UserRound, Users, Puzzle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { serverHref, serverTabLabel } from "./lib";
import { usePanel } from "./panel-context";

type Command = { id: string; label: string; hint?: string; icon: typeof Server; keywords: string; run: () => void };

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, servers, runAction, setCreateOpen, system, can } = usePanel();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => router.push(href);
    const list: Command[] = [
      { id: "overview", label: "Overview", icon: Gauge, keywords: "home dashboard", run: go("/") },
      { id: "servers", label: "All servers", icon: Server, keywords: "list", run: go("/servers") },
    ];
    if (can.users) list.push({ id: "users", label: "Users", icon: Users, keywords: "accounts invite people roles", run: go("/users") });
    list.push({ id: "account", label: "Your account", icon: UserRound, keywords: "password profile sessions sign out", run: go("/account") });
    if (can.manage && system?.dockerAvailable !== false) list.push({ id: "new", label: "New server", icon: Plus, keywords: "create add", run: () => setCreateOpen(true) });
    for (const server of servers) {
      const tabs = [
        { tab: "overview", label: "", icon: Server }, { tab: "console", label: "Console", icon: TerminalSquare }, { tab: "backups", label: "Backups", icon: Archive },
        { tab: "files", label: "Files", icon: FolderOpen }, { tab: "settings", label: "Settings", icon: Settings2 }, { tab: "activity", label: "Activity", icon: History },
      ] as const;
      for (const item of tabs) if ((item.tab !== "files" || can.files) && (item.tab !== "settings" || can.viewSettings)) list.push({ id: `${server.id}:${item.tab}`, label: item.label ? `${server.name}: ${item.label}` : server.name, hint: item.label ? undefined : "Open server", icon: item.icon, keywords: `${server.name} ${item.tab} go`, run: go(serverHref(server.id, item.tab)) });
      list.push({ id: `${server.id}:plugins`, label: `${server.name}: ${serverTabLabel(server, "plugins")}`, icon: Puzzle, keywords: `${server.name} plugins mods modrinth install`, run: go(serverHref(server.id, "plugins")) });
      if (server.operation || !can.control) continue;
      if (server.status === "running") {
        list.push({ id: `${server.id}:restart`, label: `Restart ${server.name}`, icon: RotateCcw, keywords: `${server.name} restart reboot`, run: () => void runAction(server, "restart") });
        list.push({ id: `${server.id}:stop`, label: `Stop ${server.name}`, hint: server.playersOnline ? `${server.playersOnline} online` : undefined, icon: Square, keywords: `${server.name} stop shutdown`, run: () => void runAction(server, "stop") });
      } else if (server.status !== "starting") {
        list.push({ id: `${server.id}:start`, label: `Start ${server.name}`, icon: Play, keywords: `${server.name} start boot`, run: () => void runAction(server, "start") });
      }
      list.push({ id: `${server.id}:backup`, label: `Back up ${server.name}`, icon: Archive, keywords: `${server.name} backup snapshot save`, run: () => void runAction(server, "backup") });
    }
    if (can.control && servers.length > 1) list.push({ id: "backup-all", label: "Back up all servers", icon: Archive, keywords: "backup all everything", run: () => { for (const server of servers) if (!server.operation) void runAction(server, "backup"); } });
    return list;
  }, [servers, router, runAction, setCreateOpen, system?.dockerAvailable, can]);

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return commands.filter((command) => !command.id.includes(":") || command.id.endsWith(":overview")).slice(0, 12);
    return commands.filter((command) => terms.every((term) => `${command.label} ${command.keywords}`.toLowerCase().includes(term))).slice(0, 20);
  }, [commands, query]);

  function close() { setPaletteOpen(false); setQuery(""); setActive(0); }
  function execute(command: Command | undefined) { if (!command) return; close(); command.run(); }

  return <Dialog open={paletteOpen} onOpenChange={(open) => open ? setPaletteOpen(true) : close()}>
    <DialogContent className="top-[15%] translate-y-0 gap-0 overflow-hidden border-border bg-popover p-0 text-foreground sm:max-w-lg" showCloseButton={false}>
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">Search servers and actions. Use the arrow keys to choose and Enter to run.</DialogDescription>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-muted-foreground" />
        <input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} placeholder="Jump to a server, or type an action…" aria-label="Search commands" role="combobox" aria-expanded aria-controls="palette-results" aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, results.length - 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
            if (event.key === "Enter") { event.preventDefault(); execute(results[active]); }
          }} />
      </div>
      <ul id="palette-results" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
        {results.length ? results.map((command, index) => <li key={command.id} id={`palette-${command.id}`} role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => execute(command)}
          className={cn("flex min-h-10 items-center gap-3 rounded-md px-2.5 text-sm", index === active ? "bg-accent text-foreground" : "text-muted-foreground")}>
          <command.icon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-foreground">{command.label}</span>
          {command.hint && <span className="text-xs">{command.hint}</span>}
          {index === active && <CornerDownLeft className="size-3.5" />}
        </li>) : <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</li>}
      </ul>
    </DialogContent>
  </Dialog>;
}
