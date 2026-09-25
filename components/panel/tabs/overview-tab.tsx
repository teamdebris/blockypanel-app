"use client";

import { useState } from "react";
import { Cpu, Gauge, HardDrive, History, MemoryStick, MoreHorizontal, ShieldPlus, UserMinus, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ConfirmDialog, Section, Sparkline, UsageBar } from "../common";
import { api, errorMessage, formatBytes, formatDate, formatMb, javaVersions } from "../lib";
import { usePanel } from "../panel-context";
import type { MinecraftServer } from "../types";

function Stat({ icon: Icon, label, value, children }: { icon: typeof Cpu; label: string; value: string; children?: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-card p-4">
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-4" aria-hidden />{label}</div>
    <p className="mt-2 truncate text-base font-semibold">{value}</p>
    {children && <div className="mt-2">{children}</div>}
  </div>;
}

function PlayerRow({ server, name }: { server: MinecraftServer; name: string }) {
  const { can } = usePanel();
  const [confirm, setConfirm] = useState<"kick" | "op" | null>(null);
  async function send(command: string, success: string) {
    try {
      const result = await api<{ output: string }>(`/api/servers/${server.id}/console`, { method: "POST", body: JSON.stringify({ command }) });
      toast.success(success, { description: result.output || undefined });
    } catch (error) { toast.error(errorMessage(error, "Command failed.")); }
  }
  const whitelisted = server.whitelist.some((entry) => entry.toLowerCase() === name.toLowerCase());
  return <li className="flex items-center gap-3 py-2">
    {/* eslint-disable-next-line @next/next/no-img-element -- small external avatar; next/image would need remote config */}
    <img src={`https://mc-heads.net/avatar/${encodeURIComponent(name)}/28`} alt="" width={28} height={28} className="size-7 rounded" loading="lazy" />
    <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
    {/* These are console commands, which need the Operator role (the server enforces it too). */}
    {can.console && <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!whitelisted && server.whitelist.length > 0 && <DropdownMenuItem onSelect={() => void send(`whitelist add ${name}`, `${name} added to the whitelist`)}><UserPlus />Add to whitelist</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => setConfirm("op")}><ShieldPlus />Make operator</DropdownMenuItem>
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirm("kick")}><UserMinus />Kick</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>}
    <ConfirmDialog open={confirm === "kick"} onOpenChange={(open) => !open && setConfirm(null)} title={`Kick ${name}?`} confirmLabel="Kick player" destructive onConfirm={() => void send(`kick ${name}`, `${name} was kicked`)}><p>They&apos;re disconnected but can rejoin right away.</p></ConfirmDialog>
    <ConfirmDialog open={confirm === "op"} onOpenChange={(open) => !open && setConfirm(null)} title={`Make ${name} an operator?`} confirmLabel="Make operator" onConfirm={() => void send(`op ${name}`, `${name} is now an operator`)}><p>Operators can run any command, including changing the world, banning players, and stopping the server.</p></ConfirmDialog>
  </li>;
}

export function OverviewTab({ server }: { server: MinecraftServer }) {
  const { history } = usePanel();
  const samples = history[server.id] || [];
  const java = javaVersions.find((item) => item.value === (server.javaVersion || "auto"))?.label || "Automatic";
  const running = server.status === "running";
  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat icon={Cpu} label="CPU" value={running ? `${server.cpuPercent.toFixed(1)}%` : "—"}><Sparkline values={samples.map((sample) => sample.cpu)} label="CPU over the last 10 minutes" /></Stat>
        <Stat icon={MemoryStick} label="Memory" value={running ? `${formatMb(server.memoryUsageMb)} / ${formatMb(server.memoryLimitMb)}` : `— / ${formatMb(server.memoryLimitMb)}`}>
          <UsageBar value={server.memoryUsageMb} max={server.memoryLimitMb} label="Memory used" />
          <Sparkline className="mt-1" values={samples.map((sample) => sample.memory)} max={server.memoryLimitMb} label="Memory over the last 10 minutes" />
        </Stat>
        <Stat icon={Users} label="Players" value={`${server.playersOnline} / ${server.maxPlayers}`}><UsageBar value={server.playersOnline} max={server.maxPlayers} label="Player slots used" /></Stat>
        <Stat icon={HardDrive} label="World size" value={formatBytes(server.diskUsageBytes)} />
        <Stat icon={History} label="Crashes and restarts" value={String(server.restartCount)} />
        <Stat icon={Gauge} label="Health" value={server.health.charAt(0).toUpperCase() + server.health.slice(1)} />
      </div>
      {server.status !== "running" && <div className={server.status === "failed" ? "rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm" : "rounded-xl border border-border bg-muted/50 p-4 text-sm"}>
        <p className="font-medium">{server.status === "failed" ? "The server stopped unexpectedly" : server.status === "starting" ? "Starting up" : "Stopped"}</p>
        <p className="mt-1 break-words text-muted-foreground">{server.statusMessage}</p>
      </div>}
      <Section title="Details">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          {[
            ["Java", java], ["CPU limit", server.cpuLimit ? `${server.cpuLimit} cores` : "Unlimited"],
            ["Memory for Java", `${server.initialMemoryPercent}% at start, up to ${server.maxMemoryPercent}%`], ["View / simulation distance", `${server.viewDistance} / ${server.simulationDistance} chunks`],
            ["Difficulty", server.difficulty.charAt(0).toUpperCase() + server.difficulty.slice(1)], ["Whitelist", server.whitelist.length ? `${server.whitelist.length} player${server.whitelist.length === 1 ? "" : "s"}` : "Off (anyone can join)"],
            ["Created", formatDate(server.createdAt)], ["Server ID", server.id.slice(0, 12)],
          ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 border-b border-border pb-2 sm:block sm:border-0 sm:pb-0"><dt className="text-muted-foreground">{label}</dt><dd className={label === "Server ID" ? "font-mono text-xs" : ""}>{value}</dd></div>)}
        </dl>
      </Section>
    </div>
    <Section title="Online now" description={running ? `${server.playersOnline} of ${server.maxPlayers} slots in use` : "The server isn't running."}>
      {server.players.length ? <ul className="-my-2 divide-y divide-border">{server.players.map((name) => <PlayerRow key={name} server={server} name={name} />)}</ul>
        : <p className="text-sm text-muted-foreground">{running ? "Nobody is online." : "Start the server to see who's playing."}</p>}
    </Section>
  </div>;
}
