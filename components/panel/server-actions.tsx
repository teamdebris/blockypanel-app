"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Copy, FolderOpen, MoreHorizontal, Play, RefreshCcw, RotateCcw, Settings2, Square, TerminalSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./common";
import { serverAddress, serverHref } from "./lib";
import { usePanel } from "./panel-context";
import type { MinecraftServer } from "./types";

type Pending = "stop" | "restart" | "update" | null;

function playersWarning(server: MinecraftServer) {
  if (!server.playersOnline) return "Nobody is online right now.";
  const who = server.players.length ? ` (${server.players.slice(0, 5).join(", ")}${server.players.length > 5 ? ", …" : ""})` : "";
  const warning = ` after a ${server.stopAnnounceDelaySeconds}s warning`;
  return `${server.playersOnline} player${server.playersOnline === 1 ? " is" : "s are"} online${who} and will be disconnected${warning}.`;
}

/** Confirmation dialogs for actions that disconnect players. */
function DowntimeConfirmations({ server, pending, setPending }: { server: MinecraftServer; pending: Pending; setPending: (value: Pending) => void }) {
  const { runAction } = usePanel();
  return <>
    <ConfirmDialog open={pending === "stop"} onOpenChange={(open) => !open && setPending(null)} title={`Stop ${server.name}?`} confirmLabel="Stop server" onConfirm={() => void runAction(server, "stop")}>
      <p>{playersWarning(server)}</p><p>The world is saved first. Start it again at any time.</p>
    </ConfirmDialog>
    <ConfirmDialog open={pending === "restart"} onOpenChange={(open) => !open && setPending(null)} title={`Restart ${server.name}?`} confirmLabel="Restart server" onConfirm={() => void runAction(server, "restart")}>
      <p>{playersWarning(server)}</p><p>Players can rejoin once it&apos;s back up, usually within a minute.</p>
    </ConfirmDialog>
    <ConfirmDialog open={pending === "update"} onOpenChange={(open) => !open && setPending(null)} title={`Update ${server.name}'s server software?`} confirmLabel="Update and restart" onConfirm={() => void runAction(server, "update")}>
      <p>Downloads the latest server image for Minecraft <span className="font-medium text-foreground">{server.version}</span> and restarts with it.</p>
      <p>{playersWarning(server)}</p>
      <p>Expect 1–3 minutes of downtime. A safety backup is taken first, and if the server doesn&apos;t start, the previous version is restored automatically.</p>
    </ConfirmDialog>
  </>;
}

/** Start, or Stop + Restart, for a server header. */
export function PowerControls({ server, size = "sm" }: { server: MinecraftServer; size?: "sm" | "default" }) {
  const { runAction, isPending, system, can } = usePanel();
  const [pending, setPending] = useState<Pending>(null);
  if (!can.control) return null;
  const busy = Boolean(server.operation) || isPending(`${server.id}:start`) || isPending(`${server.id}:stop`) || isPending(`${server.id}:restart`);
  const dockerDown = system?.dockerAvailable === false;
  return <>
    {server.status === "running" || server.status === "starting"
      ? <>
        <Button size={size} variant="outline" onClick={() => setPending("stop")} disabled={busy || dockerDown}><Square />Stop</Button>
        {server.status === "running" && <Button size={size} variant="outline" onClick={() => setPending("restart")} disabled={busy || dockerDown}><RotateCcw />Restart</Button>}
      </>
      : <Button size={size} onClick={() => void runAction(server, "start")} disabled={busy || dockerDown}><Play />{isPending(`${server.id}:start`) ? "Starting…" : "Start"}</Button>}
    <DowntimeConfirmations server={server} pending={pending} setPending={setPending} />
  </>;
}

/** The "…" menu: navigation shortcuts plus less frequent actions. */
export function ServerMenu({ server, inHeader = false }: { server: MinecraftServer; inHeader?: boolean }) {
  const { runAction, system, can } = usePanel();
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const busy = Boolean(server.operation);
  async function copyAddress() {
    const address = serverAddress(server.port, system?.publicHost);
    try { await navigator.clipboard.writeText(address); toast.success("Address copied", { description: address }); }
    catch { toast.error("Couldn't copy the address."); }
  }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More actions for ${server.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {!inHeader && <>
          <DropdownMenuItem asChild><Link href={serverHref(server.id, "console")}><TerminalSquare />Console</Link></DropdownMenuItem>
          <DropdownMenuItem asChild><Link href={serverHref(server.id, "backups")}><Archive />Backups</Link></DropdownMenuItem>
          {can.files && <DropdownMenuItem asChild><Link href={serverHref(server.id, "files")}><FolderOpen />Files</Link></DropdownMenuItem>}
          {can.viewSettings && <DropdownMenuItem asChild><Link href={serverHref(server.id, "settings")}><Settings2 />Settings</Link></DropdownMenuItem>}
          <DropdownMenuSeparator />
        </>}
        <DropdownMenuItem onSelect={() => void copyAddress()}><Copy />Copy address</DropdownMenuItem>
        {can.control && <DropdownMenuItem disabled={busy} onSelect={() => void runAction(server, "backup")}><Archive />Back up now</DropdownMenuItem>}
        {can.control && !inHeader && server.status === "running" && <DropdownMenuItem disabled={busy} onSelect={() => setPending("restart")}><RotateCcw />Restart</DropdownMenuItem>}
        {can.manage && <DropdownMenuItem disabled={busy} onSelect={() => setPending("update")}><RefreshCcw />Update server software</DropdownMenuItem>}
        {inHeader && can.manage && <><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => router.push(`${serverHref(server.id, "settings")}#danger-zone`)}><Trash2 />Remove server…</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
    <DowntimeConfirmations server={server} pending={pending} setPending={setPending} />
  </>;
}

export function QuickPowerButton({ server }: { server: MinecraftServer }) {
  const { runAction, isPending, system, can } = usePanel();
  const [pending, setPending] = useState<Pending>(null);
  if (!can.control) return null;
  const busy = Boolean(server.operation) || isPending(`${server.id}:start`) || isPending(`${server.id}:stop`);
  const disabled = busy || system?.dockerAvailable === false;
  return <>
    {server.status === "running" || server.status === "starting"
      ? <Button size="sm" variant="outline" className={cn("bg-transparent")} onClick={() => setPending("stop")} disabled={disabled} aria-label={`Stop ${server.name}`}><Square />Stop</Button>
      : <Button size="sm" onClick={() => void runAction(server, "start")} disabled={disabled} aria-label={`Start ${server.name}`}><Play />Start</Button>}
    <DowntimeConfirmations server={server} pending={pending} setPending={setPending} />
  </>;
}
