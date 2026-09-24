"use client";

import Link from "next/link";
import { LoaderCircle, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyAddress, StatusPill } from "./common";
import { serverHref, serverKind } from "./lib";
import { QuickPowerButton, ServerMenu } from "./server-actions";
import type { MinecraftServer } from "./types";

export function ServerCard({ server }: { server: MinecraftServer }) {
  const failed = server.status === "failed" || server.health === "unhealthy";
  return <article className={cn("flex flex-col rounded-xl border bg-card transition-colors", failed ? "border-destructive/40" : "border-border hover:border-foreground/20")}>
    <div className="flex items-start justify-between gap-3 p-4 pb-3">
      <div className="min-w-0">
        <h3 className="font-display truncate text-base font-semibold"><Link href={serverHref(server.id)} className="rounded-sm outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring">{server.name}</Link></h3>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{serverKind(server)}</p>
      </div>
      <StatusPill server={server} />
    </div>
    <div className="space-y-2 px-4 pb-3">
      <CopyAddress port={server.port} compact />
      {server.operation ? <p className="flex items-center gap-1.5 text-xs text-warning"><LoaderCircle className="size-3.5 animate-spin" />{server.operation.step || server.operation.label}…</p>
        : failed ? <p className="line-clamp-2 text-xs text-destructive">{server.statusMessage}</p> : null}
    </div>
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Users className="size-4" aria-hidden /><span><span className="font-medium text-foreground">{server.playersOnline}</span> / {server.maxPlayers}<span className="sr-only"> players online</span></span></span>
      <div className="flex items-center gap-1"><QuickPowerButton server={server} /><ServerMenu server={server} /></div>
    </div>
  </article>;
}
